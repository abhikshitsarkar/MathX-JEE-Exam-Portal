-- =====================================================================
-- Administrator functions: users and roles, question bank, exam
-- publishing, retrieval for AI generation, and reporting.
-- Every function starts with app.require_admin().
-- =====================================================================

-- ---------------------------------------------------------------------
-- Users and roles
-- ---------------------------------------------------------------------
create or replace function public.admin_list_users(p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.profiles p
               where p_search is null or p.email ilike '%' || p_search || '%' or p.full_name ilike '%' || p_search || '%'),
    'items', coalesce((
      select jsonb_agg(row_to_json(x)) from (
        select p.id, p.email, p.full_name, p.avatar_url, p.is_blocked, p.created_at,
               coalesce((select array_agg(r.role order by r.role) from public.user_roles r where r.user_id = p.id), '{}') as roles,
               (select count(*) from public.exam_attempts a where a.user_id = p.id) as attempts
          from public.profiles p
         where p_search is null or p.email ilike '%' || p_search || '%' or p.full_name ilike '%' || p_search || '%'
         order by p.created_at desc
         limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)
      ) x), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_set_role(p_user text, p_role public.app_role, p_grant boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  if p_grant then
    insert into public.user_roles (user_id, role, granted_by) values (p_user, p_role, auth.user_id())
    on conflict do nothing;
  else
    if p_role = 'admin' and (select count(*) from public.user_roles where role = 'admin') <= 1
       and exists (select 1 from public.user_roles where user_id = p_user and role = 'admin') then
      raise exception 'Cannot remove the last administrator' using errcode = 'P0001';
    end if;
    delete from public.user_roles where user_id = p_user and role = p_role;
  end if;
  perform app.audit(case when p_grant then 'role.grant' else 'role.revoke' end, 'user', p_user,
                    jsonb_build_object('role', p_role));
end;
$$;

create or replace function public.admin_set_blocked(p_user text, p_blocked boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  if p_user = auth.user_id() and p_blocked then
    raise exception 'You cannot block yourself' using errcode = 'P0001';
  end if;
  update public.profiles set is_blocked = p_blocked where id = p_user;
  perform app.audit(case when p_blocked then 'user.block' else 'user.unblock' end, 'user', p_user);
end;
$$;

-- ---------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------

-- Returns a list of problems that prevent a question from being approved.
create or replace function app.question_problems(p_question uuid)
returns text[]
language plpgsql stable security definer set search_path = ''
as $$
declare
  q public.questions;
  k public.question_answer_keys;
  labels text[];
  problems text[] := '{}';
begin
  select * into q from public.questions where id = p_question;
  if not found then return array['Question not found']; end if;
  select * into k from public.question_answer_keys where question_id = p_question;
  select coalesce(array_agg(label order by label), '{}') into labels from public.question_options where question_id = p_question;

  if q.chapter_id is null then problems := problems || 'Chapter is not set'::text; end if;
  if not exists (select 1 from public.question_solutions s where s.question_id = p_question and length(btrim(s.solution)) > 0) then
    problems := problems || 'Solution is missing'::text;
  end if;
  if k.question_id is null then
    return problems || 'Answer key is missing'::text;
  end if;

  if q.type in ('single', 'multiple') then
    if cardinality(labels) < 2 then problems := problems || 'At least two options are required'::text; end if;
    if cardinality(k.correct_options) = 0 then problems := problems || 'No correct option is marked'::text; end if;
    if not (k.correct_options <@ labels) then problems := problems || 'Answer key refers to a missing option'::text; end if;
    if q.type = 'single' and cardinality(k.correct_options) <> 1 then
      problems := problems || 'Single-correct questions need exactly one correct option'::text;
    end if;
    if exists (select 1 from public.question_options o where o.question_id = p_question
               group by lower(btrim(o.content)) having count(*) > 1) then
      problems := problems || 'Two options have identical text'::text;
    end if;
  else
    if cardinality(labels) > 0 then problems := problems || 'Numerical questions must not have options'::text; end if;
    if k.numeric_value is null and (k.range_min is null or k.range_max is null) then
      problems := problems || 'Numerical answer value or range is missing'::text;
    end if;
    if q.type = 'integer' and k.numeric_value is not null and k.numeric_value <> trunc(k.numeric_value) then
      problems := problems || 'Integer-type answer must be a whole number'::text;
    end if;
  end if;
  return problems;
end;
$$;

create or replace function public.question_problems(p_question uuid)
returns text[]
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  return app.question_problems(p_question);
end;
$$;

-- Create or update a complete question (stem, options, key, solution) atomically.
-- Input (all optional except subject, type, statement):
-- { id, subject_id | subject_code, chapter_id | chapter_name, topic_id | topic_name, subtopic,
--   type, difficulty, statement, image_path, marks, negative_marks, learning_objective, tags,
--   status, origin, source_refs, validation, generation_job_id,
--   options: [{label, content}], answer: {options:[..]} | {value, tolerance} | {min, max},
--   solution, concepts }
create or replace function public.admin_upsert_question(p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_subject uuid;
  v_chapter uuid;
  v_topic uuid;
  v_type public.question_type := (p ->> 'type')::public.question_type;
  v_status public.question_status := coalesce((p ->> 'status')::public.question_status, 'draft');
  v_old_status public.question_status;
  o jsonb;
  i int := 0;
begin
  perform app.require_admin();

  v_subject := coalesce(nullif(p ->> 'subject_id', '')::uuid,
                        (select id from public.subjects where code = upper(p ->> 'subject_code')));
  if v_subject is null then raise exception 'Unknown subject' using errcode = '22023'; end if;

  v_chapter := nullif(p ->> 'chapter_id', '')::uuid;
  if v_chapter is null and nullif(btrim(p ->> 'chapter_name'), '') is not null then
    select id into v_chapter from public.chapters
     where subject_id = v_subject and lower(name) = lower(btrim(p ->> 'chapter_name'));
    if v_chapter is null then
      insert into public.chapters (subject_id, name, sort) values (v_subject, btrim(p ->> 'chapter_name'), 999)
      returning id into v_chapter;
    end if;
  end if;
  if v_chapter is not null and not exists (select 1 from public.chapters where id = v_chapter and subject_id = v_subject) then
    raise exception 'Chapter does not belong to the subject' using errcode = '22023';
  end if;

  v_topic := nullif(p ->> 'topic_id', '')::uuid;
  if v_topic is null and v_chapter is not null and nullif(btrim(p ->> 'topic_name'), '') is not null then
    select id into v_topic from public.topics
     where chapter_id = v_chapter and parent_id is null and lower(name) = lower(btrim(p ->> 'topic_name'));
    if v_topic is null then
      insert into public.topics (chapter_id, name, sort) values (v_chapter, btrim(p ->> 'topic_name'), 999)
      returning id into v_topic;
    end if;
  end if;

  if v_id is null then
    insert into public.questions (subject_id, chapter_id, topic_id, subtopic, type, difficulty, statement, image_path,
                                  marks, negative_marks, learning_objective, tags, status, origin, source_refs,
                                  validation, generation_job_id, created_by)
    values (v_subject, v_chapter, v_topic, p ->> 'subtopic', v_type,
            coalesce((p ->> 'difficulty')::public.difficulty, 'medium'), p ->> 'statement', nullif(p ->> 'image_path', ''),
            coalesce((p ->> 'marks')::numeric, 4), coalesce((p ->> 'negative_marks')::numeric, 0),
            p ->> 'learning_objective',
            coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'tags') x), '{}'),
            'draft', coalesce((p ->> 'origin')::public.question_origin, 'manual'),
            coalesce(p -> 'source_refs', '[]'::jsonb), coalesce(p -> 'validation', '{}'::jsonb),
            nullif(p ->> 'generation_job_id', '')::uuid, auth.user_id())
    returning id into v_id;
    v_old_status := 'draft';
  else
    select status into v_old_status from public.questions where id = v_id for update;
    if not found then raise exception 'Question not found' using errcode = 'P0002'; end if;
    update public.questions set
      subject_id = v_subject, chapter_id = v_chapter, topic_id = v_topic, subtopic = p ->> 'subtopic',
      type = v_type, difficulty = coalesce((p ->> 'difficulty')::public.difficulty, difficulty),
      statement = p ->> 'statement', image_path = nullif(p ->> 'image_path', ''),
      marks = coalesce((p ->> 'marks')::numeric, marks),
      negative_marks = coalesce((p ->> 'negative_marks')::numeric, negative_marks),
      learning_objective = p ->> 'learning_objective',
      tags = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'tags') x), tags),
      source_refs = coalesce(p -> 'source_refs', source_refs),
      validation = coalesce(p -> 'validation', validation),
      -- any content edit sends an approved question back for review
      status = 'draft', reviewed_by = null, reviewed_at = null
    where id = v_id;
  end if;

  if v_type in ('integer', 'numerical') and jsonb_array_length(coalesce(p -> 'options', '[]'::jsonb)) > 0 then
    raise exception 'Integer/numerical questions must not have options' using errcode = '22023';
  end if;

  delete from public.question_options where question_id = v_id;
  if v_type in ('single', 'multiple') then
    for o in select * from jsonb_array_elements(coalesce(p -> 'options', '[]'::jsonb)) loop
      i := i + 1;
      insert into public.question_options (question_id, label, content, sort)
      values (v_id, upper(coalesce(o ->> 'label', chr(64 + i))), o ->> 'content', i);
    end loop;
  end if;

  delete from public.question_answer_keys where question_id = v_id;
  if p ? 'answer' and jsonb_typeof(p -> 'answer') = 'object' then
    insert into public.question_answer_keys (question_id, correct_options, numeric_value, tolerance, range_min, range_max)
    values (v_id,
            coalesce((select array_agg(distinct upper(x) order by upper(x))
                        from jsonb_array_elements_text(coalesce(p -> 'answer' -> 'options', '[]'::jsonb)) x), '{}'),
            (p -> 'answer' ->> 'value')::numeric,
            coalesce((p -> 'answer' ->> 'tolerance')::numeric, 0),
            (p -> 'answer' ->> 'min')::numeric,
            (p -> 'answer' ->> 'max')::numeric);
  end if;

  if nullif(btrim(p ->> 'solution'), '') is not null then
    insert into public.question_solutions (question_id, solution, concepts)
    values (v_id, p ->> 'solution', p ->> 'concepts')
    on conflict (question_id) do update set solution = excluded.solution, concepts = excluded.concepts;
  else
    delete from public.question_solutions where question_id = v_id;
  end if;

  -- Requested status (e.g. "approved" on import) is applied through the same checks as manual review
  if v_status <> 'draft' then
    perform public.set_question_status(v_id, v_status, null);
  end if;

  perform app.audit(case when p ? 'id' and p ->> 'id' <> '' then 'question.update' else 'question.create' end,
                    'question', v_id::text, jsonb_build_object('status', v_status));
  return v_id;
