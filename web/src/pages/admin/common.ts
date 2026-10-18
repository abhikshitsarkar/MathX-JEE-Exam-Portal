import { useEffect, useState } from 'react';
import { db } from '../../lib/db';

export interface Subject { id: string; code: string; name: string }
export interface Chapter { id: string; subject_id: string; name: string; sort: number }
export interface Topic { id: string; chapter_id: string; parent_id: string | null; name: string }
export interface Taxonomy { subjects: Subject[]; chapters: Chapter[]; topics: Topic[] }

let cache: Promise<Taxonomy> | null = null;

export function loadTaxonomy(force = false): Promise<Taxonomy> {
  if (!cache || force) {
    cache = (async () => {
      const [s, c, t] = await Promise.all([
        db.from('subjects').select('id, code, name').order('sort'),
        db.from('chapters').select('id, subject_id, name, sort').order('sort').limit(2000),
        db.from('topics').select('id, chapter_id, parent_id, name').order('name').limit(5000),
      ]);
      if (s.error || c.error || t.error) { cache = null; throw new Error((s.error || c.error || t.error)!.message); }
      return { subjects: s.data ?? [], chapters: c.data ?? [], topics: t.data ?? [] } as Taxonomy;
    })();
  }
  return cache;
}

export function useTaxonomy() {
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { loadTaxonomy().then(setTax).catch((e: Error) => setError(e.message)); }, []);
  return { tax, error, refresh: () => loadTaxonomy(true).then(setTax) };
}

export type Rules = Record<string, { marks: number; negative: number; unanswered?: number; partial?: string; partial_per_option?: number }>;
export interface MarkingScheme { id: string; name: string; version: number; description: string | null; rules: Rules; is_active: boolean }
export interface TemplateSection { key: string; title: string; subject_code: string; type: string; count: number; marks: number; negative: number }
export interface ExamTemplate { id: string; name: string; kind: string; version: number; description: string | null;
  config: { duration_minutes: number; difficulty_mix?: Record<string, number>; sections: TemplateSection[] }; marking_scheme_id: string | null; is_active: boolean }

export async function must<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Convert an ISO timestamp to the value of a datetime-local input, and back. */
export const toLocalInput = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
