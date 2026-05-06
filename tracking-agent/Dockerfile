# syntax=docker/dockerfile:1

# Use the official Node.js v22 base image
# We use the slim variant to keep the image size smaller while still having essential tools
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

# Configure pnpm installation directory and ensure it is on PATH
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Install required system packages and pnpm, then clean up the apt cache for a smaller image
# ca-certificates: enables TLS/SSL for securely fetching dependencies and calling HTTPS services
# --no-install-recommends keeps the image minimal
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Pin pnpm version for reproducible builds
RUN npm install -g pnpm@10

# --- Build stage ---
# Install dependencies, build the project, and prepare production assets
FROM base AS build

# Create a new directory for our application code
# And set it as the working directory
WORKDIR /app

# Copy just the dependency files first, for more efficient layer caching
COPY package.json pnpm-lock.yaml ./

# Install dependencies using pnpm
# --frozen-lockfile ensures we use exact versions from pnpm-lock.yaml for reproducible builds
RUN pnpm install --frozen-lockfile

# Copy all remaining application files into the container
# This includes source code, configuration files, and dependency specifications
# (Excludes files specified in .dockerignore)
COPY . .

# Build the project
# Your package.json must contain a "build" script, such as `"build": "tsc"`
RUN pnpm build

# Ensure the cache directory exists before downloading
RUN mkdir -p /app/.cache

# Pre-download any ML models or files the agent needs.
# Run BEFORE pruning so vite and other dev deps are still available
# (download-files runs `pnpm build` internally). NODE_OPTIONS forces IPv4
# DNS resolution, which avoids HuggingFace download stalls on hosts where
# IPv6 resolves but doesn't route.
RUN NODE_OPTIONS="--dns-result-order=ipv4first" \
    HF_HOME=/app/.cache \
    LIVEKIT_CACHE_DIR=/app/.cache \
    pnpm download-files

# The HuggingFace Hub library ignores HF_HOME during download and always
# writes to /root/.cache. Copy the downloaded files into /app/.cache so
# they're included in the final COPY --from=build /app /app step and
# available to appuser at runtime. Without this copy, model files are
# silently dropped from the production image and the agent fails to boot
# with "File not found in cache: livekit/turn-detector/onnx/model_q8.onnx".
RUN cp -r /root/.cache/huggingface /app/.cache/huggingface

# Remove dev dependencies for a leaner production image.
# Run AFTER downloading — pnpm prune only touches node_modules so /app/.cache
# is never affected.
RUN pnpm prune --prod

# --- Production stage ---
FROM base

# Create a non-privileged user that the app will run under
# See https://docs.docker.com/build/building/best-practices/#user
ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

# Re-declare cache paths for runtime so the agent's Hugging Face / LiveKit
# loaders find the model files we copied into /app/.cache during the build
# stage. Without these, the runtime defaults to /root/.cache (which appuser
# can't read) and bootstrapping the turn detector fails.
ENV HF_HOME=/app/.cache
ENV LIVEKIT_CACHE_DIR=/app/.cache

# Copy the built application with correct ownership in a single layer
# This avoids expensive recursive chown operations on node_modules
COPY --from=build --chown=appuser:appuser /app /app

USER appuser

# Set Node.js to production mode
ENV NODE_ENV=production

# Run the application
# The "start" command tells the worker to connect to LiveKit and begin waiting for jobs.
# Your package.json must contain a "start" script, such as `"start": "node dist/agent.js start"`
CMD [ "pnpm", "start" ]