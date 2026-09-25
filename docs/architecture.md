# Architecture

## Product boundary

Mimamori Care Ops begins where passive monitoring stops.

```
Signal adapter
    |
    v
+---------+
|  CASE   |
+---------+
    |
    +--> ACKNOWLEDGED
    |
    +--> ASSIGNED
    |
    +--> IN_PROGRESS
            |
            +--> HANDOFF_PENDING
            |       |
            |       +--> IN_PROGRESS
            |
            +--> COMPLETED
                    |
                    +--> CLOSED
```

## Responsibility invariant

A handoff must never create an ownership gap.

While a handoff is pending:

- the outgoing responder remains `assigneeId`
- the requested responder is stored as `handoffTargetId`
- ownership changes only on `handoff_accepted`

This is a core safety invariant, not a UI convention.

## Completion invariant

A Case cannot be completed by status change alone.

Completion requires:

1. current responder ownership
2. an explicit outcome
3. a human-readable completion summary
4. at least one evidence item

Evidence may be a call record, visit record, message, note, or external reference.

## Concurrency invariant

Every Case aggregate has a monotonically increasing `version`.

Commands must include the expected version. A stale command is rejected before transition. Persistence adapters must preserve the same compare-and-set behavior transactionally.

## Event log

The operational record is append-only.

Current event vocabulary:

- `case_created`
- `acknowledged`
- `assigned`
- `action_started`
- `handoff_requested`
- `handoff_accepted`
- `completed`
- `closed`
- `reopened`

The current Case state must be reproducible from the event stream.

## Adapter boundary

Signal sources are adapters, not Case Core features.

Examples:

- non-response
- unwell report
- SOS
- snow report
- disaster non-response
- welfare escalation
- free text
- manual operator entry
- external API

Adding a signal source must not require changing the Case state machine.

## AI boundary

AI may assist:

- normalization
- summarization
- extraction
- triage suggestions

AI must not silently:

- complete a Case
- accept a handoff
- replace accountable human ownership
- erase or rewrite operational evidence
