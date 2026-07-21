# Multi-stage build for the Next.js 15 vantage web app.
# Output: a slim runner image using Next's `output: 'standalone'` bundle.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Manifests stage: copy ONLY package.json + lockfile + workspace yaml so the
# install layer caches as long as deps don't change.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json        apps/web/package.json
COPY apps/worker/package.json     apps/worker/package.json
COPY packages/core/package.json   packages/core/package.json
COPY packages/db/package.json     packages/db/package.json
COPY packages/llm/package.json    packages/llm/package.json
COPY packages/notify/package.json packages/notify/package.json
COPY packages/sources/package.json packages/sources/package.json

FROM manifests AS deps
# `prepare` scripts (prisma generate postinstall) need the schema present —
# defer to the build stage by skipping them here.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --filter "@vantage/web..." \
      --filter "@vantage/db..."

FROM deps AS build
COPY . .
# Workspace packages publish pre-built dist/ via package.json exports.
# Build them in dependency order before next build, because next.config.ts
# lists them as serverExternalPackages and resolves them from /dist.
RUN pnpm --filter @vantage/db exec prisma generate
RUN pnpm --filter @vantage/db build
RUN pnpm --filter @vantage/notify build
RUN pnpm --filter @vantage/llm build
RUN pnpm --filter @vantage/sources build
RUN pnpm --filter @vantage/core build
RUN pnpm --filter @vantage/web exec next build

# Runtime: the workspace bundle lives under /repo so workspace symlinks
# resolve correctly. Run `node apps/web/server.js` from there.
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone bundle copies server.js + a curated node_modules to
# apps/web/.next/standalone, but with a monorepo it nests the structure
# under the original workspace layout (i.e. /repo/apps/web/server.js).
# Copy the standalone tree to /repo so workspace package symlinks still
# resolve and the server entry point is at apps/web/server.js.
COPY --chown=node:node --from=build /repo/apps/web/.next/standalone /repo
COPY --chown=node:node --from=build /repo/apps/web/.next/static     /repo/apps/web/.next/static
COPY --chown=node:node --from=build /repo/apps/web/public           /repo/apps/web/public

EXPOSE 3000
USER node
CMD ["node", "apps/web/server.js"]
