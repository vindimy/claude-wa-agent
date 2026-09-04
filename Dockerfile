# syntax=docker/dockerfile:1.7
#
# WhatsApp group digest agent — Docker / service profile.
# Build:  docker compose build
# Pair:   docker compose run --rm digest run     (scan the QR, then Ctrl-C)
# Run:    docker compose up -d
#
# Summarizer auth inside the container, pick one (see docs/deploy.md):
#   CLAUDE_CODE_OAUTH_TOKEN=...   from `claude setup-token` on any logged-in machine
#   SUMMARIZER=api-anthropic + ANTHROPIC_API_KEY=...   API-key fallback

ARG NODE_VERSION=22

# ---- build: compile TypeScript and produce a production node_modules -------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# better-sqlite3 ships prebuilt binaries; the toolchain is only a fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build \
 && pnpm prune --prod

# ---- runtime -------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    VAULT_DIR=/app/vault \
    CONFIG_PATH=/app/config.yaml \
    LOG_LEVEL=info
WORKDIR /app
# The owner's CLI adapter runs `claude -p` inside the container.
RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Run as the unprivileged `node` user; the volumes are chowned in compose.
RUN mkdir -p /app/data /app/vault && chown -R node:node /app
USER node
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["run"]
