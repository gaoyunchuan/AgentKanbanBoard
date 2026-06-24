NPM ?= npm
APP_NAME := Codex Thread Kanban
APP_VERSION := 0.1.0
APP_ARCH := $(shell uname -m)
APP_BUNDLE := src-tauri/target/release/bundle/macos/$(APP_NAME).app
DMG_DIR := src-tauri/target/release/bundle/dmg
DMG_STAGING := src-tauri/target/release/bundle/dmg-staging
DMG_PATH := $(DMG_DIR)/$(APP_NAME)_$(APP_VERSION)_$(APP_ARCH).dmg

.PHONY: build build-dmg deps test

# 本地制品构建入口：生成 macOS dmg 安装包。
build: build-dmg

deps:
	$(NPM) --prefix src-ui ci

test: deps
	$(NPM) --prefix src-ui run test
	cargo test --manifest-path src-tauri/Cargo.toml

build-dmg: deps
	$(NPM) --prefix src-ui run build:app
	rm -rf "$(DMG_STAGING)"
	mkdir -p "$(DMG_STAGING)" "$(DMG_DIR)"
	cp -R "$(APP_BUNDLE)" "$(DMG_STAGING)/"
	ln -s /Applications "$(DMG_STAGING)/Applications"
	find "$(DMG_DIR)" -maxdepth 1 -type f -name "$(APP_NAME)_*.dmg" -delete
	hdiutil create -volname "$(APP_NAME)" -srcfolder "$(DMG_STAGING)" -ov -format UDZO "$(DMG_PATH)"
	@echo "DMG created at $(DMG_PATH)"
