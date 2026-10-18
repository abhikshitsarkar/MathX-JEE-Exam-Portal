-- =====================================================================
-- Exam engine: attempts, autosave, server-authoritative deadline,
-- submission and scoring. Students interact ONLY through these functions;
-- answer keys never leave the database before the release rule allows.
-- =====================================================================

-- Seconds of network tolerance accepted after the deadline for in-flight saves.
create or replace function app.grace_seconds() returns int language sql immutable as $$ select 5 $$;

-- ---------------------------------------------------------------------
-- Answer validation / normalisation
-- Answer format: {"options": ["A","C"]}  for single / multiple
--                {"value": "9.81"}       for integer / numerical
-- ---------------------------------------------------------------------
create or replace function app.normalize_answer(p_type public.question_type, p_answer jsonb, p_labels text[])
returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_opts text[];
  v_txt  text;
begin
  if p_answer is null or jsonb_typeof(p_answer) <> 'object' then
    return null;
  end if;

  if p_type in ('single', 'multiple') then
    if jsonb_typeof(p_answer -> 'options') <> 'array' then
      raise exception 'Invalid answer format' using errcode = '22023';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into v_opts
      from jsonb_array_elements_text(p_answer -> 'options') x;
    if cardinality(v_opts) = 0 then return null; end if;
    if not (v_opts <@ p_labels) then
      raise exception 'Unknown option selected' using errcode = '22023';
    end if;
    if p_type = 'single' and cardinality(v_opts) <> 1 then
      raise exception 'Exactly one option must be selected' using errcode = '22023';
    end if;
    return jsonb_build_object('options', to_jsonb(v_opts));
  end if;

  v_txt := nullif(btrim(p_answer ->> 'value'), '');
  if v_txt is null then return null; end if;
  if char_length(v_txt) > 24 then
    raise exception 'Answer is too long' using errcode = '22023';
  end if;
  if p_type = 'integer' and v_txt !~ '^[+-]?\d+$' then
    raise exception 'Enter a whole number' using errcode = '22023';
  end if;
  if p_type = 'numerical' and v_txt !~ '^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$' then
    raise exception 'Enter a valid number' using errcode = '22023';
  end if;
  return jsonb_build_object('value', v_txt);
end;
$$;

-- ---------------------------------------------------------------------
-- Scoring of one answer.
-- Rule (per question type, from the exam version's marking rules or the
-- question override):
--   {"unanswered":0, "partial":"none"|"per_option", "partial_per_option":1}
-- Marks for correct / penalty for incorrect come from the exam question.
-- Key format: {"options":[...]} | {"value":n} | {"value":n,"tolerance":t} | {"min":a,"max":b}
-- ---------------------------------------------------------------------
create or replace function app.score_answer(
  p_type public.question_type, p_answer jsonb, p_key jsonb, p_rule jsonb,
  p_marks numeric, p_negative numeric)
returns table (outcome text, awarded numeric)
language plpgsql immutable set search_path = ''
as $$
declare
  v_chosen  text[];
  v_correct text[];
  v_txt     text;
  v_val     numeric;
  v_unans   numeric := coalesce((p_rule ->> 'unanswered')::numeric, 0);
  v_partial text    := coalesce(p_rule ->> 'partial', 'none');
  v_per     numeric := coalesce((p_rule ->> 'partial_per_option')::numeric, 1);
