-- =====================================================================
-- JEE Exam Portal — core types and tables (Neon Postgres)
-- Every table lives in `public` (exposed through the Neon Data API) but is
-- protected by Row Level Security in the next migration. Internal helpers
-- live in the private `app` schema, which is NOT exposed through the API.
--
-- Prerequisites on the Neon branch (see README): Neon Auth enabled and the
-- Data API created with Neon Auth — this provides the `authenticated` role
-- and the `auth.user_id()` function used throughout.
-- User ids are the Neon Auth user id (JWT `sub`), stored as text.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;

-- ---------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------
create type public.app_role        as enum ('student', 'admin');
create type public.question_type   as enum ('single', 'multiple', 'integer', 'numerical');
create type public.difficulty      as enum ('easy', 'medium', 'hard');
create type public.question_status as enum ('draft', 'in_review', 'approved', 'rejected', 'archived');
create type public.question_origin as enum ('manual', 'ai', 'import');
create type public.doc_status      as enum ('uploaded', 'processing', 'ready', 'needs_ocr', 'failed');
create type public.exam_kind       as enum ('jee_main', 'jee_advanced', 'custom');
create type public.version_status  as enum ('draft', 'published', 'archived');
create type public.release_policy  as enum ('immediate', 'on_close', 'scheduled', 'manual');
create type public.attempt_status  as enum ('in_progress', 'submitted', 'auto_submitted');
create type public.response_state  as enum ('not_visited', 'not_answered', 'answered', 'marked', 'answered_marked');
create type public.job_status      as enum ('planned', 'generating', 'review', 'completed', 'failed', 'cancelled');

