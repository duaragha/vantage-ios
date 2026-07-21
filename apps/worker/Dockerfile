# Slim multi-stage image for the always-on Fastify + Croner worker.
# Local embedding inference lives in apps/embedder, so this image deliberately
# excludes @huggingface/transformers and onnxruntime-node.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/corepack
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p "$COREPACK_HOME" \
    && corepack enable \
    && corepack prepare pnpm@10.32.1 --activate \
    && chmod -R a+rX "$COREPACK_HOME"
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json      apps/worker/package.json
COPY packages/core/package.json   packages/core/package.json
COPY packages/db/package.json     packages/db/package.json
COPY packages/llm/package.json    packages/llm/package.json
COPY packages/notify/package.json packages/notify/package.json
COPY packages/sources/package.json packages/sources/package.json

FROM manifests AS deps
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@vantage/worker..."

FROM deps AS build
COPY . .
RUN pnpm --filter @vantage/db exec prisma generate
RUN pnpm --filter @vantage/db build \
    && pnpm --filter @vantage/notify build \
    && pnpm --filter @vantage/llm build \
    && pnpm --filter @vantage/sources build \
    && pnpm --filter @vantage/core build \
    && pnpm --filter @vantage/worker build
RUN pnpm --filter @vantage/worker deploy --legacy --prod /app
RUN cd /app/node_modules/@vantage/db \
    && /app/node_modules/.pnpm/node_modules/.bin/prisma generate \
      --schema prisma/schema.prisma

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.description="Vantage background worker"
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV WORKER_PORT=3001
ENV WORKER_HOST=0.0.0.0
COPY --chown=node:node --from=build /app /app

EXPOSE 3001
USER node
CMD ["sh", "-c", "/app/node_modules/.pnpm/node_modules/.bin/prisma migrate deploy --schema /app/node_modules/@vantage/db/prisma/schema.prisma && exec node dist/index.js"]
