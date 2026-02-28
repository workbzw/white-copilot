#!/bin/bash
# 在 Ubuntu 服务器上拉取并运行 write-copilot 镜像
# 用法: 先修改下面三个变量，再 chmod +x deploy.sh && ./deploy.sh

# ========== 按你的环境修改这里 ==========
export LLM_BASE_URL="https://api.siliconflow.cn/v1"
export LLM_MODEL="deepseek-ai/DeepSeek-V3.2"
export LLM_API_KEY="sk-kmohdwnilkdvxhrjvxflswurrkhksxohlsszfomvtaspuvxp"
# ========================================

docker pull ccr.ccs.tencentyun.com/workbzw/write-copilot:0227
docker stop write-copilot 2>/dev/null; docker rm write-copilot 2>/dev/null
docker run -d -p 3080:3080 \
  -e PORT=3080 \
  -e LLM_BASE_URL="$LLM_BASE_URL" \
  -e LLM_MODEL="$LLM_MODEL" \
  -e LLM_API_KEY="$LLM_API_KEY" \
  -v "$(pwd)/data:/app/data" \
  --name write-copilot \
  ccr.ccs.tencentyun.com/workbzw/write-copilot:0227

echo "已启动 write-copilot，访问 http://$(hostname -I | awk '{print $1}'):3080"
