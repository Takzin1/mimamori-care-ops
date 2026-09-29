# Voice Ops live demo wiring

This document describes the live AssemblyAI demo path without storing provider credentials in the repository.

## Server composition

Use `createAssemblyAiVoiceCareOpsDeployment` from the deployment package.

The caller supplies the AssemblyAI provider credential from its server-only secret store through the `assemblyAiApiKey` option. The value must never be serialized into browser configuration, HTML, JavaScript bundles, logs, or query parameters.

The Voice deployment mounts:

- `POST /api/care-ops/tenants/:tenantId/voice/session`
- `POST /api/care-ops/tenants/:tenantId/voice/plan`

Both endpoints require the existing Care Ops bearer identity and active tenant membership.

## Browser demo

`demo/voice-ops` supports two modes.

### Synthetic mode

The existing five-screen scenario remains available without provider credentials. It is the deterministic fallback for judging and recorded walkthroughs.

### Live mode

The operator enters only the Care Ops API origin, tenant ID, locale, and Care Ops access token. The token is held in memory only.

The browser then:

1. requests a short-lived AssemblyAI realtime session through Care Ops;
2. connects directly to AssemblyAI over WSS;
3. captures mono microphone audio;
4. resamples to the session target rate;
5. encodes PCM16 little-endian;
6. streams audio to AssemblyAI;
7. renders partial Turn transcripts;
8. submits only the final Turn to `/voice/plan`;
9. renders incident classification, SOP guidance, localized guidance, and communication drafts.

## Demo data rule

Use synthetic personas and synthetic incidents only. Do not enter real resident names, real care records, diagnoses, phone numbers, or other production personal data.

## Human accountability

The demo does not diagnose or make final emergency decisions. The communication screen records human approval only; external LINE/SMS/email delivery remains a separate adapter until wired.
