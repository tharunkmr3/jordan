# Multi-stage build for the LiveKit Agents voice worker.
#
# Using node:22-slim (Debian, glibc) instead of alpine because the
# LiveKit rtc-node native bindings ship as platform-specific
# optionalDependencies. npm's optional-deps bug (npm/cli#4828) combined
# with a lockfile generated on a different platform (darwin-arm64) was
# missing the linux binding at runtime on alpine. The glibc binding is
# better-supported upstream and the slim image is still compact (~75MB
# vs alpine's 40MB — acceptable for a long-lived worker service).

FROM node:22-slim AS build

WORKDIR /app

# Install deps first for a better layer cache. `npm install` (not `ci`)
# resolves platform-specific optional deps from the package.json — the
# lockfile gets regenerated for the target platform, which avoids the
# darwin-vs-linux binding mismatch.
COPY package.json ./
ENV onnxruntime_node_install_cuda=skip
RUN npm install --no-audit --no-fund --include=optional

# Compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- Runtime ----
FROM node:22-slim AS runtime

WORKDIR /app

# Prod-only deps. Same install strategy as the build stage so the
# correct linux-x64-gnu native bindings land. curl is added so
# Coolify's default HTTP healthcheck can probe the process (we don't
# serve HTTP, but `curl --connect-timeout 1 http://127.0.0.1:<port>`
# just fails fast; disable the healthcheck in the Coolify UI for a
# cleaner signal — the worker's real healthcheck is whether it's
# registered with LiveKit).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# Skip CUDA binaries for onnxruntime-node — Silero VAD runs CPU-only;
# the CUDA tgz download from GitHub has been flaky and pulls ~500MB
# of binaries we'd never use.
ENV onnxruntime_node_install_cuda=skip
RUN npm install --omit=dev --no-audit --no-fund --include=optional

COPY --from=build /app/dist ./dist

# `start` runs the worker pool; the CLI in src/index.ts expects this
# subcommand. Coolify can override CMD if needed.
CMD ["node", "dist/index.js", "start"]