-- ---------------------------------------------------------------------
-- Users and roles
-- ---------------------------------------------------------------------
create table public.profiles (
  id          text primary key check (char_length(id) between 1 and 128),
  email       text,
  full_name   text check (char_length(full_name) <= 120),
  avatar_url  text,
  is_blocked  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Role assignments. Only server-side functions can write here; there is no
-- client-side way to become an admin.
create table public.user_roles (
  user_id    text not null references public.profiles (id) on delete cascade,
  role       public.app_role not null,
  granted_by text references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

-- E-mails that become admin automatically on their first Google sign-in.
-- Lives in the private schema; edit it only from the Neon SQL Editor.
create table app.admin_invites (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Syllabus taxonomy
-- ---------------------------------------------------------------------
create table public.subjects (
  id    uuid primary key default gen_random_uuid(),
  code  text not null unique check (code ~ '^[A-Z]{2,8}$'),
  name  text not null,
  sort  int  not null default 0
);

create table public.chapters (
  id         uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects (id) on delete restrict,
  name       text not null check (char_length(name) between 1 and 200),
  sort       int  not null default 0,
  unique (subject_id, name)
);

-- Topics; a topic with parent_id set is a subtopic.
create table public.topics (
  id         uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  parent_id  uuid references public.topics (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  sort       int  not null default 0,
  unique nulls not distinct (chapter_id, parent_id, name)
);

-- ---------------------------------------------------------------------
-- Knowledge base (uploaded study material)
-- ---------------------------------------------------------------------
create table public.documents (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null check (char_length(title) between 1 and 300),
  author                text,
  source                text,
  subject_id            uuid references public.subjects (id) on delete set null,
  storage_path          text not null,
  sha256                text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_size             bigint not null check (file_size > 0 and file_size <= 104857600),
  page_count            int check (page_count >= 0),
  status                public.doc_status not null default 'uploaded',
  error                 text,
  retries               int not null default 0,
  version               int not null default 1,
  previous_id           uuid references public.documents (id) on delete set null,
  is_active             boolean not null default true,
  authorized_confirmed  boolean not null check (authorized_confirmed),
  license_note          text,
  uploaded_by           text references public.profiles (id) on delete set null,
  processed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- The same file (same hash) is stored and processed only once.
create unique index documents_active_sha_uq on public.documents (sha256) where is_active;

create table public.document_chunks (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references public.documents (id) on delete cascade,
  chunk_index    int  not null check (chunk_index >= 0),
  page_start     int,
  page_end       int,
  heading        text,
  chapter_id     uuid references public.chapters (id) on delete set null,
  content        text not null check (char_length(content) between 1 and 8000),
  token_estimate int,
  tsv            tsvector generated always as
                 (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
  unique (document_id, chunk_index)
);
create index document_chunks_tsv_idx on public.document_chunks using gin (tsv);
create index document_chunks_chapter_idx on public.document_chunks (chapter_id);

-- ---------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------
create table public.generation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  created_by          text references public.profiles (id) on delete set null,
  status              public.job_status not null default 'planned',
  request             jsonb not null,
  blueprint           jsonb not null,
  plan                jsonb not null default '{}'::jsonb,
  exam_id             uuid,
  provider            text,
  model               text,
  questions_requested int  not null default 0,
  questions_generated int  not null default 0,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  est_cost_usd        numeric(12, 4) not null default 0,
  actual_cost_usd     numeric(12, 4) not null default 0,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.questions (
  id                 uuid primary key default gen_random_uuid(),
  subject_id         uuid not null references public.subjects (id) on delete restrict,
  chapter_id         uuid references public.chapters (id) on delete set null,
  topic_id           uuid references public.topics (id) on delete set null,
  subtopic           text,
  type               public.question_type not null,
  difficulty         public.difficulty not null default 'medium',
  statement          text not null check (char_length(statement) between 5 and 20000),
  image_path         text,
  marks              numeric(6, 2) not null default 4 check (marks > 0),
  negative_marks     numeric(6, 2) not null default 1 check (negative_marks >= 0),
  learning_objective text,
  status             public.question_status not null default 'draft',
  origin             public.question_origin not null default 'manual',
  source_refs        jsonb not null default '[]'::jsonb,
  validation         jsonb not null default '{}'::jsonb,
  tags               text[] not null default '{}',
  fingerprint        text,
  usage_count        int not null default 0,
  last_used_at       timestamptz,
  generation_job_id  uuid references public.generation_jobs (id) on delete set null,
  created_by         text references public.profiles (id) on delete set null,
  reviewed_by        text references public.profiles (id) on delete set null,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  tsv                tsvector generated always as (
                       to_tsvector('english', statement || ' ' || coalesce(subtopic, '') || ' ' ||
                                              coalesce(learning_objective, ''))) stored
);
create index questions_filter_idx on public.questions (subject_id, chapter_id, topic_id, type, difficulty, status);
create index questions_status_idx on public.questions (status, updated_at desc);
create index questions_tsv_idx on public.questions using gin (tsv);
create index questions_trgm_idx on public.questions using gin (statement extensions.gin_trgm_ops);
create index questions_fingerprint_idx on public.questions (fingerprint);
create index questions_job_idx on public.questions (generation_job_id);

create table public.question_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  label       text not null check (label ~ '^[A-H]$'),
  content     text not null check (char_length(content) between 1 and 4000),
  sort        int not null default 0,
  unique (question_id, label)
);

-- Answer keys are kept apart from the question text so they can be locked
-- down more tightly (admin-only, never readable by students).
create table public.question_answer_keys (
  question_id     uuid primary key references public.questions (id) on delete cascade,
  correct_options text[] not null default '{}',
  numeric_value   numeric,
  tolerance       numeric not null default 0 check (tolerance >= 0),
  range_min       numeric,
  range_max       numeric,
  check (range_min is null or range_max is null or range_min <= range_max)
);

create table public.question_solutions (
  question_id  uuid primary key references public.questions (id) on delete cascade,
  solution     text not null,
  concepts     text,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Marking schemes and templates (versioned, never hard-coded)
-- ---------------------------------------------------------------------
create table public.marking_schemes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  version     int  not null default 1,
  description text,
  rules       jsonb not null,
  is_active   boolean not null default true,
  created_by  text references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (name, version)
);

create table public.exam_templates (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  kind              public.exam_kind not null,
  version           int  not null default 1,
  description       text,
  config            jsonb not null,
  marking_scheme_id uuid references public.marking_schemes (id) on delete set null,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (name, version)
);

-- ---------------------------------------------------------------------
-- Exams
-- ---------------------------------------------------------------------
create table public.exams (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 200),
  kind        public.exam_kind not null default 'custom',
  description text,
  is_archived boolean not null default false,
  created_by  text references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.generation_jobs
  add constraint generation_jobs_exam_fk foreign key (exam_id) references public.exams (id) on delete set null;

create table public.exam_versions (
  id               uuid primary key default gen_random_uuid(),
  exam_id          uuid not null references public.exams (id) on delete cascade,
  version_no       int  not null default 1,
  title            text not null,
  instructions     text not null default '',
  duration_minutes int  not null check (duration_minutes between 1 and 720),
  total_marks      numeric(8, 2) not null default 0,
  marking_rules    jsonb not null,
  sections         jsonb not null default '[]'::jsonb,
  blueprint        jsonb,
  release_policy   public.release_policy not null default 'immediate',
  release_at       timestamptz,
  opens_at         timestamptz,
  closes_at        timestamptz,
  max_attempts     int not null default 1 check (max_attempts between 1 and 50),
  status           public.version_status not null default 'draft',
  published_at     timestamptz,
  published_by     text references public.profiles (id) on delete set null,
  created_by       text references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (exam_id, version_no),
  check (opens_at is null or closes_at is null or opens_at < closes_at),
  check (release_policy <> 'on_close' or closes_at is not null),
  check (release_policy <> 'scheduled' or release_at is not null)
);
create unique index exam_versions_one_published on public.exam_versions (exam_id) where status = 'published';
create index exam_versions_status_idx on public.exam_versions (status, opens_at);

-- Questions inside an exam version. On publish, the question text/options
-- are copied into `content` so later edits to the bank never change an
-- exam that students are already taking.
create table public.exam_questions (
  id              uuid primary key default gen_random_uuid(),
  exam_version_id uuid not null references public.exam_versions (id) on delete cascade,
  position        int  not null check (position >= 1),
  section_key     text not null default 'main',
  question_id     uuid references public.questions (id) on delete set null,
  subject_id      uuid references public.subjects (id) on delete set null,
  chapter_id      uuid references public.chapters (id) on delete set null,
  topic_id        uuid references public.topics (id) on delete set null,
  type            public.question_type,
  difficulty      public.difficulty,
  marks           numeric(6, 2) not null check (marks > 0),
  negative_marks  numeric(6, 2) not null default 0 check (negative_marks >= 0),
  scoring         jsonb,
  content         jsonb,
  unique (exam_version_id, position),
  unique (exam_version_id, question_id)
);
create index exam_questions_version_idx on public.exam_questions (exam_version_id, position);

-- Snapshotted answer key + solution. Admin-only table.
create table public.exam_question_keys (
  exam_question_id uuid primary key references public.exam_questions (id) on delete cascade,
  answer           jsonb not null,
  solution         text,
  concepts         text
);

-- ---------------------------------------------------------------------
-- Attempts, responses, results
-- ---------------------------------------------------------------------
create table public.exam_attempts (
  id              uuid primary key default gen_random_uuid(),
  exam_version_id uuid not null references public.exam_versions (id) on delete restrict,
  user_id         text not null references public.profiles (id) on delete cascade,
  attempt_no      int  not null default 1,
  started_at      timestamptz not null default now(),
  deadline_at     timestamptz not null,
  submitted_at    timestamptz,
  status          public.attempt_status not null default 'in_progress',
  submit_reason   text,
  last_seen_at    timestamptz,
  unique (user_id, exam_version_id, attempt_no)
);
create unique index exam_attempts_one_open on public.exam_attempts (user_id, exam_version_id) where status = 'in_progress';
create index exam_attempts_deadline_idx on public.exam_attempts (deadline_at) where status = 'in_progress';
create index exam_attempts_version_idx on public.exam_attempts (exam_version_id, status);

create table public.responses (
  attempt_id         uuid not null references public.exam_attempts (id) on delete cascade,
  exam_question_id   uuid not null references public.exam_questions (id) on delete cascade,
  answer             jsonb,
  state              public.response_state not null default 'not_visited',
  seq                bigint not null default 0,
  time_spent_seconds int not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (attempt_id, exam_question_id)
);

create table public.results (
  attempt_id         uuid primary key references public.exam_attempts (id) on delete cascade,
  user_id            text not null references public.profiles (id) on delete cascade,
  exam_version_id    uuid not null references public.exam_versions (id) on delete cascade,
  score              numeric(10, 2) not null,
  max_score          numeric(10, 2) not null,
  correct            int not null,
  incorrect          int not null,
  partial            int not null,
  unanswered         int not null,
  accuracy           numeric(6, 2),
  percentage         numeric(6, 2),
  time_taken_seconds int,
  breakdown          jsonb not null,
  per_question       jsonb not null,
  computed_at        timestamptz not null default now()
);
create index results_user_idx on public.results (user_id, computed_at desc);
create index results_version_idx on public.results (exam_version_id);

-- Integrity events reported by the exam client (tab hidden, reconnect...).
create table public.attempt_events (
  id         bigint generated always as identity primary key,
  attempt_id uuid not null references public.exam_attempts (id) on delete cascade,
  user_id    text not null references public.profiles (id) on delete cascade,
  kind       text not null check (kind in ('visibility_hidden', 'visibility_visible', 'fullscreen_exit',
                                           'offline', 'online', 'resume', 'copy_attempt')),
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index attempt_events_attempt_idx on public.attempt_events (attempt_id, created_at);

-- ---------------------------------------------------------------------
-- AI usage, settings, audit, rate limiting
-- ---------------------------------------------------------------------
create table public.ai_calls (
  id            bigint generated always as identity primary key,
  job_id        uuid references public.generation_jobs (id) on delete set null,
  user_id       text references public.profiles (id) on delete set null,
  provider      text not null,
  model         text not null,
  purpose       text not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  cost_usd      numeric(12, 6) not null default 0,
  ok            boolean not null,
  error         text,
  latency_ms    int,
  created_at    timestamptz not null default now()
);
create index ai_calls_created_idx on public.ai_calls (created_at desc);

-- Non-secret runtime configuration (AI provider/model, prices, quotas).
-- API keys are NEVER stored here — they live in Edge Function secrets.
create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by text references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    text references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

create table app.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);
