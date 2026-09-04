#!/bin/sh
# HOME lives inside the data volume so the claude CLI can keep its own state
# there regardless of which uid the container runs as (compose sets PUID/PGID).
set -e
mkdir -p "${HOME:-/app/data/home}"
exec node /app/dist/cli/index.js "$@"
