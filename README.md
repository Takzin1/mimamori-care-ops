# Mimamori Care Ops

**見守りのラストワンマイルを、支援完了まで。**

Mimamori Care Ops is a Care Operations Platform for turning a signal that requires human attention into a **verifiably completed support case**.

## Core thesis

Detection is upstream. Notification is upstream.

The product boundary starts when a signal still requires a human to:

```
confirm
→ decide
→ assign
→ act
→ hand off
→ complete
→ close
```

The system is designed to make that responsibility boundary explicit, measurable, and replayable.

## What this repository is

This repository contains the **GK / Last-mile Core** extracted from the 2026 Mimamori-kun PoC generation.

It focuses on:

- Case lifecycle
- Assignment and ownership
- Handoff without responsibility gaps
- Completion evidence
- Append-only operational events
- Optimistic concurrency
- Time-to-completion metrics

## What this repository is not

It is not intended to become:

- a generic monitoring app
- a municipal super-app
- a sensor platform
- a notification-volume optimization product
- an AI-first product

AI may assist normalization, summarization, or triage, but **human support completion is the product boundary**.

## North-star KPI

**Time to Completion (TTC)**

Supporting metrics:

- Time to Acknowledge
- Time to Assignment
- Time to First Action
- Handoff Count
- Reopen Rate
- Unassigned Aging
- SLA Breach

## Lineage

Source PoC repository:

- `Takzin1/mimamori-kun`
- Frozen reference branch: `release/mimamori-poc-2026`
- Frozen reference commit: `73d8f95aa6b3e860b632e6d35a9413abbd9df4f2`

This repository does **not** copy the legacy application wholesale. Only validated operational primitives are reintroduced deliberately.
