-- Test helpers: switch between users, assertions.
create schema if not exists t;
grant usage on schema t to authenticated, anonymous;
create table if not exists t.ctx (k text primary key, v text);
grant all on t.ctx to authenticated, anonymous;

create or replace function t.put(p_k text, p_v text) returns void language sql as $$
  insert into t.ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v;
$$;
create or replace function t.get(p_k text) returns text language sql stable as $$
  select v from t.ctx where k = p_k;
$$;

create or replace function t.logout() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', false);
  perform set_config('request.jwt.claims', '', false);
end $$;

-- Sign in as a test user: sets the JWT claims Neon would verify, then
-- switches to the `authenticated` role like the Data API does.
create or replace function t.login(p_name text) returns void language plpgsql as $$
begin
  perform t.logout();
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', t.get('user:' || p_name), 'email', t.get('email:' || p_name),
    'email_verified', coalesce(t.get('verified:' || p_name), 'true')::boolean, 'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;

create or replace function t.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_msg;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

create or replace function t.throws(p_sql text, p_pattern text, p_msg text) returns void language plpgsql as $$
declare
  v_err text;
begin
  begin
    execute p_sql;
    v_err := null;
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null then
    raise exception 'FAIL: % (no error raised)', p_msg;
  end if;
  if v_err !~* p_pattern then
    raise exception 'FAIL: % (unexpected error: %)', p_msg, v_err;
  end if;
  raise notice 'ok - % [%]', p_msg, v_err;
end $$;

grant execute on all functions in schema t to authenticated, anonymous;

-- Users: one invited admin, two students and an attacker who signs up
-- (unverified) with the invited admin's email. Neon Auth ids are opaque
-- strings, so the tests deliberately use non-uuid ids.
insert into app.admin_invites (email) values ('admin@example.com') on conflict do nothing;
select t.put('user:admin', 'neon_user_admin_01'), t.put('email:admin', 'admin@example.com');
select t.put('user:s1', 'neon_user_s1'), t.put('email:s1', 's1@example.com');
select t.put('user:s2', 'neon_user_s2'), t.put('email:s2', 's2@example.com');
select t.put('user:fake', 'neon_user_fake'), t.put('email:fake', 'ADMIN@example.com'), t.put('verified:fake', 'false');

do $$ begin
  perform t.login('fake');  perform public.sync_profile('Impostor', null);
  perform t.login('admin'); perform public.sync_profile('Ada Admin', null);
  perform t.login('s1');    perform public.sync_profile('Student One', 'https://x/y.png');
  perform t.login('s2');    perform public.sync_profile('Student Two', null);
  perform t.logout();
end $$;

do $$ begin
  perform t.ok((select count(*) from public.user_roles where user_id = t.get('user:admin')) = 2,
               'invited admin gets student + admin roles');
  perform t.ok((select array_agg(role) from public.user_roles where user_id = t.get('user:s1')) = array['student'::public.app_role],
               'new user gets only the student role');
  perform t.ok((select full_name from public.profiles where id = t.get('user:s1')) = 'Student One',
               'profile created on first sign-in');
  perform t.ok(not exists (select 1 from public.user_roles where user_id = t.get('user:fake') and role = 'admin'),
               'unverified sign-up with an invited email does NOT become admin');
  perform t.ok((select email from public.profiles where id = t.get('user:fake')) = 'admin@example.com',
               'email is taken from the verified token claims, lower-cased');
end $$;
