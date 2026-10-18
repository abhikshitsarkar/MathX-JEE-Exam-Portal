-- Admin workflows: immutability, versioning, release rules, question
-- validation, import, duplicates, assembling from a generation plan, storage.
do $$
declare
  v_version uuid := t.get('sample_version')::uuid;
  v_exam uuid;
  v_new uuid;
  r jsonb;
  v_attempt uuid;
  q uuid;
begin
  perform t.login('admin');
  select exam_id into v_exam from public.exam_versions where id = v_version;

  -- published versions are immutable
  perform t.throws(format('update public.exam_versions set title = ''Changed'' where id = %L', v_version),
                   'immutable', 'cannot edit a published version');
  perform t.throws(format('update public.exam_questions set marks = 10 where exam_version_id = %L', v_version),
                   'cannot be changed', 'cannot edit questions of a published version');
  perform t.throws(format('delete from public.exam_questions where exam_version_id = %L', v_version),
                   'cannot be changed', 'cannot delete questions of a published version');
  perform t.throws(format('delete from public.exam_versions where id = %L', v_version),
                   'cannot be deleted', 'cannot delete a published version');
  update public.exam_versions set closes_at = now() + interval '30 days' where id = v_version;
  perform t.ok(true, 'closing time of a published version can change');

  -- editing the bank does not change the published snapshot
  select question_id into q from public.exam_questions where exam_version_id = v_version and position = 1;
  update public.questions set statement = 'Edited statement for the bank copy only.' where id = q;
  perform t.ok((select content ->> 'statement' from public.exam_questions where exam_version_id = v_version and position = 1)
               like 'A ball is thrown%', 'published snapshot unaffected by bank edits');
  perform public.set_question_status(q, 'approved');

  -- new draft version with manual release
  v_new := public.create_draft_version(v_exam);
  perform t.ok((select count(*) from public.exam_questions where exam_version_id = v_new) = 16, 'draft version copies questions');
  update public.exam_versions set release_policy = 'manual', title = 'Sample v2' where id = v_new;
  perform public.reorder_exam_question((select id from public.exam_questions where exam_version_id = v_new and position = 2), -1);
  perform t.ok((select question_id from public.exam_questions where exam_version_id = v_new and position = 1)
               <> q, 'reorder swaps positions');
  r := public.publish_exam_version(v_new);
  perform t.ok((r ->> 'published')::boolean, 'draft version published');
  perform t.ok((select status from public.exam_versions where id = v_version) = 'archived', 'previous version archived');
  perform t.put('v2', v_new::text);

  -- student takes v2: result hidden until released
  perform t.login('s1');
  v_attempt := (public.start_attempt(v_new) ->> 'attempt_id')::uuid;
  perform public.submit_attempt(v_attempt);
  r := public.get_attempt_result(v_attempt);
  perform t.ok((r ->> 'released')::boolean = false and r::text !~ 'correct_answer', 'manual release hides result and keys');
  perform t.ok((select count(*) from public.results where attempt_id = v_attempt) = 0, 'unreleased result row hidden by RLS');
  perform t.ok((select (x ->> 'score') is null from jsonb_array_elements(public.list_my_attempts()) x
                 where (x ->> 'attempt_id')::uuid = v_attempt), 'history hides score before release');
  perform t.throws(format('select public.start_attempt(%L)', v_version), 'not available', 'archived version cannot be started');

  perform t.login('admin');
  r := public.get_attempt_result(v_attempt);
  perform t.ok((r ->> 'released')::boolean, 'admin can always see results');
  perform public.release_results_now(v_new);
  perform t.login('s1');
  perform t.ok((public.get_attempt_result(v_attempt) ->> 'released')::boolean, 'result visible after manual release');
  perform t.logout();
end $$;

-- Question bank validation, import, duplicates
do $$
declare
  v_id uuid;
  r jsonb;
begin
  perform t.login('admin');
  v_id := public.admin_upsert_question('{"subject_code":"PHY","chapter_name":"Optics","topic_name":"Refraction","type":"single",
    "difficulty":"medium","statement":"A ray of light passes from air into glass of refractive index 1.5. Which quantity stays unchanged?",
    "options":[{"label":"A","content":"Speed"},{"label":"B","content":"Wavelength"},{"label":"C","content":"Frequency"},{"label":"D","content":"Speed"}],
    "answer":{"options":["C"]}}');
  r := public.admin_get_question(v_id);
  perform t.ok(r ->> 'status' = 'draft', 'new question is a draft');
  perform t.ok(r -> 'problems' ? 'Solution is missing' and r -> 'problems' ? 'Two options have identical text',
               'validation reports missing solution and duplicate options');
  perform t.throws(format('select public.set_question_status(%L, ''approved'')', v_id), 'Cannot approve', 'invalid question cannot be approved');

  v_id := public.admin_upsert_question(jsonb_build_object('id', v_id) || '{"subject_code":"PHY","chapter_name":"Optics","topic_name":"Refraction","type":"single",
    "difficulty":"medium","statement":"A ray of light passes from air into glass of refractive index 1.5. Which quantity stays unchanged?",
    "options":[{"label":"A","content":"Speed"},{"label":"B","content":"Wavelength"},{"label":"C","content":"Frequency"},{"label":"D","content":"Direction"}],
    "answer":{"options":["C"]},"solution":"Frequency is set by the source and does not change on refraction.","status":"approved"}');
  perform t.ok((select status from public.questions where id = v_id) = 'approved', 'fixed question approved via upsert');

  perform t.ok((select count(*) from public.find_similar_questions(
                 'A ray of light passes from air into glass of refractive index 1.5. Which quantity remains unchanged?',
                 null, 0.5, 5)) >= 1, 'near-duplicate detected');

  r := public.admin_import_questions('[
    {"subject_code":"MAT","chapter_name":"Binomial Theorem","type":"integer","statement":"The number of terms in the expansion of $(1+x)^{10}$ is ____.","answer":{"value":11},"solution":"$n+1 = 11$ terms.","status":"approved"},
    {"subject_code":"XXX","type":"single","statement":"Broken item"},
    {"subject_code":"CHE","chapter_name":"Solutions","type":"numerical","statement":"A numerical question with options is invalid here.","options":[{"label":"A","content":"x"}],"answer":{"value":1},"solution":"n/a","status":"approved"}
  ]');
  perform t.ok(jsonb_array_length(r -> 'imported') = 1 and jsonb_array_length(r -> 'errors') = 2,
               format('import: 1 ok, 2 errors reported (%s)', r -> 'errors'));
  perform t.ok(jsonb_array_length(public.admin_export_questions('{"status":"approved"}')) >= 17, 'export returns approved questions');
  perform t.ok((public.admin_list_questions('{"q":"refraction"}') ->> 'total')::int = 1, 'text search in the bank');
  perform t.ok(exists (select 1 from public.audit_logs where action = 'question.import'), 'import is audited');
  perform t.logout();
