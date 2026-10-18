-- =====================================================================
-- Student papers and shared study material
--
-- * Every signed-in user can make a practice paper for themselves: approved
--   bank questions first, AI questions for the gaps (with a per-student daily
--   limit). AI questions written for a student's paper are checked
--   automatically and stay private to that paper; they never enter the bank.
-- * A student's own papers, attempts and marks are visible only to that
--   student. Administrators' screens and reports exclude them.
-- * Any signed-in user can upload study material; it is shared with everyone
--   immediately. Uploaders manage their own files; admins manage all.
--
-- Safe to run on an existing database (Neon SQL Editor). Run after
-- 20261019000009_material_selection.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------
alter table public.exams add column if not exists owner_id text references public.profiles (id) on delete cascade;
alter table public.questions add column if not exists owner_id text references public.profiles (id) on delete cascade;
alter table public.generation_jobs add column if not exists is_practice boolean not null default false;
create index if not exists exams_owner_idx on public.exams (owner_id);
create index if not exists questions_owner_idx on public.questions (owner_id);
create index if not exists jobs_practice_idx on public.generation_jobs (created_by, is_practice);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- A user id made safe for use as a storage folder name.
create or replace function app.safe_path_id(p text)
returns text
language sql immutable set search_path = ''
as $$
  select regexp_replace(coalesce(p, ''), '[^A-Za-z0-9._-]', '_', 'g');
$$;
grant execute on function app.safe_path_id(text) to authenticated;

