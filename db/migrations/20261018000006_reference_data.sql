-- =====================================================================
-- Reference data: subjects, syllabus chapters, default (editable) marking
-- schemes and templates, and default runtime settings.
-- The patterns below are STARTING POINTS based on recent papers. Exam
-- patterns change — verify against the latest official notice and edit
-- them in Admin → Settings before relying on them.
-- =====================================================================

insert into public.subjects (code, name, sort) values
  ('PHY', 'Physics', 1), ('CHE', 'Chemistry', 2), ('MAT', 'Mathematics', 3)
on conflict (code) do nothing;

insert into public.chapters (subject_id, name, sort)
select s.id, c.name, c.ord
  from public.subjects s
  join (values
    ('PHY', 'Units and Measurements', 1), ('PHY', 'Kinematics', 2), ('PHY', 'Laws of Motion', 3),
    ('PHY', 'Work, Energy and Power', 4), ('PHY', 'Rotational Motion', 5), ('PHY', 'Gravitation', 6),
    ('PHY', 'Properties of Solids and Liquids', 7), ('PHY', 'Thermodynamics', 8),
    ('PHY', 'Kinetic Theory of Gases', 9), ('PHY', 'Oscillations and Waves', 10), ('PHY', 'Electrostatics', 11),
    ('PHY', 'Current Electricity', 12), ('PHY', 'Magnetic Effects of Current and Magnetism', 13),
    ('PHY', 'Electromagnetic Induction and Alternating Currents', 14), ('PHY', 'Electromagnetic Waves', 15),
    ('PHY', 'Optics', 16), ('PHY', 'Dual Nature of Matter and Radiation', 17), ('PHY', 'Atoms and Nuclei', 18),
    ('PHY', 'Electronic Devices', 19), ('PHY', 'Experimental Skills', 20),
    ('CHE', 'Some Basic Concepts in Chemistry', 1), ('CHE', 'Atomic Structure', 2),
    ('CHE', 'Chemical Bonding and Molecular Structure', 3), ('CHE', 'Chemical Thermodynamics', 4),
    ('CHE', 'Solutions', 5), ('CHE', 'Equilibrium', 6), ('CHE', 'Redox Reactions and Electrochemistry', 7),
    ('CHE', 'Chemical Kinetics', 8), ('CHE', 'Classification of Elements and Periodicity in Properties', 9),
    ('CHE', 'p-Block Elements', 10), ('CHE', 'd- and f-Block Elements', 11), ('CHE', 'Coordination Compounds', 12),
    ('CHE', 'Purification and Characterisation of Organic Compounds', 13),
    ('CHE', 'Some Basic Principles of Organic Chemistry', 14), ('CHE', 'Hydrocarbons', 15),
    ('CHE', 'Organic Compounds Containing Halogens', 16), ('CHE', 'Organic Compounds Containing Oxygen', 17),
    ('CHE', 'Organic Compounds Containing Nitrogen', 18), ('CHE', 'Biomolecules', 19),
    ('CHE', 'Principles Related to Practical Chemistry', 20),
    ('MAT', 'Sets, Relations and Functions', 1), ('MAT', 'Complex Numbers and Quadratic Equations', 2),
    ('MAT', 'Matrices and Determinants', 3), ('MAT', 'Permutations and Combinations', 4),
    ('MAT', 'Binomial Theorem', 5), ('MAT', 'Sequence and Series', 6),
    ('MAT', 'Limits, Continuity and Differentiability', 7), ('MAT', 'Integral Calculus', 8),
    ('MAT', 'Differential Equations', 9), ('MAT', 'Coordinate Geometry', 10),
    ('MAT', 'Three Dimensional Geometry', 11), ('MAT', 'Vector Algebra', 12),
    ('MAT', 'Statistics and Probability', 13), ('MAT', 'Trigonometry', 14)
  ) as c(code, name, ord) on c.code = s.code
on conflict (subject_id, name) do nothing;

