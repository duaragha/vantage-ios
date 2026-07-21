# CPU-only bge-small service. The model is downloaded once at image-build time
# and the unused ONNX GPU/foreign-platform binaries are removed from runtime.

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
COPY apps/embedder/package.json apps/embedder/package.json
COPY packages/db/package.json  packages/db/package.json
COPY packages/embed/package.json packages/embed/package.json

FROM manifests AS deps
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@vantage/embedder..."

FROM deps AS build
COPY . .
RUN pnpm --filter @vantage/db exec prisma generate
RUN pnpm --filter @vantage/db build \
    && pnpm --filter @vantage/embed build \
    && pnpm --filter @vantage/embedder build
RUN pnpm --filter @vantage/embedder deploy --legacy --prod /app
RUN cd /app/node_modules/@vantage/db \
    && /app/node_modules/.pnpm/node_modules/.bin/prisma generate \
      --schema prisma/schema.prisma

# Cache the model in the immutable image so a sleeping service does not pay a
# network download on every cold start.
ENV TRANSFORMERS_CACHE_DIR=/opt/vantage-models
ENV HF_HUB_DISABLE_TELEMETRY=1
ENV HF_HUB_DISABLE_PROGRESS_BARS=1
RUN cd /app \
    && node --input-type=module -e "import { embed } from '@vantage/embed'; await embed('vantage model warmup')"

# onnxruntime-node ships CUDA, TensorRT, Windows, macOS and arm64 binaries in
# the npm tarball. Railway runs this image on Linux x64 CPU, so retain only the
# x64 CPU runtime and shared provider library.
RUN find /app/node_modules -type d \
      \( -path '*/onnxruntime-node/bin/napi-v6/darwin' \
      -o -path '*/onnxruntime-node/bin/napi-v6/win32' \
      -o -path '*/onnxruntime-node/bin/napi-v6/linux/arm64' \) \
      -prune -exec rm -rf '{}' + \
    && find /app/node_modules -type f \
      \( -name 'libonnxruntime_providers_cuda.so' \
      -o -name 'libonnxruntime_providers_tensorrt.so' \) \
      -delete

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002
ENV EMBEDDER_HOST=0.0.0.0
ENV TRANSFORMERS_CACHE_DIR=/opt/vantage-models
ENV HF_HUB_DISABLE_TELEMETRY=1
ENV HF_HUB_DISABLE_PROGRESS_BARS=1
COPY --chown=node:node --from=build /app /app
COPY --chown=node:node --from=build /opt/vantage-models /opt/vantage-models

EXPOSE 3002
USER node
CMD ["node", "dist/index.js"]
