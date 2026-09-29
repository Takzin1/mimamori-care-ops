# Voice Ops live demo wiring

This runbook covers the live AssemblyAI demo path without storing provider credentials in the repository.

## Server composition

Use `createAssemblyAiVoiceCareOpsDeployment`.

Supply the AssemblyAI credential from the deployment platform's server-only secret store through `assemblyAiApiKey`. Never serialize it into browser configuration, HTML, JavaScript bundles, logs, query parameters, or client storage.

Voice-enabled deployments mount:

- `POST /api/care-ops/tenants/:tenantId/voice/session`
- `POST /api/care-ops/tenants/:tenantId/voice/plan`
- `POST /api/care-ops/tenants/:tenantId/voice/communications/approve`
- `GET /api/care-ops/tenants/:tenantId/voice/outbox/health`

All three use the existing Care Ops bearer identity and tenant membership boundary.

## Browser demo modes

### Synthetic

The five-screen deterministic scenario remains available without provider credentials. Use it as the fallback for judging, recordings, and UI review.

### Live

The operator enters only:

- Care Ops API origin;
- tenant ID;
- locale;
- Care Ops access token.

The token is held in memory only.

The live path is:

1. request a short-lived AssemblyAI session through Care Ops;
2. connect directly to AssemblyAI over WSS;
3. capture mono microphone audio;
4. resample to the session target rate;
5. encode signed PCM16 little-endian;
6. stream audio to AssemblyAI;
7. render partial Turn transcripts;
8. stop microphone streaming on the final Turn;
9. submit the final Turn to `/voice/plan`;
10. persist a Care Ops Case through the existing Case repository;
11. render incident classification, SOP guidance, localized guidance, and communication drafts;
12. obtain explicit human confirmation;
13. submit each approved draft to `/voice/communications/approve`;
14. receive durable Outbox queue confirmation.

## Delivery worker

The durable Outbox message is handled by `ApprovedCommunicationOutboxHandler`.

`WebhookCommunicationSender` resolves the external destination only on the server and sends over HTTPS with the Outbox delivery key as the idempotency key.

Configure the resolver to point at the chosen LINE/SMS/email/provider gateway. Do not store the actual destination phone number or email address in the browser or Outbox payload.

## Claude multilingual path

The current domain layer includes `ClaudeGuidanceTranslator`, which fails closed if a provider response changes action IDs, count, or order.

The network transport for the current Claude/Anthropic API is intentionally injected. Configure it from current provider documentation rather than freezing provider-specific API details into the Care Ops domain layer.

## Demo data rule

Use synthetic personas and synthetic incidents only.

Do not enter real resident names, care records, diagnoses, phone numbers, email addresses, or other production personal data.

## Human accountability

The system may create a Case and recommend SOP actions, but it does not diagnose, make final emergency decisions, assign accountable ownership, accept handoff, complete, or close a Case.

Communication is not queued until a human confirms it.


## Payload-free Outbox evidence

After Human Confirm queues approved communication drafts, the Live Demo reads the authenticated, tenant-scoped Outbox health projection.

The endpoint exposes only aggregate operational state:

- pending
- processing
- failed
- dead-letter
- evaluated timestamp / oldest actionable timestamp / max attempt count

It does not expose message payloads, destination addresses, delivery keys, Case IDs, resident identifiers, or approval text.
