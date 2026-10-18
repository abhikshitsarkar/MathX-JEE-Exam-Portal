// Turns an admin's exam requirements into a validated blueprint of "slots"
// (section × chapter × difficulty) with exact counts and marks.
import {
  type Blueprint, DIFFICULTIES, type Difficulty, type GenerationRequest, QUESTION_TYPES, type Slot, type Taxonomy,
} from './types.ts';

export interface BlueprintResult { blueprint: Blueprint | null; errors: string[] }

/** Split `total` into integer parts proportional to `weights` (largest remainder). */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (Math.max(0, w) / sum) * total);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k].i]++;
  return base;
}

export function buildBlueprint(req: GenerationRequest, tax: Taxonomy): BlueprintResult {
  const errors: string[] = [];
  if (!req.title?.trim()) errors.push('Exam name is required.');
  if (!Number.isInteger(req.duration_minutes) || req.duration_minutes < 1 || req.duration_minutes > 720) {
    errors.push('Duration must be between 1 and 720 minutes.');
  }
  if (!Array.isArray(req.sections) || req.sections.length === 0) errors.push('Add at least one section.');
  if ((req.sections?.length ?? 0) > 30) errors.push('At most 30 sections are supported.');

  const mix = req.difficulty_mix ?? { easy: 1, medium: 1, hard: 1 };
  const mixWeights = DIFFICULTIES.map((d) => Number(mix[d] ?? 0));
  if (mixWeights.some((w) => !Number.isFinite(w) || w < 0) || mixWeights.reduce((a, b) => a + b, 0) <= 0) {
    errors.push('Difficulty distribution must contain non-negative values with a positive total.');
  }

  const keys = new Set<string>();
  for (const s of req.sections ?? []) {
    const where = `Section "${s.title || s.key}"`;
    if (!s.key?.trim()) errors.push(`${where}: key is required.`);
    if (keys.has(s.key)) errors.push(`${where}: duplicate section key "${s.key}".`);
    keys.add(s.key);
    if (!QUESTION_TYPES.includes(s.type)) errors.push(`${where}: unsupported question type "${s.type}".`);
    if (!Number.isInteger(s.count) || s.count < 1 || s.count > 100) errors.push(`${where}: question count must be 1–100.`);
    if (!(s.marks > 0)) errors.push(`${where}: marks per question must be positive.`);
    if (!(s.negative >= 0)) errors.push(`${where}: negative marks must be zero or positive.`);
    const subject = tax.subjects.find((x) => x.code === s.subject_code);
    if (!subject) { errors.push(`${where}: unknown subject "${s.subject_code}".`); continue; }
    for (const cid of s.chapter_ids ?? []) {
      const ch = tax.chapters.find((c) => c.id === cid);
      if (!ch || ch.subject_id !== subject.id) errors.push(`${where}: a selected chapter does not belong to ${subject.name}.`);
    }
    if (!(req.marking_rules ?? {})[s.type]) errors.push(`${where}: the marking scheme has no rule for "${s.type}" questions.`);
    const chapters = (s.chapter_ids?.length ? s.chapter_ids : tax.chapters.filter((c) => c.subject_id === subject.id).map((c) => c.id));
    if (chapters.length === 0) errors.push(`${where}: ${subject.name} has no chapters configured.`);
  }

  const totalQuestions = (req.sections ?? []).reduce((a, s) => a + (s.count || 0), 0);
  const totalMarks = (req.sections ?? []).reduce((a, s) => a + (s.count || 0) * (s.marks || 0), 0);
  if (totalQuestions > 300) errors.push('An exam can have at most 300 questions.');
  if (req.total_marks != null && Math.abs(req.total_marks - totalMarks) > 1e-9) {
    errors.push(`Marks do not add up: sections give ${totalMarks}, but the requested total is ${req.total_marks}.`);
  }
  if (req.release_policy === 'on_close' && !req.closes_at) errors.push('“Release when the exam closes” needs a closing time.');
  if (req.release_policy === 'scheduled' && !req.release_at) errors.push('A scheduled release needs a release time.');
  if (req.opens_at && req.closes_at && new Date(req.opens_at) >= new Date(req.closes_at)) {
    errors.push('The exam must open before it closes.');
  }
  if (errors.length) return { blueprint: null, errors };

  const slots: Slot[] = [];
  let rotate = 0;
  for (const s of req.sections) {
    const subject = tax.subjects.find((x) => x.code === s.subject_code)!;
    const chapterIds = s.chapter_ids?.length
      ? s.chapter_ids
      : tax.chapters.filter((c) => c.subject_id === subject.id).map((c) => c.id);
    const perDifficulty = apportion(s.count, mixWeights);

    // assign each question a chapter, spreading evenly and rotating the start
    const groups = new Map<string, { difficulty: Difficulty; chapter: string; count: number }>();
    DIFFICULTIES.forEach((d, di) => {
      for (let k = 0; k < perDifficulty[di]; k++) {
        const chapter = chapterIds[(rotate++) % chapterIds.length];
        const gk = `${d}|${chapter}`;
        const g = groups.get(gk) ?? { difficulty: d, chapter, count: 0 };
        g.count++;
        groups.set(gk, g);
      }
    });

    for (const g of groups.values()) {
      const ch = tax.chapters.find((c) => c.id === g.chapter);
      const topics = tax.topics.filter((t) => t.chapter_id === g.chapter && (!s.topic_ids?.length || s.topic_ids.includes(t.id)));
      const restrictTopics = !!s.topic_ids?.length;
      slots.push({
        slot_id: `${s.key}:${g.chapter}:${g.difficulty}`,
        section_key: s.key,
        label: `${s.title} · ${ch?.name ?? 'Chapter'} · ${g.difficulty}`,
        subject_id: subject.id,
        subject_code: subject.code,
        chapter_ids: [g.chapter],
        chapter_names: [ch?.name ?? ''],
        topic_ids: restrictTopics ? topics.map((t) => t.id) : [],
        topic_names: topics.map((t) => t.name).slice(0, 12),
        type: s.type,
        difficulty: g.difficulty,
        count: g.count,
        marks: s.marks,
        negative_marks: s.negative,
        question_ids: [],
        bank_ids: [],
        generated_ids: [],
      });
    }
  }

  const bySubject: Blueprint['totals']['by_subject'] = {};
  const byDifficulty: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
  const byType: Blueprint['totals']['by_type'] = {};
  for (const sl of slots) {
    bySubject[sl.subject_code] ??= { questions: 0, marks: 0 };
    bySubject[sl.subject_code].questions += sl.count;
    bySubject[sl.subject_code].marks += sl.count * sl.marks;
    byDifficulty[sl.difficulty] += sl.count;
    byType[sl.type] = (byType[sl.type] ?? 0) + sl.count;
  }
  const blueprint: Blueprint = {
    sections: req.sections.map((s) => ({ key: s.key, title: s.title, subject_code: s.subject_code })),
    slots,
    totals: { questions: totalQuestions, marks: totalMarks, by_subject: bySubject, by_difficulty: byDifficulty, by_type: byType },
  };

  // final consistency check
  const slotQuestions = slots.reduce((a, s) => a + s.count, 0);
  const slotMarks = slots.reduce((a, s) => a + s.count * s.marks, 0);
  if (slotQuestions !== totalQuestions || Math.abs(slotMarks - totalMarks) > 1e-9) {
    return { blueprint: null, errors: ['Internal error: blueprint totals are inconsistent.'] };
  }
  return { blueprint, errors: [] };
}
