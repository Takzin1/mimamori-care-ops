# Vercel Preview deployment

This adapter is intentionally **Preview-only**.

If `VERCEL_ENV=production`, the Care Ops function returns a configuration error until production-grade request admission is explicitly introduced.

## Project

Create a separate Vercel project for this repository.

Recommended project name:

`mimamori-care-ops`

Do not reuse `mimamori-kun` or `mimamori-platform`.

## Git branch

Use:

`feat/assemblyai-voice-ops`

The Vercel Git integration will create a Preview Deployment for the branch.

## Preview environment variables

Set the following **Preview-only** server variables:

- `ASSEMBLYAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CARE_OPS_SLA_POLICIES_JSON`

Optional:

- `CARE_OPS_OUTBOUND_TIMEOUT_MS`
- `CARE_OPS_MAX_COMMAND_BODY_BYTES`

Do not prefix secrets with `NEXT_PUBLIC_` or otherwise expose them to the browser.

The adapter derives `CARE_OPS_CONSOLE_ORIGINS` from the Vercel deployment's own request origin, so each Preview URL remains same-origin without storing a branch-specific URL ahead of the first deployment.

## Routes

The root page serves the Voice Ops demo.

`/`

Care Ops requests are rewritten into one Vercel Function while preserving the original Care Ops path.

Examples:

- `/api/care-ops/tenants/:tenantId/voice/session`
- `/api/care-ops/tenants/:tenantId/voice/plan`
- `/api/care-ops/tenants/:tenantId/voice/communications/approve`

## First verification

After Preview is READY:

1. open the root page;
2. confirm Synthetic mode loads;
3. run `npm run voice:smoke` against the Preview URL;
4. use a synthetic Supabase user/token and synthetic tenant;
5. test microphone → AssemblyAI → final Turn;
6. confirm a real Care Ops Case is persisted;
7. confirm Human approval produces a durable Outbox message.

Do not use real resident or care data.

## Production

Do **not** promote this Preview to Production yet.

Production requires a real shared/edge request admission implementation and explicit production origin/provider configuration.
