#!/bin/sh
# HOME lives inside the data volume so the claude, gemini, and codex CLIs keep
# their state and credentials there (./data/home on the host) regardless of
# which uid the container runs as (compose sets PUID/PGID).
set -e
mkdir -p "${HOME:-/app/data/home}"
exec node /app/dist/cli/index.js "$@"
