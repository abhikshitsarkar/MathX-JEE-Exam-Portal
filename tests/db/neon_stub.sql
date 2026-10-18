-- Minimal stand-in for what Neon provides once Neon Auth and the Data API
-- are enabled on a branch: the `authenticated` / `anonymous` roles and the
-- `auth` schema with user_id(), uid() and session(). Lets the migrations,
-- RLS policies and functions be tested on plain PostgreSQL.
-- (Never run this against Neon — Neon creates these itself.)
do $$ begin
  create role authenticated nologin noinherit;
  create role anonymous nologin noinherit;
  create role authenticator login noinherit;
  grant authenticated, anonymous to authenticator;
exception when duplicate_object then null; end $$;

create schema if not exists auth;
grant usage on schema auth to authenticated, anonymous;

-- Neon: auth.session() returns the verified JWT claims of the request.
create or replace function auth.session() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
-- Neon: auth.user_id() returns the JWT `sub` claim as text.
create or replace function auth.user_id() returns text language sql stable as $$
  select nullif(auth.session() ->> 'sub', '')
$$;
-- Neon: auth.uid() returns `sub` as uuid, or null when it is not a uuid.
create or replace function auth.uid() returns uuid language plpgsql stable as $$
begin
  return auth.user_id()::uuid;
exception when others then
  return null;
end $$;
grant execute on all functions in schema auth to authenticated, anonymous;
