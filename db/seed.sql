-- =====================================================================
-- Development sample data (optional). Adds 16 verified practice questions
-- and one published 30-minute sample test so the student flow can be
-- tried without any AI calls. Safe to run more than once.
-- Apply with: bash db/apply.sh "<connection string>" --seed   (or run in the Neon SQL Editor after the migrations).
-- =====================================================================

create or replace function pg_temp.add_q(p jsonb) returns uuid
language plpgsql as $$
declare
  v_subject uuid := (select id from public.subjects where code = p ->> 'subject');
  v_chapter uuid := (select id from public.chapters where subject_id = v_subject and name = p ->> 'chapter');
  v_topic uuid;
  v_id uuid;
  o jsonb;
  i int := 0;
  v_problems text[];
begin
  if v_chapter is null then raise exception 'Unknown chapter %', p ->> 'chapter'; end if;
  insert into public.topics (chapter_id, name) values (v_chapter, p ->> 'topic')
  on conflict (chapter_id, parent_id, name) do nothing;
  select id into v_topic from public.topics where chapter_id = v_chapter and parent_id is null and name = p ->> 'topic';

  select id into v_id from public.questions where fingerprint = app.text_fingerprint(p ->> 'statement');
  if v_id is not null then return v_id; end if;

  insert into public.questions (subject_id, chapter_id, topic_id, type, difficulty, statement, marks, negative_marks,
                                learning_objective, origin, tags)
  values (v_subject, v_chapter, v_topic, (p ->> 'type')::public.question_type, (p ->> 'difficulty')::public.difficulty,
          p ->> 'statement', (p ->> 'marks')::numeric, (p ->> 'negative')::numeric, p ->> 'objective', 'manual',
          array['sample'])
  returning id into v_id;

  for o in select * from jsonb_array_elements(coalesce(p -> 'options', '[]')) loop
    i := i + 1;
    insert into public.question_options (question_id, label, content, sort) values (v_id, chr(64 + i), o #>> '{}', i);
  end loop;

  insert into public.question_answer_keys (question_id, correct_options, numeric_value, tolerance)
  values (v_id,
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'correct') x), '{}'),
          (p ->> 'value')::numeric, coalesce((p ->> 'tolerance')::numeric, 0));
  insert into public.question_solutions (question_id, solution, concepts) values (v_id, p ->> 'solution', p ->> 'concepts');

  v_problems := app.question_problems(v_id);
  if cardinality(v_problems) > 0 then raise exception 'Sample question invalid: %', v_problems; end if;
  update public.questions set status = 'approved', reviewed_at = now() where id = v_id;
  return v_id;
end;
$$;

do $$
declare
  ids uuid[] := '{}';
  v_exam uuid;
  v_version uuid;
  v_rules jsonb := (select rules from public.marking_schemes where name = 'JEE Main style' and version = 1);
