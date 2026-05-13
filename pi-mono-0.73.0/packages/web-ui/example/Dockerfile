FROM node:22-bookworm-slim

WORKDIR /app

ENV HUSKY=0

COPY . .

RUN npm ci
RUN npm run build --workspace=@mariozechner/pi-ai
RUN npm run build --workspace=@mariozechner/pi-agent-core
RUN npm run build --workspace=@mariozechner/pi-web-ui
RUN npm run build --workspace=pi-web-ui-example

ENV NODE_ENV=production

RUN mkdir -p /app/packages/web-ui/example/data/sessions \
  /app/packages/web-ui/example/data/projects

WORKDIR /app/packages/web-ui/example

EXPOSE 5173

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173"]
