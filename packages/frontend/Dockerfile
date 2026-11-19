# Monitor + operator console (static) and the btq-htlc single-file download, served by nginx.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/htlc/package.json packages/htlc/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci --workspace=@btq-swap/htlc --workspace=@btq-swap/frontend --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/htlc packages/htlc
COPY packages/frontend packages/frontend
RUN node packages/htlc/scripts/bundle.mjs && npm run build -w packages/frontend

FROM nginx:1.27-alpine
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY --from=build /app/packages/htlc/dist/btq-htlc.mjs /usr/share/nginx/html/downloads/btq-htlc.mjs
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
