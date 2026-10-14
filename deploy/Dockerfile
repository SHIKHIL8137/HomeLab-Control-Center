# Build context is the repository root. Two images come out of this file:
#   docker build -f deploy/Dockerfile --target api   -t homelab-control-center:local .
#   docker build -f deploy/Dockerfile --target proxy -t homelab-control-center-docker-proxy:local .
#
# NODE_IMAGE is pinned by digest so a build today and a build next month use the same base.
# Pinning also means security updates arrive only when you bump it; see docs/deployment.md.
# Currently node:24-alpine = Node v24.21.0, resolved 2026-10-14.
ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/docker-proxy/package.json apps/docker-proxy/
COPY apps/web/package.json apps/web/
# Install scripts are not needed by any dependency here, so they are not run.
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps apps
RUN npm run build -w @hlcc/web

# The read-only Docker proxy: no dependencies, no build step, the only thing that touches the socket.
FROM ${NODE_IMAGE} AS proxy
ENV NODE_ENV=production PROXY_HOST=0.0.0.0 PROXY_PORT=2375 DOCKER_SOCKET=/var/run/docker.sock
WORKDIR /app
COPY apps/docker-proxy/package.json ./
COPY apps/docker-proxy/src ./src
USER node
EXPOSE 2375
# The credential comes from PROXY_TOKEN_FILE (a mounted secret); the check authenticates with it.
HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.ts"]
STOPSIGNAL SIGTERM
CMD ["node", "src/server.ts"]

# The dashboard API (also serves the built web app). It never sees the Docker socket.
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    HLCC_HOST=0.0.0.0 \
    HLCC_PORT=8787 \
    HLCC_DATA_DIR=/data \
    HLCC_WEB_DIST=/repo/apps/web/dist
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/docker-proxy/package.json apps/docker-proxy/
COPY apps/web/package.json apps/web/
# API runtime dependencies only; the web build output is copied below.
RUN npm ci --omit=dev --ignore-scripts --workspace @hlcc/api --workspace @hlcc/shared --include-workspace-root=false \
    && npm cache clean --force
COPY packages packages
COPY apps/api apps/api
COPY migrations migrations
COPY --from=build /repo/apps/web/dist apps/web/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
WORKDIR /repo/apps/api
CMD ["node", "src/index.ts"]
