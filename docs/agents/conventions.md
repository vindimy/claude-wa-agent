# Coding conventions and workflow

## Code

- Strict TS. `any` only at adapter boundaries with third-party payloads.
- Every module exposes a small typed interface; cross-module imports go
  through that module's `index.ts` only.
- Errors are typed (`Result` in `src/shared/result.ts` or tagged errors),
  never thrown strings.
- Log with pino, structured, one logger per module; see `operations.md` for
  what may be logged.
- CLI adapters (`cli-*`) are owner-only: they must never run for a tenant
  other than `owner`. Every other tenant uses `api-*` adapters (ADR-0003).

## Workflow

- `pnpm dev` runs with hot reload against a real linked session (pair once
  via QR in the terminal). Never leave it running alongside pm2 or the
  container: it is a second linked instance.
- `pnpm test` is vitest. Summarizer adapters are tested against fixture
  transcripts with the `fake` adapter; real CLI/API calls are behind
  `INTEGRATION=1`. Tests need no network and no paired device.
- `pnpm digest summarize <group> --since 2d --dry-run` prints a summary
  without delivering. Prefer dry runs to live sends.
- `pnpm typecheck` and `pnpm lint` must pass before commit.
- Changing an architecture decision means adding or amending a file in
  `docs/adr/` in the same change.
- Adding to the roadmap: the list lives in `README.md` under "Roadmap".
  Shelved designs live in `docs/superpowers/specs/`.
