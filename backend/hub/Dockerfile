# syntax=docker/dockerfile:1
# VOLTEX hub image (API + web app) (built for linux/arm64 in CI). Build context = repository root:
#   docker buildx build --platform linux/arm64 -f backend/hub/Dockerfile .

# Web app: plain static files, identical for every CPU, so build it natively (no arm64 emulation).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/contracts/package.json shared/contracts/
COPY frontend/web/package.json frontend/web/
RUN npm ci --workspace shared/contracts --workspace frontend/web
COPY shared/contracts shared/contracts
COPY frontend/web frontend/web
RUN npm run build -w shared/contracts && npm run build -w frontend/web

FROM node:24-bookworm-slim AS build
WORKDIR /src
# Toolchain only in case better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/contracts/package.json shared/contracts/
COPY backend/hub/package.json backend/hub/
RUN npm ci --workspace shared/contracts --workspace backend/hub
COPY shared/contracts shared/contracts
COPY backend/hub backend/hub
RUN npm run build -w shared/contracts && npm run build -w backend/hub \
 && npm prune --omit=dev --workspace shared/contracts --workspace backend/hub \
 && mkdir -p backend/hub/node_modules

FROM node:24-bookworm-slim
ARG VOLTAX_VERSION=dev
ENV NODE_ENV=production \
    VOLTAX_VERSION=${VOLTAX_VERSION} \
    UI_DIR=/app/public
# Fixed non-root uid/gid; host directories are chowned to 10001 by provision.sh.
RUN groupadd -g 10001 voltax && useradd -u 10001 -g voltax -M -d /nonexistent -s /usr/sbin/nologin voltax
WORKDIR /app/backend/hub
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/shared/contracts/package.json /app/shared/contracts/package.json
COPY --from=build /src/shared/contracts/dist /app/shared/contracts/dist
COPY --from=build /src/backend/hub/node_modules ./node_modules
COPY --from=build /src/backend/hub/package.json ./
COPY --from=build /src/backend/hub/dist ./dist
COPY --from=build /src/backend/hub/migrations ./migrations
COPY --from=web /src/frontend/web/out /app/public
USER 10001:10001
EXPOSE 8443
CMD ["node", "dist/main.js"]
