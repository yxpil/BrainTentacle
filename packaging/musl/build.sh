#!/usr/bin/env bash
# Alpine (musl) 构建脚本——在 alpine:edge 容器内运行。
# 产物：bit-cli 裸二进制 tar.gz（TUI/worker/guardian 三模式）。
# musl/exotic 无 GUI（Electron 无 musl 二进制，已拍板只保 CLI），webkit 等不再需要。
# 用法: build.sh <apk-arch> <version>   例如: build.sh x86_64 0.6.24
set -euo pipefail
ARCH="$1"
VERSION="$2"

apk add --no-cache build-base pkgconf file rust cargo openssl-dev

rustc --version
# 只编 bit-cli：--no-default-features 跳过 desktop-ctl（enigo 依赖 libxdo，Alpine 无包）
# 与 tui-ui？TUI 是 CLI 形态核心能力，保留（ratatui/crossterm 纯 Rust，musl 无障碍）
cargo build --release --locked -p bit-core --bin bit-cli --no-default-features --features tui-ui
BIN=target/release/bit-cli
ls -lh "$BIN"

OUT=packaging/musl/out
rm -rf "$OUT"
mkdir -p "$OUT"
tar -czf "$OUT/bit-cli_${VERSION}_${ARCH}-musl.tar.gz" -C target/release bit-cli

ls -lh "$OUT"
