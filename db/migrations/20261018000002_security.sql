-- =====================================================================
-- Security: helper functions, triggers, privileges and Row Level Security
-- =====================================================================

-- Functions created from here on are not callable by API roles unless
-- explicitly granted.
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------
-- Helper functions (private schema)
-- ---------------------------------------------------------------------
create or replace function app.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.user_id()) and r.role = 'admin'
  );
$$;

create or replace function app.require_admin()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not app.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
end;
$$;

create or replace function app.audit(p_action text, p_entity_type text, p_entity_id text, p_details jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values ((select auth.user_id()), p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- Fixed-window rate limiter. Raises an error when the bucket is exhausted.
create or replace function app.check_rate(p_bucket text, p_max int, p_window_seconds int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into app.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  if v_hits > p_max then
    raise exception 'Too many requests, please slow down' using errcode = 'P0429';
  end if;
  -- opportunistic cleanup of old windows
  if random() < 0.01 then
    delete from app.rate_limits where window_start < now() - interval '1 day';
  end if;
end;
$$;

create or replace function app.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Normalised text fingerprint used for exact-duplicate detection.
create or replace function app.text_fingerprint(p_text text)
returns text language sql immutable set search_path = ''
as $$
  select md5(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '', 'g'));
$$;

-- ---------------------------------------------------------------------
-- Users: Neon Auth owns sign-in; the app keeps its own profile + roles,
-- created on first use (no trigger on the auth tables is needed).
-- ---------------------------------------------------------------------

-- Claims of the current request's JWT (Neon Data API: auth.session();
-- PostgREST-compatible fallback: request.jwt.claims).
create or replace function app.jwt_claims()
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v jsonb;
begin
  begin
    execute 'select auth.session()' into v;
    if v is not null then return v; end if;
  exception when others then
    null;
  end;
  return coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
end;
$$;

-- Whether the signed-in user's email is verified. Checked against Neon
-- Auth's own user table when readable, otherwise the JWT claim. Used so an
-- admin invitation can never be claimed by an unverified sign-up.
create or replace function app.email_verified(p_uid text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v boolean;
  c jsonb := app.jwt_claims();
begin
  begin
    execute 'select "emailVerified" from neon_auth."user" where id::text = $1' into v using p_uid;
    if v is not null then return v; end if;
  exception when others then
    null;
  end;
  return coalesce((c ->> 'email_verified')::boolean, (c ->> 'emailVerified')::boolean, false);
end;
$$;

-- Create the profile and student role for the current user if missing.
create or replace function app.ensure_profile(p_name text default null, p_avatar text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := (select auth.user_id());
  v_email text := lower(nullif(app.jwt_claims() ->> 'email', ''));
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url)
  values (uid, v_email, left(nullif(btrim(p_name), ''), 120), left(nullif(btrim(p_avatar), ''), 1000))
  on conflict (id) do update
     set email      = coalesce(excluded.email, public.profiles.email),
         full_name  = coalesce(public.profiles.full_name, excluded.full_name),
         avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);

  insert into public.user_roles (user_id, role) values (uid, 'student') on conflict do nothing;

  if v_email is not null
     and exists (select 1 from app.admin_invites i where i.email = v_email)
     and not exists (select 1 from public.user_roles r where r.user_id = uid and r.role = 'admin')
     and app.email_verified(uid) then
    insert into public.user_roles (user_id, role) values (uid, 'admin') on conflict do nothing;
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (uid, 'role.granted_by_invite', 'user', uid, jsonb_build_object('role', 'admin', 'email', v_email));
  end if;
  return uid;
end;
$$;

-- Called by the website after every sign-in: keeps name/photo current and
-- returns the user's roles.
create or replace function public.sync_profile(p_name text default null, p_avatar text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid text := app.ensure_profile(p_name, p_avatar);
begin
  perform app.check_rate('sync:' || uid, 30, 60);
  return jsonb_build_object(
    'id', uid,
    'roles', coalesce((select jsonb_agg(role order by role) from public.user_roles where user_id = uid), '[]'::jsonb),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid));
end;
$$;
grant execute on function public.sync_profile(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- updated_at + fingerprint triggers
-- ---------------------------------------------------------------------
create trigger profiles_touch       before update on public.profiles        for each row execute function app.touch_updated_at();
create trigger documents_touch      before update on public.documents       for each row execute function app.touch_updated_at();
create trigger exams_touch          before update on public.exams           for each row execute function app.touch_updated_at();
create trigger exam_versions_touch  before update on public.exam_versions   for each row execute function app.touch_updated_at();
create trigger jobs_touch           before update on public.generation_jobs for each row execute function app.touch_updated_at();
create trigger solutions_touch      before update on public.question_solutions for each row execute function app.touch_updated_at();

create or replace function app.questions_before_write()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.fingerprint := app.text_fingerprint(new.statement);
  new.updated_at := now();
  return new;
end;
$$;
create trigger questions_before_write before insert or update on public.questions
  for each row execute function app.questions_before_write();

-- ---------------------------------------------------------------------
-- Immutability of published exam versions
-- ---------------------------------------------------------------------
create or replace function app.guard_exam_version()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  mutable_cols text[] := array['status', 'release_policy', 'release_at', 'closes_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published or archived exam versions cannot be deleted; archive the exam instead'
        using errcode = '42501';
    end if;
    return old;
  end if;

  if old.status <> 'draft' then
    if new.status = 'draft' then
      raise exception 'A published exam version cannot return to draft; create a new version instead'
        using errcode = '42501';
    end if;
    if (to_jsonb(new) - mutable_cols) is distinct from (to_jsonb(old) - mutable_cols) then
      raise exception 'Published exam versions are immutable (only status, release and closing time can change)'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger exam_versions_guard before update or delete on public.exam_versions
  for each row execute function app.guard_exam_version();

create or replace function app.guard_exam_children()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.version_status;
begin
  if tg_table_name = 'exam_questions' then
    select v.status into v_status from public.exam_versions v
     where v.id = coalesce(new.exam_version_id, old.exam_version_id);
  else
    select v.status into v_status
      from public.exam_questions q join public.exam_versions v on v.id = q.exam_version_id
     where q.id = coalesce(new.exam_question_id, old.exam_question_id);
  end if;

  if v_status is not null and v_status <> 'draft' then
    raise exception 'Questions of a published exam version cannot be changed' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger exam_questions_guard before insert or update or delete on public.exam_questions
  for each row execute function app.guard_exam_children();
create trigger exam_question_keys_guard before insert or update or delete on public.exam_question_keys
  for each row execute function app.guard_exam_children();

-- ---------------------------------------------------------------------
-- Release rule: may this attempt's result/solutions be shown?
-- ---------------------------------------------------------------------
create or replace function app.result_released(p_attempt_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select a.status <> 'in_progress' and case v.release_policy
             when 'immediate' then true
             when 'on_close'  then now() >= v.closes_at
             when 'scheduled' then now() >= v.release_at
             when 'manual'    then v.release_at is not null and now() >= v.release_at
           end
      from public.exam_attempts a
      join public.exam_versions v on v.id = a.exam_version_id
     where a.id = p_attempt_id
  ), false);
$$;

grant execute on function app.result_released(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Privileges: nothing for anonymous users; signed-in users get table
-- access only where RLS policies allow, and all writes that matter go
-- through server functions.
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    execute 'revoke all on all tables in schema public from anonymous';
    execute 'revoke all on all sequences in schema public from anonymous';
  end if;
end $$;

revoke insert, update, delete on public.profiles, public.user_roles, public.exam_attempts,
  public.responses, public.results, public.attempt_events, public.audit_logs from authenticated;
grant update (full_name) on public.profiles to authenticated;
-- admins manage attempts only through functions; results are computed only by the server
revoke truncate on all tables in schema public from authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.user_roles           enable row level security;
alter table public.subjects             enable row level security;
alter table public.chapters             enable row level security;
alter table public.topics               enable row level security;
alter table public.documents            enable row level security;
alter table public.document_chunks      enable row level security;
alter table public.generation_jobs      enable row level security;
alter table public.questions            enable row level security;
alter table public.question_options     enable row level security;
alter table public.question_answer_keys enable row level security;
alter table public.question_solutions   enable row level security;
alter table public.marking_schemes      enable row level security;
alter table public.exam_templates       enable row level security;
alter table public.exams                enable row level security;
alter table public.exam_versions        enable row level security;
alter table public.exam_questions       enable row level security;
alter table public.exam_question_keys   enable row level security;
alter table public.exam_attempts        enable row level security;
alter table public.responses            enable row level security;
alter table public.results              enable row level security;
alter table public.attempt_events       enable row level security;
alter table public.ai_calls             enable row level security;
alter table public.app_settings         enable row level security;
alter table public.audit_logs           enable row level security;

-- Profiles and roles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.user_id()) or (select app.is_admin()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.user_id())) with check (id = (select auth.user_id()));

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.user_id()) or (select app.is_admin()));

