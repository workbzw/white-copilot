#!/bin/bash
# Ubuntu 安装 Node.js 20（不依赖 nvm，直接下载官方二进制包解压到 /usr/local）
# 适合：无法访问 raw.githubusercontent.com 装 nvm 时使用。
# 用法: chmod +x scripts/install-node20-ubuntu-standalone.sh && sudo ./scripts/install-node20-ubuntu-standalone.sh

set -e

NODE_VERSION="20.18.0"
MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"
# 例如 https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-linux-x64.tar.xz
TARBALL_URL="${MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
INSTALL_DIR="/usr/local"

echo "安装 Node.js ${NODE_VERSION}（独立安装，无需 nvm）..."
echo "下载: ${TARBALL_URL}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行此脚本。"
  exit 1
fi

if ! command -v curl &>/dev/null; then
  apt update && apt install -y curl
fi

TMP=$(mktemp -d)
cd "$TMP"
curl -fsSL -o node.tar.xz "$TARBALL_URL"
echo "解压到 ${INSTALL_DIR} ..."
tar -xJf node.tar.xz
rm -rf "${INSTALL_DIR}/node-v${NODE_VERSION}-linux-x64" 2>/dev/null || true
mv "node-v${NODE_VERSION}-linux-x64" "${INSTALL_DIR}/"
cd /
rm -rf "$TMP"

# 替换旧 node/npm/npx 链接
rm -f "${INSTALL_DIR}/bin/node" "${INSTALL_DIR}/bin/npm" "${INSTALL_DIR}/bin/npx" 2>/dev/null || true
ln -sf "${INSTALL_DIR}/node-v${NODE_VERSION}-linux-x64/bin/node" "${INSTALL_DIR}/bin/node"
ln -sf "${INSTALL_DIR}/node-v${NODE_VERSION}-linux-x64/bin/npm" "${INSTALL_DIR}/bin/npm"
ln -sf "${INSTALL_DIR}/node-v${NODE_VERSION}-linux-x64/bin/npx" "${INSTALL_DIR}/bin/npx"

echo "完成。"
echo "验证: node -v   # 应为 v${NODE_VERSION}"
echo "      npm -v"
/usr/local/bin/node -v
/usr/local/bin/npm -v
