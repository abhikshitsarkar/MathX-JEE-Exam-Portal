-- Generation limited to chosen study-material PDFs (search_chunks p_documents).
do $$
declare
  v_phy uuid := (select id from public.subjects where code = 'PHY');
  d1 uuid; d2 uuid; d_old uuid;
  r jsonb;
begin
  perform t.logout();
  insert into public.documents (title, subject_id, storage_path, sha256, file_size, status, authorized_confirmed)
  values ('Mechanics notes', v_phy, 'books/m.pdf', repeat('a', 64), 1000, 'ready', true) returning id into d1;
  insert into public.documents (title, subject_id, storage_path, sha256, file_size, status, authorized_confirmed)
  values ('Optics notes', v_phy, 'books/o.pdf', repeat('b', 64), 1000, 'ready', true) returning id into d2;
  insert into public.documents (title, subject_id, storage_path, sha256, file_size, status, authorized_confirmed, is_active)
  values ('Old optics', v_phy, 'books/o0.pdf', repeat('c', 64), 1000, 'ready', true, false) returning id into d_old;
  insert into public.document_chunks (document_id, chunk_index, page_start, page_end, content) values
    (d1, 0, 1, 2, 'Projectile motion: range R = u^2 sin 2θ / g. Kinematics in two dimensions.'),
    (d1, 1, 3, 4, 'Newton laws of motion and friction on an inclined plane.'),
    (d2, 0, 1, 1, 'Refraction through a prism and the lens maker formula.'),
    (d_old, 0, 1, 1, 'Refraction notes from an older edition.');

  perform t.login('admin');
  r := public.search_chunks('refraction lens', v_phy, null, 10);
  perform t.ok(jsonb_array_length(r) = 1 and r -> 0 ->> 'document_id' = d2::text,
               'without a selection, matching active material is searched (deactivated excluded)');

  r := public.search_chunks('refraction lens', v_phy, null, 10, array[d1]);
  perform t.ok(jsonb_array_length(r) = 2
               and not exists (select 1 from jsonb_array_elements(r) e where e ->> 'document_id' <> d1::text),
               'with a selection, only the chosen PDF is used, even when no words match');

  r := public.search_chunks('projectile range', v_phy, null, 1, array[d1, d2]);
  perform t.ok(jsonb_array_length(r) = 1 and r -> 0 ->> 'content' like 'Projectile%',
               'best-matching page of the chosen PDFs comes first');

  r := public.search_chunks('refraction', v_phy, null, 10, array[d_old]);
  perform t.ok(jsonb_array_length(r) = 0, 'a deactivated PDF is never used even if chosen');

  r := public.search_chunks('refraction', v_phy, null, 10, '{}'::uuid[]);
  perform t.ok(jsonb_array_length(r) = 1, 'an empty selection means all material');

  perform t.login('s1');
  r := public.search_chunks('refraction lens', v_phy, null, 10);
  perform t.ok(jsonb_array_length(r) = 1, 'students can use shared study material for their papers');
  perform t.logout();
  perform t.throws('select public.search_chunks(''motion'')', 'Sign in required', 'signed-out callers cannot search study material');
end $$;

