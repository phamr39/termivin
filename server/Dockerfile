# termivin-relay — small, no native modules (SQLite comes from node:sqlite).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    RELAY_DATA_DIR=/data \
    RELAY_PORT=8787 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN ln -s /app/src/cli.js /usr/local/bin/termivin-relay && chmod +x /app/src/cli.js \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
