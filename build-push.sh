#!/bin/bash
# 本地构建 write-copilot 镜像并推送到腾讯云 CCR
# 用法: 先 docker login ccr.ccs.tencentyun.com，再 chmod +x build-push.sh && ./build-push.sh

set -e

REGISTRY="ccr.ccs.tencentyun.com/workbzw"
IMAGE="write-copilot"
TAG="${1:-030103}"

FULL_IMAGE="${REGISTRY}/${IMAGE}:${TAG}"

echo "构建镜像: ${FULL_IMAGE} (linux/amd64，避免在 x86 服务器上 exec format error)"
docker build --platform linux/amd64 -t "$FULL_IMAGE" .

echo "推送镜像: ${FULL_IMAGE}"
docker push "$FULL_IMAGE"

echo "完成。部署时使用: docker pull ${FULL_IMAGE}"
echo "若 deploy.sh 使用其他 tag，请先修改 deploy.sh 中的镜像 tag，或运行: ./build-push.sh <你的tag>"
