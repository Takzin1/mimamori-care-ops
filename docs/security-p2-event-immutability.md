# P2-A: Case Event Append-only Defense

## Intent

Protect the **existing, verified Case history** from ordinary direct UPDATE or DELETE commands, including accidental use by a privileged maintenance operator. **Do not** add application features or change how the Case engine, tenant isolation, DB RPCs, and outbox work.

The trigger is declared in `db/case_store.sql`:
- `public.reject_care_case_event_rewrite()` is a minimal `SECURITY INVOKER` trigger that always raises SQLSTATE `55000`.
- `care_case_events_append_only_guard` rejects row-level `UPDATE` and `DELETE` on `public.care_case_events`.
- Existing `create_care_case()` and `append_care_case_event()` use only `INSERT` into this table and remain unchanged.
- Runtime `service_role` already lacks direct Case/event DML privileges. This trigger is **defense in depth**, not the main authorization control.

## Guarantees and non-guarantees

| Case | Expected result |
| --- | --- |
| Normal authorized Case create/append RPC | Allowed, preserving event/snapshot/outbox atomicity |
| Direct UPDATE of an existing event by migration owner | Rejected by trigger |
| Direct DELETE of an existing event by migration owner | Rejected by trigger |
| SELECT and replay of existing Case events | Unchanged |
| Table owner/superuser disabling the trigger | **Not prevented** |
| Privileged TRUNCATE, DROP, storage tampering or rewriting entire snapshots | **Not prevented** by this row trigger |
| Full event-history cryptographic tamper evidence | **Not provided** |
| Backups, PITR, protected off-database evidence | **Not provided** by this PR |

The `SECURITY DEFINER` RPC owner and Postgres schema owner remain highly privileged trust boundaries. PostgreSQL explicitly allows owners to disable table triggers; an audit trigger cannot protect the database against its administrator.

## Test and release gate

1. Run `npm test` and the existing Node 24 typecheck.
2. Run the real PostgreSQL integration workflow against a disposable database; it installs `db/case_store.sql`, verifies two successful RPC writes, then attempts row UPDATE and DELETE as the database owner. Both must be refused and event data must remain byte-identical.
3. Do not automatically apply this migration to a live Supabase project or process resident data. Check existing write paths for any maintenance UPDATE/DELETE of historical events; replace those with new auditable Case operations.
4. For production promotion, take a verified backup first, use approved change control, validate successful RPC creation/append with synthetic data, and run event replay/restore checks.
5. Rollback of this protection (disabling/dropping the trigger) **reduces audit safety**. Do not perform it as an automatic application rollback. Prefer forward-fix, with human review and the existing restore runbook.

## Deferred security work

- Independent, immutable audit anchors or cryptographically chained event hashes, stored and verified outside the operational DB.
- Point-in-time recovery and successful independent restore drill; organization-defined RPO/RTO, backup retention, key management.
- Database owner privileges, delegated incident response, deletion/retention compliance, event log redaction without destroying evidentiary value.
- Review of timestamp/event payload validity at service-to-DB boundary, and migrations required to reconcile older events.

References: [PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html), [ALTER TABLE (trigger disable)](https://www.postgresql.org/docs/current/sql-altertable.html), [PostgreSQL Wiki: audit trigger owner limitations](https://wiki.postgresql.org/wiki/Audit_trigger).
