-- =====================================================================
-- File access rules for Neon Object Storage.
-- Files live in two private buckets (created in the Neon Console/CLI):
--   documents        — uploaded PDFs (admin only)
--   question-images  — figures used in questions
-- The browser never holds storage credentials. The `api` Neon Function
-- signs short-lived URLs only after asking the database whether the
-- signed-in user may access the object, using this function.
-- =====================================================================

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
revoke execute on function public.can_access_file(text, text, boolean) from public;
grant execute on function public.can_access_file(text, text, boolean) to authenticated;
