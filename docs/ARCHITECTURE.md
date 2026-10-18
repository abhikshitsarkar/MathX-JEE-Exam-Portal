# Architecture

## Database schema

All application tables are in `public`, with Row Level Security enabled on every one. Internal helpers live in the private `app` schema, which the Neon Data API does not expose. Sign-in is Neon Auth (its own `neon_auth` schema); the app identifies users by `auth.user_id()` — the JWT `sub` — stored as text.

```
Neon Auth user (JWT sub) ─┬─ profiles (created by sync_profile on first sign-in)
                          └─ user_roles (student | admin; server-only writes)

subjects ─< chapters ─< topics (parent_id → sub-topics)

documents ─< document_chunks (full-text tsvector, page range, heading)

generation_jobs ─< questions >─ subjects / chapters / topics
                   ├─ question_options        (A–F)
                   ├─ question_answer_keys    (admin-only)
                   └─ question_solutions      (admin-only)

marking_schemes (versioned)      exam_templates (versioned, sections + difficulty mix)

exams ─< exam_versions ─< exam_questions ── exam_question_keys (snapshot key + solution, admin-only)
               │                 └─ question_id → questions (source; content is snapshotted on publish)
               └─< exam_attempts ─< responses (one row per question; answer, state, seq, time)
                          ├── results (score, breakdown by subject/chapter/topic/difficulty, per-question outcomes)
                          └─< attempt_events (tab hidden, offline, …)

ai_calls · app_settings · audit_logs · app.rate_limits · app.admin_invites
```

The key design rules:

- **One published version per exam.** It is immutable, enforced by triggers. Changing a live paper means creating a new draft version, which archives the old one when published. In-progress attempts on the old version still finish and score.
- **Snapshots on publish.** `publish_exam_version` copies each question's text, options, key and solution into `exam_questions.content` and `exam_question_keys`, so later edits to the bank cannot alter a paper students have taken.
- **Marking is data, not code.** Each version stores its own copy of the marking rules (`marking_rules` per question type: unanswered marks, partial-credit mode). Each exam question stores its own `marks` and `negative_marks`.
- **UUID primary keys, `timestamptz` everywhere,** foreign keys with explicit delete behaviour. Indexes cover every list filter, full-text search (GIN) and trigram duplicate search.

## Exam lifecycle (server functions)

| Step | Function | Notes |
|---|---|---|
| List | `list_my_exams()` | Published, non-archived papers with the student's attempt state |
| Instructions | `get_exam_overview(version)` | Structure and marking; no questions |
| Start | `start_attempt(version)` | Checks window, attempts left and blocked status. Sets `deadline = min(now + duration, closes_at)`. Resumes an open attempt. Race-safe. |
| Load | `get_attempt(attempt)` | Paper without keys, saved responses, server time |
| Autosave | `save_responses(attempt, items)` | Validates option labels and number formats. Ignores stale `seq`. Refuses after deadline + 5 s. |
| Submit | `submit_attempt(attempt, reason)` | Idempotent; scores via `app.compute_result` |
| Result | `get_attempt_result(attempt)` | Keys, solutions and per-question outcomes only when released |
| Analytics | `my_performance()` | Built only from the student's released results |

### Scoring

For each question type, `app.score_answer` handles three cases:

- **Single-correct:** the full marks or the penalty.
- **Multiple-correct:** the full marks if the chosen set equals the key. With `partial = per_option`, choosing only correct options earns `partial_per_option ×` the number chosen. Any wrong option earns the penalty.
- **Integer and numerical:** compared with the exact value, value ± tolerance, or a min–max range.

A question marked for review without an answer is not evaluated. An answered question that is also marked for review is evaluated.

### Release policies

| Policy | Results visible |
|---|---|
| `immediate` | As soon as the attempt is submitted |
| `on_close` | After `closes_at` |
| `scheduled` | After `release_at` |
| `manual` | When an admin presses **Release results now** |

## Hybrid generation

1. **Requirements → blueprint** (`_shared/blueprint.ts`). Each section is split into slots (section × chapter × difficulty) using the difficulty mix (largest remainder), with chapters rotated evenly. The builder checks that counts, marks, types, chapters, the marking scheme and release settings are consistent, and that marks add up to the requested total.
2. **Bank first.** `search_question_bank` ranks approved questions in the same subject, chapter, type and difficulty. It prefers matching topics, rarely used questions and questions not used in the last two weeks. Questions are never repeated within a paper.
3. **Estimate.** Remaining gaps × tokens per question × configured prices, with no calls made. A job is saved with the plan.
4. **Generate in batches.** Each call to the `api` function (`POST /ai`, action `generate`) does one batch of up to `batch_size` questions:
   - It locks the job and checks the quotas.
   - It retrieves only the most relevant excerpts (`search_chunks`, full-text search) from the indexed study material. If the admin ticked specific PDFs on the Generate page (`document_ids`), only those are searched, and their best pages are used even when no words match the chapter names.
   - It calls the configured provider, or the free mock.
   - It records tokens and cost in `ai_calls`.
5. **Validate** (`_shared/validate.ts`). Every generated question goes through these checks:
   - **Structure:** the strict schema, option/key agreement, and exactly one key for single-correct questions.
   - **Calculation:** an independent recomputation of the model's verification expression with a safe evaluator.
   - **Originality:** a duplicate and near-duplicate check (trigram similarity) and a check for long runs copied from the source text.
   - **Fit:** difficulty and type match the slot.

   Failures are discarded and reported; anything uncertain is flagged. Everything is saved as a **draft**, with source page references.
6. **Review.** The admin approves, edits or rejects each question. A rejected question's slot is filled again on the next batch.
7. **Assemble.** `assemble_exam_from_job` builds a draft exam from approved questions only. It reports any slot that is short rather than silently creating an incomplete paper, and offers to create the exam with the questions available.
8. **Publish.** This snapshots the paper and freezes it.

## Knowledge base

The admin uploads a PDF. It goes to the private `documents` bucket in Neon Object Storage through a short-lived upload URL signed by the `api` function (or through the function itself if the browser cannot reach storage directly). The browser then runs the rest:

1. Computes a SHA-256 hash, so the same file is never processed twice.
2. Extracts text per page with pdf.js.
3. Detects scanned PDFs by their text density, and marks them `needs_ocr`.
4. Splits the text into overlapping chunks of about 2,400 characters with page ranges and detected headings. Paragraphs and equations are not split.
5. Inserts the chunks in batches.

Replacing a document creates a new version and deactivates the old one. Deactivated documents are excluded from retrieval.
