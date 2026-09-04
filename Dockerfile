# syntax=docker/dockerfile:1.7
#
# WhatsApp group digest agent — Docker / service profile.
# Prebuilt images: ghcr.io/vindimy/claude-wa-agent (see .github/workflows/docker.yml)
# Local build: docker compose -f docker-compose.yml -f docker-compose.build.yml build
# Pair:        docker compose run --rm digest run     (scan the QR, then Ctrl-C)
# Run:         docker compose up -d
#
# Summarizer auth inside the container, pick one (see docs/deploy.md):
#   cli-claude:  CLAUDE_CODE_OAUTH_TOKEN=...   from `claude setup-token` on any logged-in machine
#   cli-gemini:  ./data/home/.gemini/oauth_creds.json + GOOGLE_GENAI_USE_GCA=true
#   cli-codex:   ./data/home/.codex/auth.json  (`codex login --device-auth` in the container)
#   api-*:       SUMMARIZER=api-anthropic + ANTHROPIC_API_KEY=...   API-key fallback
#                (or SUMMARIZER=api-openai + OPENAI_API_KEY, SUMMARIZER=api-google + GOOGLE_API_KEY)

ARG NODE_VERSION=22

# ---- build: compile TypeScript and produce a production node_modules -------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# better-sqlite3 ships prebuilt binaries; the toolchain is only a fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
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
    LOG_DIR=/app/data/logs \
    HOME=/app/data/home
WORKDIR /app
# The owner's CLI adapters run `claude -p`, `gemini -p`, and `codex exec`
# inside the container. Their credentials live under $HOME, which is in the
# data volume (see docker-entrypoint.sh and docs/deploy.md).
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex \
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