-- Taxonomy: readable by every signed-in user, managed by admins
create policy subjects_read on public.subjects for select to authenticated using (true);
create policy subjects_admin on public.subjects for all to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));
create policy chapters_read on public.chapters for select to authenticated using (true);
create policy chapters_admin on public.chapters for all to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));
create policy topics_read on public.topics for select to authenticated using (true);
create policy topics_admin on public.topics for all to authenticated
  using ((select app.is_admin())) with check ((select app.is_admin()));

-- Admin-only tables (students reach exam content only through functions
-- that strip answer keys)
do $$
declare t text;
begin
  foreach t in array array[
    'documents', 'document_chunks', 'generation_jobs', 'questions', 'question_options',
    'question_answer_keys', 'question_solutions', 'marking_schemes', 'exam_templates',
    'exams', 'exam_versions', 'exam_questions', 'exam_question_keys', 'ai_calls', 'app_settings'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated using ((select app.is_admin())) with check ((select app.is_admin()))',
      t || '_admin_all', t);
  end loop;
end $$;

-- Attempts / responses / results: own rows (results only once released)
create policy attempts_select on public.exam_attempts for select to authenticated
  using (user_id = (select auth.user_id()) or (select app.is_admin()));

create policy responses_select on public.responses for select to authenticated
  using ((select app.is_admin()) or exists (
    select 1 from public.exam_attempts a where a.id = attempt_id and a.user_id = (select auth.user_id())));

create policy results_select on public.results for select to authenticated
  using ((select app.is_admin()) or (user_id = (select auth.user_id()) and app.result_released(attempt_id)));

create policy attempt_events_admin on public.attempt_events for select to authenticated
  using ((select app.is_admin()));

create policy audit_logs_admin on public.audit_logs for select to authenticated
  using ((select app.is_admin()));
