NPM ?= npm
PYTHON ?= python3
APP_NAME := Codex Thread Kanban
APP_VERSION := 0.1.0
APP_ARCH := $(shell uname -m)
APP_BUNDLE := src-tauri/target/release/bundle/macos/$(APP_NAME).app
DMG_DIR := src-tauri/target/release/bundle/dmg
DMG_STAGING := src-tauri/target/release/bundle/dmg-staging
DMG_PATH := $(DMG_DIR)/$(APP_NAME)_$(APP_VERSION)_$(APP_ARCH)_development.dmg

.PHONY: build build-app build-dmg install-local run-local deps test test-local-tools

# 本机使用可直接 make run-local；build 保留为开发 DMG 构建入口。
build: build-dmg

deps:
	$(NPM) --prefix src-ui ci

test-local-tools:
	$(PYTHON) -m unittest discover -s scripts -p 'test_macos_local.py' -v

test: deps test-local-tools
	$(NPM) --prefix src-ui run test
	cargo test --manifest-path src-tauri/Cargo.toml

build-app: deps
	$(NPM) --prefix src-ui run build:app

install-local: build-app
	$(PYTHON) scripts/macos_local.py install

run-local: install-local
	$(PYTHON) scripts/macos_local.py open

build-dmg: build-app
	rm -rf "$(DMG_STAGING)"
	mkdir -p "$(DMG_STAGING)" "$(DMG_DIR)"
	ditto "$(APP_BUNDLE)" "$(DMG_STAGING)/$(APP_NAME).app"
	ln -s /Applications "$(DMG_STAGING)/Applications"
	find "$(DMG_DIR)" -maxdepth 1 -type f -name "$(APP_NAME)_*_development.dmg*" -delete
	hdiutil create -volname "$(APP_NAME)" -srcfolder "$(DMG_STAGING)" -ov -format UDZO "$(DMG_PATH)"
	$(PYTHON) scripts/macos_local.py verify-dmg "$(DMG_PATH)"
	@echo "Verified development DMG: $(DMG_PATH)"
