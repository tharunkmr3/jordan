# Multi-stage build for the LiveKit Agents voice worker.
# Target runtime: Node.js 22 LTS (same major as the Next app).
# The worker is a long-running process — Coolify runs it as a
# service without HTTP exposure. All communication is outbound
# WebSocket to LiveKit + Sarvam + Supabase.

FROM node:22-alpine AS build

WORKDIR /app

# Install deps first for a better layer cache.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- Runtime ----
FROM node:22-alpine AS runtime

WORKDIR /app

# Prod-only deps keep the image small. The Silero VAD plugin ships
# a small ONNX model, so we don't strip dev dependencies that the
# plugins bundle themselves.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# `start` runs the worker pool; the CLI in src/index.ts expects this
# subcommand. Coolify can override CMD if needed.
CMD ["node", "dist/index.js", "start"]