-- Owner of a student's private paper (null for papers published by admins).
create or replace function app.version_owner(p_version uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select e.owner_id from public.exam_versions v join public.exams e on e.id = v.exam_id where v.id = p_version;
$$;

create or replace function app.is_private_version(p_version uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.version_owner(p_version) is not null;
$$;
grant execute on function app.version_owner(uuid), app.is_private_version(uuid) to authenticated;

-- Admins may work on any job; a student only on their own practice job.
create or replace function app.require_job_access(p_job uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if app.is_admin() then return; end if;
  if not exists (select 1 from public.generation_jobs j
                  where j.id = p_job and j.is_practice and j.created_by = (select auth.user_id())) then
    raise exception 'Generation job not found' using errcode = 'P0002';
  end if;
end;
$$;

-- A private paper can only be attempted by its owner (covers start_attempt).
create or replace function app.guard_private_attempt()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_owner text := app.version_owner(new.exam_version_id);
begin
  if v_owner is not null and v_owner <> new.user_id then
    raise exception 'This exam is not available' using errcode = 'P0002';
  end if;
  return new;
end;
$$;
drop trigger if exists exam_attempts_private_guard on public.exam_attempts;
create trigger exam_attempts_private_guard before insert on public.exam_attempts
  for each row execute function app.guard_private_attempt();

-- ---------------------------------------------------------------------
-- Privacy of attempts, answers and marks on private papers
-- (admins keep access to papers they publish; never to students' own papers)
-- ---------------------------------------------------------------------
drop policy if exists attempts_select on public.exam_attempts;
create policy attempts_select on public.exam_attempts for select to authenticated
  using (user_id = (select auth.user_id())
         or ((select app.is_admin()) and not app.is_private_version(exam_version_id)));

drop policy if exists responses_select on public.responses;
create policy responses_select on public.responses for select to authenticated
  using (exists (select 1 from public.exam_attempts a
                  where a.id = attempt_id
                    and (a.user_id = (select auth.user_id())
                         or ((select app.is_admin()) and not app.is_private_version(a.exam_version_id)))));

drop policy if exists results_select on public.results;
create policy results_select on public.results for select to authenticated
  using ((user_id = (select auth.user_id()) and app.result_released(attempt_id))
         or ((select app.is_admin()) and not app.is_private_version(exam_version_id)));

drop policy if exists attempt_events_admin on public.attempt_events;
create policy attempt_events_admin on public.attempt_events for select to authenticated
  using ((select app.is_admin()) and exists (
    select 1 from public.exam_attempts a where a.id = attempt_id and not app.is_private_version(a.exam_version_id)));

-- ---------------------------------------------------------------------
-- Reading reference data needed to make a paper
-- ---------------------------------------------------------------------
drop policy if exists marking_schemes_read on public.marking_schemes;
create policy marking_schemes_read on public.marking_schemes for select to authenticated using (is_active);
drop policy if exists exam_templates_read on public.exam_templates;
create policy exam_templates_read on public.exam_templates for select to authenticated using (is_active);
-- AI settings hold limits and prices only (the API key lives in the function's environment)
drop policy if exists app_settings_read_ai on public.app_settings;
create policy app_settings_read_ai on public.app_settings for select to authenticated using (key = 'ai');

-- Students read their own practice jobs (question ids only; content and keys stay protected)
drop policy if exists generation_jobs_own_read on public.generation_jobs;
create policy generation_jobs_own_read on public.generation_jobs for select to authenticated
  using (is_practice and created_by = (select auth.user_id()));

-- The generator logs each AI call as the signed-in user, through a checked,
-- rate-limited function (so nobody can write fake costs to exhaust the budget).
drop policy if exists ai_calls_own_insert on public.ai_calls;
create or replace function public.log_ai_call(p_job uuid, p_provider text, p_model text, p_input_tokens int,
                                              p_output_tokens int, p_cost numeric, p_ok boolean, p_error text,
                                              p_latency_ms int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
begin
  perform app.require_job_access(p_job);
  perform app.check_rate('aicall:' || uid, 120, 3600);
  insert into public.ai_calls (job_id, user_id, provider, model, purpose, input_tokens, output_tokens, cost_usd, ok, error, latency_ms)
  values (p_job, uid, left(p_provider, 40), left(p_model, 120), 'generate_questions',
          greatest(coalesce(p_input_tokens, 0), 0), greatest(coalesce(p_output_tokens, 0), 0),
          least(greatest(coalesce(p_cost, 0), 0), 5), coalesce(p_ok, false), left(p_error, 1000),
          greatest(coalesce(p_latency_ms, 0), 0));
end;
$$;

-- ---------------------------------------------------------------------
-- Shared study material
-- ---------------------------------------------------------------------
drop policy if exists documents_read_shared on public.documents;
create policy documents_read_shared on public.documents for select to authenticated
  using (is_active or uploaded_by = (select auth.user_id()));
drop policy if exists documents_insert_own on public.documents;
create policy documents_insert_own on public.documents for insert to authenticated
  with check (uploaded_by = (select auth.user_id()) and authorized_confirmed
              and storage_path like 'u/' || app.safe_path_id((select auth.user_id())) || '/%');
drop policy if exists documents_update_own on public.documents;
create policy documents_update_own on public.documents for update to authenticated
  using (uploaded_by = (select auth.user_id())) with check (uploaded_by = (select auth.user_id()));
drop policy if exists documents_delete_own on public.documents;
create policy documents_delete_own on public.documents for delete to authenticated
  using (uploaded_by = (select auth.user_id()));

drop policy if exists document_chunks_own on public.document_chunks;
create policy document_chunks_own on public.document_chunks for all to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and d.uploaded_by = (select auth.user_id())))
  with check (exists (select 1 from public.documents d where d.id = document_id and d.uploaded_by = (select auth.user_id())));

-- Uploader names shown next to shared material
create or replace function public.document_uploaders()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(d.id, coalesce(nullif(p.full_name, ''), 'A student')), '{}'::jsonb)
    from public.documents d left join public.profiles p on p.id = d.uploaded_by
   where d.is_active and (select auth.user_id()) is not null;
$$;

-- Storage: everyone may upload PDFs into their own folder (u/<user>/...);
-- read access to a PDF file is for its uploader and admins (others use the
-- indexed text through the generator).
create or replace function public.can_access_file(p_bucket text, p_path text, p_write boolean default false)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  uid text := (select auth.user_id());
begin
  if uid is null or p_path is null or p_path like '%..%' then
    return false;
  end if;
  if app.is_admin() then
    return p_bucket in ('documents', 'question-images');
  end if;
  if p_bucket = 'documents' then
    return p_path like 'u/' || app.safe_path_id(uid) || '/%' and lower(p_path) like '%.pdf';
  end if;
  if p_write or p_bucket <> 'question-images' then
    return false;
  end if;
  -- students may read a figure only if it belongs to an exam they attempted
  return exists (
    select 1
      from public.exam_questions eq
      join public.exam_attempts a on a.exam_version_id = eq.exam_version_id
     where a.user_id = uid
       and eq.content ->> 'image_path' = p_path
  );
end;
$$;

-- Retrieval of study-material excerpts: now available to every signed-in user
-- (the generator calls it as the student making a paper).
create or replace function public.search_chunks(p_query text, p_subject uuid default null,
                                                p_chapter uuid default null, p_limit int default 6,
                                                p_documents uuid[] default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ts tsquery;
  v_docs uuid[] := nullif(p_documents, '{}');
begin
  perform app.require_user();
  v_ts := to_tsquery('english', coalesce(nullif(array_to_string(
            array(select lexeme from unnest(to_tsvector('english', coalesce(p_query, ''))) limit 30), ' | '), ''), 'xyzzynomatch'));
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.rank desc)
      from (
        select c.id, c.document_id, d.title as document_title, c.page_start, c.page_end, c.heading,
               c.content, ts_rank_cd(c.tsv, v_ts) + case when c.chapter_id = p_chapter then 0.5 else 0 end as rank
          from public.document_chunks c
          join public.documents d on d.id = c.document_id
         where d.is_active and d.status = 'ready'
           and (case when v_docs is not null
                     then d.id = any(v_docs)
                     else (p_subject is null or d.subject_id is null or d.subject_id = p_subject)
                          and (c.tsv @@ v_ts or (p_chapter is not null and c.chapter_id = p_chapter))
                end)
         order by rank desc, c.document_id, c.page_start
         limit least(greatest(p_limit, 1), 20)
      ) x), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Question bank searches never include students' private questions
-- ---------------------------------------------------------------------
create or replace function public.search_question_bank(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_chapters uuid[] := (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'chapter_ids', '[]')) x);
  v_topics   uuid[] := (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'topic_ids', '[]')) x);
  v_exclude  uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'exclude_ids', '[]')) x), '{}');
  v_text     text := nullif(p ->> 'text', '');
  v_admin    boolean := app.is_admin();
