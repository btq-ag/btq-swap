FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/frontend/package.json packages/frontend/
COPY packages/backend/package.json packages/backend/
COPY packages/contracts/package.json packages/contracts/
COPY tsconfig.base.json ./
COPY packages/frontend packages/frontend

# Skip native module postinstall scripts (bufferutil/utf-8-validate) in Alpine
ENV npm_config_ignore_scripts=true
RUN npm ci --workspace=@btq-swap/frontend --include-workspace-root

# Same-origin API + WebSocket via nginx reverse proxy
ENV VITE_API_URL=/api
ENV VITE_WS_URL=

RUN npm run build -w packages/frontend

FROM nginx:alpine
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
