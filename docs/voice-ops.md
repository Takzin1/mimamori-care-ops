# Mimamori Ops Voice

Mimamori Ops Voice is a provider-bounded Voice Operations layer for frontline care workflows.

The implemented flow is:

Voice transcript
→ incident draft
→ existing Care Ops signal
→ SOP next-action guidance
→ localized explanation
→ human-reviewed communication draft
→ approved outbox message

The realtime transport path is intentionally separated from the operational workflow:

Authenticated operator
→ short-lived realtime session request
→ AssemblyAI token issuer (server only)
→ validated WSS session
→ browser microphone capture
→ mono resample
→ PCM16 little-endian audio chunks
→ AssemblyAI realtime WebSocket
→ final Turn
→ Voice Evidence
→ Voice Operations workflow

## Safety boundary

The Voice layer does not diagnose, decide final emergency severity, assign accountable ownership, accept a handoff, or complete a Case.

Near-miss / incident classification belongs to the Voice layer. The existing Case lifecycle remains unchanged.

Only final AssemblyAI turns may enter the operational plan. Transcript evidence keeps the provider, transcript ID, language, timestamp, and source text.

Browser clients must never receive a long-lived provider API key. The AssemblyAI API key remains server-side and is used only to mint a short-lived realtime token. The browser receives the resulting short-lived WSS session.

Microphone capture defaults to mono audio with echo cancellation, noise suppression, and automatic gain control requested from the browser. Audio is resampled to the provider session target rate and encoded as signed 16-bit little-endian PCM before transport.

The provider adapter is isolated from the Care Ops Core so a provider API change does not alter Case lifecycle, SOP guidance, Outbox, handoff, or completion semantics.

## Current implementation boundary

Implemented:
- normalized AssemblyAI final-turn boundary
- AssemblyAI short-lived realtime token/session issuer adapter
- AssemblyAI Turn message parser that emits only end-of-turn evidence
- authenticated Voice Session HTTP API boundary
- Supabase Care Ops runtime mount for voice session route when an issuer is configured
- browser Voice Session client using existing Care Ops bearer auth
- browser WebSocket transport abstraction with audio gating
- browser microphone capture + deterministic mono resampling + PCM16 encoder
- synthetic rule-based incident extractor for demo/testing
- deterministic SOP guidance
- Japanese passthrough and Indonesian synthetic localization adapter
- supervisor/family communication drafts
- explicit human approval before creating an Outbox message
- unit tests for provider token issuance, Turn parsing, runtime route mounting, workflow, session validation, transport state, auth boundary, and PCM conversion

Still required for live demo:
- server runtime configuration with an actual ASSEMBLYAI_API_KEY
- live microphone/WebSocket smoke test against AssemblyAI
- browser UI wiring from the synthetic demo to the live session controller

Not yet wired:
- Claude Haiku translation/extraction provider
- provider delivery handler for LINE/SMS/email
- production care data or production clinical policy

The demo and tests must use synthetic subjects and synthetic incident data only.
