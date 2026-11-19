# Backend image: API + workers, Discord bot, simulator, devnet tools (role chosen by the entrypoint argument).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/htlc/package.json packages/htlc/
COPY packages/backend/package.json packages/backend/
RUN npm ci --workspace=@btq-swap/htlc --workspace=@btq-swap/backend --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY packages/htlc packages/htlc
COPY packages/backend packages/backend
RUN npm run build -w packages/htlc && node packages/htlc/scripts/bundle.mjs && npm run build -w packages/backend

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/htlc/package.json packages/htlc/
COPY packages/backend/package.json packages/backend/
RUN npm ci --workspace=@btq-swap/htlc --workspace=@btq-swap/backend --include-workspace-root --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /app/packages/htlc/dist packages/htlc/dist
COPY --from=build /app/packages/backend/dist packages/backend/dist
COPY packages/backend/migrations packages/backend/migrations
COPY packages/backend/scripts packages/backend/scripts
COPY deploy/backend-entrypoint.sh /usr/local/bin/btq-swap
RUN chmod +x /usr/local/bin/btq-swap && mkdir -p /app/packages/backend/sim-reports && chown node:node /app/packages/backend/sim-reports
WORKDIR /app/packages/backend
USER node
EXPOSE 3001
ENTRYPOINT ["btq-swap"]
CMD ["api"]
