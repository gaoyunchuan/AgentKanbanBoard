#!/usr/bin/env python3
"""构建、打包并安装 Electron 版 Codex Thread Kanban（开发制品，ad-hoc 签名）。"""
import argparse
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'desktop'
APP_NAME = 'Codex Thread Kanban'

def run(argv, **kwargs):
    subprocess.run([str(value) for value in argv], cwd=ROOT, check=True, **kwargs)

def build_ui():
    run(['npm', '--prefix', 'src-ui', 'run', 'build'])
    ui = DESKTOP / 'ui'
    # 每次重新拷贝完整构建，避免上一版未被引用的 hash 资源残留进安装包。
    if ui.exists():
        shutil.rmtree(ui)
    ui.mkdir()
    shutil.copytree(ROOT / 'src-ui' / 'dist', ui, dirs_exist_ok=True)

def build_sidecar():
    run(['cargo', 'build', '--release', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--bin', 'akb_sidecar'])

def package_app():
    packager = DESKTOP / 'node_modules' / '.bin' / 'electron-packager'
    output = DESKTOP / 'dist-electron'
    run([packager, str(DESKTOP), APP_NAME, '--platform=darwin', '--arch=arm64', '--out=' + str(output),
         '--overwrite', '--app-bundle-id=local.codex.thread-kanban', '--app-version=0.1.0',
         '--icon=src-tauri/icons/icon.icns', '--extra-resource=src-tauri/target/release/akb_sidecar'])
    app = output / (APP_NAME + '-darwin-arm64') / (APP_NAME + '.app')
    run(['codesign', '--force', '--deep', '--sign', '-', str(app)])
    run(['codesign', '--verify', '--deep', '--strict', str(app)])
    return app

def install(app, open_after):
    target = Path.home() / 'Applications' / (APP_NAME + '.app')
    if target.exists():
        backup = target.with_name(f'{APP_NAME}.backup-{uuid.uuid4()}.app')
        target.rename(backup)
        print(f'已保留旧版本：{backup}')
    shutil.copytree(app, target, symlinks=True)
    run(['codesign', '--verify', '--deep', '--strict', str(target)])
    if open_after:
        run(['open', '-a', str(target)])
    print(f'已安装：{target}')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if not args.skip_build:
        build_ui()
        build_sidecar()
    app = package_app()
    install(app, not args.no_open)

if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
