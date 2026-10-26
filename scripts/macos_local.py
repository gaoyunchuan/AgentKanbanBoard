#!/usr/bin/env python3
"""Build, verify, and install the personal macOS app without Apple credentials.

Ad-hoc signatures establish bundle integrity. They do not establish Developer ID
trust, notarization, or permission under a managed Mac's security policy.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
APPLE_SIGNING_ENV = frozenset(
    {
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_PASSWORD",
        "APPLE_TEAM_ID",
        "APPLE_API_ISSUER",
        "APPLE_API_KEY",
        "APPLE_API_KEY_PATH",
        "APPLE_KEYCHAIN",
        "APPLE_CODESIGN_KEYCHAIN",
        "APPLE_KEYCHAIN_PROFILE",
    }
)


class LocalBuildError(RuntimeError):
    """An actionable failure safe to display without credential-bearing argv."""


def require_macos():
    if sys.platform != "darwin":
        raise LocalBuildError("This command requires macOS.")


def run(argv, *, label, env=None, capture=True):
    """Run native tools without a shell or exposing inherited credentials."""
    try:
        result = subprocess.run(
            [str(arg) for arg in argv],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=capture,
            check=False,
        )
    except OSError as error:
        raise LocalBuildError(f"{label} could not start: {error.strerror}.") from None
    if result.returncode != 0:
        diagnostic = ""
        # These native operations accept only public paths/flags in this helper.
        # Build output already streams directly; never echo argv or the env.
        if capture and str(argv[0]) in {"codesign", "hdiutil", "ditto"}:
            detail = (result.stderr or result.stdout or "").strip()[-2000:]
            if detail:
                diagnostic = f"\n{detail}"
        raise LocalBuildError(f"{label} failed (exit {result.returncode}).{diagnostic}")
    return result


def config():
    settings = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    name = settings.get("productName", "")
    identifier = settings.get("identifier", "")
    if not isinstance(name, str) or not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise LocalBuildError("tauri.conf.json has an invalid productName.")
    if not isinstance(identifier, str) or not identifier:
        raise LocalBuildError("tauri.conf.json has no bundle identifier.")
    return settings


def app_name():
    return f"{config()['productName']}.app"


def built_app():
    return ROOT / "src-tauri/target/release/bundle/macos" / app_name()


def installed_app():
    return Path.home() / "Applications" / app_name()


def local_build_env():
    return {key: value for key, value in os.environ.items() if key not in APPLE_SIGNING_ENV}


def verify_app(path=None):
    require_macos()
    app = Path(path) if path is not None else built_app()
    if not app.is_dir():
        raise LocalBuildError(f"App bundle not found: {app}")
    if not (app / "Contents/_CodeSignature/CodeResources").is_file():
        raise LocalBuildError(f"App bundle has no signed resource manifest: {app}")
    run(["codesign", "--verify", "--deep", "--strict", app], label="App signature verification")
    result = run(["codesign", "-dv", "--verbose=4", app], label="Read app signature")
    details = {}
    for line in (result.stdout + "\n" + result.stderr).splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            details[key.strip()] = value.strip()
    if details.get("Signature") != "adhoc":
        raise LocalBuildError("The local app must have an explicit ad-hoc bundle signature.")
    if details.get("Identifier") != config()["identifier"]:
        raise LocalBuildError("The app signature identifier does not match tauri.conf.json.")
    cdhash = details.get("CDHash", "")
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", cdhash):
        raise LocalBuildError("The app signature contains no valid CDHash.")
    return {"identifier": details["Identifier"], "signature": "adhoc", "cdhash": cdhash.lower()}


def build_app():
    require_macos()
    local_config = ROOT / "src-tauri/tauri.local.conf.json"
    settings = json.loads(local_config.read_text())
    if settings.get("bundle", {}).get("macOS", {}).get("signingIdentity") != "-":
        raise LocalBuildError("tauri.local.conf.json must set macOS signingIdentity to '-'.")
    run(
        [
            ROOT / "src-ui/node_modules/.bin/tauri",
            "build", "--ci", "--bundles", "app",
            "--config", local_config,
        ],
        label="Local macOS build",
        env=local_build_env(),
        capture=False,
    )
    verify_app()
    print(f"Built and verified local ad-hoc app: {built_app()}")


@contextmanager
def mounted_dmg(dmg):
    """Always attempt to detach our own mount, including partial attach failures."""
    temporary = Path(tempfile.mkdtemp(prefix="agentkanban-dmg-"))
    mount = temporary / "mount"
    mount.mkdir()
    attached = False
    try:
        run(
            ["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg],
            label="Mount development DMG read-only",
        )
        attached = True
        yield mount
    finally:
        try:
            run(["hdiutil", "detach", mount], label="Detach development DMG")
        except LocalBuildError:
            if attached or os.path.ismount(mount):
                # Never recursively remove a path which could still be mounted.
                raise LocalBuildError(
                    f"Could not detach the temporary DMG mount at {mount}; "
                    "the mount and temporary directory were preserved for cleanup."
                ) from None
        if mount.exists():
            mount.rmdir()
        temporary.rmdir()


def same_app(actual, expected):
    if actual != expected:
        raise LocalBuildError("Copied app signature/CDHash does not match the verified build.")


def sidecars(dmg):
    return Path(str(dmg) + ".sha256"), Path(str(dmg) + ".verification.json")


def verify_dmg(path):
    require_macos()
    dmg = Path(path).expanduser().resolve()
    checksum_path, report_path = sidecars(dmg)
    # A failed repeat verification must not leave a stale success report behind.
    for artifact in (checksum_path, report_path):
        artifact.unlink(missing_ok=True)
    if not dmg.is_file():
        raise LocalBuildError(f"DMG not found: {dmg}")
    expected = verify_app()
    run(["hdiutil", "verify", dmg], label="DMG image integrity verification")
    with mounted_dmg(dmg) as mount:
        same_app(verify_app(mount / app_name()), expected)

    digest = hashlib.sha256()
    with dmg.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    checksum = digest.hexdigest()
    report = {
        "schema_version": 1,
        "distribution": "local-development",
        "notarized": False,
        "gatekeeper": "not-assessed",
        "managed_device_policy": "not-assessed",
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "dmg": dmg.name,
        "sha256": checksum,
        "app": app_name(),
        "version": config().get("version"),
        **expected,
        "checks": ["image-integrity", "mounted-app-signature", "build-cdhash-match", "detached"],
    }
    # Publish success evidence only after the mounted copy passes and is detached.
    try:
        checksum_path.write_text(f"{checksum}  {dmg.name}\n", encoding="utf-8")
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except OSError:
        for artifact in (checksum_path, report_path):
            artifact.unlink(missing_ok=True)
        raise
    print(f"Verified local development DMG: {dmg}")
    print("Ad-hoc signed; not notarized. Gatekeeper and managed-device policy were not assessed.")
    return report


def install_app():
    require_macos()
    source = built_app()
    expected = verify_app(source)
    target = installed_app()
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".agentkanban-install-", dir=target.parent))
    staged_app = staging / app_name()
    backup = None
    moved_new = False
    try:
        run(["ditto", source, staged_app], label="Copy verified app for local installation")
        same_app(verify_app(staged_app), expected)
        if os.path.lexists(target):
            backup = target.with_name(f"{target.stem}.backup-{uuid.uuid4().hex}.app")
            target.rename(backup)
        try:
            staged_app.rename(target)
            moved_new = True
            same_app(verify_app(target), expected)
        except BaseException:
            try:
                if moved_new:
                    target.rename(staged_app)
                if backup is not None:
                    backup.rename(target)
            except OSError:
                recovery = (
                    f"The previous app is preserved at {backup}. "
                    if backup is not None else "There was no previous installation. "
                )
                raise LocalBuildError(
                    f"Installation rollback failed. {recovery}Inspect {target} before retrying."
                ) from None
            raise
    finally:
        shutil.rmtree(staging)
    print(f"Installed verified local app: {target}")
    if backup is not None:
        print(f"Previous app preserved: {backup}")
    return target


def open_app():
    require_macos()
    target = installed_app()
    verify_app(target)
    run(["open", target], label="Open local app", capture=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build-app", help="Build and verify the local ad-hoc app")
    verify = commands.add_parser("verify-app", help="Verify an ad-hoc app bundle")
    verify.add_argument("path", nargs="?", type=Path)
    verify_image = commands.add_parser("verify-dmg", help="Verify the final DMG and its mounted app")
    verify_image.add_argument("path", type=Path)
    commands.add_parser("install", help="Install the local build in ~/Applications; preserve the old app")
    commands.add_parser("open", help="Open the installed app through normal macOS checks")
    args = parser.parse_args(argv)
    try:
        if args.command == "build-app":
            build_app()
        elif args.command == "verify-app":
            print(json.dumps(verify_app(args.path), indent=2))
        elif args.command == "verify-dmg":
            verify_dmg(args.path)
        elif args.command == "install":
            install_app()
        elif args.command == "open":
            open_app()
    except (LocalBuildError, OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
