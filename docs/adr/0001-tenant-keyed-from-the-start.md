# ADR 0001: Tenant-keyed from the start

**Date:** 2026-09-03
**Status:** accepted

## Context

The project began as a single-user WhatsApp digest agent for the owner. The
long-term direction is a hosted service where each customer links their own
WhatsApp account and we summarize the groups they already belong to. Phases 1
and 2 shipped before that direction was written down: auth state lives in
`data/auth/` and the `groups` and `messages` tables have no tenant column.

## Decision

Treat the owner as tenant `owner` and make `tenant_id` a first-class key now:

- every table carries `tenant_id` from its first migration;
- auth state moves to `data/tenants/<tenant_id>/auth/`;
- every log line and queue item carries `tenant_id`;
- send limits apply per tenant;
- session lifecycle is an explicit per-tenant state.

The single-user path runs the same code with one tenant, so this is not
scaffolding that only a future service would use.

Phases 1–2 are retrofitted at the start of phase 3, before the `summaries` and
`runs` tables exist, when the schema is cheapest to change.

## Consequences

- `config.yaml` remains the owner's source of truth; tenant settings later
  live in the store with the same zod-defined shape.
- CLI adapters (`cli-claude` etc.) are owner-only; other tenants use `api-*`.
- SQLite stays. A later Postgres move is a driver swap because the schema is
  already tenant-partitioned.
- Billing, onboarding UI, and admin dashboard stay out of scope until the
  single-user agent has run reliably for a month.