begin
  if p_type in ('single', 'multiple') then
    if p_answer is null or jsonb_typeof(p_answer -> 'options') is distinct from 'array' then
      return query select 'unanswered'::text, v_unans; return;
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into v_chosen
      from jsonb_array_elements_text(p_answer -> 'options') x;
    if cardinality(v_chosen) = 0 then
      return query select 'unanswered'::text, v_unans; return;
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into v_correct
      from jsonb_array_elements_text(coalesce(p_key -> 'options', '[]'::jsonb)) x;
    if v_chosen = v_correct then
      return query select 'correct'::text, p_marks; return;
    end if;
    if p_type = 'multiple' and v_partial = 'per_option' and v_chosen <@ v_correct then
      return query select 'partial'::text, least(p_marks, v_per * cardinality(v_chosen)); return;
    end if;
    return query select 'incorrect'::text, -p_negative; return;
  end if;

  v_txt := nullif(btrim(p_answer ->> 'value'), '');
  if v_txt is null then
    return query select 'unanswered'::text, v_unans; return;
  end if;
  if v_txt !~ '^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$' then
    return query select 'incorrect'::text, -p_negative; return;
  end if;
  v_val := v_txt::numeric;

  if p_key ? 'min' and p_key ? 'max' then
    if v_val between (p_key ->> 'min')::numeric and (p_key ->> 'max')::numeric then
      return query select 'correct'::text, p_marks; return;
    end if;
  elsif p_type = 'integer' then
    if v_val = (p_key ->> 'value')::numeric then
      return query select 'correct'::text, p_marks; return;
    end if;
  else
    if abs(v_val - (p_key ->> 'value')::numeric)
       <= coalesce((p_key ->> 'tolerance')::numeric, 0) + 0.000000001 then
      return query select 'correct'::text, p_marks; return;
    end if;
  end if;
  return query select 'incorrect'::text, -p_negative;
end;
$$;

