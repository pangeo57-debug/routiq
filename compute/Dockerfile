# Build from the repository root:  docker build -f compute/Dockerfile -t routepal-compute .
FROM node:20-slim
WORKDIR /app
COPY routiq.html /app/routiq.html
COPY compute/package.json /app/compute/package.json
RUN cd /app/compute && npm install --omit=dev
COPY compute/*.js /app/compute/
ENV PORT=8790
EXPOSE 8790
USER node
CMD ["node", "/app/compute/server.js"]
