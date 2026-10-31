# 一般 Node 伺服器版的 retrace（functions/server.js），設定見 server.js 開頭；建置：docker build -t holdkit-retrace .
FROM node:22-slim
WORKDIR /app
COPY functions/package.json functions/package-lock.json functions/.npmrc ./
RUN npm ci --omit=dev
COPY functions/*.js ./
COPY models/mobilesam-encoder.onnx models/mobilesam-decoder.onnx ./models/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
