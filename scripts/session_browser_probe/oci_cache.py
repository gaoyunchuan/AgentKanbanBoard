"""宿主下载已锁定 OCI 对象并导入 Docker，不依赖 Docker daemon 的外网链路。"""

import concurrent.futures
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.request


def authenticated_registry(registry, repository):
    url = f"https://{registry}/v2/{repository}/manifests/probe-not-a-tag"
    try:
        urllib.request.urlopen(url, timeout=20)
    except urllib.error.HTTPError as error:
        challenge = error.headers.get("www-authenticate", "")
        if not challenge:
            return None
        fields = dict(re.findall(r'(\w+)="([^"]+)"', challenge))
        url = fields["realm"] + "?service=" + fields["service"] + "&scope=" + fields["scope"]
        with urllib.request.urlopen(url, timeout=30) as response:
            payload = json.load(response)
        return payload.get("token", payload.get("access_token"))


def verify_file(filename, digest):
    if not filename.exists():
        return False
    with filename.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    return actual == digest.removeprefix("sha256:")


def fetch_verified(url, destination, digest, curl_config):
    if verify_file(destination, digest):
        return
    partial = destination.with_suffix(".partial")
    # 凭据只放 0600 临时配置，不拼进 argv 或日志；任何下载都必须匹配锁定 digest。
    subprocess.run([
        "curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2",
        "--max-time", "300", "--config", str(curl_config), url, "-o", str(partial),
    ], check=True)
    if not verify_file(partial, digest):
        raise RuntimeError(f"OCI 内容摘要不符: {digest}")
    partial.replace(destination)


def download_manifest(registry, repository, platform, root, curl_config):
    manifest_digest = platform["manifestDigest"]
    filename = root / manifest_digest.split(":")[1]
    fetch_verified(f"https://{registry}/v2/{repository}/manifests/{manifest_digest}", filename, manifest_digest, curl_config)
    manifest = json.loads(filename.read_text())
    if manifest["config"]["digest"] != platform["configId"]:
        raise RuntimeError("镜像 manifest 的 config 与锁定值不符")
    return manifest


def download_blobs(registry, repository, manifest, root, curl_config):
    def download(item):
        digest = item["digest"]
        destination = root / digest.split(":")[1]
        fetch_verified(f"https://{registry}/v2/{repository}/blobs/{digest}", destination, digest, curl_config)
        print(f"已验证 OCI 对象 {digest}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, [manifest["config"]] + manifest["layers"]))


def docker_archive(manifest, root, tag):
    output = root / "docker-archive"
    output.mkdir(exist_ok=True)
    config = manifest["config"]["digest"].split(":")[1]
    shutil.copyfile(root / config, output / (config + ".json"))
    layers = []
    for layer in manifest["layers"]:
        digest = layer["digest"].split(":")[1]
        destination = output / digest / "layer.tar"
        destination.parent.mkdir(exist_ok=True)
        with gzip.open(root / digest, "rb") as source, destination.open("wb") as target:
            shutil.copyfileobj(source, target)
        layers.append(digest + "/layer.tar")
    (output / "manifest.json").write_text(json.dumps([{"Config": config + ".json", "RepoTags": [tag], "Layers": layers}]))
    archive_path = root / "docker-load.tar"
    with tarfile.open(archive_path, "w") as archive:
        for filename in output.iterdir():
            archive.add(filename, arcname=filename.name)
    return archive_path


def load_locked_image(chrome, platform, cache):
    root = pathlib.Path(cache)
    root.mkdir(parents=True, exist_ok=True)
    registry, repository = chrome["registry"], chrome["repository"]
    token = authenticated_registry(registry, repository)
    curl_config = root / "registry-auth.curl"
    curl_config.touch(mode=0o600)
    curl_config.chmod(0o600)
    curl_config.write_text(('header = "Authorization: Bearer ' + token + '"\n' if token else '') + 'header = "Accept: application/vnd.oci.image.manifest.v1+json"\n')
    try:
        manifest = download_manifest(registry, repository, platform, root, curl_config)
        download_blobs(registry, repository, manifest, root, curl_config)
        archive = docker_archive(manifest, root, repository + ":akb-fixed")
        subprocess.run(["docker", "load", "-i", str(archive)], check=True)
    finally:
        curl_config.unlink(missing_ok=True)
