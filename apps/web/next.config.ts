import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Required for the docker multi-stage build — emits a self-contained
  // .next/standalone bundle (server.js + curated node_modules) that the
  // runtime image copies directly. Without this the runner can't resolve
  // workspace deps because the monorepo node_modules isn't shipped.
  output: 'standalone',
  // Workspace packages (db/llm/notify/core/sources) publish pre-built
  // ESM from ./dist via package.json exports. Next.js resolves the pre-built
  // .js directly — no transpilePackages needed (the Flight Action loader
  // can't resolve '.js' imports from workspace TS src; see memory [35]).
  // Local embedding inference is isolated behind the private embedder service;
  // the web image never installs ONNX or model weights.
  serverExternalPackages: [
    '@vantage/core',
    '@vantage/sources',
    '@vantage/llm',
    'sharp',
    'yahoo-finance2',
    'ws',
  ],
  typedRoutes: true,
  turbopack: {
    // Pin to the monorepo root so stray package-lock.json files in $HOME don't confuse Next.
    root: path.resolve(__dirname, '../..'),
  },
};

export default nextConfig;