insert into public.marking_schemes (name, version, description, rules) values
  ('JEE Main style', 1,
   'Starting point: +4 correct, −1 incorrect for MCQ and numerical. Verify against the current official notice.',
   '{"single":   {"marks":4,"negative":1,"unanswered":0,"partial":"none"},
     "multiple": {"marks":4,"negative":2,"unanswered":0,"partial":"per_option","partial_per_option":1},
     "integer":  {"marks":4,"negative":1,"unanswered":0,"partial":"none"},
     "numerical":{"marks":4,"negative":1,"unanswered":0,"partial":"none"}}'),
  ('JEE Advanced style', 1,
   'Starting point modelled on recent papers: single +3/−1, multiple +4 with partial credit/−2, numerical +4/0. Verify each year.',
   '{"single":   {"marks":3,"negative":1,"unanswered":0,"partial":"none"},
     "multiple": {"marks":4,"negative":2,"unanswered":0,"partial":"per_option","partial_per_option":1},
     "integer":  {"marks":4,"negative":0,"unanswered":0,"partial":"none"},
     "numerical":{"marks":4,"negative":0,"unanswered":0,"partial":"none"}}')
on conflict (name, version) do nothing;

insert into public.exam_templates (name, kind, version, description, config, marking_scheme_id)
select 'JEE Main style — full paper', 'jee_main', 1,
       '3 subjects × (20 single-correct + 5 numerical), 180 minutes, 300 marks.',
       jsonb_build_object(
         'duration_minutes', 180,
         'difficulty_mix', jsonb_build_object('easy', 30, 'medium', 50, 'hard', 20),
         'sections', jsonb_build_array(
           jsonb_build_object('key','PHY-A','title','Physics — Section A','subject_code','PHY','type','single','count',20,'marks',4,'negative',1),
           jsonb_build_object('key','PHY-B','title','Physics — Section B','subject_code','PHY','type','numerical','count',5,'marks',4,'negative',1),
           jsonb_build_object('key','CHE-A','title','Chemistry — Section A','subject_code','CHE','type','single','count',20,'marks',4,'negative',1),
           jsonb_build_object('key','CHE-B','title','Chemistry — Section B','subject_code','CHE','type','numerical','count',5,'marks',4,'negative',1),
           jsonb_build_object('key','MAT-A','title','Mathematics — Section A','subject_code','MAT','type','single','count',20,'marks',4,'negative',1),
           jsonb_build_object('key','MAT-B','title','Mathematics — Section B','subject_code','MAT','type','numerical','count',5,'marks',4,'negative',1))),
       (select id from public.marking_schemes where name = 'JEE Main style' and version = 1)
on conflict (name, version) do nothing;

insert into public.exam_templates (name, kind, version, description, config, marking_scheme_id)
select 'JEE Advanced style — one paper', 'jee_advanced', 1,
       'Per subject: 4 single (+3/−1), 3 multiple (+4 partial/−2), 6 integer (+4/0), 4 single (+3/−1); 180 minutes.',
       jsonb_build_object(
         'duration_minutes', 180,
         'difficulty_mix', jsonb_build_object('easy', 15, 'medium', 45, 'hard', 40),
         'sections', (select jsonb_agg(sec order by ord) from (
            select s.ord * 10 + x.ord as ord,
                   jsonb_build_object('key', s.code || '-' || x.k, 'title', s.name || ' — ' || x.t, 'subject_code', s.code,
                                      'type', x.ty, 'count', x.n, 'marks', x.m, 'negative', x.neg) as sec
              from (values ('PHY','Physics',1), ('CHE','Chemistry',2), ('MAT','Mathematics',3)) s(code, name, ord)
              cross join (values (1,'1','Section 1 (single correct)','single',4,3,1),
                                 (2,'2','Section 2 (one or more correct)','multiple',3,4,2),
                                 (3,'3','Section 3 (integer answer)','integer',6,4,0),
                                 (4,'4','Section 4 (single correct)','single',4,3,1)) x(ord,k,t,ty,n,m,neg)) z)),
       (select id from public.marking_schemes where name = 'JEE Advanced style' and version = 1)
on conflict (name, version) do nothing;

-- Default AI configuration. provider "mock" makes no paid calls.
-- Prices are USD per million tokens and are used only for estimates.
insert into public.app_settings (key, value) values
  ('ai', '{
     "provider": "mock",
     "model": "claude-sonnet-5-5",
     "base_url": null,
     "max_output_tokens": 6000,
     "temperature": 0.4,
     "price_input_per_mtok": 2.0,
     "price_output_per_mtok": 10.0,
     "batch_size": 4,
     "max_questions_per_job": 90,
     "daily_question_quota": 150,
     "monthly_budget_usd": 10,
     "context_chunks": 5
   }'::jsonb),
  ('uploads', '{"max_pdf_mb": 100, "chunk_chars": 2400, "chunk_overlap": 300}'::jsonb)
on conflict (key) do nothing;