begin
  perform app.require_user();
  return coalesce((
    select jsonb_agg(case when v_admin then to_jsonb(x) else jsonb_build_object('id', x.id) end order by x.rank desc)
      from (
        select q.id, q.chapter_id, q.topic_id, q.type, q.difficulty, q.marks, q.usage_count, left(q.statement, 200) as preview,
               ( case when v_topics is not null and q.topic_id = any (v_topics) then 3 else 0 end
               + case when q.difficulty::text = p ->> 'difficulty' then 2 else 0 end
               - least(q.usage_count, 10) * 0.3
               - case when q.last_used_at > now() - interval '14 days' then 1 else 0 end
               + case when v_text is not null then ts_rank(q.tsv, websearch_to_tsquery('english', v_text)) * 2 else 0 end
               + random() * 0.2 ) as rank
          from public.questions q
         where q.status = 'approved'
           and q.owner_id is null
           and q.subject_id = (p ->> 'subject_id')::uuid
           and q.type = (p ->> 'type')::public.question_type
           and (v_chapters is null or q.chapter_id = any (v_chapters))
           and (v_topics is null or coalesce((p ->> 'strict_topic')::boolean, false) = false or q.topic_id = any (v_topics))
           and (p ->> 'difficulty' is null or coalesce((p ->> 'strict_difficulty')::boolean, true) = false
                or q.difficulty = (p ->> 'difficulty')::public.difficulty)
           and not (q.id = any (v_exclude))
         order by rank desc
         limit least(coalesce((p ->> 'limit')::int, 10), 100)
      ) x), '[]'::jsonb);
end;
$$;

create or replace function public.find_similar_questions(p_statement text, p_subject uuid default null,
                                                         p_threshold real default 0.55, p_limit int default 5)
returns table (id uuid, similarity real, statement text, status public.question_status, exact boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_admin boolean := app.is_admin();
begin
  perform app.require_user();
  return query
    select q.id, extensions.similarity(q.statement, p_statement) as sim,
           case when v_admin then left(q.statement, 300) end, q.status,
           q.fingerprint = app.text_fingerprint(p_statement)
      from public.questions q
     where (p_subject is null or q.subject_id = p_subject)
       and q.status <> 'rejected'
       and (case when v_admin then q.owner_id is null
                 else q.status = 'approved' and (q.owner_id is null or q.owner_id = (select auth.user_id())) end)
       and (q.fingerprint = app.text_fingerprint(p_statement)
            or extensions.similarity(q.statement, p_statement) >= p_threshold)
     order by sim desc
     limit least(p_limit, 20);
end;
$$;

create or replace function public.admin_list_questions(p_filters jsonb default '{}'::jsonb, p_limit int default 25, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
begin
  perform app.require_admin();
  return (
    with base as (
      select q.* from public.questions q
       where q.owner_id is null
         and (f ->> 'subject_id' is null or q.subject_id = (f ->> 'subject_id')::uuid)
         and (f ->> 'chapter_id' is null or q.chapter_id = (f ->> 'chapter_id')::uuid)
         and (f ->> 'topic_id' is null or q.topic_id = (f ->> 'topic_id')::uuid)
         and (f ->> 'type' is null or q.type = (f ->> 'type')::public.question_type)
         and (f ->> 'difficulty' is null or q.difficulty = (f ->> 'difficulty')::public.difficulty)
         and (case when f ->> 'status' is null then q.status <> 'archived'
                   else q.status = (f ->> 'status')::public.question_status end)
         and (f ->> 'origin' is null or q.origin = (f ->> 'origin')::public.question_origin)
         and (f ->> 'job_id' is null or q.generation_job_id = (f ->> 'job_id')::uuid)
         and (nullif(f ->> 'q', '') is null or q.tsv @@ websearch_to_tsquery('english', f ->> 'q')
              or q.statement ilike '%' || (f ->> 'q') || '%')
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', b.id, 'statement', left(b.statement, 400), 'type', b.type, 'difficulty', b.difficulty,
                 'status', b.status, 'origin', b.origin, 'marks', b.marks, 'subject', s.code,
                 'chapter', c.name, 'topic', t.name, 'usage_count', b.usage_count,
                 'flags', coalesce(b.validation -> 'flags', '[]'::jsonb), 'updated_at', b.updated_at)
               order by b.updated_at desc)
          from (select * from base order by updated_at desc
                 limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) b
          join public.subjects s on s.id = b.subject_id
          left join public.chapters c on c.id = b.chapter_id
          left join public.topics t on t.id = b.topic_id), '[]'::jsonb)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Generation support: job owners (students) may run their own practice jobs
