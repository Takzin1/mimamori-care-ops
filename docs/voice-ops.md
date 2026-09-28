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

## Safety boundary

The Voice layer does not diagnose, decide final emergency severity, assign accountable ownership, accept a handoff, or complete a Case.

Near-miss / incident classification belongs to the Voice layer. The existing Case lifecycle remains unchanged.

Only final AssemblyAI turns may enter the operational plan. Transcript evidence keeps the provider, transcript ID, language, timestamp, and source text.

## Current implementation boundary

Implemented:
- normalized AssemblyAI final-turn boundary
- synthetic rule-based incident extractor for demo/testing
- deterministic SOP guidance
- Japanese passthrough and Indonesian synthetic localization adapter
- supervisor/family communication drafts
- explicit human approval before creating an Outbox message
- unit tests

Not yet wired:
- live AssemblyAI WebSocket/token exchange
- Claude Haiku translation/extraction provider
- provider delivery handler for LINE/SMS/email
- production care data or production clinical policy

The demo and tests must use synthetic subjects and synthetic incident data only.
