FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
COPY tsconfig.base.json ./
COPY packages/backend/tsconfig.json packages/backend/

RUN npm ci --workspace=@btq-swap/backend --include-workspace-root

COPY packages/backend/src packages/backend/src
RUN npm run build -w packages/backend

FROM node:20-alpine
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json ./
COPY packages/backend/package.json packages/backend/
RUN npm ci --workspace=@btq-swap/backend --include-workspace-root --omit=dev

COPY --from=builder /app/packages/backend/dist packages/backend/dist
COPY packages/backend/migrations packages/backend/migrations
COPY packages/backend/scripts packages/backend/scripts
COPY packages/backend/docker-entrypoint.sh packages/backend/docker-entrypoint.sh

WORKDIR /app/packages/backend
RUN chmod +x docker-entrypoint.sh

USER appuser
EXPOSE 3001
ENV NODE_ENV=production

ENTRYPOINT ["./docker-entrypoint.sh"]
