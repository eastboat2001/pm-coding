FROM node:22-bookworm-slim

WORKDIR /app

ENV HUSKY=0
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_REPLACE_REGISTRY_HOST=npmjs
ARG NPM_FETCH_TIMEOUT=600000
ARG NPM_FETCH_RETRIES=5

COPY . .

RUN npm ci \
    --registry="${NPM_REGISTRY}" \
    --replace-registry-host="${NPM_REPLACE_REGISTRY_HOST}" \
    --fetch-timeout="${NPM_FETCH_TIMEOUT}" \
    --fetch-retries="${NPM_FETCH_RETRIES}" \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    --no-audit \
    --fund=false
RUN npm run build --workspace=@mariozechner/pi-ai
RUN npm run build --workspace=@mariozechner/pi-agent-core
RUN npm run build --workspace=@mariozechner/pi-web-workspace
RUN npm run build --workspace=@mariozechner/pi-web-ui
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace=pi-coding-web
RUN npm run build:worker --workspace=pi-coding-web

ENV NODE_ENV=production

RUN mkdir -p /app/apps/pi-coding-web/data/sessions \
  /app/apps/pi-coding-web/data/projects \
  /app/apps/pi-coding-web/data/logs \
  /app/apps/pi-coding-web/data/skills \
  /app/apps/pi-coding-web/data/default-skills

WORKDIR /app/apps/pi-coding-web

EXPOSE 5173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