-- ---------------------------------------------------------------------
create or replace function public.claim_generation_job(p_job uuid, p_seconds int default 150)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_job_access(p_job);
  update public.generation_jobs
     set locked_until = now() + make_interval(secs => least(greatest(p_seconds, 10), 600)),
         status = case when status = 'planned' then 'generating'::public.job_status else status end
   where id = p_job and (locked_until is null or locked_until < now())
     and status in ('planned', 'generating', 'review');
  return found;
end;
$$;

create or replace function public.release_generation_job(p_job uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_job_access(p_job);
  update public.generation_jobs set locked_until = null where id = p_job;
end;
$$;

create or replace function public.record_generation_batch(p_job uuid, p_slot_id text, p_question_ids uuid[],
                                                          p_input_tokens int, p_output_tokens int, p_cost numeric,
                                                          p_error text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.generation_jobs;
  v_slots jsonb;
  v_ids uuid[] := coalesce(p_question_ids, '{}');
begin
  perform app.require_job_access(p_job);
  select * into j from public.generation_jobs where id = p_job for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if j.is_practice then
    -- only questions actually written for this job may be attached to it
    select coalesce(array_agg(q.id), '{}') into v_ids from public.questions q
     where q.id = any (v_ids) and q.generation_job_id = p_job and q.owner_id = j.created_by;
  end if;

  select coalesce(jsonb_agg(case when s ->> 'slot_id' = p_slot_id
                                 then jsonb_set(s, '{generated_ids}',
                                                coalesce(s -> 'generated_ids', '[]'::jsonb) || to_jsonb(v_ids)) ||
                                      jsonb_build_object('question_ids',
                                                coalesce(s -> 'question_ids', '[]'::jsonb) || to_jsonb(v_ids),
                                                'attempts', coalesce((s ->> 'attempts')::int, 0) + 1)
                                 else s end), '[]'::jsonb)
    into v_slots
    from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) s;

  update public.generation_jobs
     set plan = jsonb_set(plan, '{slots}', v_slots),
         questions_generated = questions_generated + cardinality(v_ids),
         input_tokens = input_tokens + coalesce(p_input_tokens, 0),
         output_tokens = output_tokens + coalesce(p_output_tokens, 0),
         actual_cost_usd = actual_cost_usd + coalesce(p_cost, 0),
         error = p_error,
         locked_until = null
   where id = p_job
  returning * into j;
  return to_jsonb(j) - 'request';
end;
$$;

create or replace function public.generation_job_progress(p_job uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  j public.generation_jobs;
begin
  perform app.require_job_access(p_job);
  select * into j from public.generation_jobs where id = p_job;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'job', to_jsonb(j) - 'plan',
    'slots', coalesce((
      select jsonb_agg(s || jsonb_build_object(
               'approved', (select count(*) from public.questions q
                             where q.status = 'approved'
                               and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(s -> 'question_ids', '[]')) x)),
               'pending', (select count(*) from public.questions q
                            where q.status in ('draft', 'in_review')
                              and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(s -> 'question_ids', '[]')) x)),
               'remaining', greatest(0, (s ->> 'count')::int - (select count(*) from public.questions q
                            where q.status in ('approved', 'draft', 'in_review')
                              and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(s -> 'question_ids', '[]')) x))))
             order by ord)
        from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) with ordinality t(s, ord)), '[]'::jsonb),
    'estimate', j.plan -> 'estimate'
  );
