# syntax=docker/dockerfile:1

# Use the official Node.js v22 base image
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

# Configure pnpm installation directory and ensure it is on PATH
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Install required system packages and pnpm
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

# --- Build stage ---
FROM base AS build

WORKDIR /app

# Cache-bust: increment this to force a fresh build
ARG CACHE_BUST=4
RUN echo "Cache bust: $CACHE_BUST"

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Ensure the cache directory exists before downloading
RUN mkdir -p /app/.cache

# Download model files BEFORE pruning so that vite and other dev
# dependencies are still available (download-files runs pnpm build internally)
RUN NODE_OPTIONS="--dns-result-order=ipv4first" \
    HF_HOME=/app/.cache \
    LIVEKIT_CACHE_DIR=/app/.cache \
    pnpm download-files

# The HuggingFace library ignores HF_HOME and always writes to /root/.cache.
# Copy the downloaded files into /app/.cache so they are included in the
# final COPY --from=build step and available to appuser at runtime.
RUN cp -r /root/.cache/huggingface /app/.cache/huggingface

# Prune dev dependencies AFTER downloading — pnpm prune only removes
# packages inside node_modules so /app/.cache is never touched
RUN pnpm prune --prod

# --- Production stage ---
FROM base

ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

# Re-declare cache paths for runtime so the agent knows where to find model files
ENV HF_HOME=/app/.cache
ENV LIVEKIT_CACHE_DIR=/app/.cache
ENV NODE_ENV=production

# Copy the built application (including the .cache folder) with correct ownership
COPY --from=build --chown=appuser:appuser /app /app

USER appuser

# Run the application
CMD [ "pnpm", "start" ]
