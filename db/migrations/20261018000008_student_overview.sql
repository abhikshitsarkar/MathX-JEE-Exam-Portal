-- Read-only overview of a published paper for its instruction page
-- (no questions, no keys).
create or replace function public.get_exam_overview(p_version uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  uid text := app.require_user();
  v public.exam_versions;
begin
  select * into v from public.exam_versions where id = p_version and status = 'published';
  if not found or exists (select 1 from public.exams e where e.id = v.exam_id and e.is_archived) then
    raise exception 'This exam is not available' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'version_id', v.id, 'title', v.title, 'instructions', v.instructions, 'duration_minutes', v.duration_minutes,
    'total_marks', v.total_marks, 'marking_rules', v.marking_rules, 'release_policy', v.release_policy,
    'opens_at', v.opens_at, 'closes_at', v.closes_at, 'max_attempts', v.max_attempts, 'server_now', now(),
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
revoke execute on function public.get_exam_overview(uuid) from public;
grant execute on function public.get_exam_overview(uuid) to authenticated;
