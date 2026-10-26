# Container image for tracker.mjs (UNTESTED unless noted in the research file). Build context = ../tracker
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000 METRICS_PORT=9464
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tracker.mjs package.json ./
USER node
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--max-old-space-size=1024", "tracker.mjs"]
