#!/bin/bash
# 在 Ubuntu 服务器上拉取并运行 white-copilot 镜像
# 用法: 先修改下面三个变量，再 chmod +x deploy.sh && ./deploy.sh

# ========== 按你的环境修改这里 ==========
export LLM_BASE_URL="http://10.96.91.228:1025/v1"
export LLM_MODEL="deepseek_32b"
export LLM_API_KEY="sk-sntgzyndiukafftszxatgcjfawdneobqkhravkgysxounyoh"
# ========================================

docker pull ccr.ccs.tencentyun.com/workbzw/white-copilot:0227
docker stop white-copilot 2>/dev/null; docker rm white-copilot 2>/dev/null
docker run -d -p 3090:3090 \
  -e LLM_BASE_URL="$LLM_BASE_URL" \
  -e LLM_MODEL="$LLM_MODEL" \
  -e LLM_API_KEY="$LLM_API_KEY" \
  -v "$(pwd)/data:/app/data" \
  --name white-copilot \
  ccr.ccs.tencentyun.com/workbzw/white-copilot:0227

echo "已启动 white-copilot，访问 http://$(hostname -I | awk '{print $1}'):3000"
