# ADR 0021: Deployment identity routing and Framework mount

## Status

Proposed

## Context

ADR 0019 added `LineAccessTokenAuthenticator` and ADR 0020 added the Framework HTTP API, but the
deployment composition (`createCareOpsDeployment` → `SupabaseCareOpsRuntime`) still verified bearer
tokens with Supabase Auth only and served only `/api/care-ops/`. The LINE field app (mimamori-kun
`/framework`) therefore could not reach either feature in a deployed runtime.

Both LINE and Supabase tokens arrive as `Authorization: Bearer`. LINE v2.1 access tokens can be
JWT-shaped, so the token format alone cannot tell them apart. Trying one provider and falling back to
the other would send a Supabase session token to LINE (a third party), which is not acceptable.

## Decision

1. **Opt-in settings.** `CARE_OPS_LINE_CHANNEL_ID` (numeric) enables LINE identity;
   `CARE_OPS_FRAMEWORK_ENABLED=true` mounts the Framework API. Both are unset/false by default, and a
   deployment without them behaves exactly as before.
2. **One provider per token, chosen by claimed issuer.** `IssuerRoutingAuthenticator` reads the
   *unverified* `iss` claim only to choose the provider: a JWT claiming this project's Supabase Auth
   issuer (`<SUPABASE_URL origin>/auth/v1`) goes to Supabase Auth; every other token goes to LINE.
   The chosen provider fully verifies the token. There is no fallback to the other provider after a
   failure, so Supabase tokens never reach LINE. Principal IDs stay namespaced (`line:<userId>`).
3. **Framework mount.** Requests under `/api/framework/` go to `FrameworkHttpApi` (with the P2 record
   routes) built on the same authenticator, membership directory and `CaseService` as the Case API,
   with `PostgrestFrameworkStore`. Everything else keeps going to `CareOpsHttpApi`. The operational
   wrapper (admission, origin policy, health/readiness, logs, metrics) is unchanged and applies to both.
4. **Config doctor** reports only whether each feature is enabled, never the channel ID.

## Consequences

- Enabling the Framework requires `db/framework_store.sql` and `db/framework_records.sql` to be applied
  first (backup + staging); before that, the routes answer `503 FRAMEWORK_UNAVAILABLE`.
- Enabling LINE requires `line:<userId>` memberships to be provisioned (ADR 0019).
- A custom Supabase Auth domain whose issuer differs from the project URL would route Supabase tokens to
  LINE (and fail closed). Supporting that needs an explicit issuer setting.
- Browser CORS is still limited to `/api/care-ops/` (ADR 0018); the LINE field app reaches the
  Framework through its own server-side relay, which sends no `Origin`.

## Invariants

Unchanged: no ownership gap during handoff, no status-only completion, no caller-controlled audit
actor, no stale overwrite, no cross-tenant addressing by Case ID alone, replayable state.
