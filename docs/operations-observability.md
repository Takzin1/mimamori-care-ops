# Operations and Observability Baseline

`OperationalCareOpsRuntime` wraps any Care Ops HTTP handler with a small provider-neutral operations boundary.

## Endpoints

### `GET /healthz`

Returns only:

```json
{"status":"ok"}
```

This is a process/liveness signal.

It does not validate external dependencies.

### `GET /readyz`

Runs injected readiness checks.

Returns only:

```json
{"status":"ready"}
```

or:

```json
{"status":"not_ready"}
```

The response deliberately does not disclose:

- check names
- database/provider names
- exception messages
- credentials
- internal topology

HEAD is supported for both endpoints without a response body.

## Structured logging

The default log schema contains only:

- event
- timestamp
- request ID when available
- route class
- HTTP method
- status
- duration
- readiness boolean/check count for readiness evaluation

It intentionally excludes:

- URL path
- query string
- tenant ID
- Case ID
- subject ID
- principal ID
- actor ID
- request body
- Authorization header
- access token

The default route classes are:

- `health`
- `readiness`
- `care_ops`

## Metrics

The provider-neutral metrics sink receives:

- `care_ops_http_requests_total`
- `care_ops_http_request_duration_ms`

Labels are limited to:

- route class
- method
- status class

Do not add tenant, resident, subject, Case, actor, or principal identifiers as metric labels.

## Failure behavior

Logger/metrics failures are best-effort and do not break Care Ops request handling.

An uncaught application-handler exception becomes a stable 500 response:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error",
    "requestId": "..."
  }
}
```

The underlying exception message/stack is not returned by this wrapper.

## Readiness checks

Readiness checks are injected.

Examples a deployment may choose to implement:

- Postgres reachability
- Auth-provider reachability
- mandatory tenant configuration loaded
- required downstream worker dependency reachable

A failed check should return false or throw.

The external readiness response remains generic.

## Supabase composition

Use:

```
createOperationalSupabaseCareOpsRuntime(...)
```

to combine:

- Supabase Auth verification
- membership/RBAC
- Case/Queue runtime
- HTTP API
- health/readiness
- structured logs
- metrics

## Still required in production

The repository does not choose an observability vendor.

A deployment still needs:

- log sink
- metrics backend
- alert thresholds
- dashboard
- on-call owner
- dead-letter alerting
- retention policy for operational logs
- incident response process

Do not route resident/care payloads into observability by default.
