# Service direction: multi-tenant, BYO account

Read this when a change touches tenancy, auth state, session lifecycle, send
limits, or data handling, so the single-user path keeps growing toward the
service without a rewrite.

## Goal

A hosted service where each customer links **their own** WhatsApp account
to our backend (QR / pairing code) and we summarize the groups they already
belong to. We never operate bot numbers and never read a group a tenant is
not a member of.

## Why this direction

- Meta's official Groups API only covers groups the business itself creates
  (invite-link, OBA-only). It cannot join existing groups, so it does not fit
  "summarize the chats you already have."
- Dedicated bot numbers put ban risk on *our* numbers and scale with SIM
  cards.
- BYO account keeps the account risk with the tenant. This is an unofficial
  client path and a WhatsApp ToS gray zone; the product must say so plainly
  during onboarding, and the architecture must make a per-tenant logout
  harmless.

## Consequences that apply now

- **Tenant is a first-class key.** Every table, log line, and queue item
  carries `tenant_id`. Auth state lives in `data/tenants/<tenant_id>/auth/`,
  one supervised Baileys socket per tenant.
- **Session lifecycle is a product feature, not an error path.** Pairing,
  reconnect, logout (401) are explicit states; a logged-out tenant pauses
  cleanly and nothing else is affected. A `phone_offline` state is planned
  but not yet implemented.
- **Send discipline is per tenant** (jitter, daily cap, no bursts).
- **Summarizer adapters are API-key based (`api-*`) for tenants.** The CLI
  adapters ride the owner's personal subscription logins and are owner-only
  (ADR-0003).
- **Group posting stays opt-in per group** and signed as an automated digest.
- **Deployment**: the Docker profile is the service profile. Stateless app
  container(s) plus a persistent volume per tenant now; object storage for
  auth/state once we pass a handful of tenants.

## Deferred until the single-user agent has run reliably for a month

- Billing, web onboarding UI, admin dashboard.
- Encryption of auth state and message bodies at rest (ADR-0003 says why it
  can wait); revisit before the first non-owner tenant.
- Tenant-configurable retention, one-click export and delete, GDPR-grade
  consent, privacy policy, and a DPA before any paid tier.

Build no multi-tenant scaffolding the single-user path does not also use:
same code, tenant count of one.
