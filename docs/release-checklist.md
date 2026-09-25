# Production Release Checklist

This checklist is intentionally stricter than the current prototype state.

Do not treat completion of the Core as production approval.

## Architecture

- [ ] Case lifecycle invariants reviewed
- [ ] ADRs current
- [ ] Signal idempotency implemented
- [ ] SLA / escalation semantics defined
- [ ] production Postgres adapter implemented
- [ ] integration tests run against production-equivalent Postgres

## Identity and authorization

- [ ] production identity provider integrated
- [ ] tenant membership source defined
- [ ] role provisioning / revocation process documented
- [ ] inactive user access verified fail-closed
- [ ] service accounts separated from human principals
- [ ] least-privilege database/service credentials reviewed

## Data protection

- [ ] data classification completed
- [ ] personal / care / medical data scope approved
- [ ] encryption configuration reviewed
- [ ] secret manager configured
- [ ] key rotation process tested
- [ ] retention / deletion policy implemented
- [ ] backup and restore tested
- [ ] synthetic/demo environments separated from production

## Application security

- [ ] RLS verified in deployed database
- [ ] PUBLIC / anon / authenticated grants reviewed
- [ ] service-role usage confined to trusted server environment
- [ ] rate limiting / abuse prevention implemented
- [ ] audit actor spoofing regression tests passing
- [ ] cross-tenant access tests passing
- [ ] stale-write / concurrency tests passing
- [ ] dependency / supply-chain review completed

## Operations

- [ ] structured logs
- [ ] metrics / alerting
- [ ] incident response runbook
- [ ] on-call / escalation ownership
- [ ] health checks
- [ ] recovery objectives defined
- [ ] rollback plan tested
- [ ] deployment environment documented

## Product / human operations

- [ ] responder roles and responsibilities validated with target operators
- [ ] handoff semantics validated in field workflow
- [ ] completion evidence policy validated
- [ ] false alarm / decline / emergency handoff outcomes reviewed
- [ ] usability test for high-stress operation completed
- [ ] accessibility review completed

## Privacy / legal / governance

- [ ] privacy review
- [ ] contractual data-processing responsibilities defined
- [ ] consent / lawful basis confirmed where applicable
- [ ] audit / retention obligations reviewed
- [ ] production demo policy approved
- [ ] real-world PoC governance approved

Only after the applicable items are complete should production resident/care data be considered.
