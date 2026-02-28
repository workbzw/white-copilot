#!/bin/bash
# Ubuntu 安装 Node.js 20（本脚本会先自动安装 nvm，再通过 nvm 安装 Node 20，无需预先安装 nvm）
# 用法: chmod +x scripts/install-node20-ubuntu.sh && ./scripts/install-node20-ubuntu.sh
# 需要先有 curl：sudo apt update && sudo apt install -y curl

set -e

# 若用 sudo 运行，则安装到实际用户目录
RUN_AS=""
if [ -n "${SUDO_USER}" ] && [ "${SUDO_USER}" != "root" ]; then
  RUN_AS="su - ${SUDO_USER} -c"
else
  RUN_AS="bash -c"
fi

echo "安装 Node.js 20（使用 nvm）..."

# 国内镜像，避免连接 nodejs.org / deb.nodesource.com 超时或失败
export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://npmmirror.com/mirrors/node}"

install_nvm() {
  if [ -n "${SUDO_USER}" ] && [ "${SUDO_USER}" != "root" ]; then
    # 以实际用户身份安装 nvm 和 Node，避免装到 root 目录
    su - "${SUDO_USER}" -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash -s -- --no-use'
    su - "${SUDO_USER}" -c "export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\" && export NVM_NODEJS_ORG_MIRROR=${NVM_NODEJS_ORG_MIRROR} && nvm install 20 && nvm alias default 20"
  else
    export NVM_DIR="${HOME}/.nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash -s -- --no-use
    . "${NVM_DIR}/nvm.sh"
    nvm install 20
    nvm alias default 20
  fi
}

if ! command -v curl &>/dev/null; then
  echo "请先安装 curl： sudo apt update && sudo apt install -y curl"
  exit 1
fi

install_nvm

echo "完成。请重新打开终端或执行以下命令后再用 node/npm："
if [ -n "${SUDO_USER}" ] && [ "${SUDO_USER}" != "root" ]; then
  echo "  source /home/${SUDO_USER}/.nvm/nvm.sh && nvm use 20"
else
  echo "  source \"\$HOME/.nvm/nvm.sh\" && nvm use 20"
fi
echo "然后验证: node -v   # 应为 v20.x.x"