-- ---------------------------------------------------------------------
-- Result computation (deterministic, server-side only)
-- ---------------------------------------------------------------------
create or replace function app.compute_result(p_attempt uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  a public.exam_attempts;
  v public.exam_versions;
begin
  select * into a from public.exam_attempts where id = p_attempt;
  select * into v from public.exam_versions where id = a.exam_version_id;

  with pq as (
    select eq.id, eq.position, eq.section_key, eq.subject_id, eq.chapter_id, eq.topic_id,
           eq.difficulty, eq.type, eq.marks,
           coalesce(r.time_spent_seconds, 0) as t,
           s.outcome, s.awarded
      from public.exam_questions eq
      join public.exam_question_keys k on k.exam_question_id = eq.id
      left join public.responses r on r.attempt_id = p_attempt and r.exam_question_id = eq.id
      cross join lateral app.score_answer(
        eq.type, r.answer, k.answer,
        coalesce(eq.scoring, v.marking_rules -> eq.type::text, '{}'::jsonb),
        eq.marks, eq.negative_marks) s
     where eq.exam_version_id = a.exam_version_id
  ),
  dims as (
    select 'subject' as dim, pq.subject_id::text as k, sb.name as label, pq.* from pq
      left join public.subjects sb on sb.id = pq.subject_id
    union all
    select 'chapter', pq.chapter_id::text, ch.name, pq.* from pq
      left join public.chapters ch on ch.id = pq.chapter_id
    union all
    select 'topic', pq.topic_id::text, tp.name, pq.* from pq
      left join public.topics tp on tp.id = pq.topic_id
    union all
    select 'difficulty', pq.difficulty::text, pq.difficulty::text, pq.* from pq
  ),
  agg as (
    select dim, k, max(label) as label,
           sum(awarded) as score, sum(marks) as max_score, count(*) as total,
           count(*) filter (where outcome = 'correct') as correct,
           count(*) filter (where outcome = 'incorrect') as incorrect,
           count(*) filter (where outcome = 'partial') as partial,
           count(*) filter (where outcome = 'unanswered') as unanswered,
           sum(t) as time_spent
      from dims group by dim, k
  ),
  breakdown as (
    select coalesce(jsonb_object_agg(dim, items), '{}'::jsonb) as b
      from (select dim, jsonb_agg(jsonb_build_object(
                     'key', k, 'label', coalesce(label, 'Untagged'), 'score', score, 'max', max_score,
                     'total', total, 'correct', correct, 'incorrect', incorrect, 'partial', partial,
                     'unanswered', unanswered, 'time_spent', time_spent) order by label) as items
              from agg group by dim) x
  ),
  totals as (
    select coalesce(sum(awarded), 0) as score, coalesce(sum(marks), 0) as max_score,
           count(*) filter (where outcome = 'correct') as correct,
           count(*) filter (where outcome = 'incorrect') as incorrect,
           count(*) filter (where outcome = 'partial') as partial,
           count(*) filter (where outcome = 'unanswered') as unanswered,
           coalesce(jsonb_agg(jsonb_build_object(
             'exam_question_id', id, 'position', position, 'section_key', section_key,
             'subject_id', subject_id, 'chapter_id', chapter_id, 'topic_id', topic_id,
             'difficulty', difficulty, 'type', type, 'marks', marks,
             'outcome', outcome, 'awarded', awarded, 'time_spent', t) order by position), '[]'::jsonb) as pq
      from pq
  )
  insert into public.results as res (attempt_id, user_id, exam_version_id, score, max_score, correct, incorrect,
                              partial, unanswered, accuracy, percentage, time_taken_seconds, breakdown,
                              per_question, computed_at)
  select a.id, a.user_id, a.exam_version_id, t.score, t.max_score, t.correct, t.incorrect, t.partial, t.unanswered,
         case when t.correct + t.incorrect + t.partial > 0
              then round(100.0 * (t.correct + t.partial) / (t.correct + t.incorrect + t.partial), 2) end,
         case when t.max_score > 0 then round(100.0 * t.score / t.max_score, 2) end,
         greatest(0, extract(epoch from (least(coalesce(a.submitted_at, now()), a.deadline_at) - a.started_at)))::int,
         b.b, t.pq, now()
    from totals t cross join breakdown b
  on conflict (attempt_id) do update set
    score = excluded.score, max_score = excluded.max_score, correct = excluded.correct,
    incorrect = excluded.incorrect, partial = excluded.partial, unanswered = excluded.unanswered,
    accuracy = excluded.accuracy, percentage = excluded.percentage,
    time_taken_seconds = excluded.time_taken_seconds, breakdown = excluded.breakdown,
    per_question = excluded.per_question, computed_at = excluded.computed_at;
end;
$$;

-- Close an attempt and score it. Caller must hold a lock on the attempt row.
create or replace function app.finalize_attempt(p_attempt uuid, p_status public.attempt_status, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.exam_attempts
     set status = p_status,
         submit_reason = p_reason,
         submitted_at = case when p_status = 'auto_submitted' then least(now(), deadline_at) else now() end
   where id = p_attempt and status = 'in_progress';
  if found then
    perform app.compute_result(p_attempt);
  end if;
end;
$$;

-- Auto-submit an attempt whose deadline has passed. Returns true if closed now.
create or replace function app.finalize_if_expired(p_attempt uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_deadline timestamptz;
begin
  select deadline_at into v_deadline from public.exam_attempts
   where id = p_attempt and status = 'in_progress' for update;
  if found and now() > v_deadline + make_interval(secs => app.grace_seconds()) then
    perform app.finalize_attempt(p_attempt, 'auto_submitted', 'deadline');
    return true;
  end if;
  return false;
end;
$$;

-- Sweep all expired attempts (for an optional pg_cron job; also called lazily).
create or replace function public.finalize_expired_attempts()
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  for r in select id from public.exam_attempts
            where status = 'in_progress'
              and deadline_at < now() - make_interval(secs => app.grace_seconds())
            limit 500
  loop
    if app.finalize_if_expired(r.id) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.finalize_expired_attempts() from public, authenticated;

-- ---------------------------------------------------------------------
-- Student-facing functions
-- ---------------------------------------------------------------------
create or replace function app.require_user()
returns text
language plpgsql stable set search_path = ''
as $$
declare
  v text := (select auth.user_id());
begin
  if v is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- Exams a student can see, with their own attempt state.
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
    select jsonb_agg(row_to_json(x) order by x.opens_at nulls first, x.title)
      from (
        select v.id as version_id, e.id as exam_id, v.title, e.kind, e.description,
               v.duration_minutes, v.total_marks, v.opens_at, v.closes_at, v.max_attempts,
               v.release_policy,
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
           and (v.closes_at is null or v.closes_at > now() - interval '30 days')
      ) x
  ), '[]'::jsonb);
end;
$$;

create or replace function public.start_attempt(p_version uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  v public.exam_versions;
  a public.exam_attempts;
  n int;
begin
  perform app.ensure_profile();
  perform app.check_rate('start:' || uid, 20, 60);

  if exists (select 1 from public.profiles p where p.id = uid and p.is_blocked) then
    raise exception 'Your account is not allowed to take exams. Contact the administrator.' using errcode = '42501';
  end if;

  select * into v from public.exam_versions where id = p_version and status = 'published';
  if not found or exists (select 1 from public.exams e where e.id = v.exam_id and e.is_archived) then
    raise exception 'This exam is not available' using errcode = 'P0002';
  end if;

  -- Resume an open attempt if one exists.
  select * into a from public.exam_attempts
   where user_id = uid and exam_version_id = p_version and status = 'in_progress' for update;
  if found then
    if not app.finalize_if_expired(a.id) then
      return jsonb_build_object('attempt_id', a.id, 'deadline_at', a.deadline_at, 'server_now', now(), 'resumed', true);
    end if;
  end if;

  if v.opens_at is not null and now() < v.opens_at then
    raise exception 'This exam has not opened yet' using errcode = 'P0001';
  end if;
  if v.closes_at is not null and now() >= v.closes_at then
    raise exception 'This exam window has closed' using errcode = 'P0001';
  end if;

  select count(*) into n from public.exam_attempts where user_id = uid and exam_version_id = p_version;
  if n >= v.max_attempts then
    raise exception 'You have used all attempts for this exam' using errcode = 'P0001';
  end if;

  begin
    insert into public.exam_attempts (exam_version_id, user_id, attempt_no, started_at, deadline_at)
    values (p_version, uid, n + 1, now(),
            least(now() + make_interval(mins => v.duration_minutes), coalesce(v.closes_at, 'infinity'::timestamptz)))
    returning * into a;
  exception when unique_violation then
    -- a concurrent request created the attempt first: return that one
    select * into a from public.exam_attempts
     where user_id = uid and exam_version_id = p_version and status = 'in_progress';
    if not found then raise; end if;
    return jsonb_build_object('attempt_id', a.id, 'deadline_at', a.deadline_at, 'server_now', now(), 'resumed', true);
  end;

  insert into public.responses (attempt_id, exam_question_id)
  select a.id, q.id from public.exam_questions q where q.exam_version_id = p_version;

  return jsonb_build_object('attempt_id', a.id, 'deadline_at', a.deadline_at, 'server_now', now(), 'resumed', false);
end;
$$;

-- Question paper (no answer keys) + saved responses + server clock.
create or replace function public.get_attempt(p_attempt uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  a public.exam_attempts;
  v public.exam_versions;
begin
  select * into a from public.exam_attempts where id = p_attempt and user_id = uid;
  if not found then
    raise exception 'Attempt not found' using errcode = 'P0002';
  end if;
  perform app.finalize_if_expired(a.id);
  select * into a from public.exam_attempts where id = p_attempt;
  select * into v from public.exam_versions where id = a.exam_version_id;

  update public.exam_attempts set last_seen_at = now() where id = a.id and status = 'in_progress';

  return jsonb_build_object(
    'server_now', now(),
    'attempt', jsonb_build_object('id', a.id, 'status', a.status, 'started_at', a.started_at,
                                  'deadline_at', a.deadline_at, 'submitted_at', a.submitted_at,
                                  'attempt_no', a.attempt_no),
    'exam', jsonb_build_object('version_id', v.id, 'title', v.title, 'instructions', v.instructions,
                               'duration_minutes', v.duration_minutes, 'total_marks', v.total_marks,
                               'sections', v.sections, 'marking_rules', v.marking_rules,
                               'release_policy', v.release_policy),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'position', q.position, 'section_key', q.section_key,
               'subject', jsonb_build_object('id', s.id, 'code', s.code, 'name', s.name),
               'type', q.type, 'marks', q.marks, 'negative_marks', q.negative_marks,
               'statement', q.content ->> 'statement', 'image_path', q.content ->> 'image_path',
               'options', coalesce(q.content -> 'options', '[]'::jsonb)) order by q.position)
        from public.exam_questions q
        left join public.subjects s on s.id = q.subject_id
       where q.exam_version_id = v.id), '[]'::jsonb),
    'responses', coalesce((
      select jsonb_agg(jsonb_build_object('exam_question_id', r.exam_question_id, 'answer', r.answer,
                                          'state', r.state, 'seq', r.seq,
                                          'time_spent_seconds', r.time_spent_seconds))
        from public.responses r where r.attempt_id = a.id), '[]'::jsonb)
  );
