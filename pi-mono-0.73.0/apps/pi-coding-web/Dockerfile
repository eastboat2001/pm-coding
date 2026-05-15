FROM node:22-bookworm-slim

WORKDIR /app

ENV HUSKY=0

COPY . .

RUN npm ci
RUN npm run build --workspace=@mariozechner/pi-ai
RUN npm run build --workspace=@mariozechner/pi-agent-core
RUN npm run build --workspace=@mariozechner/pi-web-workspace
RUN npm run build --workspace=@mariozechner/pi-web-ui
RUN npm run build --workspace=pi-coding-web

ENV NODE_ENV=production

RUN mkdir -p /app/apps/pi-coding-web/data/sessions \
  /app/apps/pi-coding-web/data/projects

WORKDIR /app/apps/pi-coding-web

EXPOSE 5173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
