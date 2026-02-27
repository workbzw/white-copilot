#!/bin/bash
# Ubuntu 安装 Node.js 21（通过 NodeSource）
# 用法: chmod +x scripts/install-node21-ubuntu.sh && sudo ./scripts/install-node21-ubuntu.sh

set -e

echo "安装 Node.js 21 ..."

apt update
apt install -y curl

curl -fsSL https://deb.nodesource.com/setup_21.x | bash -
apt install -y nodejs

echo "完成。"
node -v
npm -v
