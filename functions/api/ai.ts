// Hybrid exam generation: question bank first, AI only for the gaps.
// All database access goes through the Neon Data API with the CALLER'S token,
// so Row Level Security and the admin checks inside SQL still apply.
import { buildBlueprint } from '../_shared/blueprint.ts';
import { parseModelJson } from '../_shared/jsonRepair.ts';
import { buildUserPrompt, SYSTEM_PROMPT, type WorkItem } from '../_shared/prompt.ts';
import { callModel, costUsd, estimateGeneration, mockModelResponse, ProviderError } from '../_shared/providers.ts';
import type { AiSettings, Excerpt, GenerationRequest, Slot, Taxonomy } from '../_shared/types.ts';
import { validateGenerated } from '../_shared/validate.ts';
import { type Db, HttpError } from './http.ts';

const DEFAULT_SETTINGS: AiSettings = {
  provider: 'mock', model: 'claude-sonnet-5-5', base_url: null, max_output_tokens: 6000, temperature: 0.4,
  price_input_per_mtok: 2, price_output_per_mtok: 10, batch_size: 4, max_questions_per_job: 90,
  daily_question_quota: 150, monthly_budget_usd: 10, context_chunks: 5, student_daily_questions: 20,
};

interface Usage { my_questions_24h: number; questions_24h: number; cost_30d: number }

/** AI questions this student may still get today (Infinity with the free mock provider). */
export function studentAllowance(settings: AiSettings, usage: Usage): number {
  if (settings.provider === 'mock') return Infinity;
  return Math.max(0, (settings.student_daily_questions ?? 20) - Number(usage.my_questions_24h));
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new HttpError(500, `${what}: ${error.message}`);
  return data;
}

export async function loadSettings(db: Db): Promise<AiSettings> {
  const row = await must(db.from('app_settings').select('value').eq('key', 'ai').maybeSingle(), 'Loading AI settings');
  return { ...DEFAULT_SETTINGS, ...((row as { value?: Partial<AiSettings> } | null)?.value ?? {}) };
}

async function loadTaxonomy(db: Db): Promise<Taxonomy> {
  const [subjects, chapters, topics] = await Promise.all([
    must(db.from('subjects').select('id, code, name').order('sort'), 'Loading subjects'),
    must(db.from('chapters').select('id, subject_id, name').order('sort').limit(2000), 'Loading chapters'),
    must(db.from('topics').select('id, chapter_id, name').order('sort').limit(5000), 'Loading topics'),
  ]);
  return { subjects, chapters, topics } as Taxonomy;
}