begin
  ids := ids || pg_temp.add_q('{"subject":"PHY","chapter":"Kinematics","topic":"Motion under gravity","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"A ball is thrown vertically upward with a speed of $20\\ \\text{m s}^{-1}$. Taking $g = 10\\ \\text{m s}^{-2}$ and neglecting air resistance, the maximum height reached by the ball is:",
    "options":["$10\\ \\text{m}$","$20\\ \\text{m}$","$40\\ \\text{m}$","$80\\ \\text{m}$"],"correct":["B"],
    "solution":"At the highest point $v = 0$. Using $v^2 = u^2 - 2gh$: $h = \\dfrac{u^2}{2g} = \\dfrac{400}{20} = 20\\ \\text{m}$.",
    "concepts":"Equations of motion with constant acceleration.","objective":"Apply kinematic equations to vertical motion."}');
  ids := ids || pg_temp.add_q('{"subject":"PHY","chapter":"Laws of Motion","topic":"Connected bodies","type":"numerical","difficulty":"medium","marks":4,"negative":1,
    "statement":"Two blocks of masses $2\\ \\text{kg}$ and $3\\ \\text{kg}$ are placed in contact on a smooth horizontal surface. A horizontal force of $10\\ \\text{N}$ is applied to the $2\\ \\text{kg}$ block. The magnitude of the contact force between the blocks (in newton) is ____.",
    "value":6,"tolerance":0.01,
    "solution":"Common acceleration $a = \\dfrac{10}{2+3} = 2\\ \\text{m s}^{-2}$. The contact force is the only horizontal force on the $3\\ \\text{kg}$ block: $N = 3 \\times 2 = 6\\ \\text{N}$.",
    "concepts":"Newton''s second law applied to a system and to an individual body."}');
  ids := ids || pg_temp.add_q('{"subject":"PHY","chapter":"Work, Energy and Power","topic":"Work-energy theorem","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"The speed of a $2\\ \\text{kg}$ body increases from $2\\ \\text{m s}^{-1}$ to $4\\ \\text{m s}^{-1}$. The work done by the net force on the body is:",
    "options":["$4\\ \\text{J}$","$12\\ \\text{J}$","$16\\ \\text{J}$","$24\\ \\text{J}$"],"correct":["B"],
    "solution":"$W = \\Delta K = \\tfrac12 m (v^2 - u^2) = \\tfrac12 \\cdot 2 \\cdot (16 - 4) = 12\\ \\text{J}$.",
    "concepts":"Work-energy theorem."}');
  ids := ids || pg_temp.add_q('{"subject":"PHY","chapter":"Electrostatics","topic":"Conductors","type":"multiple","difficulty":"medium","marks":4,"negative":2,
    "statement":"For an isolated charged conductor in electrostatic equilibrium, which of the following statements is/are correct?",
    "options":["The electric field inside the conductor is zero.","Any excess charge resides on the outer surface.","The electric field just outside the surface is perpendicular to the surface.","The electric potential inside the conductor is zero."],
    "correct":["A","B","C"],
    "solution":"In equilibrium free charges experience no force inside, so $\\vec E = 0$ inside (A). By Gauss''s law no net charge exists inside, so it lies on the surface (B). A tangential field component would move surface charges, so the field is normal (C). The potential inside is constant and equal to the surface potential, not necessarily zero (D is false).",
    "concepts":"Properties of conductors; Gauss''s law."}');
  ids := ids || pg_temp.add_q('{"subject":"PHY","chapter":"Current Electricity","topic":"Combination of resistors","type":"integer","difficulty":"easy","marks":4,"negative":1,
    "statement":"Three resistors of $6\\ \\Omega$ each are connected in parallel, and this combination is connected in series with a $4\\ \\Omega$ resistor across an ideal $12\\ \\text{V}$ battery. The current drawn from the battery (in ampere) is ____.",
    "value":2,
    "solution":"Parallel: $R_p = 6/3 = 2\\ \\Omega$. Total $R = 2 + 4 = 6\\ \\Omega$. $I = 12/6 = 2\\ \\text{A}$.",
    "concepts":"Series and parallel combinations; Ohm''s law."}');
  ids := ids || pg_temp.add_q('{"subject":"CHE","chapter":"Some Basic Concepts in Chemistry","topic":"Mole concept","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"The number of moles present in $9\\ \\text{g}$ of water ($M = 18\\ \\text{g mol}^{-1}$) is:",
    "options":["$0.25$","$0.5$","$1$","$2$"],"correct":["B"],
    "solution":"$n = \\dfrac{m}{M} = \\dfrac{9}{18} = 0.5\\ \\text{mol}$.","concepts":"Mole concept."}');
  ids := ids || pg_temp.add_q('{"subject":"CHE","chapter":"Solutions","topic":"Concentration terms","type":"numerical","difficulty":"easy","marks":4,"negative":1,
    "statement":"$4\\ \\text{g}$ of NaOH ($M = 40\\ \\text{g mol}^{-1}$) is dissolved in water to make $500\\ \\text{mL}$ of solution. The molarity of the solution (in $\\text{mol L}^{-1}$) is ____.",
    "value":0.2,"tolerance":0.005,
    "solution":"$n = 4/40 = 0.1\\ \\text{mol}$; $M = 0.1/0.5 = 0.2\\ \\text{mol L}^{-1}$.","concepts":"Molarity."}');
  ids := ids || pg_temp.add_q('{"subject":"CHE","chapter":"Atomic Structure","topic":"Electronic configuration","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"The maximum number of electrons that can be accommodated in the shell with principal quantum number $n = 3$ is:",
    "options":["$8$","$9$","$18$","$32$"],"correct":["C"],
    "solution":"Maximum electrons in a shell $= 2n^2 = 2 \\times 9 = 18$.","concepts":"Quantum numbers and shell capacity."}');
  ids := ids || pg_temp.add_q('{"subject":"CHE","chapter":"Chemical Bonding and Molecular Structure","topic":"Dipole moment","type":"multiple","difficulty":"medium","marks":4,"negative":2,
    "statement":"Which of the following molecules have zero net dipole moment?",
    "options":["$\\mathrm{CO_2}$","$\\mathrm{BF_3}$","$\\mathrm{NH_3}$","$\\mathrm{CH_4}$"],"correct":["A","B","D"],
    "solution":"$\\mathrm{CO_2}$ (linear), $\\mathrm{BF_3}$ (trigonal planar) and $\\mathrm{CH_4}$ (tetrahedral) are symmetric, so bond dipoles cancel. $\\mathrm{NH_3}$ is trigonal pyramidal with a lone pair and has a net dipole moment.",
    "concepts":"VSEPR geometry and vector addition of bond dipoles."}');
  ids := ids || pg_temp.add_q('{"subject":"CHE","chapter":"Equilibrium","topic":"pH","type":"integer","difficulty":"easy","marks":4,"negative":1,
    "statement":"The pH of a $0.001\\ \\text{M}$ aqueous HCl solution at $25^\\circ\\text{C}$ is ____.",
    "value":3,
    "solution":"HCl is a strong acid: $[\\mathrm{H^+}] = 10^{-3}\\ \\text{M}$, so $\\text{pH} = -\\log 10^{-3} = 3$.","concepts":"pH of strong acids."}');
  ids := ids || pg_temp.add_q('{"subject":"MAT","chapter":"Complex Numbers and Quadratic Equations","topic":"Roots and coefficients","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"If $\\alpha$ and $\\beta$ are the roots of $x^2 - 5x + 6 = 0$, then $\\alpha^2 + \\beta^2$ equals:",
    "options":["$11$","$13$","$25$","$37$"],"correct":["B"],
    "solution":"$\\alpha + \\beta = 5$, $\\alpha\\beta = 6$. $\\alpha^2 + \\beta^2 = (\\alpha+\\beta)^2 - 2\\alpha\\beta = 25 - 12 = 13$.",
    "concepts":"Relation between roots and coefficients."}');
  ids := ids || pg_temp.add_q('{"subject":"MAT","chapter":"Permutations and Combinations","topic":"Arrangements with repetition","type":"integer","difficulty":"easy","marks":4,"negative":1,
    "statement":"The number of distinct arrangements of the letters of the word LEVEL is ____.",
    "value":30,
    "solution":"5 letters with L and E each repeated twice: $\\dfrac{5!}{2!\\,2!} = \\dfrac{120}{4} = 30$.","concepts":"Permutations of multiset."}');
  ids := ids || pg_temp.add_q('{"subject":"MAT","chapter":"Integral Calculus","topic":"Definite integrals","type":"numerical","difficulty":"easy","marks":4,"negative":1,
    "statement":"The value of $\\displaystyle\\int_0^1 (3x^2 + 2x)\\,dx$ is ____.",
    "value":2,"tolerance":0.001,
    "solution":"$\\left[x^3 + x^2\\right]_0^1 = 1 + 1 = 2$.","concepts":"Fundamental theorem of calculus."}');
  ids := ids || pg_temp.add_q('{"subject":"MAT","chapter":"Matrices and Determinants","topic":"Properties of matrices","type":"multiple","difficulty":"medium","marks":4,"negative":2,
    "statement":"Let $A = \\begin{pmatrix} 1 & 2 \\\\ 2 & 4 \\end{pmatrix}$. Which of the following is/are true?",
    "options":["$\\det A = 0$","$A$ is symmetric","$A$ is invertible","$\\operatorname{tr} A = 5$"],"correct":["A","B","D"],
    "solution":"$\\det A = 4 - 4 = 0$, so $A$ is singular (C false). $A^T = A$ (symmetric). Trace $= 1 + 4 = 5$.",
    "concepts":"Determinant, invertibility, symmetric matrices, trace."}');
  ids := ids || pg_temp.add_q('{"subject":"MAT","chapter":"Trigonometry","topic":"Compound angles","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"The value of $\\sin 75^\\circ \\cos 15^\\circ + \\cos 75^\\circ \\sin 15^\\circ$ is:",
    "options":["$0$","$\\tfrac12$","$\\tfrac{\\sqrt3}{2}$","$1$"],"correct":["D"],
    "solution":"$\\sin A\\cos B + \\cos A \\sin B = \\sin(A+B) = \\sin 90^\\circ = 1$.","concepts":"Compound-angle identity."}');
  ids := ids || pg_temp.add_q('{"subject":"MAT","chapter":"Statistics and Probability","topic":"Classical probability","type":"single","difficulty":"easy","marks":4,"negative":1,
    "statement":"Two fair dice are thrown. The probability that the sum of the numbers shown is $7$ is:",
    "options":["$\\tfrac16$","$\\tfrac19$","$\\tfrac1{12}$","$\\tfrac{5}{36}$"],"correct":["A"],
    "solution":"Favourable outcomes: $(1,6),(2,5),(3,4),(4,3),(5,2),(6,1)$ — 6 of 36. $P = \\tfrac{6}{36} = \\tfrac16$.","concepts":"Classical probability."}');

  if exists (select 1 from public.exams where title = 'Sample Mixed Practice Test') then return; end if;

  insert into public.exams (title, kind, description)
  values ('Sample Mixed Practice Test', 'custom', 'A short sample test (16 questions, 30 minutes) for trying the portal.')
  returning id into v_exam;

  insert into public.exam_versions (exam_id, title, instructions, duration_minutes, marking_rules, sections, release_policy, max_attempts)
  values (v_exam, 'Sample Mixed Practice Test',
          E'This is a 30-minute sample test with 16 questions across Physics, Chemistry and Mathematics.\n\n'
          || E'• Single-correct and numerical questions: +4 for a correct answer, −1 for an incorrect one.\n'
          || E'• One-or-more-correct questions: +4 if all correct options are chosen; +1 for each correct option if only correct options are chosen; −2 otherwise.\n'
          || E'• Unanswered questions score 0. Questions marked for review without an answer are not evaluated.',
          30, v_rules,
          '[{"key":"PHY","title":"Physics"},{"key":"CHE","title":"Chemistry"},{"key":"MAT","title":"Mathematics"}]'::jsonb,
          'immediate', 5)
  returning id into v_version;

  insert into public.exam_questions (exam_version_id, position, section_key, question_id, marks, negative_marks)
  select v_version, row_number() over (order by s.sort, u.ord), s.code, q.id, q.marks, q.negative_marks
    from unnest(ids) with ordinality u(id, ord)
    join public.questions q on q.id = u.id
    join public.subjects s on s.id = q.subject_id;

  perform app.do_publish(v_version);
end $$;
