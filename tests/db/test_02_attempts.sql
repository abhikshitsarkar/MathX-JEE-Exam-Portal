-- Full attempt lifecycle, autosave semantics, scoring and result release.
do $$
declare
  exams jsonb;
  v_version uuid;
  st jsonb;
  paper jsonb;
  qid uuid[];
  r jsonb;
  res jsonb;
  v_attempt uuid;
begin
  perform t.login('s1');
  exams := public.list_my_exams();
  perform t.ok(jsonb_array_length(exams) = 1, 'student sees the published sample exam');
  v_version := (exams -> 0 ->> 'version_id')::uuid;
  perform t.put('sample_version', v_version::text);
  perform t.ok((exams -> 0 ->> 'question_count')::int = 16, 'sample exam has 16 questions');

  st := public.start_attempt(v_version);
  v_attempt := (st ->> 'attempt_id')::uuid;
  perform t.put('attempt:s1', v_attempt::text);
  perform t.ok((st ->> 'resumed')::boolean = false, 'start_attempt creates an attempt');
  perform t.ok((st ->> 'deadline_at')::timestamptz between now() + interval '29 minutes' and now() + interval '31 minutes',
               'deadline is server time + duration');
  perform t.ok((public.start_attempt(v_version) ->> 'attempt_id')::uuid = v_attempt, 'starting again resumes the same attempt');

  paper := public.get_attempt(v_attempt);
  perform t.ok(jsonb_array_length(paper -> 'questions') = 16, 'paper has 16 questions');
  perform t.ok(paper::text !~ '(correct_answer|"solution"|Gauss|correct_options)', 'paper contains no keys or solutions');
  select array_agg((q ->> 'id')::uuid order by (q ->> 'position')::int) into qid from jsonb_array_elements(paper -> 'questions') q;
  perform t.ok((paper -> 'questions' -> 0 -> 'subject' ->> 'code') = 'PHY', 'questions ordered by subject');

  -- autosave
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', qid[1], 'answer', '{"options":["B"]}'::jsonb, 'state', 'answered', 'seq', 1, 'time_delta', 30),
    jsonb_build_object('exam_question_id', qid[2], 'answer', '{"value":"6.0"}'::jsonb, 'state', 'answered', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[3], 'answer', '{"options":["A"]}'::jsonb, 'state', 'answered', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[4], 'answer', '{"options":["B","A"]}'::jsonb, 'state', 'answered', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[5], 'answer', null, 'state', 'not_answered', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[6], 'answer', '{"options":["B"]}'::jsonb, 'state', 'answered_marked', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[7], 'answer', '{"value":"0.204"}'::jsonb, 'state', 'answered', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[8], 'answer', '{"options":["C"]}'::jsonb, 'state', 'marked', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[9], 'answer', '{"options":["A","C"]}'::jsonb, 'state', 'answered', 'seq', 1),
    jsonb_build_object('exam_question_id', qid[10], 'answer', '{"value":"3"}'::jsonb, 'state', 'answered', 'seq', 1)));
  perform t.ok((r ->> 'saved')::int = 10, 'ten responses saved');

  -- stale / duplicate save is ignored; newer one wins
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', qid[1], 'answer', '{"options":["D"]}'::jsonb, 'state', 'answered', 'seq', 1)));
  perform t.ok((r ->> 'saved')::int = 0, 'duplicate seq is ignored');
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', qid[1], 'answer', '{"options":["D"]}'::jsonb, 'state', 'answered', 'seq', 2)));
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', qid[1], 'answer', '{"options":["B"]}'::jsonb, 'state', 'answered', 'seq', 3)));
  perform t.ok((select answer from public.responses where attempt_id = v_attempt and exam_question_id = qid[1]) = '{"options":["B"]}',
               'latest seq wins');
  perform t.ok((select state from public.responses where attempt_id = v_attempt and exam_question_id = qid[8]) = 'marked'
               and (select answer from public.responses where attempt_id = v_attempt and exam_question_id = qid[8]) is null,
               'marked-without-answer stores no answer');
  perform t.ok((select time_spent_seconds from public.responses where attempt_id = v_attempt and exam_question_id = qid[1]) = 30,
               'time spent recorded');

  -- validation
  perform t.throws(format('select public.save_responses(%L, %L)', v_attempt,
                   jsonb_build_array(jsonb_build_object('exam_question_id', qid[1], 'answer', '{"options":["Z"]}'::jsonb, 'state', 'answered', 'seq', 9))),
                   'Unknown option', 'unknown option label rejected');
  perform t.throws(format('select public.save_responses(%L, %L)', v_attempt,
                   jsonb_build_array(jsonb_build_object('exam_question_id', qid[1], 'answer', '{"options":["A","B"]}'::jsonb, 'state', 'answered', 'seq', 9))),
                   'Exactly one', 'two options on single-correct rejected');
  perform t.throws(format('select public.save_responses(%L, %L)', v_attempt,
                   jsonb_build_array(jsonb_build_object('exam_question_id', qid[5], 'answer', '{"value":"2.5"}'::jsonb, 'state', 'answered', 'seq', 9))),
                   'whole number', 'decimal on integer question rejected');

  -- other student cannot touch this attempt
  perform t.login('s2');
  perform t.throws(format('select public.get_attempt(%L)', v_attempt), 'Attempt not found', 'other student cannot load attempt');
  perform t.throws(format('select public.save_responses(%L, ''[]'')', v_attempt), 'Attempt not found', 'other student cannot save');
  perform t.throws(format('select public.submit_attempt(%L)', v_attempt), 'Attempt not found', 'other student cannot submit');
  perform t.ok((select count(*) from public.responses) = 0, 'other student sees no responses');
  perform t.ok((select count(*) from public.exam_attempts) = 0, 'other student sees no attempts');

  -- submit (idempotent)
  perform t.login('s1');
  r := public.submit_attempt(v_attempt);
  perform t.ok(r ->> 'status' = 'submitted' and (r ->> 'already_submitted')::boolean = false, 'submit works');
  r := public.submit_attempt(v_attempt);
  perform t.ok((r ->> 'already_submitted')::boolean, 'second submit is a no-op');
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', qid[11], 'answer', '{"options":["B"]}'::jsonb, 'state', 'answered', 'seq', 1)));
  perform t.ok((r ->> 'saved')::int = 0 and r ->> 'status' = 'submitted', 'saves after submission are rejected');

  -- score: 4 + 4 - 1 + 2 + 0 + 4 + 4 + 0 - 2 + 4 = 19 / 64
  res := public.get_attempt_result(v_attempt);
  perform t.ok((res ->> 'released')::boolean, 'immediate release policy shows result');
  perform t.ok((res -> 'result' ->> 'score')::numeric = 19, format('score is 19 (got %s)', res -> 'result' ->> 'score'));
  perform t.ok((res -> 'result' ->> 'max_score')::numeric = 64, 'max score 64');
  perform t.ok((res -> 'result' ->> 'correct')::int = 5 and (res -> 'result' ->> 'incorrect')::int = 2
               and (res -> 'result' ->> 'partial')::int = 1 and (res -> 'result' ->> 'unanswered')::int = 8,
               'outcome counts 5/2/1/8');
  perform t.ok((res -> 'result' ->> 'accuracy')::numeric = 75 and (res -> 'result' ->> 'percentage')::numeric = 29.69,
               'accuracy 75%, percentage 29.69%');
  perform t.ok((res -> 'questions' -> 3 ->> 'outcome') = 'partial' and (res -> 'questions' -> 3 ->> 'awarded')::numeric = 2,
               'multiple-correct partial credit +2');
  perform t.ok((res -> 'questions' -> 0 -> 'correct_answer') = '{"options":["B"]}' and (res -> 'questions' -> 0 ->> 'solution') is not null,
               'released result includes key and solution');
  perform t.ok(jsonb_array_length(res -> 'result' -> 'breakdown' -> 'subject') = 3, 'subject-wise breakdown present');
  perform t.ok((select (b ->> 'score')::numeric from jsonb_array_elements(res -> 'result' -> 'breakdown' -> 'subject') b
                 where b ->> 'label' = 'Physics') = 9, 'physics subtotal 9');
  perform t.ok((select count(*) from public.results) = 1, 'student can read own released result row');

  r := public.my_performance();
  perform t.ok((r ->> 'attempts')::int = 1 and jsonb_array_length(r -> 'by_subject') = 3, 'performance analytics computed');
  perform t.ok(jsonb_array_length(public.list_my_attempts()) = 1, 'attempt history listed');
  perform t.logout();
