# Voice live smoke test

Run this only against a deployed Voice-enabled Care Ops environment.

Required environment variables:

- `CARE_OPS_API_BASE`
- `CARE_OPS_TENANT_ID`
- `CARE_OPS_ACCESS_TOKEN`

Optional:

- `CARE_OPS_VOICE_LOCALE` (defaults to `ja-JP`)

Command:

```sh
npm run voice:smoke
```

The script requests a short-lived Voice session and validates the returned AssemblyAI WSS session contract.

It does **not** print the Care Ops bearer token or the short-lived AssemblyAI token. Output is limited to provider name, websocket host, sample rate, encoding, and expiry.

A successful smoke check verifies the server-side token/session boundary only. The browser Live Demo must still be used to verify microphone capture, realtime transcription, final Turn handling, Case creation, SOP rendering, and human-approved Outbox enqueue.