end;
$$;

-- Usage figures for the signed-in user (and the overall budget).
create or replace function public.my_ai_usage()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
begin
  return jsonb_build_object(
    'my_questions_24h', (select count(*) from public.questions
                          where origin = 'ai' and owner_id = uid and created_at > now() - interval '24 hours'),
    'questions_24h', (select count(*) from public.questions where origin = 'ai' and created_at > now() - interval '24 hours'),
    'cost_30d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > now() - interval '30 days')
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Practice papers
-- ---------------------------------------------------------------------
-- Create a practice job from a plan computed by the generator. Only approved
-- bank questions may be pre-filled; AI questions are attached later.
create or replace function public.practice_create_job(p_request jsonb, p_blueprint jsonb, p_plan jsonb,
                                                      p_provider text, p_model text, p_requested int, p_est numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  v_slots jsonb := '[]'::jsonb;
  s jsonb;
  v_ids uuid[];
  v_total int := 0;
  v_id uuid;
begin
  perform app.ensure_profile();
  perform app.check_rate('practice:' || uid, 10, 3600);
  if exists (select 1 from public.profiles p where p.id = uid and p.is_blocked) then
    raise exception 'Your account is not allowed to take exams. Contact the administrator.' using errcode = '42501';
  end if;

  for s in select * from jsonb_array_elements(coalesce(p_plan -> 'slots', '[]'::jsonb)) loop
    v_total := v_total + greatest(coalesce((s ->> 'count')::int, 0), 0);
    select coalesce(array_agg(q.id), '{}') into v_ids
      from public.questions q
     where q.status = 'approved' and q.owner_id is null
       and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(s -> 'bank_ids', '[]')) x);
    v_slots := v_slots || (s || jsonb_build_object('bank_ids', to_jsonb(v_ids), 'question_ids', to_jsonb(v_ids),
                                                   'generated_ids', '[]'::jsonb, 'attempts', 0));
  end loop;
  if v_total < 1 or v_total > 200 then
    raise exception 'A paper must have between 1 and 200 questions' using errcode = '22023';
  end if;

  insert into public.generation_jobs (created_by, status, request, blueprint, plan, provider, model,
                                      questions_requested, est_cost_usd, is_practice)
  values (uid, 'planned', p_request, coalesce(p_blueprint, '{}'::jsonb), jsonb_set(p_plan, '{slots}', v_slots),
          p_provider, p_model, greatest(coalesce(p_requested, 0), 0), greatest(coalesce(p_est, 0), 0), true)
  returning id into v_id;
  return v_id;
end;
$$;

