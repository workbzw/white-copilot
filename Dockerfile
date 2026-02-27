# 构建: docker build -t writing-copilot .
# 运行（内部大模型）:
#   docker run -p 3000:3000 \
#     -e LLM_BASE_URL=https://your-llm-api/v1 \
#     -e LLM_MODEL=your-model-name \
#     -e LLM_API_KEY=your-api-key \
#     -v $(pwd)/data:/app/data \
#     writing-copilot
# 不设 LLM_* 时使用硅基流动默认地址，需 SILICONFLOW_API_KEY。
# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci 2>/dev/null || npm install

COPY . .
RUN npm run build

# 运行阶段（仅保留 standalone 输出，镜像更小）
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 从构建阶段复制 standalone 产物
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 用户文档存储目录（需挂载卷持久化）
RUN mkdir -p data/users && chown -R nextjs:nodejs data

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
