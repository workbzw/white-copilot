#!/bin/sh
# 在 Ubuntu 服务器上拉取并运行 write-copilot 镜像
# 用法: 先修改下面变量，再 chmod +x deploy.sh && ./deploy.sh

# ========== 按你的环境修改这里 ==========
export LLM_BASE_URL="http://10.96.91.228:1025/v1"
export LLM_MODEL="deepseek_32b"
export LLM_API_KEY="sk-sntgzyndiukafftszxatgcjfawdneobqkhravkgysxounyoh"
# 知识库（可选）：与 agent-prd-nginx 同网络，用容器名访问
export KNOWLEDGE_API_KEY="dataset-TXwZnSXne0jwEdjRoFTrJSK7"
export KNOWLEDGE_BASE_URL="http://agent-prd-nginx/v1"
# ========================================

docker pull ccr.ccs.tencentyun.com/workbzw/write-copilot:030308
docker stop write-copilot 2>/dev/null; docker rm write-copilot 2>/dev/null

# 宿主机先创建 data/users（及 default 用户目录）并放宽权限，避免容器内 EACCES（应用需在此目录下写用户文档）
mkdir -p data/users/default
chmod -R 777 data

docker run -d -p 3080:3080 \
  --network agent-prd_default \
  -e PORT=3080 \
  -e "LLM_BASE_URL=$LLM_BASE_URL" \
  -e "LLM_MODEL=$LLM_MODEL" \
  -e "LLM_API_KEY=$LLM_API_KEY" \
  -e "KNOWLEDGE_API_KEY=$KNOWLEDGE_API_KEY" \
  -e "KNOWLEDGE_BASE_URL=$KNOWLEDGE_BASE_URL" \
  -v "$(pwd)/data:/app/data" \
  --name write-copilot \
  ccr.ccs.tencentyun.com/workbzw/write-copilot:030308

echo "已启动 write-copilot，访问 http://$(hostname -I | awk '{print $1}'):3080"
