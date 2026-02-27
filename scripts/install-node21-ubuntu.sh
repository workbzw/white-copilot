#!/bin/bash
# Ubuntu 安装 Node.js 21（通过 NodeSource）
# 用法: chmod +x scripts/install-node21-ubuntu.sh && sudo ./scripts/install-node21-ubuntu.sh

set -e

echo "安装 Node.js 21 ..."

apt update
apt install -y curl

# 注意：sudo 要加在 bash 前，不能加在 curl 前，否则脚本内部 apt 无权限
curl -fsSL https://deb.nodesource.com/setup_21.x | sudo bash -
apt install -y nodejs

echo "完成。"
node -v
npm -v
