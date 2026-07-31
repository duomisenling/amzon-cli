# amz-cli 审计接收端 + 看板(纯 Node,无第三方依赖,无构建步骤)
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
ENV PORT=8080 \
    AUDIT_DATA_DIR=/data
EXPOSE 8080
# 持久卷:审计数据存这里,重启不丢
VOLUME ["/data"]
CMD ["node", "server.mjs"]
