# Security and exam integrity

## What is enforced on the server

| Protection | How |
|---|---|
| No anonymous access | Neon's `anonymous` role has no table or function privileges. Every API call needs a valid Neon Auth token. |
| Students can't see answer keys or unpublished exams | Bank tables, exam tables and key tables are admin-only under RLS. Students get the paper from `get_attempt`, which returns question text and options only. Keys and solutions come from `get_attempt_result`, and only once the release rule allows. |
| Students can't see others' data | RLS limits attempts, responses and results to the owner; results also wait for release. |
| Students' own papers are private | A paper a student makes for themselves (`exams.owner_id`) is listed, opened and attempted only by that student (`list_my_exams`, `get_exam_overview`, and a trigger on `exam_attempts`). Its attempts, answers and marks are hidden from administrators too: RLS on attempts/responses/results/events excludes private papers for admins, `admin_exam_report` refuses them, and the admin overview, exam list and question bank leave them out. The AI questions written for it are private to that paper and never enter the shared bank. |
| Students' papers can't smuggle in questions | `practice_create_job` keeps only approved shared bank questions from the plan; `record_generation_batch` attaches only questions written for that job; `practice_save_question` runs the same checks as a manual approval; `practice_finish` uses only approved bank questions or the student's own questions for that job. Students never read question or key tables, even for their own paper, until results are released. |
| No self-promotion to admin | `user_roles` has no write grant for clients. Roles change only through `admin_set_role` (admin-only, audited) or SQL run by the project owner. The last admin cannot be removed. An admin invitation by email applies only to a **verified** email, so an unverified sign-up with that address gets nothing. |
| Timer can't be extended | `deadline_at` is fixed at start from the server clock. Saves after `deadline + 5 s` (network grace) are refused and the attempt is auto-submitted. Expired attempts are finalised on any read and by the optional cron job. |
| Answers can't be lost or reordered | Each answer carries a per-question sequence number; older or duplicate saves are ignored. Unsent saves are kept in the browser's storage and retried. |
| Double submission is harmless | `submit_attempt` locks the attempt row and is idempotent. Concurrent `start_attempt` calls return the same attempt. |
| Scores can't be forged | Scores are computed only by `app.compute_result` inside Postgres. Clients have no write access to `results`. |
| Published papers can't change | Triggers block edits to published versions, their questions and keys. Bank edits don't affect them, because each published question is a snapshot. |
| Private files | Both Neon storage buckets are private, and the browser never holds storage credentials. The `api` function asks the database (`can_access_file`, as the signed-in user) before it signs a short-lived URL: any signed-in user may upload PDFs into their own folder (`u/<user id>/`) and read them back; admins may access everything; figures are readable only by students with an attempt on that exam. |
| Shared study material | Every signed-in user can see the list of active PDFs and use their indexed text when making a paper. Only the uploader (or an admin) can re-index, edit or delete a PDF; others cannot add text to it or download the original file. Admins can deactivate anything that should not be shared. |
| AI keys stay secret | Only the `api` Neon Function reads `AI_API_KEY`. The browser bundle contains only public URLs. The function verifies each caller's Neon Auth token against the branch JWKS, then acts on the database through the Data API **as that user**, so RLS still applies. |
| Abuse limits | Rate limits on starting, saving, submitting and event logging. AI generation has a per-job cap, an overall daily question quota, a per-student daily limit for their own papers (default 20 new questions), a 30-day budget, and one batch per job runs at a time. Students can start at most 10 new papers an hour. |
| Untrusted text | Question text is HTML-escaped; KaTeX runs with `trust: false`. The Firebase CSP blocks inline and third-party scripts. |
| Audit trail | Role changes, blocks, question create/update/status/import, publish, new versions, result release and assembly are written to `audit_logs`. |

## Honest limits

A website cannot lock down a student's computer. The portal does **not** prevent:

- opening other tabs or apps, using a phone, or asking someone for help;
- screenshots or copying of question text.

It does record when the test tab is hidden or the network drops (`attempt_events`) and shows tab-switch counts in the admin report. Treat these as signals, not proof: browsers can miss them, and a determined student can block them. For high-stakes exams, use supervision or a dedicated lockdown browser.

AI-generated questions for **official papers** are never trusted automatically. Numeric answers are recomputed from the model's verification expression with an independent evaluator, and mismatches are flagged. Every such question is saved as a draft and needs an administrator's approval before any exam can use it.

AI questions for a **student's own paper** are not reviewed by a person (by design, so the paper is ready at once). They pass the same automatic checks; anything the checks doubt is discarded and rewritten. A wrong question can still slip through, so students should treat their own papers as practice and report mistakes.

**Uploads are shared immediately.** Anything a student uploads is usable by everyone at once, before anyone has looked at it. The uploader must confirm they have the right to share it, and administrators can deactivate or delete any upload, but the site owner remains responsible for what is shared.

**Administrators cannot see students' private marks through the portal,** but the project owner can still read every table directly in the Neon SQL Editor. Privacy here means privacy from other users and from the admin screens.
