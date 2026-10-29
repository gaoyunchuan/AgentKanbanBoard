"""准备本 APP 私有固定 sidecar 与 Docker 镜像，不修改全局 agent-browser。"""

import argparse
import base64
import hashlib
import json
import pathlib
import platform
import shutil
import subprocess
import tarfile
from oci_cache import load_locked_image


HERE = pathlib.Path(__file__).resolve().parent


def read_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=HERE.parents[1] / ".build/browser")
    parser.add_argument("--npm-tarball", type=pathlib.Path)
    parser.add_argument("--official-npm", action="store_true")
    parser.add_argument("--binary-only", action="store_true")
    parser.add_argument("--image-only", action="store_true")
    return parser.parse_args()


def prepare_tarball(config, options, output):
    archive = options.npm_tarball or output / "agent-browser-0.40.0.tgz"
    if not archive.exists():
        url = config["source"] if options.official_npm else config["mirror"]
        subprocess.run(["curl", "--fail", "--location", "--retry", "2", "--max-time", "300", url, "-o", str(archive)], check=True)
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if actual != config["integrity"]:
        raise RuntimeError("agent-browser npm 包完整性校验失败")
    return archive


def prepare_binary(config, options, output):
    system = platform.system().lower()
    architecture = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    target = f"{system}-{architecture}"
    expected = config["binaries"].get(target)
    if not expected:
        raise RuntimeError(f"未锁定该平台的 agent-browser: {target}")
    destination = output / "agent-browser"
    if not destination.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
        archive = prepare_tarball(config, options, output)
        with tarfile.open(archive) as package:
            source = package.extractfile(f"package/bin/agent-browser-{target}")
            with destination.open("wb") as binary:
                shutil.copyfileobj(source, binary)
        if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
            raise RuntimeError("agent-browser 可执行文件摘要校验失败")
        destination.chmod(0o700)
    version = subprocess.check_output([str(destination), "--version"], text=True).strip()
    if version != "agent-browser " + config["version"]:
        raise RuntimeError("agent-browser 版本与锁定值不符")
    return destination


def prepare_image(chrome, output):
    architecture = subprocess.check_output(["docker", "version", "--format", "{{.Server.Arch}}"], text=True).strip()
    selected = chrome["platforms"].get(architecture)
    if not selected:
        raise RuntimeError(f"未锁定该 Docker 架构: {architecture}")
    inspected = subprocess.run(["docker", "image", "inspect", selected["configId"], "--format", "{{.Id}}"], capture_output=True, text=True)
    if inspected.returncode or inspected.stdout.strip() != selected["configId"]:
        load_locked_image(chrome, selected, output / "oci-cache" / architecture)
    actual = subprocess.check_output(["docker", "image", "inspect", selected["configId"], "--format", "{{.Id}}"], text=True).strip()
    if actual != selected["configId"]:
        raise RuntimeError("Docker 缓存镜像 config 摘要不符")
    return {"architecture": architecture, **selected}


def prepare_cjk_image(selected, output):
    """在固定基础镜像上增加中文字体层；标签由基础镜像 digest 唯一确定。"""
    digest = selected["configId"].removeprefix("sha256:")[:12]
    base_tag = f"akb-chrome-base:{digest}"
    cjk_tag = f"akb-chrome-cjk-{selected['architecture']}:{digest}"
    subprocess.run(["docker", "tag", selected["configId"], base_tag], check=True)
    build = output / f"cjk-{selected['architecture']}"
    build.mkdir(parents=True, exist_ok=True)
    (build / "Dockerfile").write_text(
        f"FROM {base_tag}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends fonts-wqy-microhei && rm -rf /var/lib/apt/lists/*\n"
    )
    # 字体层一旦构建成功就与本机固定基础镜像绑定；失败时保留基础镜像，页面仍可用。
    subprocess.run(["docker", "build", "-t", cjk_tag, str(build)], check=True)
    return cjk_tag


def main():
    options = read_arguments()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock = json.loads((HERE / "runtime.json").read_text())
    binary = None if options.image_only else prepare_binary(lock["agentBrowser"], options, output)
    image = None if options.binary_only else prepare_image(lock["chrome"], output)
    prepared = {"binary": str(binary) if binary else None, "version": lock["agentBrowser"]["version"], "chrome": image}
    if image:
        prepared["chrome"]["cjk_image"] = prepare_cjk_image(image, output)
    (output / "runtime.json").write_text(json.dumps(prepared, indent=2) + "\n")
    print(json.dumps(prepared, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