end;
$$;

-- Incremental autosave. Items: [{exam_question_id, answer, state, seq, time_delta}]
-- `seq` is a per-question counter from the client; stale or duplicate saves
-- (seq <= stored seq) are ignored, so retries and out-of-order delivery are safe.
create or replace function public.save_responses(p_attempt uuid, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  a public.exam_attempts;
  item jsonb;
  q record;
  v_state public.response_state;
  v_answer jsonb;
  v_seq bigint;
  v_rows int;
  n int := 0;
begin
  perform app.check_rate('save:' || uid, 300, 60);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'Invalid save request' using errcode = '22023';
  end if;

  select * into a from public.exam_attempts where id = p_attempt and user_id = uid for update;
  if not found then
    raise exception 'Attempt not found' using errcode = 'P0002';
  end if;

  if a.status = 'in_progress' and now() > a.deadline_at + make_interval(secs => app.grace_seconds()) then
    perform app.finalize_attempt(a.id, 'auto_submitted', 'deadline');
    a.status := 'auto_submitted';
  end if;
  if a.status <> 'in_progress' then
    return jsonb_build_object('saved', 0, 'status', a.status, 'deadline_at', a.deadline_at, 'server_now', now());
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    select eq.id, eq.type,
           coalesce((select array_agg(o ->> 'label') from jsonb_array_elements(eq.content -> 'options') o), '{}') as labels
      into q
      from public.exam_questions eq
     where eq.id = (item ->> 'exam_question_id')::uuid and eq.exam_version_id = a.exam_version_id;
    continue when not found;

    v_state := coalesce((item ->> 'state')::public.response_state, 'not_answered');
    v_seq := coalesce((item ->> 'seq')::bigint, 0);
    v_answer := case when v_state in ('answered', 'answered_marked')
                     then app.normalize_answer(q.type, item -> 'answer', q.labels) end;
    if v_answer is null and v_state = 'answered' then v_state := 'not_answered'; end if;
    if v_answer is null and v_state = 'answered_marked' then v_state := 'marked'; end if;

    update public.responses r
       set answer = v_answer, state = v_state, seq = v_seq, updated_at = now(),
           time_spent_seconds = r.time_spent_seconds
                                + least(greatest(coalesce((item ->> 'time_delta')::int, 0), 0), 900)
     where r.attempt_id = a.id and r.exam_question_id = q.id and r.seq < v_seq;
    get diagnostics v_rows = row_count;
    n := n + v_rows;
  end loop;

  update public.exam_attempts set last_seen_at = now() where id = a.id;
  return jsonb_build_object('saved', n, 'status', 'in_progress', 'deadline_at', a.deadline_at, 'server_now', now());
end;
$$;

-- Final submission. Idempotent: repeated calls return the same outcome.
create or replace function public.submit_attempt(p_attempt uuid, p_reason text default 'manual')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  a public.exam_attempts;
begin
  perform app.check_rate('submit:' || uid, 30, 60);
  select * into a from public.exam_attempts where id = p_attempt and user_id = uid for update;
  if not found then
    raise exception 'Attempt not found' using errcode = 'P0002';
  end if;

  if a.status = 'in_progress' then
    if now() > a.deadline_at + make_interval(secs => app.grace_seconds()) or p_reason = 'timer' then
      perform app.finalize_attempt(a.id, 'auto_submitted', case when p_reason = 'timer' then 'timer' else 'deadline' end);
    else
      perform app.finalize_attempt(a.id, 'submitted', 'manual');
    end if;
    select * into a from public.exam_attempts where id = p_attempt;
    return jsonb_build_object('status', a.status, 'submitted_at', a.submitted_at, 'already_submitted', false,
                              'result_released', app.result_released(a.id));
  end if;

  return jsonb_build_object('status', a.status, 'submitted_at', a.submitted_at, 'already_submitted', true,
                            'result_released', app.result_released(a.id));
end;
$$;

-- Result + (when released) answer keys and solutions.
create or replace function public.get_attempt_result(p_attempt uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  a public.exam_attempts;
  v public.exam_versions;
  res public.results;
  v_admin boolean := app.is_admin();
  v_released boolean;
begin
  select * into a from public.exam_attempts where id = p_attempt and (user_id = uid or v_admin);
  if not found then
    raise exception 'Attempt not found' using errcode = 'P0002';
  end if;
  perform app.finalize_if_expired(a.id);
  select * into a from public.exam_attempts where id = p_attempt;
  select * into v from public.exam_versions where id = a.exam_version_id;

  if a.status = 'in_progress' then
    return jsonb_build_object('status', a.status, 'released', false);
  end if;

  v_released := v_admin or app.result_released(a.id);
  if not v_released then
    return jsonb_build_object('status', a.status, 'released', false, 'title', v.title,
                              'submitted_at', a.submitted_at, 'release_policy', v.release_policy,
                              'release_at', case v.release_policy when 'on_close' then v.closes_at
                                                                  when 'scheduled' then v.release_at
                                                                  else null end);
  end if;

  select * into res from public.results where attempt_id = a.id;

  return jsonb_build_object(
    'status', a.status, 'released', true, 'title', v.title, 'version_id', v.id,
    'started_at', a.started_at, 'submitted_at', a.submitted_at, 'submit_reason', a.submit_reason,
    'result', to_jsonb(res) - 'per_question',
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'position', q.position, 'section_key', q.section_key, 'type', q.type,
               'subject', s.name, 'chapter', ch.name, 'topic', tp.name, 'difficulty', q.difficulty,
               'marks', q.marks, 'negative_marks', q.negative_marks,
               'statement', q.content ->> 'statement', 'image_path', q.content ->> 'image_path',
               'options', coalesce(q.content -> 'options', '[]'::jsonb),
               'your_answer', r.answer, 'state', r.state, 'time_spent', r.time_spent_seconds,
               'correct_answer', k.answer, 'solution', k.solution, 'concepts', k.concepts,
               'outcome', pq ->> 'outcome', 'awarded', (pq ->> 'awarded')::numeric)
             order by q.position)
        from public.exam_questions q
        join public.exam_question_keys k on k.exam_question_id = q.id
        left join public.responses r on r.attempt_id = a.id and r.exam_question_id = q.id
        left join public.subjects s on s.id = q.subject_id
        left join public.chapters ch on ch.id = q.chapter_id
        left join public.topics tp on tp.id = q.topic_id
        left join lateral (select e from jsonb_array_elements(res.per_question) e
                            where e ->> 'exam_question_id' = q.id::text) x(pq) on true
       where q.exam_version_id = v.id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.list_my_attempts()
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
    select jsonb_agg(jsonb_build_object(
             'attempt_id', a.id, 'version_id', v.id, 'title', v.title, 'attempt_no', a.attempt_no,
             'status', a.status, 'started_at', a.started_at, 'submitted_at', a.submitted_at,
             'deadline_at', a.deadline_at,
             'released', app.result_released(a.id),
             'score', case when app.result_released(a.id) then res.score end,
             'max_score', case when app.result_released(a.id) then res.max_score end,
             'percentage', case when app.result_released(a.id) then res.percentage end)
           order by a.started_at desc)
      from public.exam_attempts a
      join public.exam_versions v on v.id = a.exam_version_id
      left join public.results res on res.attempt_id = a.id
     where a.user_id = uid
  ), '[]'::jsonb);
