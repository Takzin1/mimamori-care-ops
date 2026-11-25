---
title: Mimamori Framework Lab
emoji: "🛟"
colorFrom: blue
colorTo: teal
sdk: static
app_file: index.html
pinned: false
short_description: Synthetic demo for cross-sector manual, training and response workflows
---

# Mimamori Framework Lab

**Synthetic public demonstration only. No production operations.**

Japanese-language interactive demonstration of a common response framework for care, schools, hospital facility operations, and municipalities.

The demo supports:
- Industry template switcher and manual keyword search
- Read-only synthetic response steps with version labels
- One-question training simulation and pass history
- Demonstration Case creation and bounded state transitions
- Synthetic append-only event journal, local JSON export, browser-local state reset

**Security / data handling:** All examples are fictional. Do not enter personal information. The app does not send any data to a server. Its browser-local storage is not a database and is not suitable for clinical, disaster-response, or operational records. No LINE messages, real CareOps actions, or emergency notifications are performed.

**Production roadmap:** Authentication and tenant scoping, versioned manual approval, permission-checked Case API integration, durable PostgreSQL event/record storage, and offline-safe fallback are intentionally NOT implemented in this public demo. They must be implemented and independently validated before real-world use.

Source of truth for the production Case engine: [mimamori-care-ops](https://github.com/Takzin1/mimamori-care-ops).

Hugging Face Static Spaces require no paid compute, and this repository's README metadata includes `sdk: static` and `app_file: index.html`.