// ---------------------------------------------------------------------------
// Study-material PDFs chosen for a job (valid ids only); null = all indexed material.
function chosenDocuments(request: GenerationRequest | null | undefined): string[] | null {
  const ids = (request?.document_ids ?? []).filter((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
  return ids.length ? [...new Set(ids)].slice(0, 50) : null;
}

// plan: blueprint → search the bank → gaps → estimate → job
// ---------------------------------------------------------------------------
export async function plan(db: Db, userId: string, input: GenerationRequest, practice = false) {
  const request: GenerationRequest = practice
    ? {
      ...input,
      title: (input.title ?? '').trim() || 'My practice paper',
      // a student's own paper: open at once, results immediately, a few attempts
      release_policy: 'immediate', release_at: null, opens_at: null, closes_at: null,
      max_attempts: Math.min(10, Math.max(1, Number(input.max_attempts) || 3)),
    }
    : input;
  const [settings, tax] = await Promise.all([loadSettings(db), loadTaxonomy(db)]);
  const { blueprint, errors } = buildBlueprint(request, tax);
  if (!blueprint) throw new HttpError(400, 'The exam requirements are not valid.', { errors });

  const used = new Set<string>();
  for (const slot of blueprint.slots) {
    const found = await must(db.rpc('search_question_bank', {
      p: {
        subject_id: slot.subject_id, chapter_ids: slot.chapter_ids, topic_ids: slot.topic_ids, type: slot.type,
        difficulty: slot.difficulty, strict_topic: slot.topic_ids.length > 0, exclude_ids: [...used], limit: slot.count,
      },
    }), 'Searching the question bank') as { id: string }[];
    const picked = (found ?? []).slice(0, slot.count).map((q) => q.id);
    picked.forEach((id) => used.add(id));
    slot.bank_ids = picked;
    slot.question_ids = [...picked];
    slot.generated_ids = [];
  }

  const fromBank = blueprint.slots.reduce((a, s) => a + (s.bank_ids?.length ?? 0), 0);
  const gaps = blueprint.totals.questions - fromBank;
  const allowAi = request.allow_ai !== false;
  if (allowAi && gaps > settings.max_questions_per_job) {
    throw new HttpError(400,
      `This paper needs ${gaps} new questions, above the per-job limit of ${settings.max_questions_per_job}. ` +
      'Add questions to the bank, reduce the paper, or raise the limit in Settings.');
  }
  const estimate = estimateGeneration(settings, allowAi ? gaps : 0);
  const missing = blueprint.slots
    .filter((s) => (s.bank_ids?.length ?? 0) < s.count)
    .map((s) => ({ slot_id: s.slot_id, label: s.label, needed: s.count - (s.bank_ids?.length ?? 0) }));

  if (practice) {
    if (allowAi && gaps > 0) {
      const usage = await must(db.rpc('my_ai_usage'), 'Reading AI usage') as Usage;
      const left = studentAllowance(settings, usage);
      if (gaps > left) {
        throw new HttpError(429,
          `This paper needs ${gaps} new AI-written questions, but you can get ${left} more today ` +
          `(limit ${settings.student_daily_questions ?? 20} a day). Make the paper smaller, pick chapters with more ` +
          'questions in the bank, or untick "Write new questions with AI".');
      }
      if (settings.provider !== 'mock' && Number(usage.cost_30d) >= settings.monthly_budget_usd) {
        throw new HttpError(429, 'AI question writing is paused for now (the monthly budget is used up). Untick "Write new questions with AI" to use the question bank only.');
      }
    }
    if (!allowAi && fromBank === 0) {
      throw new HttpError(400, 'The question bank has no questions for these chapters and types yet. Tick "Write new questions with AI" or choose other chapters.');
    }
    const id = await must(db.rpc('practice_create_job', {
      p_request: request,
      p_blueprint: { sections: blueprint.sections, totals: blueprint.totals },
      p_plan: { slots: blueprint.slots, estimate, from_bank: fromBank, gaps, allow_ai: allowAi },
      p_provider: settings.provider, p_model: settings.model, p_requested: allowAi ? gaps : 0, p_est: estimate.usd,
    }), 'Creating your paper') as string;
    return { job_id: id, totals: blueprint.totals, from_bank: fromBank, gaps: allowAi ? gaps : 0, missing, estimate, allow_ai: allowAi };
  }

  const job = await must(db.from('generation_jobs').insert({
    created_by: userId,
    status: 'planned',
    request,
    blueprint: { sections: blueprint.sections, totals: blueprint.totals },
    plan: { slots: blueprint.slots, estimate, from_bank: fromBank, gaps, allow_ai: allowAi },
    provider: settings.provider,
    model: settings.model,
    questions_requested: allowAi ? gaps : 0,
    est_cost_usd: estimate.usd,
  }).select('id').single(), 'Creating the generation job') as { id: string };

  return { job_id: job.id, totals: blueprint.totals, from_bank: fromBank, gaps, missing, estimate, allow_ai: allowAi };
}

// ---------------------------------------------------------------------------
// generate: one batch of questions for the slots that still need them
// ---------------------------------------------------------------------------
interface ProgressSlot extends Slot { remaining: number; attempts?: number }

export async function generate(db: Db, userId: string, jobId: string, practice = false) {
  const job = await must(db.from('generation_jobs').select('*').eq('id', jobId).maybeSingle(), 'Loading the job') as
    | { id: string; exam_id: string | null; request: GenerationRequest; status: string; questions_generated: number }
    | null;
  if (!job) throw new HttpError(404, 'Generation job not found.');
  if (job.exam_id) throw new HttpError(409, 'This job has already been assembled into an exam.');
  if (job.request?.allow_ai === false) throw new HttpError(400, 'AI generation is disabled for this job.');

  const settings = await loadSettings(db);
  const claimed = await must(db.rpc('claim_generation_job', { p_job: jobId, p_seconds: 170 }), 'Locking the job');
  if (!claimed) throw new HttpError(409, 'Another batch for this job is still running. Try again shortly.');

  let released = false;
  try {
    const progress = await must(db.rpc('generation_job_progress', { p_job: jobId }), 'Reading progress') as
      { slots: ProgressSlot[] };
    const pending = progress.slots.filter((s) => s.remaining > 0 && (s.attempts ?? 0) < 6);
    if (pending.length === 0) {
      if (practice) await db.rpc('release_generation_job', { p_job: jobId });
      else await db.from('generation_jobs').update({ status: 'review', locked_until: null }).eq('id', jobId);
      released = true;
      return { done: true, generated: 0, failures: [], remaining: 0 };
    }

    // quotas
    const usage = await must(db.rpc(practice ? 'my_ai_usage' : 'ai_usage_status'), 'Reading AI usage') as Usage;
    if (usage.questions_24h >= settings.daily_question_quota) {
      throw new HttpError(429, practice
        ? 'AI question writing has reached today\'s overall limit. You can start the paper with the questions ready so far, or try again tomorrow.'
        : `Daily AI question quota reached (${settings.daily_question_quota}). Raise it in Settings or try tomorrow.`);
    }
    if (settings.provider !== 'mock' && Number(usage.cost_30d) >= settings.monthly_budget_usd) {
      throw new HttpError(429, practice
        ? 'AI question writing is paused for now (the monthly budget is used up). You can start the paper with the questions ready so far.'
        : `30-day AI budget of $${settings.monthly_budget_usd} reached. Raise it in Settings to continue.`);
    }
    const studentLeft = practice ? studentAllowance(settings, usage) : Infinity;
    if (studentLeft <= 0) {
      throw new HttpError(429, `You have used today's ${settings.student_daily_questions ?? 20} AI-written questions. You can start the paper with the questions ready so far, or continue tomorrow.`);
    }

    // pick a batch from one subject so the context excerpts stay relevant
    const subjectId = pending[0].subject_id;
    const batchSize = Math.max(1, Math.min(settings.batch_size, 10,
      settings.daily_question_quota - usage.questions_24h, studentLeft));
    const items: WorkItem[] = [];
    for (const slot of pending.filter((s) => s.subject_id === subjectId)) {
      for (let i = 0; i < slot.remaining && items.length < batchSize; i++) {
        items.push({ ref: `Q${items.length + 1}`, slot });
      }
      if (items.length >= batchSize) break;
    }

    const tax = await loadTaxonomy(db);
    const subject = tax.subjects.find((s) => s.id === subjectId);
    const chapterNames = [...new Set(items.flatMap((i) => i.slot.chapter_names))];
    const topicNames = [...new Set(items.flatMap((i) => i.slot.topic_names))].slice(0, 15);
    const excerpts = settings.context_chunks > 0
      ? (await must(db.rpc('search_chunks', {
        p_query: [...chapterNames, ...topicNames].join(' '), p_subject: subjectId,
        p_chapter: items[0].slot.chapter_ids[0] ?? null, p_limit: settings.context_chunks,
        p_documents: chosenDocuments(job.request),
      }), 'Retrieving study material') as Excerpt[])
      : [];

    // call the model
    const t0 = Date.now();
    let text = '';
    let inTok = 0;
    let outTok = 0;
    let callError: string | null = null;
    try {
      if (settings.provider === 'mock') {
        text = mockModelResponse(items, excerpts, String(job.questions_generated));
      } else {
        const system = SYSTEM_PROMPT;
        const user = buildUserPrompt(items, excerpts, subject?.name ?? '');
        let res;
        try {
          res = await callModel(settings, process.env.AI_API_KEY, system, user);
        } catch (e) {
          if (e instanceof ProviderError && e.retryable) {
            await new Promise((r) => setTimeout(r, 2500));
            res = await callModel(settings, process.env.AI_API_KEY, system, user);
          } else throw e;
        }
        text = res.text;
        inTok = res.inputTokens;
        outTok = res.outputTokens;
      }
    } catch (e) {
      callError = (e as Error).message;
    }
    const cost = settings.provider === 'mock' ? 0 : costUsd(settings, inTok, outTok);
    await db.rpc('log_ai_call', {
      p_job: jobId, p_provider: settings.provider, p_model: settings.model, p_input_tokens: inTok,
      p_output_tokens: outTok, p_cost: cost, p_ok: !callError, p_error: callError, p_latency_ms: Date.now() - t0,
    });

    let parsed: { questions?: unknown[] } = {};
    if (!callError) {
      try {
        parsed = parseModelJson(text);
        if (!Array.isArray(parsed.questions)) throw new Error('missing "questions" array');
      } catch (e) {
        callError = `The model returned malformed output (${(e as Error).message}).`;
      }
    }
    if (callError) {
      for (const slotId of new Set(items.map((i) => i.slot.slot_id))) {
        await db.rpc('record_generation_batch', {
          p_job: jobId, p_slot_id: slotId, p_question_ids: [], p_input_tokens: 0, p_output_tokens: 0, p_cost: 0,
          p_error: callError,
        });
      }
      await db.rpc('record_generation_batch', {
        p_job: jobId, p_slot_id: '__none__', p_question_ids: [], p_input_tokens: inTok, p_output_tokens: outTok,
        p_cost: cost, p_error: callError,
      });
      released = true;
      throw new HttpError(502, callError);
    }

    // validate and save each question as a draft
    const byRef = new Map<string, Record<string, unknown>>();
    (parsed.questions as Record<string, unknown>[]).forEach((q, i) => byRef.set(String(q?.ref ?? `Q${i + 1}`), q));
    const created = new Map<string, string[]>();
    const failures: { ref: string; slot: string; errors: string[] }[] = [];
    let flagged = 0;

    for (const item of items) {
      const raw = byRef.get(item.ref);
      if (!raw) {
        failures.push({ ref: item.ref, slot: item.slot.label, errors: ['The model did not return this question.'] });
        continue;
      }
      const { report, normalized } = validateGenerated({
        question: raw, expectedType: item.slot.type, expectedDifficulty: item.slot.difficulty,
        excerpts: excerpts.map((e) => e.content),
      });
      if (!normalized) {
        failures.push({ ref: item.ref, slot: item.slot.label, errors: report.errors });
        continue;
      }

      if (practice && report.verdict !== 'pass') {
        // no human review for students' papers: anything doubtful is rewritten instead
        failures.push({ ref: item.ref, slot: item.slot.label, errors: [`Automatic check: ${report.flags.join(', ')}`] });
        continue;
      }
      const similar = practice ? [] : await must(db.rpc('find_similar_questions', {
        p_statement: normalized.statement, p_subject: item.slot.subject_id, p_threshold: 0.6, p_limit: 3,
      }), 'Checking for duplicates') as { id: string; similarity: number; exact: boolean }[];
      if (similar.some((s) => s.exact)) {
        failures.push({ ref: item.ref, slot: item.slot.label, errors: ['Exact duplicate of an existing question.'] });
        continue;
      }
      if (similar.length) {
        report.flags.push('possible_duplicate');
        report.checks.duplicates = similar.map((s) => `${s.id} (${Math.round(s.similarity * 100)}% similar)`).join(', ');
        if (report.verdict === 'pass') report.verdict = 'needs_review';
      }
      if (report.verdict !== 'pass') flagged++;

      const refs = (normalized.source_excerpts ?? [])
        .map((r) => excerpts[Number(String(r).replace(/\D/g, '')) - 1])
        .filter(Boolean)
        .map((e) => ({ document_id: e.document_id, title: e.document_title, page_start: e.page_start, page_end: e.page_end, chunk_id: e.id }));
      const chapterId = item.slot.chapter_ids[0] ?? null;
      const topic = normalized.subtopic
        ? tax.topics.find((t) => t.chapter_id === chapterId && t.name.toLowerCase() === normalized.subtopic!.toLowerCase())
        : undefined;

      const payload = {
        subject_id: item.slot.subject_id,
        chapter_id: chapterId,
        topic_id: topic?.id ?? (item.slot.topic_ids.length === 1 ? item.slot.topic_ids[0] : null),
        subtopic: normalized.subtopic ?? null,
        type: normalized.type,
        difficulty: normalized.difficulty,
        statement: normalized.statement,
        options: normalized.options,
        answer: normalized.answer,
        solution: normalized.solution,
        concepts: normalized.concepts ?? null,
        learning_objective: normalized.learning_objective ?? null,
        marks: item.slot.marks,
        negative_marks: item.slot.negative_marks,
        origin: 'ai',
        status: 'draft',
        tags: ['ai', item.slot.section_key],
        source_refs: refs,
        generation_job_id: jobId,
        validation: {
          ...report,
          provider: settings.provider,
          model: settings.model,
          verification: normalized.verification ?? null,
          generated_at: new Date().toISOString(),
        },
      };
      let id: string;
      if (practice) {
        const { data, error } = await db.rpc('practice_save_question', { p_job: jobId, p: { ...payload, status: undefined } });
        if (error) {
          failures.push({ ref: item.ref, slot: item.slot.label, errors: [error.message] });
          continue;
        }
        id = data as string;
      } else {
        id = await must(db.rpc('admin_upsert_question', { p: payload }), 'Saving a generated question') as string;
      }
      created.set(item.slot.slot_id, [...(created.get(item.slot.slot_id) ?? []), id]);
    }

    // record progress per slot (tokens/cost attributed once)
    let first = true;
    for (const slotId of new Set(items.map((i) => i.slot.slot_id))) {
      await must(db.rpc('record_generation_batch', {
        p_job: jobId, p_slot_id: slotId, p_question_ids: created.get(slotId) ?? [],
        p_input_tokens: first ? inTok : 0, p_output_tokens: first ? outTok : 0, p_cost: first ? cost : 0,
        p_error: failures.length ? `${failures.length} question(s) failed validation in the last batch` : null,
      }), 'Recording progress');
      first = false;
    }
    released = true;

    const after = await must(db.rpc('generation_job_progress', { p_job: jobId }), 'Reading progress') as { slots: ProgressSlot[] };
    const remaining = after.slots.filter((s) => (s.attempts ?? 0) < 6).reduce((a, s) => a + s.remaining, 0);
    if (remaining === 0 && !practice) await db.from('generation_jobs').update({ status: 'review' }).eq('id', jobId);

    return {
      done: remaining === 0,
      generated: [...created.values()].reduce((a, b) => a + b.length, 0),
      flagged,
      failures,
      remaining,
      cost_usd: cost,
      tokens: { input: inTok, output: outTok },
    };
  } finally {
    if (!released) await db.rpc('release_generation_job', { p_job: jobId });
  }
}

