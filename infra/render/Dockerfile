FROM node:22-alpine AS api-build
WORKDIR /workspace/services/api
RUN corepack enable
COPY services/api/package.json services/api/pnpm-lock.yaml services/api/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY services/api/tsconfig.json ./
COPY services/api/src ./src
COPY services/api/tests ./tests
COPY services/api/migrations ./migrations
RUN pnpm run build

FROM node:22-alpine AS api-production-dependencies
WORKDIR /workspace/services/api
RUN corepack enable
COPY services/api/package.json services/api/pnpm-lock.yaml services/api/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS web-build
WORKDIR /workspace/apps/web
RUN corepack enable
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web/ ./
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
RUN pnpm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=10000 MURAL_API_HOST=0.0.0.0 MURAL_WEB_ROOT=/app/web
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY --from=api-production-dependencies --chown=node:node /workspace/services/api/node_modules ./services/api/node_modules
COPY --from=api-build --chown=node:node /workspace/services/api/package.json ./services/api/package.json
COPY --from=api-build --chown=node:node /workspace/services/api/dist ./services/api/dist
COPY --from=api-build --chown=node:node /workspace/services/api/migrations ./services/api/migrations
COPY --from=web-build --chown=node:node /workspace/apps/web/dist ./web
COPY --chown=node:node docs/web-app.md ./web/docs/web-app.md
COPY --chown=node:node infra/render/container-entrypoint.mjs ./infra/render/container-entrypoint.mjs
USER node
EXPOSE 10000
ENTRYPOINT ["node", "/app/infra/render/container-entrypoint.mjs"]