end;
$$;

create or replace function public.set_question_status(p_question uuid, p_status public.question_status, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_problems text[];
begin
  perform app.require_admin();
  if p_status = 'approved' then
    v_problems := app.question_problems(p_question);
    if cardinality(v_problems) > 0 then
      raise exception 'Cannot approve: %', array_to_string(v_problems, '; ') using errcode = 'P0001';
    end if;
  end if;
  update public.questions
     set status = p_status,
         reviewed_by = case when p_status in ('approved', 'rejected') then auth.user_id() else reviewed_by end,
         reviewed_at = case when p_status in ('approved', 'rejected') then now() else reviewed_at end,
         validation = case when p_note is not null
                           then validation || jsonb_build_object('review_note', p_note) else validation end
   where id = p_question;
  if not found then raise exception 'Question not found' using errcode = 'P0002'; end if;
  perform app.audit('question.status', 'question', p_question::text, jsonb_build_object('status', p_status, 'note', p_note));
end;
$$;

-- Full question (for the editor and for export).
create or replace function app.question_json(p_question uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', q.id, 'subject_id', q.subject_id, 'subject_code', s.code, 'chapter_id', q.chapter_id,
    'chapter_name', c.name, 'topic_id', q.topic_id, 'topic_name', t.name, 'subtopic', q.subtopic,
    'type', q.type, 'difficulty', q.difficulty, 'statement', q.statement, 'image_path', q.image_path,
    'marks', q.marks, 'negative_marks', q.negative_marks, 'learning_objective', q.learning_objective,
    'tags', to_jsonb(q.tags), 'status', q.status, 'origin', q.origin, 'source_refs', q.source_refs,
    'validation', q.validation, 'usage_count', q.usage_count, 'last_used_at', q.last_used_at,
    'generation_job_id', q.generation_job_id, 'created_at', q.created_at, 'updated_at', q.updated_at,
    'options', coalesce((select jsonb_agg(jsonb_build_object('label', o.label, 'content', o.content) order by o.sort, o.label)
                           from public.question_options o where o.question_id = q.id), '[]'::jsonb),
    'answer', (select case when q.type in ('single', 'multiple') then jsonb_build_object('options', to_jsonb(k.correct_options))
                           when k.range_min is not null then jsonb_build_object('min', k.range_min, 'max', k.range_max)
                           else jsonb_build_object('value', k.numeric_value, 'tolerance', k.tolerance) end
                 from public.question_answer_keys k where k.question_id = q.id),
    'solution', (select s2.solution from public.question_solutions s2 where s2.question_id = q.id),
    'concepts', (select s2.concepts from public.question_solutions s2 where s2.question_id = q.id))
  from public.questions q
  join public.subjects s on s.id = q.subject_id
  left join public.chapters c on c.id = q.chapter_id
  left join public.topics t on t.id = q.topic_id
  where q.id = p_question;
$$;

create or replace function public.admin_get_question(p_question uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  return app.question_json(p_question) || jsonb_build_object('problems', to_jsonb(app.question_problems(p_question)));
end;
$$;

-- Paginated, filtered question list.
-- Filters: {subject_id, chapter_id, topic_id, type, difficulty, status, origin, q (text), job_id}
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
       where (f ->> 'subject_id' is null or q.subject_id = (f ->> 'subject_id')::uuid)
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

-- Bulk import (documented in docs/IMPORT_FORMAT.md). Each item is the
-- admin_upsert_question payload; failures are reported per item.
create or replace function public.admin_import_questions(p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  item jsonb;
  idx int := 0;
  ok jsonb := '[]'::jsonb;
  errs jsonb := '[]'::jsonb;
  v_id uuid;
begin
  perform app.require_admin();
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'Provide an array of at most 500 questions' using errcode = '22023';
  end if;
  for item in select * from jsonb_array_elements(p_items) loop
    idx := idx + 1;
    begin
      v_id := public.admin_upsert_question((item - 'id') || jsonb_build_object('origin', coalesce(item ->> 'origin', 'import')));
      ok := ok || to_jsonb(v_id::text);
    exception when others then
      errs := errs || jsonb_build_object('index', idx, 'error', sqlerrm);
    end;
  end loop;
  perform app.audit('question.import', 'question', null,
                    jsonb_build_object('imported', jsonb_array_length(ok), 'failed', jsonb_array_length(errs)));
  return jsonb_build_object('imported', ok, 'errors', errs);
end;
$$;

create or replace function public.admin_export_questions(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
begin
  perform app.require_admin();
  return coalesce((
    select jsonb_agg(app.question_json(q.id) - 'id' - 'subject_id' - 'chapter_id' - 'topic_id' - 'usage_count'
                     - 'last_used_at' - 'generation_job_id' - 'created_at' - 'updated_at' order by q.created_at)
      from public.questions q
     where (f ->> 'subject_id' is null or q.subject_id = (f ->> 'subject_id')::uuid)
       and (f ->> 'status' is null or q.status = (f ->> 'status')::public.question_status)
     limit 5000), '[]'::jsonb);
end;
$$;

-- Near-duplicate detection (trigram similarity + exact fingerprint).
create or replace function public.find_similar_questions(p_statement text, p_subject uuid default null,
                                                         p_threshold real default 0.55, p_limit int default 5)
returns table (id uuid, similarity real, statement text, status public.question_status, exact boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  return query
    select q.id, extensions.similarity(q.statement, p_statement) as sim, left(q.statement, 300), q.status,
           q.fingerprint = app.text_fingerprint(p_statement)
      from public.questions q
     where (p_subject is null or q.subject_id = p_subject)
       and q.status <> 'rejected'
       and (q.fingerprint = app.text_fingerprint(p_statement)
            or extensions.similarity(q.statement, p_statement) >= p_threshold)
     order by sim desc
     limit least(p_limit, 20);
end;
$$;

-- Ranked search of the bank for one blueprint slot (used by the generator).
-- Filters: {subject_id, chapter_ids[], topic_ids[], type, difficulty, exclude_ids[], limit, text}
create or replace function public.search_question_bank(p jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_chapters uuid[] := (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'chapter_ids', '[]')) x);
  v_topics   uuid[] := (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'topic_ids', '[]')) x);
  v_exclude  uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'exclude_ids', '[]')) x), '{}');
  v_text     text := nullif(p ->> 'text', '');