end;
$$;

-- Performance analytics from the student's released results only.
create or replace function public.my_performance()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
begin
  return (
    with rel as (
      select res.*, v.title from public.results res
        join public.exam_versions v on v.id = res.exam_version_id
       where res.user_id = uid and app.result_released(res.attempt_id)
    ),
    q as (
      select e ->> 'subject_id' as subject_id, e ->> 'chapter_id' as chapter_id, e ->> 'topic_id' as topic_id,
             e ->> 'difficulty' as difficulty, e ->> 'outcome' as outcome,
             (e ->> 'awarded')::numeric as awarded, (e ->> 'marks')::numeric as marks,
             coalesce((e ->> 'time_spent')::int, 0) as t
        from rel cross join jsonb_array_elements(rel.per_question) e
    ),
    agg as (
      select dim, k, count(*) as total,
             count(*) filter (where outcome = 'correct') as correct,
             count(*) filter (where outcome = 'partial') as partial,
             count(*) filter (where outcome = 'incorrect') as incorrect,
             count(*) filter (where outcome = 'unanswered') as unanswered,
             sum(awarded) as score, sum(marks) as max_score, sum(t) as time_spent
        from (select 'subject' dim, subject_id k, * from q
              union all select 'chapter', chapter_id, * from q
              union all select 'topic', topic_id, * from q
              union all select 'difficulty', difficulty, * from q) d
       where k is not null
       group by dim, k
    ),
    labelled as (
      select agg.*, coalesce(s.name, c.name, t.name, agg.k) as label,
             case when correct + partial + incorrect > 0
                  then round(100.0 * (correct + partial) / (correct + partial + incorrect), 1) end as accuracy,
             case when max_score > 0 then round(100.0 * score / max_score, 1) end as score_pct
        from agg
        left join public.subjects s on agg.dim = 'subject' and s.id::text = agg.k
        left join public.chapters c on agg.dim = 'chapter' and c.id::text = agg.k
        left join public.topics t on agg.dim = 'topic' and t.id::text = agg.k
    )
    select jsonb_build_object(
      'attempts', (select count(*) from rel),
      'trend', coalesce((select jsonb_agg(jsonb_build_object('attempt_id', attempt_id, 'title', title,
                                  'date', computed_at, 'score', score, 'max', max_score,
                                  'percentage', percentage, 'accuracy', accuracy) order by computed_at)
                           from rel), '[]'::jsonb),
      'totals', (select jsonb_build_object('questions', count(*),
                        'correct', count(*) filter (where outcome = 'correct'),
                        'partial', count(*) filter (where outcome = 'partial'),
                        'incorrect', count(*) filter (where outcome = 'incorrect'),
                        'unanswered', count(*) filter (where outcome = 'unanswered'),
                        'time_spent', coalesce(sum(t), 0)) from q),
      'by_subject', coalesce((select jsonb_agg(to_jsonb(l) order by label) from labelled l where dim = 'subject'), '[]'::jsonb),
      'by_chapter', coalesce((select jsonb_agg(to_jsonb(l) order by score_pct nulls last) from labelled l where dim = 'chapter'), '[]'::jsonb),
      'by_difficulty', coalesce((select jsonb_agg(to_jsonb(l)) from labelled l where dim = 'difficulty'), '[]'::jsonb),
      -- weak areas: chapters/topics seen at least 2 times with < 50% of marks earned
      'weak_areas', coalesce((select jsonb_agg(to_jsonb(l) order by score_pct, total desc)
                                from (select * from labelled
                                       where dim in ('chapter', 'topic') and total >= 2 and coalesce(score_pct, 0) < 50
                                       order by score_pct, total desc limit 8) l), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.log_attempt_event(p_attempt uuid, p_kind text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
begin
  perform app.check_rate('event:' || uid, 60, 60);
  if not exists (select 1 from public.exam_attempts a
                  where a.id = p_attempt and a.user_id = uid and a.status = 'in_progress') then
    return;
  end if;
  insert into public.attempt_events (attempt_id, user_id, kind, details)
  values (p_attempt, uid, p_kind, coalesce(p_details, '{}'::jsonb) - 'user_id');
end;
$$;

grant execute on function public.list_my_exams(), public.start_attempt(uuid), public.get_attempt(uuid),
  public.save_responses(uuid, jsonb), public.submit_attempt(uuid, text), public.get_attempt_result(uuid),
  public.list_my_attempts(), public.my_performance(), public.log_attempt_event(uuid, text, jsonb)
  to authenticated;
