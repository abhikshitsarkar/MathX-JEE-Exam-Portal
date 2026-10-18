-- Student papers: making a private paper, privacy of papers and marks,
-- per-job access, and shared study material uploaded by students.
do $$
declare
  v_phy uuid := (select id from public.subjects where code = 'PHY');
  v_chap uuid;
  v_bank uuid[];
  v_draft uuid;
  v_rules jsonb := (select marking_rules from public.exam_versions where id = t.get('sample_version')::uuid);
  v_job uuid;
  v_q uuid;
  v_other uuid;
  r jsonb;
  v_version uuid;
  v_exam uuid;
  v_attempt uuid;
  n int;
  v_doc uuid;
  s1 text := t.get('user:s1');
  q jsonb;
begin
  perform t.logout();
  select q.chapter_id into v_chap from public.questions q
   where q.subject_id = v_phy and q.status = 'approved' and q.type = 'single' and q.owner_id is null limit 1;
  select array_agg(id) into v_bank from (select id from public.questions
   where subject_id = v_phy and chapter_id = v_chap and status = 'approved' and type = 'single' and owner_id is null limit 1) x;
  -- an unreviewed admin draft that must never leak into a student's paper
  insert into public.questions (subject_id, chapter_id, type, statement, status)
  values (v_phy, v_chap, 'single', 'Unreviewed admin draft question text', 'draft') returning id into v_draft;

  -- ---------------- bank search as a student: ids only, no private questions
  perform t.login('s1');
  r := public.search_question_bank(jsonb_build_object('subject_id', v_phy, 'type', 'single', 'limit', 50));
  perform t.ok(jsonb_array_length(r) > 0 and (r -> 0) ?& array['id'] and not ((r -> 0) ? 'preview'),
               'students get only question ids from the bank search');
  perform t.ok(not exists (select 1 from jsonb_array_elements(r) e where (e ->> 'id')::uuid = v_draft),
               'bank search never returns unapproved questions');

  -- ---------------- create a practice job; a forged id is stripped
  v_job := public.practice_create_job(
    jsonb_build_object('title', 'My physics practice', 'kind', 'custom', 'duration_minutes', 20, 'marking_rules', v_rules,
                       'max_attempts', 2),
    jsonb_build_object('sections', jsonb_build_array(jsonb_build_object('key', 'PHY', 'title', 'Physics'))),
    jsonb_build_object('slots', jsonb_build_array(jsonb_build_object(
      'slot_id', 'S1', 'label', 'Physics single', 'section_key', 'PHY', 'subject_id', v_phy, 'chapter_ids', jsonb_build_array(v_chap),
      'type', 'single', 'difficulty', 'medium', 'count', 2, 'marks', 4, 'negative_marks', 1,
      'bank_ids', to_jsonb(v_bank || v_draft)))),
    'mock', 'mock', 1, 0);
  perform t.ok((select jsonb_array_length(plan -> 'slots' -> 0 -> 'question_ids') from public.generation_jobs where id = v_job) = 1,
               'a forged unapproved question id is dropped from a student plan');
  perform t.ok((select count(*) from public.generation_jobs where id = v_job) = 1, 'student can read their own practice job');

  -- ---------------- save an AI question: checked and private
  q := jsonb_build_object('subject_id', v_phy, 'chapter_id', v_chap, 'type', 'single', 'difficulty', 'medium',
         'statement', 'A practice-only question about uniform motion with speed 5 m/s for 2 s. How far does it go?',
         'options', jsonb_build_array(jsonb_build_object('label', 'A', 'content', '5 m'), jsonb_build_object('label', 'B', 'content', '10 m'),
                                      jsonb_build_object('label', 'C', 'content', '15 m'), jsonb_build_object('label', 'D', 'content', '20 m')),
         'answer', jsonb_build_object('options', jsonb_build_array('B')), 'solution', 'Distance = 5 × 2 = 10 m.', 'marks', 4, 'negative_marks', 1);
  v_q := public.practice_save_question(v_job, q);
  perform t.ok((select count(*) from public.questions where id = v_q) = 0, 'the student cannot read the question table (keys stay hidden)');
  perform t.throws(format('select public.practice_save_question(%L, %L::jsonb)', v_job, (q - 'solution')::text),
                   'automatic checks', 'a question without a solution is rejected');
  perform t.logout();
  perform t.ok((select status = 'approved' and owner_id = s1 from public.questions where id = v_q),
               'a valid AI question is approved automatically and owned by the student');
  perform t.ok((select count(*) from public.questions where generation_job_id = v_job) = 1, 'the rejected question is not stored');
  perform t.login('s1');
  perform public.record_generation_batch(v_job, 'S1', array[v_q, v_draft], 0, 0, 0, null);
  perform t.ok((select plan -> 'slots' -> 0 -> 'question_ids' from public.generation_jobs where id = v_job) @> to_jsonb(array[v_q])
               and not ((select plan -> 'slots' -> 0 -> 'question_ids' from public.generation_jobs where id = v_job) @> to_jsonb(array[v_draft])),
               'only questions written for the job can be attached to it');
  perform t.ok((public.my_ai_usage() ->> 'my_questions_24h')::int = 1, 'daily AI usage is counted per student');
  perform t.throws('insert into public.ai_calls (user_id, provider, model, purpose, cost_usd, ok) values (' || quote_literal(s1) || ', ''x'', ''x'', ''x'', 999, true)',
                   'row-level security', 'students cannot write AI cost records directly');
  perform public.log_ai_call(v_job, 'anthropic', 'm', 10, 10, 999, true, null, 5);
  perform t.logout();
  perform t.ok((select max(cost_usd) from public.ai_calls where user_id = s1) = 5, 'logged AI cost per call is capped');
  perform t.login('s1');

  -- ---------------- another student cannot touch the job
  perform t.login('s2');
  perform t.throws(format('select public.generation_job_progress(%L)', v_job), 'not found', 'another student cannot read the job');
  perform t.throws(format('select public.practice_save_question(%L, %L::jsonb)', v_job, q::text), 'not found',
                   'another student cannot add questions to the job');
  perform t.throws(format('select public.practice_finish(%L)', v_job), 'not found', 'another student cannot finish the job');
  perform t.throws(format('select public.log_ai_call(%L, ''x'', ''x'', 1, 1, 1, true, null, 1)', v_job), 'not found',
                   'another student cannot log costs against the job');
  perform t.ok((select count(*) from public.generation_jobs where id = v_job) = 0, 'another student cannot see the job');

  -- ---------------- finish: a private published paper
  perform t.login('s1');
  r := public.practice_finish(v_job);
  perform t.ok((r ->> 'ok')::boolean and (r ->> 'questions')::int = 2, 'the paper is created with bank + AI questions');
  v_version := (r ->> 'version_id')::uuid;
  v_exam := (r ->> 'exam_id')::uuid;
  perform t.ok((public.practice_finish(v_job) ->> 'version_id')::uuid = v_version, 'finishing twice returns the same paper');
  perform t.ok(exists (select 1 from jsonb_array_elements(public.list_my_exams()) e
                        where (e ->> 'version_id')::uuid = v_version and (e ->> 'is_mine')::boolean),
               'the student sees their paper in their list');
  perform t.ok((public.get_exam_overview(v_version) ->> 'is_mine')::boolean, 'the student can open their paper');

  v_attempt := (public.start_attempt(v_version) ->> 'attempt_id')::uuid;
  perform public.submit_attempt(v_attempt, 'manual');
  perform t.ok((public.get_attempt_result(v_attempt) -> 'result' ->> 'max_score')::numeric = 8,
               'the student sees their own result straight away');

  perform t.login('s2');
  perform t.ok(not exists (select 1 from jsonb_array_elements(public.list_my_exams()) e where (e ->> 'version_id')::uuid = v_version),
               'other students do not see the paper');
  perform t.throws(format('select public.get_exam_overview(%L)', v_version), 'not available', 'other students cannot open the paper');
  perform t.throws(format('select public.start_attempt(%L)', v_version), 'not available', 'other students cannot attempt the paper');
  perform t.ok((select count(*) from public.results where exam_version_id = v_version) = 0, 'other students cannot see the marks');

  -- ---------------- admins do not see students' papers or marks
  perform t.login('admin');
  perform t.ok((select count(*) from public.exam_attempts where id = v_attempt) = 0, 'admin cannot read the attempt');
  perform t.ok((select count(*) from public.results where attempt_id = v_attempt) = 0, 'admin cannot read the marks');
  perform t.ok((select count(*) from public.responses where attempt_id = v_attempt) = 0, 'admin cannot read the answers');
  perform t.throws(format('select public.admin_exam_report(%L)', v_version), 'private paper', 'admin report refuses a private paper');
  perform t.ok(not (public.admin_overview() -> 'recent_attempts')::text like '%My physics practice%',
               'admin overview leaves out private attempts');
  perform t.ok(not exists (select 1 from jsonb_array_elements(public.admin_list_questions('{}'::jsonb, 200) -> 'items') i
                            where (i ->> 'id')::uuid = v_q), 'admin question bank leaves out private questions');
  perform t.ok(jsonb_array_length(public.admin_exam_report(t.get('sample_version')::uuid) -> 'attempts') > 0,
               'admin reports on official papers still work');

  -- ---------------- archive your own paper
  perform t.login('s2');
  perform t.throws(format('select public.practice_archive(%L)', v_exam), 'not found', 'others cannot archive the paper');
  perform t.login('s1');
  perform public.practice_archive(v_exam);
  perform t.ok(not exists (select 1 from jsonb_array_elements(public.list_my_exams()) e where (e ->> 'version_id')::uuid = v_version),
               'an archived paper leaves the student''s list');
  perform t.ok((select count(*) from public.results where attempt_id = v_attempt) = 1, 'marks are kept after archiving');

  -- ---------------- shared study material
  perform t.ok(public.can_access_file('documents', 'u/' || s1 || '/notes.pdf', true), 'a student can upload into their own folder');
  perform t.ok(not public.can_access_file('documents', 'u/someone_else/notes.pdf', true), 'but not into another folder');
  perform t.ok(not public.can_access_file('documents', 'books/x.pdf', true), 'or outside the user folders');
  perform t.throws(format($s$insert into public.documents (title, storage_path, sha256, file_size, status, authorized_confirmed, uploaded_by)
                    values ('Bad', 'books/bad.pdf', %L, 10, 'uploaded', true, %L)$s$, repeat('e', 64), s1),
                   'row-level security', 'a student document must live in their own folder');
  insert into public.documents (title, subject_id, storage_path, sha256, file_size, status, authorized_confirmed, uploaded_by)
  values ('Student notes', v_phy, 'u/' || s1 || '/notes.pdf', repeat('d', 64), 10, 'uploaded', true, s1) returning id into v_doc;
  insert into public.document_chunks (document_id, chunk_index, page_start, page_end, content)
  values (v_doc, 0, 1, 1, 'Student notes on simple harmonic motion and springs.');
  update public.documents set status = 'ready' where id = v_doc;

  perform t.login('s2');
  perform t.ok((select count(*) from public.documents where id = v_doc) = 1, 'other users see shared material at once');
  perform t.ok(jsonb_array_length(public.search_chunks('harmonic springs', v_phy, null, 5, array[v_doc])) = 1,
               'other users can make papers from it');
  update public.documents set title = 'Hijacked' where id = v_doc;
  perform t.ok((select title from public.documents where id = v_doc) = 'Student notes', 'others cannot edit it');
  delete from public.documents where id = v_doc;
  perform t.ok((select count(*) from public.documents where id = v_doc) = 1, 'others cannot delete it');
  perform t.throws(format('insert into public.document_chunks (document_id, chunk_index, content) values (%L, 5, ''spam'')', v_doc),
                   'row-level security', 'others cannot add text to it');
  perform t.ok(not public.can_access_file('documents', 'u/' || s1 || '/notes.pdf'), 'others cannot download the original file');
  perform t.ok(public.document_uploaders() ->> v_doc::text = 'Student Uno', 'uploader name is shown with shared material');

  perform t.login('admin');
  update public.documents set is_active = false where id = v_doc;
  perform t.ok((select not is_active from public.documents where id = v_doc), 'admin can deactivate any shared material');
  perform t.logout();
end $$;

select 'ALL DATABASE TESTS PASSED' as result;
