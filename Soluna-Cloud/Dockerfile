FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV SOLUNA_WEB_HOST=0.0.0.0 \
    SOLUNA_HOME=/var/soluna
EXPOSE 10000
CMD ["node", "bin/soluna-web.js"]