begin
  perform app.require_admin();
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.rank desc)
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

-- Retrieval of study-material excerpts for generation (full-text search).
create or replace function public.search_chunks(p_query text, p_subject uuid default null,
                                                p_chapter uuid default null, p_limit int default 6)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ts tsquery;
begin
  perform app.require_admin();
  -- OR the query terms so partial matches still rank
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
           and (p_subject is null or d.subject_id is null or d.subject_id = p_subject)
           and (c.tsv @@ v_ts or (p_chapter is not null and c.chapter_id = p_chapter))
         order by rank desc
         limit least(greatest(p_limit, 1), 20)
      ) x), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Exams
-- ---------------------------------------------------------------------

-- Publishing snapshots every question (text, options, key, solution) into
-- the version and makes it immutable.
create or replace function public.publish_exam_version(p_version uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  return app.do_publish(p_version);
end;
$$;

create or replace function app.do_publish(p_version uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.exam_versions;
  eq record;
  v_problems text[];
  v_issues jsonb := '[]'::jsonb;
  v_total numeric;
begin
  select * into v from public.exam_versions where id = p_version for update;
  if not found then raise exception 'Exam version not found' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only draft versions can be published' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.exam_questions where exam_version_id = p_version) then
    raise exception 'The exam has no questions' using errcode = 'P0001';
  end if;

  for eq in select x.*, q.status as q_status from public.exam_questions x
              left join public.questions q on q.id = x.question_id
             where x.exam_version_id = p_version order by x.position loop
    if eq.question_id is null then
      v_issues := v_issues || jsonb_build_object('position', eq.position, 'problem', 'Question was deleted from the bank');
      continue;
    end if;
    if eq.q_status <> 'approved' then
      v_issues := v_issues || jsonb_build_object('position', eq.position, 'problem', 'Question is not approved');
    end if;
    v_problems := app.question_problems(eq.question_id);
    if cardinality(v_problems) > 0 then
      v_issues := v_issues || jsonb_build_object('position', eq.position, 'problem', array_to_string(v_problems, '; '));
    end if;
  end loop;
  if jsonb_array_length(v_issues) > 0 then
    return jsonb_build_object('published', false, 'issues', v_issues);
  end if;

  -- snapshot content and metadata
  update public.exam_questions x set
    subject_id = q.subject_id, chapter_id = q.chapter_id, topic_id = q.topic_id,
    type = q.type, difficulty = q.difficulty,
    content = jsonb_build_object(
      'statement', q.statement, 'image_path', q.image_path,
      'options', coalesce((select jsonb_agg(jsonb_build_object('label', o.label, 'content', o.content) order by o.sort, o.label)
                             from public.question_options o where o.question_id = q.id), '[]'::jsonb))
  from public.questions q
  where q.id = x.question_id and x.exam_version_id = p_version;

  delete from public.exam_question_keys k using public.exam_questions x
   where k.exam_question_id = x.id and x.exam_version_id = p_version;
  insert into public.exam_question_keys (exam_question_id, answer, solution, concepts)
  select x.id,
         case when q.type in ('single', 'multiple') then jsonb_build_object('options', to_jsonb(k.correct_options))
              when k.range_min is not null then jsonb_build_object('min', k.range_min, 'max', k.range_max)
              else jsonb_build_object('value', k.numeric_value, 'tolerance', k.tolerance) end,
         s.solution, s.concepts
    from public.exam_questions x
    join public.questions q on q.id = x.question_id
    join public.question_answer_keys k on k.question_id = q.id
    left join public.question_solutions s on s.question_id = q.id
   where x.exam_version_id = p_version;

  select sum(marks) into v_total from public.exam_questions where exam_version_id = p_version;

  -- archive the previously published version of the same exam
  update public.exam_versions set status = 'archived'
   where exam_id = v.exam_id and status = 'published' and id <> p_version;

  update public.exam_versions
     set status = 'published', published_at = now(), published_by = auth.user_id(), total_marks = v_total
   where id = p_version;

  update public.questions q set usage_count = usage_count + 1, last_used_at = now()
    from public.exam_questions x
   where x.question_id = q.id and x.exam_version_id = p_version;

  perform app.audit('exam.publish', 'exam_version', p_version::text, jsonb_build_object('total_marks', v_total));
  return jsonb_build_object('published', true, 'total_marks', v_total);
end;
$$;

-- New editable draft copied from the latest version (to change a published exam).
create or replace function public.create_draft_version(p_exam uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  src public.exam_versions;
  v_new uuid;
begin
  perform app.require_admin();
  if exists (select 1 from public.exam_versions where exam_id = p_exam and status = 'draft') then
    raise exception 'This exam already has a draft version' using errcode = 'P0001';
  end if;
  select * into src from public.exam_versions where exam_id = p_exam order by version_no desc limit 1;
  if not found then raise exception 'Exam has no versions' using errcode = 'P0002'; end if;

  insert into public.exam_versions (exam_id, version_no, title, instructions, duration_minutes, marking_rules,
                                    sections, blueprint, release_policy, release_at, opens_at, closes_at,
                                    max_attempts, created_by)
  values (p_exam, src.version_no + 1, src.title, src.instructions, src.duration_minutes, src.marking_rules,
          src.sections, src.blueprint, src.release_policy, src.release_at, src.opens_at, src.closes_at,
          src.max_attempts, auth.user_id())
  returning id into v_new;

  insert into public.exam_questions (exam_version_id, position, section_key, question_id, subject_id, chapter_id,
                                     topic_id, type, difficulty, marks, negative_marks, scoring)
  select v_new, position, section_key, question_id, subject_id, chapter_id, topic_id, type, difficulty,
         marks, negative_marks, scoring
    from public.exam_questions where exam_version_id = src.id and question_id is not null;

  perform app.audit('exam.new_version', 'exam_version', v_new::text, jsonb_build_object('from', src.id));
  return v_new;
end;
$$;

-- Add bank questions to a draft version (appended in order, deduplicated).
create or replace function public.add_questions_to_version(p_version uuid, p_question_ids uuid[], p_section text default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_pos int;
  n int;
begin
  perform app.require_admin();
  if (select status from public.exam_versions where id = p_version) <> 'draft' then
    raise exception 'Only draft versions can be edited' using errcode = 'P0001';
  end if;
  select coalesce(max(position), 0) into v_pos from public.exam_questions where exam_version_id = p_version;
  insert into public.exam_questions (exam_version_id, position, section_key, question_id, subject_id, chapter_id,
                                     topic_id, type, difficulty, marks, negative_marks)
  select p_version, v_pos + row_number() over (order by ord), coalesce(p_section, s.code), q.id, q.subject_id,
         q.chapter_id, q.topic_id, q.type, q.difficulty, q.marks, q.negative_marks
    from unnest(p_question_ids) with ordinality u(id, ord)
    join public.questions q on q.id = u.id
    join public.subjects s on s.id = q.subject_id
   where not exists (select 1 from public.exam_questions x where x.exam_version_id = p_version and x.question_id = q.id);
  get diagnostics n = row_count;
  perform app.renumber_exam_questions(p_version);
  return n;
end;
$$;

-- Keep positions contiguous and grouped by section order.
create or replace function app.renumber_exam_questions(p_version uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_sections jsonb := (select sections from public.exam_versions where id = p_version);
begin
  -- two passes to avoid unique (version, position) clashes
  update public.exam_questions set position = position + 100000 where exam_version_id = p_version;
  with ordered as (
    select x.id, row_number() over (
             order by coalesce((select s.ord from jsonb_array_elements(v_sections) with ordinality s(val, ord)
                                 where s.val ->> 'key' = x.section_key), 999), x.position) as rn
      from public.exam_questions x where x.exam_version_id = p_version
  )
  update public.exam_questions x set position = o.rn from ordered o where o.id = x.id;
end;
$$;

create or replace function public.reorder_exam_question(p_exam_question uuid, p_direction int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me public.exam_questions;
  other public.exam_questions;
begin
  perform app.require_admin();
  select * into me from public.exam_questions where id = p_exam_question;
  select * into other from public.exam_questions
   where exam_version_id = me.exam_version_id and position = me.position + sign(p_direction)::int;
  if not found then return; end if;
  update public.exam_questions set position = 1000000 where id = me.id;
  update public.exam_questions set position = me.position where id = other.id;
  update public.exam_questions set position = other.position where id = me.id;
end;
$$;

create or replace function public.remove_exam_question(p_exam_question uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_version uuid;
begin
  perform app.require_admin();
  delete from public.exam_questions where id = p_exam_question returning exam_version_id into v_version;
  if v_version is not null then perform app.renumber_exam_questions(v_version); end if;
end;
$$;

create or replace function public.release_results_now(p_version uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  update public.exam_versions set release_policy = 'manual', release_at = now() where id = p_version;
  perform app.audit('exam.release_results', 'exam_version', p_version::text);
end;
$$;

-- Assemble a draft exam from a generation job's plan.
-- plan.slots[]: {section_key, subject_id, chapter_ids, topic_ids, type, difficulty, count, marks,
--                negative_marks, question_ids[]}
create or replace function public.assemble_exam_from_job(p_job uuid, p_allow_partial boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.generation_jobs;
  slot jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_have int;
  v_exam uuid;
  v_version uuid;
  v_pos int := 0;
  v_ids uuid[];
  v_used uuid[] := '{}';
  qid uuid;
  r jsonb := '{}'::jsonb;
begin
  perform app.require_admin();
  select * into j from public.generation_jobs where id = p_job for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;
  if j.exam_id is not null then raise exception 'This job was already assembled into an exam' using errcode = 'P0001'; end if;
  r := j.request;

  for slot in select * from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) loop
    select count(*) into v_have
      from public.questions q
     where q.status = 'approved'
       and q.id in (select x::uuid from jsonb_array_elements_text(coalesce(slot -> 'question_ids', '[]')) x);
    if v_have < (slot ->> 'count')::int then
      v_missing := v_missing || jsonb_build_object('slot', slot ->> 'slot_id', 'label', slot ->> 'label',
                                                   'needed', (slot ->> 'count')::int, 'approved', v_have);
    end if;
  end loop;

  if jsonb_array_length(v_missing) > 0 and not p_allow_partial then
    return jsonb_build_object('ok', false, 'missing', v_missing);
  end if;

  insert into public.exams (title, kind, description, created_by)
  values (r ->> 'title', coalesce((r ->> 'kind')::public.exam_kind, 'custom'), r ->> 'description', auth.user_id())
  returning id into v_exam;

  insert into public.exam_versions (exam_id, version_no, title, instructions, duration_minutes, marking_rules, sections,
                                    blueprint, release_policy, release_at, opens_at, closes_at, max_attempts, created_by)
  values (v_exam, 1, r ->> 'title', coalesce(r ->> 'instructions', ''), (r ->> 'duration_minutes')::int,
          coalesce(r -> 'marking_rules', '{}'::jsonb), coalesce(j.blueprint -> 'sections', '[]'::jsonb), j.blueprint,
          coalesce((r ->> 'release_policy')::public.release_policy, 'immediate'),
          (r ->> 'release_at')::timestamptz, (r ->> 'opens_at')::timestamptz, (r ->> 'closes_at')::timestamptz,
          coalesce((r ->> 'max_attempts')::int, 1), auth.user_id())
  returning id into v_version;

  for slot in select * from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) loop
    select array_agg(q.id order by array_position(
             array(select x::uuid from jsonb_array_elements_text(slot -> 'question_ids') x), q.id))
      into v_ids
      from public.questions q
     where q.status = 'approved'
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

  update public.exam_versions set total_marks = coalesce((select sum(marks) from public.exam_questions
                                                           where exam_version_id = v_version), 0)
   where id = v_version;
  update public.generation_jobs set exam_id = v_exam, status = 'completed' where id = p_job;
  perform app.audit('exam.assemble', 'exam', v_exam::text, jsonb_build_object('job', p_job, 'missing', v_missing));
  return jsonb_build_object('ok', true, 'exam_id', v_exam, 'version_id', v_version, 'missing', v_missing);
end;
$$;

-- ---------------------------------------------------------------------
-- Reporting
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
                    from (select status, count(*) n from public.questions group by status) x),
    'exams_published', (select count(*) from public.exam_versions where status = 'published'),
    'exams_draft', (select count(*) from public.exam_versions where status = 'draft'),
    'attempts_in_progress', (select count(*) from public.exam_attempts where status = 'in_progress'),
    'attempts_completed', (select count(*) from public.exam_attempts where status <> 'in_progress'),
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
          left join public.results res on res.attempt_id = a.id
         order by a.started_at desc limit 8) x), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_exam_report(p_version uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
begin
  perform app.require_admin();
  for r in select id from public.exam_attempts where exam_version_id = p_version and status = 'in_progress'
                                                 and deadline_at < now() loop
    perform app.finalize_if_expired(r.id);
  end loop;

  return jsonb_build_object(
    'summary', (select jsonb_build_object('attempts', count(*), 'avg', round(avg(score), 2), 'max', max(score),
                                          'min', min(score), 'avg_pct', round(avg(percentage), 2),
                                          'max_score', max(max_score))
                  from public.results where exam_version_id = p_version),
    'in_progress', (select count(*) from public.exam_attempts where exam_version_id = p_version and status = 'in_progress'),
    'attempts', coalesce((
      select jsonb_agg(row_to_json(x) order by x.score desc nulls last) from (
        select a.id as attempt_id, p.email, p.full_name, a.status, a.started_at, a.submitted_at, a.submit_reason,
               res.score, res.max_score, res.percentage, res.accuracy, res.time_taken_seconds,
               (select count(*) from public.attempt_events e where e.attempt_id = a.id
                                                              and e.kind in ('visibility_hidden', 'fullscreen_exit')) as focus_losses
          from public.exam_attempts a
          join public.profiles p on p.id = a.user_id
          left join public.results res on res.attempt_id = a.id
         where a.exam_version_id = p_version) x), '[]'::jsonb),
    'questions', coalesce((
      select jsonb_agg(row_to_json(x) order by x.position) from (
        select eq.position, eq.id, left(eq.content ->> 'statement', 160) as preview, eq.type, eq.difficulty,
               count(*) filter (where e ->> 'outcome' = 'correct') as correct,
               count(*) filter (where e ->> 'outcome' = 'partial') as partial,
               count(*) filter (where e ->> 'outcome' = 'incorrect') as incorrect,
               count(*) filter (where e ->> 'outcome' = 'unanswered') as unanswered
          from public.exam_questions eq
          left join public.results res on res.exam_version_id = eq.exam_version_id
          left join lateral jsonb_array_elements(res.per_question) e on e ->> 'exam_question_id' = eq.id::text
         where eq.exam_version_id = p_version
         group by eq.position, eq.id) x), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
grant execute on function
  public.admin_list_users(text, int, int), public.admin_set_role(text, public.app_role, boolean),
  public.admin_set_blocked(text, boolean), public.question_problems(uuid), public.admin_upsert_question(jsonb),
  public.set_question_status(uuid, public.question_status, text), public.admin_get_question(uuid),
  public.admin_list_questions(jsonb, int, int), public.admin_import_questions(jsonb),
  public.admin_export_questions(jsonb), public.find_similar_questions(text, uuid, real, int),
  public.search_question_bank(jsonb), public.search_chunks(text, uuid, uuid, int),
  public.publish_exam_version(uuid), public.create_draft_version(uuid),
  public.add_questions_to_version(uuid, uuid[], text), public.reorder_exam_question(uuid, int),
  public.remove_exam_question(uuid), public.release_results_now(uuid), public.assemble_exam_from_job(uuid, boolean),
  public.admin_overview(), public.admin_exam_report(uuid)
to authenticated;

-- Internal helpers are never callable directly by API roles (except the
-- two used inside RLS policies).
revoke execute on all functions in schema app from public;
-- Only explicitly granted functions are callable by API roles.
revoke execute on all functions in schema public from public;
grant execute on function public.sync_profile(text, text) to authenticated;
grant execute on function app.is_admin(), app.result_released(uuid), app.text_fingerprint(text) to authenticated;
