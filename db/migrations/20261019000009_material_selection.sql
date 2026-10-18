-- =====================================================================
-- Generation can be limited to chosen study-material PDFs.
-- search_chunks gains p_documents: when given, only those documents are
-- searched, and their best excerpts are returned even when no words match
-- the chapter names (the admin chose them on purpose).
-- Safe to run on an existing database (SQL Editor) — replaces one function.
-- =====================================================================
drop function if exists public.search_chunks(text, uuid, uuid, int);

create or replace function public.search_chunks(p_query text, p_subject uuid default null,
                                                p_chapter uuid default null, p_limit int default 6,
                                                p_documents uuid[] default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ts tsquery;
  v_docs uuid[] := nullif(p_documents, '{}');
begin
  perform app.require_admin();
  -- OR the query terms so partial matches still rank
  v_ts := to_tsquery('english', coalesce(nullif(array_to_string(
            array(select lexeme from unnest(to_tsvector('english', coalesce(p_query, ''))) limit 30), ' | '), ''), 'xyzzynomatch'));
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.rank desc)
      from (
        select c.id, c.document_id, d.title as document_title, c.page_start, c.page_end, c.heading,
               c.content, ts_rank_cd(c.tsv, v_ts) + case when c.chapter_id = p_chapter then 0.5 else 0 end as rank
          from public.document_chunks c
          join public.documents d on d.id = c.document_id
         where d.is_active and d.status = 'ready'
           and (case when v_docs is not null
                     then d.id = any(v_docs)
                     else (p_subject is null or d.subject_id is null or d.subject_id = p_subject)
                          and (c.tsv @@ v_ts or (p_chapter is not null and c.chapter_id = p_chapter))
                end)
         order by rank desc, c.document_id, c.page_start
         limit least(greatest(p_limit, 1), 20)
      ) x), '[]'::jsonb);
end;
$$;

revoke execute on function public.search_chunks(text, uuid, uuid, int, uuid[]) from public;
grant execute on function public.search_chunks(text, uuid, uuid, int, uuid[]) to authenticated;
