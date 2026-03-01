#!/bin/bash
# 在 Ubuntu 服务器上拉取并运行 write-copilot 镜像
# 用法: 先修改下面三个变量，再 chmod +x deploy.sh && ./deploy.sh

# ========== 按你的环境修改这里 ==========
export LLM_BASE_URL="https://api.siliconflow.cn/v1"
export LLM_MODEL="deepseek-ai/DeepSeek-V3.2"
export LLM_API_KEY="sk-mgubibjtdksrcejvbzowwijegdmteujktpdkerysxmvkpdhq"
# export LLM_BASE_URL="http://10.96.91.228:1025/v1"
# export LLM_MODEL="deepseek_32b"
# export LLM_API_KEY="sk-sntgzyndiukafftszxatgcjfawdneobqkhravkgysxounyoh"
# 知识库（可选）：仅在使用者于界面选择知识库时检索
export KNOWLEDGE_API_KEY="dataset-TXwZnSXne0jwEdjRoFTrJSK7"
export KNOWLEDGE_BASE_URL="http://192.168.93.128:11014/v1"
# ========================================

docker pull ccr.ccs.tencentyun.com/workbzw/write-copilot:0301
docker stop write-copilot 2>/dev/null; docker rm write-copilot 2>/dev/null
RUN_ARGS=(
  -d -p 3080:3080
  -e PORT=3080
  -e "LLM_BASE_URL=$LLM_BASE_URL"
  -e "LLM_MODEL=$LLM_MODEL"
  -e "LLM_API_KEY=$LLM_API_KEY"
  -v "$(pwd)/data:/app/data"
  --name write-copilot
  ccr.ccs.tencentyun.com/workbzw/write-copilot:0301
)
[ -n "$KNOWLEDGE_API_KEY" ] && RUN_ARGS+=( -e "KNOWLEDGE_API_KEY=$KNOWLEDGE_API_KEY" )
[ -n "$KNOWLEDGE_BASE_URL" ] && RUN_ARGS+=( -e "KNOWLEDGE_BASE_URL=$KNOWLEDGE_BASE_URL" )

docker run "${RUN_ARGS[@]}"

echo "已启动 write-copilot，访问 http://$(hostname -I | awk '{print $1}'):3080"
