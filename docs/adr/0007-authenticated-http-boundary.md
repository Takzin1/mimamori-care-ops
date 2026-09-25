# ADR 0007: Authenticated HTTP boundary

Status: Accepted

Date: 2026-09-26

## Context

The Care Operations Core, application services, queue projection, repository and outbox are server-side capabilities.

A future Responder Console needs an HTTP boundary, but the client must never become the source of truth for staff identity, roles, actor IDs, tenant membership, or database service credentials.

## Decision

The first HTTP API is a thin transport around existing Application Services and uses Web-standard `Request` / `Response` primitives.

Routes:

```text
GET  /v1/tenants/:tenantId/cases
GET  /v1/tenants/:tenantId/cases/:caseId
POST /v1/tenants/:tenantId/cases/:caseId/commands
```

Signal ingestion is intentionally not exposed through this responder-facing API.

## Identity boundary

A trusted `RequestAuthenticator` converts the incoming request into:

```
AuthenticatedPrincipal {
  principalId
}
```

The HTTP JSON body never supplies:

- principalId
- actorId
- roles
- tenant membership
- service-role database credentials

The path supplies a requested tenant context. Existing Application authorization then resolves:

```
tenantId + authenticated principalId
  -> trusted TenantMembership
  -> actorId + roles
```

before Case disclosure or mutation.

## Command contract

The request body is strictly parsed.

Unknown fields are rejected.

Supported command payloads contain only the business intent plus `expectedVersion`; the trusted actor is bound later by the Application Service.

This gives two independent protections:

1. HTTP schema refuses identity injection.
2. Application Service ignores client actor identity by design because its command type does not contain one.

## Concurrency

Clients submit `expectedVersion`.

A stale command maps to HTTP 409 with the expected/current versions, while the authoritative compare-and-set remains in the repository/database layer.

## Request safety

Command requests require:

- `Content-Type: application/json`
- bounded body bytes
- valid JSON
- strict command schema
- safe path identifiers

The byte limit is enforced while reading the body stream, not only through `Content-Length`.

## Response safety

Every response sets:

- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`
- server-generated `X-Request-Id`

Internal storage/integrity failures return an opaque service-unavailable response instead of raw database errors.

## Framework boundary

The HTTP module intentionally has no Express, Next.js, Fastify, or Supabase Auth dependency.

A deployment framework may adapt its request into the standard `Request` object and provide a production `RequestAuthenticator`.

## CORS

The core transport does not emit permissive CORS headers.

Deployment-specific origin policy belongs at the trusted edge/application host and must be reviewed before production use.

## Consequences

- Responder Console can consume a stable server API
- identity cannot be chosen from JSON
- business rules remain in Application/Core layers
- production authentication remains replaceable
- service-role credentials remain server-side
