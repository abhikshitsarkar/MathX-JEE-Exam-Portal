-- Row Level Security and privilege tests.
do $$
declare
  n int;
begin
  -- Anonymous users cannot read anything
  perform t.logout();
  perform set_config('role', 'anonymous', false);
  perform t.throws('select count(*) from public.questions', 'permission denied', 'anonymous cannot read questions');
  perform t.throws('select count(*) from public.subjects', 'permission denied', 'anonymous cannot read subjects');
  perform t.throws('select public.list_my_exams()', 'permission denied', 'anonymous cannot call student functions');

  perform t.login('s1');
  perform t.ok((select count(*) from public.subjects) = 3, 'student can read subjects');
  perform t.ok((select count(*) from public.questions) = 0, 'student sees no bank questions');
  perform t.ok((select count(*) from public.question_options) = 0, 'student sees no bank options');
  perform t.ok((select count(*) from public.question_answer_keys) = 0, 'student sees no answer keys');
  perform t.ok((select count(*) from public.question_solutions) = 0, 'student sees no solutions');
  perform t.ok((select count(*) from public.exam_versions) = 0, 'student cannot list exam versions directly');
  perform t.ok((select count(*) from public.exam_questions) = 0, 'student cannot read exam questions directly');
  perform t.ok((select count(*) from public.exam_question_keys) = 0, 'student cannot read exam keys');
  perform t.ok((select count(*) from public.app_settings where key <> 'ai') = 0, 'student cannot read settings other than AI limits');
  perform t.ok((select count(*) from public.audit_logs) = 0, 'student cannot read audit logs');
  perform t.ok((select count(*) from public.profiles) = 1, 'student sees only their own profile');
  perform t.ok((select count(*) from public.user_roles) = 1, 'student sees only their own roles');

  -- Privilege escalation attempts
  perform t.throws(format('insert into public.user_roles (user_id, role) values (%L, ''admin'')', t.get('user:s1')),
                   'permission denied', 'student cannot grant themselves admin');
  perform t.throws('update public.profiles set is_blocked = false', 'permission denied',
                   'student cannot change protected profile columns');
  update public.profiles set full_name = 'Student Uno';
  perform t.ok((select full_name from public.profiles) = 'Student Uno', 'student can edit own name');
  perform t.throws('select public.admin_overview()', 'Administrator access required', 'student cannot call admin functions');
  perform t.throws(format('select public.admin_set_role(%L, ''admin'', true)', t.get('user:s1')),
                   'Administrator access required', 'student cannot call admin_set_role');
  perform t.throws('select app.do_publish(gen_random_uuid())', 'permission denied', 'student cannot call internal publish');
  perform t.throws('select app.ensure_profile()', 'permission denied', 'student cannot call internal profile helper');
  perform t.throws(format('update public.profiles set email = %L', 'admin@example.com'), 'permission denied', 'student cannot change their email');
  perform t.throws('select app.compute_result(gen_random_uuid())', 'permission denied', 'student cannot call internal scoring');
  perform t.throws('select public.finalize_expired_attempts()', 'permission denied', 'student cannot run the sweeper');
  perform t.throws('insert into public.results (attempt_id, user_id, exam_version_id, score, max_score, correct, incorrect, partial, unanswered, breakdown, per_question) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1,1,1,0,0,0,''{}'',''[]'')',
                   'permission denied', 'student cannot insert results');
  perform t.throws('insert into public.questions (subject_id, type, statement) select id, ''single'', ''hello world'' from public.subjects limit 1',
                   'row-level security', 'student cannot insert questions');
  perform t.throws('insert into public.app_settings (key, value) values (''x'', ''{}'')', 'row-level security',
                   'student cannot write settings');

  -- Admin sees everything
  perform t.login('admin');
  select count(*) into n from public.question_answer_keys;
  perform t.ok(n = 16, 'admin can read answer keys');
  perform t.ok((select count(*) from public.profiles) = 4, 'admin sees all profiles');
  perform t.ok((public.admin_overview() ->> 'students')::int = 4, 'admin overview works');
  perform t.throws(format('select public.admin_set_role(%L, ''admin'', false)', t.get('user:admin')),
                   'last administrator', 'cannot remove the last admin');
  perform t.throws(format('select public.admin_set_blocked(%L, true)', t.get('user:admin')),
                   'cannot block yourself', 'admin cannot block themselves');
  perform t.logout();
end $$;
