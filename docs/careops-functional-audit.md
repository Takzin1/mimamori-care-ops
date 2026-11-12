# CareOps Functional Audit (2026-11-12)

Functional audit of the CareOps app for PR #74. The audit ran the real local
server (fresh SQLite, synthetic data only) and exercised the requirements of
phases 1–7 and the ten completion criteria through the HTTP API and a phone-sized
Chromium (iPhone 13 profile). PostgreSQL / PostgREST behaviour is covered
separately by CI (`postgres-integration`, `staging-stack`).

## Method

- **Automated checks (141)** across the Case lifecycle, forbidden transitions,
  duplicate notifications, idempotent creation, escalation and delivery,
  settings and SLA approval, facility/tenant isolation, list search, filters and
  pagination, dashboard counts versus list totals, AI drafts and approval,
  analytics, and in the browser: every screen, dialogs, double submit, a version
  conflict, role-specific navigation, offline handling, layout at phone width
  (overflow, ≥44 px targets, labelled controls, one `h1`), console errors.
- **Exploratory probes** in places the scripted checks did not reach: a Japanese
  time zone, long-running pages, settings edits, and visual review of
  screenshots.

The audit harness itself is not part of the repository. The defects it found
are covered by `tests/e2e/careops-audit-regressions.e2e.ts`. Each of those
tests failed against the code before the fix and passes after it.

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | In a UTC+ time zone (Japan), the analytics period and the Case-list date filter moved one day earlier on every submit, because dates went through UTC strings. The first query was correct; resubmitting changed the period silently. | Fixed: dates now use local calendar values that survive a round trip unchanged, and the end date is exclusive (the start of the following local day). |
| F2 | High | The 30 s auto-refresh discarded unsaved input once the field lost focus, for example a phone call being recorded in the inbox, unsaved facility settings, or an edited AI draft. | Fixed: any edit pauses auto-refresh until the user saves, navigates, or presses 更新. The attention strip shows 「入力中のため自動更新を停止中」. |
| F3 | Low | Text links in the handoff history and the staff notification list had touch targets smaller than 44 px. | Fixed: links are at least 44 px high and the history link reads 「Caseを開く」. |
| F4 | Low | For responders, the handoff board heading said 「施設全体の未受領」 but listed only Cases the responder is involved in. | Fixed: the heading follows the actual visibility. |
| F5 | Low | In settings, an escalation rule with no recipient roles was silently changed to 「管理者」 on save. | Fixed: saving is refused with an explicit message. |

After the fixes, the full audit passed 141/141 checks on two consecutive runs.
Unit tests (244), typecheck (×2), lint and the mobile E2E tests also pass.

## Observations (not changed in this PR)

- The settings page is very long on a phone (SLA table, rule table and
  permission matrix on one page). Splitting it into sections or tabs would
  help, but it works as is.
- On a phone, the attention strip takes about two lines above the content.
- The web UI keeps the access token in memory only (by design), so reloading
  the page requires logging in again. Token refresh is listed in
  `careops-remaining-work.md`.
- The inbox and the notification list are not paged yet. Volumes in the
  current scope are small; see the scale notes in `careops-remaining-work.md`.