end $$;

-- Generation plan → exam assembly; missing slots are reported
do $$
declare
  v_job uuid;
  r jsonb;
  phy uuid := (select id from public.subjects where code = 'PHY');
  ids jsonb;
begin
  perform t.login('admin');
  select jsonb_agg(id) into ids from (select id from public.questions where subject_id = phy and type = 'single' and status = 'approved' limit 3) x;
  insert into public.generation_jobs (created_by, request, blueprint, plan)
  values (auth.uid(),
          jsonb_build_object('title', 'Assembled Test', 'kind', 'custom', 'duration_minutes', 20,
                             'marking_rules', (select rules from public.marking_schemes where name = 'JEE Main style')),
          '{"sections":[{"key":"PHY","title":"Physics"}]}',
          jsonb_build_object('slots', jsonb_build_array(
            jsonb_build_object('slot_id', 's1', 'label', 'Physics single', 'section_key', 'PHY', 'count', 3, 'marks', 4,
                               'negative_marks', 1, 'question_ids', ids),
            jsonb_build_object('slot_id', 's2', 'label', 'Physics numerical', 'section_key', 'PHY', 'count', 2, 'marks', 4,
                               'negative_marks', 1, 'question_ids', '[]'::jsonb))))
  returning id into v_job;

  r := public.assemble_exam_from_job(v_job, false);
  perform t.ok((r ->> 'ok')::boolean = false and jsonb_array_length(r -> 'missing') = 1, 'assembly reports the unfilled slot');
  r := public.assemble_exam_from_job(v_job, true);
  perform t.ok((r ->> 'ok')::boolean and (select count(*) from public.exam_questions where exam_version_id = (r ->> 'version_id')::uuid) = 3,
               'partial assembly creates a draft with available questions');
  perform t.ok((select total_marks from public.exam_versions where id = (r ->> 'version_id')::uuid) = 12, 'draft total marks computed');
  perform t.throws(format('select public.assemble_exam_from_job(%L, true)', v_job), 'already assembled', 'a job assembles only once');
  perform t.logout();
end $$;

-- File access rules (used by the api function before signing storage URLs)
do $$
declare
  v_path text;
  v_version uuid;
begin
  -- give a question in the published v2 paper a figure, as a fresh draft version
  perform t.login('admin');
  perform t.ok(public.can_access_file('documents', 'books/hc-verma.pdf'), 'admin can read study material');
  perform t.ok(public.can_access_file('question-images', 'questions/x.png', true), 'admin can upload figures');
  perform t.ok(not public.can_access_file('secrets', 'x'), 'unknown buckets are refused');
  perform t.ok(not public.can_access_file('documents', '../etc/passwd'), 'path traversal is refused');
  perform t.logout();

  select content ->> 'image_path' into v_path from public.exam_questions where content ->> 'image_path' is not null limit 1;
  perform t.login('s1');
  perform t.ok(not public.can_access_file('documents', 'books/hc-verma.pdf'), 'student cannot read study material');
  perform t.ok(not public.can_access_file('question-images', 'questions/x.png', true), 'student cannot upload');
  perform t.ok(not public.can_access_file('question-images', 'questions/unrelated.png'), 'student cannot read unrelated figures');
  perform t.logout();

  -- attach a figure to a question of the exam s1 attempted, via the snapshot
  select x.exam_version_id into v_version from public.exam_attempts x
   where x.user_id = t.get('user:s1') order by started_at desc limit 1;
  alter table public.exam_questions disable trigger exam_questions_guard;
  update public.exam_questions set content = content || '{"image_path":"questions/fig-1.png"}'
   where exam_version_id = v_version and position = 1;
  alter table public.exam_questions enable trigger exam_questions_guard;
  perform t.login('s1');
  perform t.ok(public.can_access_file('question-images', 'questions/fig-1.png'), 'student can read a figure from an exam they attempted');
  perform t.login('s2');
  perform t.ok(not public.can_access_file('question-images', 'questions/fig-1.png'), 'another student without that attempt cannot');
  perform t.logout();
end $$;