-- Save one AI-written question for the caller's practice paper. It is checked
-- like a manual approval (key, options, solution) and kept private.
create or replace function public.practice_save_question(p_job uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  j public.generation_jobs;
  v_id uuid;
  v_type public.question_type := (p ->> 'type')::public.question_type;
  v_subject uuid := (p ->> 'subject_id')::uuid;
  v_chapter uuid := nullif(p ->> 'chapter_id', '')::uuid;
  v_topic uuid := nullif(p ->> 'topic_id', '')::uuid;
  v_problems text[];
  o jsonb;
  i int := 0;
begin
  select * into j from public.generation_jobs where id = p_job and is_practice and created_by = uid;
  if not found then raise exception 'Generation job not found' using errcode = 'P0002'; end if;
  if j.exam_id is not null then raise exception 'This paper is already finished' using errcode = 'P0001'; end if;
  if (select count(*) from public.questions where generation_job_id = p_job) >= j.questions_requested + 20 then
    raise exception 'Too many questions for this paper' using errcode = 'P0001';
  end if;
  if v_chapter is not null and not exists (select 1 from public.chapters where id = v_chapter and subject_id = v_subject) then
    v_chapter := null;
  end if;
  if v_topic is not null and not exists (select 1 from public.topics where id = v_topic and chapter_id = v_chapter) then
    v_topic := null;
  end if;

  insert into public.questions (subject_id, chapter_id, topic_id, subtopic, type, difficulty, statement,
                                marks, negative_marks, learning_objective, tags, status, origin, source_refs,
                                validation, generation_job_id, created_by, owner_id)
  values (v_subject, v_chapter, v_topic, left(p ->> 'subtopic', 200), v_type,
          coalesce((p ->> 'difficulty')::public.difficulty, 'medium'), p ->> 'statement',
          coalesce((p ->> 'marks')::numeric, 4), coalesce((p ->> 'negative_marks')::numeric, 0),
          left(p ->> 'learning_objective', 1000), array['ai', 'practice'], 'draft', 'ai',
          coalesce(p -> 'source_refs', '[]'::jsonb), coalesce(p -> 'validation', '{}'::jsonb), p_job, uid, uid)
  returning id into v_id;

  if v_type in ('single', 'multiple') then
    for o in select * from jsonb_array_elements(coalesce(p -> 'options', '[]'::jsonb)) loop
      i := i + 1;
      insert into public.question_options (question_id, label, content, sort)
      values (v_id, upper(coalesce(o ->> 'label', chr(64 + i))), o ->> 'content', i);
    end loop;
  end if;
  if jsonb_typeof(p -> 'answer') = 'object' then
    insert into public.question_answer_keys (question_id, correct_options, numeric_value, tolerance, range_min, range_max)
    values (v_id,
            coalesce((select array_agg(distinct upper(x) order by upper(x))
                        from jsonb_array_elements_text(coalesce(p -> 'answer' -> 'options', '[]'::jsonb)) x), '{}'),
            (p -> 'answer' ->> 'value')::numeric, coalesce((p -> 'answer' ->> 'tolerance')::numeric, 0),
            (p -> 'answer' ->> 'min')::numeric, (p -> 'answer' ->> 'max')::numeric);
  end if;
  if nullif(btrim(p ->> 'solution'), '') is not null then
    insert into public.question_solutions (question_id, solution, concepts) values (v_id, p ->> 'solution', p ->> 'concepts');
  end if;

  v_problems := app.question_problems(v_id);
  if cardinality(v_problems) > 0 then
    delete from public.questions where id = v_id;
    raise exception 'Question failed the automatic checks: %', array_to_string(v_problems, '; ') using errcode = 'P0001';
  end if;
  update public.questions set status = 'approved', reviewed_at = now() where id = v_id;
  return v_id;
end;
$$;

-- Turn the caller's practice job into a private, published paper.
create or replace function public.practice_finish(p_job uuid, p_allow_partial boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  j public.generation_jobs;
  r jsonb;
  slot jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_have int;
  v_exam uuid;
  v_version uuid;
  v_pos int := 0;
  v_ids uuid[];
  v_used uuid[] := '{}';
  qid uuid;
  v_pub jsonb;
begin
  select * into j from public.generation_jobs where id = p_job and is_practice and created_by = uid for update;
  if not found then raise exception 'Generation job not found' using errcode = 'P0002'; end if;
  if j.exam_id is not null then
    return jsonb_build_object('ok', true, 'exam_id', j.exam_id,
      'version_id', (select id from public.exam_versions where exam_id = j.exam_id and status = 'published' limit 1));
  end if;
  r := j.request;

  -- usable questions: approved bank questions, or approved questions written for this job
  for slot in select * from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) loop
    select count(*) into v_have from public.questions q
     where q.status = 'approved' and (q.owner_id is null or (q.owner_id = uid and q.generation_job_id = p_job))
       and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(slot -> 'question_ids', '[]')) x);
    if v_have < (slot ->> 'count')::int then
      v_missing := v_missing || jsonb_build_object('label', slot ->> 'label', 'needed', (slot ->> 'count')::int, 'have', v_have);
    end if;
  end loop;
  if jsonb_array_length(v_missing) > 0 and not p_allow_partial then
    return jsonb_build_object('ok', false, 'missing', v_missing);
  end if;

  insert into public.exams (title, kind, description, created_by, owner_id)
  values (left(coalesce(nullif(btrim(r ->> 'title'), ''), 'My practice paper'), 200),
          coalesce((r ->> 'kind')::public.exam_kind, 'custom'), 'Practice paper', uid, uid)
  returning id into v_exam;

  insert into public.exam_versions (exam_id, version_no, title, instructions, duration_minutes, marking_rules, sections,
                                    blueprint, release_policy, max_attempts, created_by)
  values (v_exam, 1, left(coalesce(nullif(btrim(r ->> 'title'), ''), 'My practice paper'), 200),
          left(coalesce(r ->> 'instructions', ''), 4000),
          least(greatest(coalesce((r ->> 'duration_minutes')::int, 60), 1), 720),
          coalesce(r -> 'marking_rules', '{}'::jsonb), coalesce(j.blueprint -> 'sections', '[]'::jsonb), j.blueprint,
          'immediate', least(greatest(coalesce((r ->> 'max_attempts')::int, 3), 1), 10), uid)
  returning id into v_version;

  for slot in select * from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) loop
    select array_agg(q.id order by array_position(
             array(select x::uuid from jsonb_array_elements_text(slot -> 'question_ids') x), q.id))
      into v_ids
      from public.questions q
     where q.status = 'approved' and (q.owner_id is null or (q.owner_id = uid and q.generation_job_id = p_job))
       and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(slot -> 'question_ids', '[]')) x)
       and not (q.id = any (v_used));
    v_have := 0;
    foreach qid in array coalesce(v_ids, '{}') loop
      exit when v_have >= (slot ->> 'count')::int;
      v_pos := v_pos + 1;
      v_have := v_have + 1;
      v_used := v_used || qid;
      insert into public.exam_questions (exam_version_id, position, section_key, question_id, subject_id, chapter_id,
                                         topic_id, type, difficulty, marks, negative_marks)
      select v_version, v_pos, slot ->> 'section_key', q.id, q.subject_id, q.chapter_id, q.topic_id, q.type,
             q.difficulty, coalesce((slot ->> 'marks')::numeric, q.marks),
             coalesce((slot ->> 'negative_marks')::numeric, q.negative_marks)
        from public.questions q where q.id = qid;
    end loop;
  end loop;

  if v_pos = 0 then
    raise exception 'No questions are available for this paper yet' using errcode = 'P0001';
  end if;

  v_pub := app.do_publish(v_version);
  if not coalesce((v_pub ->> 'published')::boolean, false) then
    raise exception 'The paper could not be prepared: %', v_pub -> 'issues' using errcode = 'P0001';
  end if;
  update public.generation_jobs set exam_id = v_exam, status = 'completed', locked_until = null where id = p_job;
  return jsonb_build_object('ok', true, 'exam_id', v_exam, 'version_id', v_version, 'questions', v_pos,
                            'missing', v_missing);
