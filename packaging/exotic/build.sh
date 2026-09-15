#!/usr/bin/env bash
# 国产/新兴架构（riscv64 / loongarch64 / ppc64le）构建脚本——在对应架构的 Debian 容器内运行。
# 产物：bit-cli deb 包 + 裸二进制 tar.gz（TUI/worker/guardian 三模式）。
# musl/exotic 无 GUI（Electron 无 musl 二进制、Exotic 架构无 Electron 发行，已拍板只保 CLI），
# webkit/gtk/appindicator 依赖全部移除，容器依赖从 ~400MB 降到最小工具链。
# 用法: build.sh <deb-arch> <version>   例如: build.sh riscv64 0.6.24
# armv7/armhf 无法支持：Rust 官方仍支持但 Electron/WebKitGTK 均无 32 位 ARM 桌面生态，
# CLI 虽可编但用户场景缺失，维持不支持。申威 SW64 无 Rust 工具链。s390x 大端生态缺失。
set -euo pipefail
DEB_ARCH="$1"
VERSION="$2"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates build-essential pkg-config libssl-dev file

# rustup 官方分发 riscv64gc / loongarch64 的 rustup-init（tier2 目标）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
rustc --version

# 只编 bit-cli：--no-default-features 跳过 desktop-ctl（enigo 依赖 libxdo，容器缺失）
cargo build --release --locked -p bit-core --bin bit-cli --no-default-features --features tui-ui
BIN=target/release/bit-cli
ls -lh "$BIN"

OUT=packaging/exotic/out
rm -rf "$OUT"
mkdir -p "$OUT"

# ---- deb 包（Debian/Ubuntu/Loongnix/龙蜥等直接安装）----
PKG="$OUT/pkg"
mkdir -p "$PKG/DEBIAN" "$PKG/usr/bin"
install -m 755 "$BIN" "$PKG/usr/bin/bit-cli"
cat > "$PKG/DEBIAN/control" <<CTL
Package: bit-cli
Version: $VERSION
Section: devel
Priority: optional
Architecture: $DEB_ARCH
Maintainer: yxpil <yxpil@users.noreply.github.com>
Depends: libssl3t64
Description: bit-cli - 触手怪 Tentacle 命令行形态（TUI/worker/guardian）
CTL
dpkg-deb --build --root-owner-group "$PKG" "$OUT/bit-cli_${VERSION}_${DEB_ARCH}.deb"

# ---- 裸二进制 tar.gz（Arch/其他发行版手动安装）----
tar -czf "$OUT/bit-cli_${VERSION}_${DEB_ARCH}.tar.gz" -C target/release bit-cli

ls -lh "$OUT"
