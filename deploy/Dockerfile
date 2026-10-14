# Build context is the repository root:  docker build -f deploy/Dockerfile -t hlcc:local .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build -w @hlcc/web

FROM node:24-alpine
ENV NODE_ENV=production \
    HLCC_HOST=0.0.0.0 \
    HLCC_PORT=8787 \
    HLCC_DATA_DIR=/data \
    HLCC_WEB_DIST=/repo/apps/web/dist
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# API runtime dependencies only; the web build output is copied below.
RUN npm ci --omit=dev --workspace @hlcc/api --workspace @hlcc/shared --include-workspace-root=false \
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
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /repo/apps/api
CMD ["node", "src/index.ts"]
