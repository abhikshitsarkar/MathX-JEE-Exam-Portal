-- =====================================================================
-- Support functions for the AI generation Edge Function: job locking,
-- quota status and atomic progress updates.
-- =====================================================================

alter table public.generation_jobs add column if not exists locked_until timestamptz;

-- Claim a job for one generation batch so two requests never run on the
-- same job at once. Returns false if another batch holds the lock.
create or replace function public.claim_generation_job(p_job uuid, p_seconds int default 150)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  perform app.require_admin();
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
  perform app.require_admin();
  update public.generation_jobs set locked_until = null where id = p_job;
end;
$$;

-- Record a batch result: append generated question ids to the plan slot and
-- add token/cost counters.
create or replace function public.record_generation_batch(p_job uuid, p_slot_id text, p_question_ids uuid[],
                                                          p_input_tokens int, p_output_tokens int, p_cost numeric,
                                                          p_error text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.generation_jobs;
  v_slots jsonb;
begin
  perform app.require_admin();
  select * into j from public.generation_jobs where id = p_job for update;
  if not found then raise exception 'Job not found' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(case when s ->> 'slot_id' = p_slot_id
                                 then jsonb_set(s, '{generated_ids}',
                                                coalesce(s -> 'generated_ids', '[]'::jsonb) || to_jsonb(coalesce(p_question_ids, '{}'))) ||
                                      jsonb_build_object('question_ids',
                                                coalesce(s -> 'question_ids', '[]'::jsonb) || to_jsonb(coalesce(p_question_ids, '{}')),
                                                'attempts', coalesce((s ->> 'attempts')::int, 0) + 1)
                                 else s end), '[]'::jsonb)
    into v_slots
    from jsonb_array_elements(coalesce(j.plan -> 'slots', '[]'::jsonb)) s;

  update public.generation_jobs
     set plan = jsonb_set(plan, '{slots}', v_slots),
         questions_generated = questions_generated + coalesce(cardinality(p_question_ids), 0),
         input_tokens = input_tokens + coalesce(p_input_tokens, 0),
         output_tokens = output_tokens + coalesce(p_output_tokens, 0),
         actual_cost_usd = actual_cost_usd + coalesce(p_cost, 0),
         error = p_error,
         locked_until = null
   where id = p_job
  returning * into j;
  return to_jsonb(j);
end;
$$;

-- Remaining work per slot: needed − (approved bank picks + non-rejected generated drafts).
create or replace function public.generation_job_progress(p_job uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  j public.generation_jobs;
begin
  perform app.require_admin();
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

-- Usage figures used to enforce quotas.
create or replace function public.ai_usage_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'questions_24h', (select count(*) from public.questions where origin = 'ai' and created_at > now() - interval '24 hours'),
    'cost_30d', (select coalesce(sum(cost_usd), 0) from public.ai_calls where created_at > now() - interval '30 days'),
    'calls_24h', (select count(*) from public.ai_calls where created_at > now() - interval '24 hours')
  );
end;
$$;

revoke execute on function public.claim_generation_job(uuid, int), public.release_generation_job(uuid),
  public.record_generation_batch(uuid, text, uuid[], int, int, numeric, text),
  public.generation_job_progress(uuid), public.ai_usage_status() from public;
grant execute on function public.claim_generation_job(uuid, int), public.release_generation_job(uuid),
  public.record_generation_batch(uuid, text, uuid[], int, int, numeric, text),
  public.generation_job_progress(uuid), public.ai_usage_status() to authenticated;