end $$;

-- Server-authoritative deadline
do $$
declare
  st jsonb;
  r jsonb;
  v_attempt uuid;
  q uuid;
begin
  perform t.login('s2');
  st := public.start_attempt(t.get('sample_version')::uuid);
  v_attempt := (st ->> 'attempt_id')::uuid;
  select (x ->> 'id')::uuid into q from jsonb_array_elements(public.get_attempt(v_attempt) -> 'questions') x
   where (x ->> 'position')::int = 1;
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', q, 'answer', '{"options":["B"]}'::jsonb, 'state', 'answered', 'seq', 1)));

  -- simulate the deadline passing (as if the clock moved forward)
  perform t.logout();
  update public.exam_attempts set started_at = now() - interval '40 minutes', deadline_at = now() - interval '10 minutes'
   where id = v_attempt;

  perform t.login('s2');
  r := public.save_responses(v_attempt, jsonb_build_array(
    jsonb_build_object('exam_question_id', q, 'answer', '{"options":["A"]}'::jsonb, 'state', 'answered', 'seq', 2)));
  perform t.ok((r ->> 'saved')::int = 0 and r ->> 'status' = 'auto_submitted', 'save after deadline is refused and auto-submits');
  perform t.ok((select answer from public.responses where attempt_id = v_attempt and exam_question_id = q) = '{"options":["B"]}',
               'late answer did not overwrite the saved one');
  r := public.get_attempt_result(v_attempt);
  perform t.ok((r -> 'result' ->> 'score')::numeric = 4, 'auto-submitted attempt was scored with saved answers');
  perform t.ok((r -> 'result' ->> 'time_taken_seconds')::int = 1800, 'time taken capped at the deadline');
  perform t.logout();
end $$;

-- Deadline in the past is also enforced lazily on any read and by the sweeper
do $$
declare
  v_attempt uuid;
begin
  perform t.login('s2');
  v_attempt := (public.start_attempt(t.get('sample_version')::uuid) ->> 'attempt_id')::uuid;
  perform t.logout();
  update public.exam_attempts set deadline_at = now() - interval '1 minute' where id = v_attempt;
  perform t.ok(public.finalize_expired_attempts() = 1, 'sweeper closes expired attempts');
  perform t.ok((select status from public.exam_attempts where id = v_attempt) = 'auto_submitted', 'attempt auto-submitted');
  perform t.ok(exists (select 1 from public.results where attempt_id = v_attempt), 'auto-submitted attempt has a result');
end $$;

-- Blocked users and attempt limits
do $$
begin
  update public.profiles set is_blocked = true where id = t.get('user:s2');
  perform t.login('s2');
  perform t.throws(format('select public.start_attempt(%L)', t.get('sample_version')), 'not allowed', 'blocked user cannot start');
  perform t.logout();
  update public.profiles set is_blocked = false where id = t.get('user:s2');
  update public.exam_attempts set status = 'submitted' where status = 'in_progress';
end $$;
