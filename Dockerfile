# syntax=docker/dockerfile:1.7
#
# WhatsApp group digest agent — Docker / service profile.
# Prebuilt images: ghcr.io/vindimy/claude-wa-agent (see .github/workflows/docker.yml)
# Local build: docker compose -f docker-compose.yml -f docker-compose.build.yml build
# Pair:        docker compose run --rm digest run     (scan the QR, then Ctrl-C)
# Run:         docker compose up -d
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
    LOG_LEVEL=info \
    HOME=/app/data/home
WORKDIR /app
# The owner's CLI adapter runs `claude -p` inside the container.
RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json docker-entrypoint.sh ./
# Unprivileged by default; compose overrides the uid/gid to match the host
# owner of the mounted directories (PUID/PGID in .env).
RUN mkdir -p /app/data /app/vault && chown -R node:node /app
USER node
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["run"]
