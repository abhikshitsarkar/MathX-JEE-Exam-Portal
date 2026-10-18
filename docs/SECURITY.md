# Security and exam integrity

## What is enforced on the server

| Protection | How |
|---|---|
| No anonymous access | Neon's `anonymous` role has no table or function privileges. Every API call needs a valid Neon Auth token. |
| Students can't see answer keys or unpublished exams | Bank tables, exam tables and key tables are admin-only under RLS. Students get the paper from `get_attempt`, which returns question text and options only. Keys and solutions come from `get_attempt_result`, and only once the release rule allows. |
| Students can't see others' data | RLS limits attempts, responses and results to the owner; results also wait for release. |
| No self-promotion to admin | `user_roles` has no write grant for clients. Roles change only through `admin_set_role` (admin-only, audited) or SQL run by the project owner. The last admin cannot be removed. An admin invitation by email applies only to a **verified** email, so an unverified sign-up with that address gets nothing. |
| Timer can't be extended | `deadline_at` is fixed at start from the server clock. Saves after `deadline + 5 s` (network grace) are refused and the attempt is auto-submitted. Expired attempts are finalised on any read and by the optional cron job. |
| Answers can't be lost or reordered | Each answer carries a per-question sequence number; older or duplicate saves are ignored. Unsent saves are kept in the browser's storage and retried. |
| Double submission is harmless | `submit_attempt` locks the attempt row and is idempotent. Concurrent `start_attempt` calls return the same attempt. |
| Scores can't be forged | Scores are computed only by `app.compute_result` inside Postgres. Clients have no write access to `results`. |
| Published papers can't change | Triggers block edits to published versions, their questions and keys. Bank edits don't affect them, because each published question is a snapshot. |
| Private files | Both Neon storage buckets are private, and the browser never holds storage credentials. The `api` function asks the database (`can_access_file`, as the signed-in user) before it signs a short-lived URL: uploads are admin-only, and figures are readable only by students with an attempt on that exam. |
| AI keys stay secret | Only the `api` Neon Function reads `AI_API_KEY`. The browser bundle contains only public URLs. The function verifies each caller's Neon Auth token against the branch JWKS, then acts on the database through the Data API **as that user**, so RLS still applies. |
| Abuse limits | Rate limits on starting, saving, submitting and event logging. AI generation has a per-job cap, a daily question quota and a 30-day budget, and one batch per job runs at a time. |
| Untrusted text | Question text is HTML-escaped; KaTeX runs with `trust: false`. The Firebase CSP blocks inline and third-party scripts. |
| Audit trail | Role changes, blocks, question create/update/status/import, publish, new versions, result release and assembly are written to `audit_logs`. |

## Honest limits

A website cannot lock down a student's computer. The portal does **not** prevent:

- opening other tabs or apps, using a phone, or asking someone for help;
- screenshots or copying of question text.

It does record when the test tab is hidden or the network drops (`attempt_events`) and shows tab-switch counts in the admin report. Treat these as signals, not proof: browsers can miss them, and a determined student can block them. For high-stakes exams, use supervision or a dedicated lockdown browser.

AI-generated questions are never trusted automatically. Numeric answers are recomputed from the model's verification expression with an independent evaluator, and mismatches are flagged. Every AI question is saved as a draft and needs an administrator's approval before any exam can use it.
