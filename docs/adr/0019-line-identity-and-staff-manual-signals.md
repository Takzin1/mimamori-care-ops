# ADR 0019: LINE identity provider and staff manual-signal intake

## Status

Accepted

## Context

The upstream field app (見守りくん LINE MINI App) now lets facility staff follow
approved emergency procedures and hand the incident to Care Ops. Two gaps
blocked using the authenticated HTTP boundary (ADR 0009) from that app:

1. Staff authenticate with LINE Login (LIFF / LINE MINI App access tokens),
   while the only reference `PrincipalAuthenticator` was Supabase Auth.
2. Signals could only be opened server-side (`CaseService.openFromSignal`).
   There was no authenticated way for a staff member to report a signal such as
   "a resident fell on the night round".

The field app must not hold a service credential that could open or mutate
Cases on behalf of arbitrary staff, and it must not re-implement Case state.

## Decision

### LINE access-token authenticator

`LineAccessTokenAuthenticator` implements `PrincipalAuthenticator`:

- `GET https://api.line.me/oauth2/v2.1/verify?access_token=…` must return the
  configured LINE Login channel ID as `client_id` and a positive `expires_in`.
- `GET https://api.line.me/v2/profile` with the same token yields the LINE user ID.
- The principal is `line:<userId>`, provider `line`. It is only an identity key:
  tenant, actor ID and roles still come exclusively from the membership directory.
- Every failure (wrong channel, expiry, upstream error, malformed response,
  network failure) fails closed as `AuthenticationError` (HTTP 401), the same
  contract as the Supabase Auth authenticator. Tokens are never logged.

### Staff manual-signal intake

```http
POST /api/care-ops/tenants/{tenantId}/manual-signals
Authorization: Bearer <access-token>
Content-Type: application/json

{ "signalId": "<uuid>", "subjectId": "2F-203", "priority": "high" }
```

- Authenticated principal → active tenant membership with one of
  `dispatcher`, `responder`, `supervisor`. Auditors cannot report.
- The server fixes `sourceAdapter = "staff_manual"` and `type = "manual"`; the
  body cannot choose an adapter, actor, tenant field, Case ID or status
  (unknown fields are rejected).
- Idempotency stays the ADR 0004 boundary `tenantId + sourceAdapter + signalId`:
  a retried report returns the original Case (`200`, `created: false`); the
  first report returns `201`. A replay with different content is `409
  SIGNAL_REPLAY_MISMATCH` instead of a silent overwrite.
- `subjectId` must be a pseudonymous facility-local key
  (`^[A-Za-z0-9._:-]{1,64}$`), so names or free text cannot enter the Case.
- Reporting opens a `NEW` Case only. It grants no lifecycle command; acknowledge,
  assign, handoff and completion keep the existing RBAC and Core rules.
- `CareOpsHttpClient.openManualSignal` implements the new
  `CareOpsSignalReporter` interface, kept separate from the Console client.

## Consequences

- The field app forwards the staff member's own LINE token; Care Ops verifies it
  independently. No new service credential is introduced.
- The `case_created` event keeps `actorId: null` (event vocabulary unchanged).
  Reporter attribution lives in the upstream app's append-only operations audit.
  Adding `reportedBy` to the event vocabulary would require a separate ADR.
- A responder who reports a Case cannot see it in the Queue until a dispatcher
  assigns it (responder Queue visibility is unchanged).
- Deployments must configure the LINE Login channel ID used by the field app
  and provision memberships whose principal IDs are `line:<userId>`.

## Invariants

Unchanged: no ownership gap during handoff, no status-only completion, no
caller-controlled audit actor, no stale overwrite, no cross-tenant addressing by
Case ID alone, replayable state.