end;
$$;

-- Remove one of your own papers from your list (attempts and marks are kept).
create or replace function public.practice_archive(p_exam uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.exams set is_archived = true where id = p_exam and owner_id = app.require_user();
  if not found then raise exception 'Paper not found' using errcode = 'P0002'; end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Student views: official papers + only your own private papers
-- ---------------------------------------------------------------------
create or replace function public.list_my_exams()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  r record;
begin
  for r in select a.id from public.exam_attempts a
            where a.user_id = uid and a.status = 'in_progress' and a.deadline_at < now()
  loop
    perform app.finalize_if_expired(r.id);
  end loop;

  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.is_mine, x.opens_at nulls first, x.created_at desc, x.title)
      from (
        select v.id as version_id, e.id as exam_id, v.title, e.kind, e.description,
               v.duration_minutes, v.total_marks, v.opens_at, v.closes_at, v.max_attempts,
               v.release_policy, e.owner_id is not null as is_mine, e.created_at,
               (select count(*) from public.exam_questions q where q.exam_version_id = v.id) as question_count,
               (select count(*) from public.exam_attempts a where a.exam_version_id = v.id and a.user_id = uid) as my_attempts,
               (select a.id from public.exam_attempts a
                 where a.exam_version_id = v.id and a.user_id = uid and a.status = 'in_progress') as open_attempt_id,
               case when v.opens_at is not null and v.opens_at > now() then 'upcoming'
                    when v.closes_at is not null and v.closes_at <= now() then 'closed'
                    else 'open' end as availability
          from public.exam_versions v
          join public.exams e on e.id = v.exam_id
         where v.status = 'published' and not e.is_archived
           and (e.owner_id is null or e.owner_id = uid)
           and (v.closes_at is null or v.closes_at > now() - interval '30 days')
      ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_exam_overview(p_version uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  v public.exam_versions;
  v_owner text := app.version_owner(p_version);
begin
  select * into v from public.exam_versions where id = p_version and status = 'published';
  if not found or exists (select 1 from public.exams e where e.id = v.exam_id and e.is_archived)
     or (v_owner is not null and v_owner <> uid) then
    raise exception 'This exam is not available' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'version_id', v.id, 'title', v.title, 'instructions', v.instructions, 'duration_minutes', v.duration_minutes,
    'total_marks', v.total_marks, 'marking_rules', v.marking_rules, 'release_policy', v.release_policy,
    'opens_at', v.opens_at, 'closes_at', v.closes_at, 'max_attempts', v.max_attempts, 'server_now', now(),
    'is_mine', v_owner is not null,
    'my_attempts', (select count(*) from public.exam_attempts a where a.exam_version_id = v.id and a.user_id = uid),
    'open_attempt_id', (select a.id from public.exam_attempts a
                         where a.exam_version_id = v.id and a.user_id = uid and a.status = 'in_progress'),
    'sections', coalesce((
      select jsonb_agg(jsonb_build_object('key', x.section_key, 'title', coalesce(
                 (select s ->> 'title' from jsonb_array_elements(v.sections) s where s ->> 'key' = x.section_key), x.section_key),
               'questions', x.n, 'marks', x.marks, 'types', x.types) order by x.first_pos)
        from (select q.section_key, count(*) as n, sum(q.marks) as marks, min(q.position) as first_pos,
                     jsonb_agg(distinct jsonb_build_object('type', q.type, 'marks', q.marks, 'negative', q.negative_marks)) as types
                from public.exam_questions q where q.exam_version_id = v.id group by q.section_key) x), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Admin screens leave students' own papers out
-- ---------------------------------------------------------------------
create or replace function public.admin_overview()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  perform public.finalize_expired_attempts();
  return jsonb_build_object(
    'students', (select count(*) from public.user_roles where role = 'student'),
    'admins', (select count(*) from public.user_roles where role = 'admin'),
    'questions', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                    from (select status, count(*) n from public.questions where owner_id is null group by status) x),
    'exams_published', (select count(*) from public.exam_versions v join public.exams e on e.id = v.exam_id
                         where v.status = 'published' and e.owner_id is null),
    'exams_draft', (select count(*) from public.exam_versions v join public.exams e on e.id = v.exam_id
                     where v.status = 'draft' and e.owner_id is null),
    'student_papers', (select count(*) from public.exams where owner_id is not null),
    'attempts_in_progress', (select count(*) from public.exam_attempts a
                              where a.status = 'in_progress' and not app.is_private_version(a.exam_version_id)),
    'attempts_completed', (select count(*) from public.exam_attempts a
                            where a.status <> 'in_progress' and not app.is_private_version(a.exam_version_id)),
    'documents', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                    from (select status, count(*) n from public.documents where is_active group by status) x),
    'ai_cost_30d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > now() - interval '30 days'),
    'ai_calls_30d', (select count(*) from public.ai_calls where created_at > now() - interval '30 days'),
    'ai_failures_30d', (select count(*) from public.ai_calls where not ok and created_at > now() - interval '30 days'),
    'recent_attempts', coalesce((
      select jsonb_agg(row_to_json(x)) from (
        select a.id, a.status, a.started_at, a.submitted_at, p.email, p.full_name, v.title, res.score, res.max_score
          from public.exam_attempts a
          join public.profiles p on p.id = a.user_id
          join public.exam_versions v on v.id = a.exam_version_id
          join public.exams e on e.id = v.exam_id and e.owner_id is null
          left join public.results res on res.attempt_id = a.id
         order by a.started_at desc limit 8) x), '[]'::jsonb)
  );
end;
$$;

-- Wrap the existing report: refuse students' private papers.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'app' and p.proname = 'admin_exam_report_impl') then
    alter function public.admin_exam_report(uuid) set schema app;
    alter function app.admin_exam_report(uuid) rename to admin_exam_report_impl;
  end if;
end $$;
revoke execute on function app.admin_exam_report_impl(uuid) from public, authenticated;

create or replace function public.admin_exam_report(p_version uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  if app.is_private_version(p_version) then
    raise exception 'This is a student''s private paper; its results are visible only to that student' using errcode = '42501';
  end if;
  return app.admin_exam_report_impl(p_version);
end;
$$;

-- ---------------------------------------------------------------------
-- Settings: per-student daily AI limit (default 20 new questions a day)
-- ---------------------------------------------------------------------
update public.app_settings
   set value = value || jsonb_build_object('student_daily_questions', coalesce((value ->> 'student_daily_questions')::int, 20))
 where key = 'ai';

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
revoke execute on function
  public.log_ai_call(uuid, text, text, int, int, numeric, boolean, text, int),
  public.document_uploaders(), public.my_ai_usage(),
  public.practice_create_job(jsonb, jsonb, jsonb, text, text, int, numeric),
  public.practice_save_question(uuid, jsonb), public.practice_finish(uuid, boolean), public.practice_archive(uuid),
  public.admin_exam_report(uuid)
from public;
grant execute on function
  public.log_ai_call(uuid, text, text, int, int, numeric, boolean, text, int),
  public.document_uploaders(), public.my_ai_usage(),
  public.practice_create_job(jsonb, jsonb, jsonb, text, text, int, numeric),
  public.practice_save_question(uuid, jsonb), public.practice_finish(uuid, boolean), public.practice_archive(uuid),
  public.admin_exam_report(uuid)
to authenticated;
