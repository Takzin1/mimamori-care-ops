# Care Operations HTTP API

This API is the server-side transport boundary for responder-facing clients.

It is intentionally small. The UI should not import repository, service-role credentials, or Case Core mutation functions directly.

## Authentication adapter

Deployments provide:

```ts
interface RequestAuthenticator {
  authenticate(
    request: Request,
  ): Promise<{ principalId: string } | null>;
}
```

The repository includes no production identity-provider assumption yet.

Tests use a synthetic authenticator defined only inside the test suite.

## Endpoints

### List operational queue

```http
GET /v1/tenants/{tenantId}/cases
```

Returns the authorized Case Queue projection.

Dispatcher/supervisor/auditor membership can receive the tenant-wide queue. Responder-only membership receives current assignments and incoming handoffs according to the Application policy.

### Read Case

```http
GET /v1/tenants/{tenantId}/cases/{caseId}
```

Returns:

```json
{
  "aggregate": {},
  "events": []
}
```

The response includes `X-Case-Version`.

### Execute Case command

```http
POST /v1/tenants/{tenantId}/cases/{caseId}/commands
Content-Type: application/json
```

Example:

```json
{
  "expectedVersion": 3,
  "command": {
    "type": "start_action"
  }
}
```

The request never contains `actorId`, `principalId`, or roles.

## Supported command shapes

```json
{ "type": "acknowledge" }
{ "type": "set_priority", "priority": "critical" }
{ "type": "assign", "assigneeId": "responder-a" }
{ "type": "start_action" }
{ "type": "request_handoff", "targetAssigneeId": "responder-b" }
{ "type": "accept_handoff" }
{
  "type": "complete",
  "outcome": "confirmed_safe",
  "summary": "Synthetic confirmation",
  "evidence": [
    { "kind": "call", "ref": "synthetic:call:001" }
  ]
}
{ "type": "close" }
{ "type": "reopen", "reason": "Synthetic follow-up required" }
```

Unknown fields are rejected.

## Error contract

Errors use:

```json
{
  "error": {
    "code": "STABLE_CODE",
    "message": "Safe message",
    "requestId": "server-generated-id"
  }
}
```

Representative mappings:

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | INVALID_REQUEST | JSON/schema/path validation failure |
| 401 | AUTHENTICATION_REQUIRED | no trusted principal |
| 403 | FORBIDDEN | tenant/role access denied |
| 404 | CASE_NOT_FOUND | authorized tenant, Case absent |
| 409 | CASE_VERSION_CONFLICT | stale optimistic version |
| 409 | INVALID_CASE_TRANSITION | lifecycle invariant denied |
| 413 | REQUEST_BODY_TOO_LARGE | body exceeded configured byte limit |
| 415 | JSON_CONTENT_TYPE_REQUIRED | command endpoint requires JSON |
| 503 | CARE_OPS_UNAVAILABLE | storage/integrity/SLA dependency unavailable |
| 500 | INTERNAL_ERROR | unexpected server failure |

Cross-tenant requests are denied by membership before the repository reveals whether a Case exists.

## Request IDs

Every response contains a server-generated `X-Request-Id`, and error bodies repeat that ID.

Deployments should carry this ID into structured server logs without logging sensitive request bodies.

## Body limit

The default command body limit is 32 KiB.

The stream reader counts actual bytes and rejects oversized bodies even when the request does not provide a trustworthy `Content-Length`.

## Deployment rule

The production HTTP process may hold service-role credentials indirectly through server-side repository adapters.

The browser/LIFF/mobile client must never receive those credentials.
