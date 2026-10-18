// Deterministic checks applied to every AI-generated question before it is
// saved (always as a draft). Nothing here trusts the model's own claim that
// an answer is right: numeric answers are recomputed from the model's
// verification expression with an independent evaluator.
import { close, evaluate, numberInText } from './mathEval.ts';
import type { Difficulty, GeneratedQuestion, QuestionType, ValidationReport } from './types.ts';

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const CRITICAL_FLAGS = new Set([
  'calculation_mismatch', 'calculation_points_to_other_option', 'verification_unparseable',
  'unverified_calculation', 'possible_verbatim_copy',
]);

export interface ValidationInput {
  question: unknown;
  expectedType: QuestionType;
  expectedDifficulty: Difficulty;
  excerpts?: string[];
}

export interface ValidationOutput {
  report: ValidationReport;
  normalized: GeneratedQuestion | null;
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** True if any run of `n` consecutive words of `text` appears in one of the sources. */
export function sharesLongRun(text: string, sources: string[], n = 12): boolean {
  const w = words(text);
  if (w.length < n) return false;
  const runs = new Set<string>();
  for (const src of sources) {
    const sw = words(src);
    for (let i = 0; i + n <= sw.length; i++) runs.add(sw.slice(i, i + n).join(' '));
  }
  for (let i = 0; i + n <= w.length; i++) if (runs.has(w.slice(i, i + n).join(' '))) return true;
  return false;
}

export function validateGenerated({ question, expectedType, expectedDifficulty, excerpts = [] }: ValidationInput): ValidationOutput {
  const errors: string[] = [];
  const flags: string[] = [];
  const checks: Record<string, string> = {};
  const q = (question ?? {}) as Record<string, unknown>;

  const statement = typeof q.statement === 'string' ? q.statement.trim() : '';
  const solution = typeof q.solution === 'string' ? q.solution.trim() : '';
  const type = q.type as QuestionType;
  const difficulty = q.difficulty as Difficulty;

  if (statement.length < 20) errors.push('Statement is missing or too short.');
  if (statement.length > 6000) errors.push('Statement is too long.');
  if (solution.length < 30) errors.push('Step-by-step solution is missing or too short.');
  if (type !== expectedType) errors.push(`Expected a "${expectedType}" question but got "${String(type)}".`);
  if (/\[(insert|todo|placeholder)|lorem ipsum|\?\?\?/i.test(statement + solution)) {
    errors.push('Output contains placeholder text.');
  }
  if (difficulty !== expectedDifficulty) {
    flags.push('difficulty_mismatch');
    checks.difficulty = `requested ${expectedDifficulty}, model labelled ${String(difficulty)}`;
  }

  // ---- options and answer key ----
  const rawAnswer = (q.answer ?? {}) as Record<string, unknown>;
  let options: { label: string; content: string }[] = [];
  let answer: GeneratedQuestion['answer'] = {};

  if (expectedType === 'single' || expectedType === 'multiple') {
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    options = rawOpts.map((o, i) => {
      const obj = (o ?? {}) as Record<string, unknown>;
      return { label: LABELS[i] ?? '?', content: typeof obj.content === 'string' ? obj.content.trim() : String(o ?? '').trim() };
    });
    // keep the model's labels only if they are A, B, C... in order
    const givenLabels = rawOpts.map((o) => String((o as Record<string, unknown>)?.label ?? '').trim().toUpperCase());
    const labelMap = new Map<string, string>();
    givenLabels.forEach((g, i) => { if (g) labelMap.set(g, LABELS[i]); });

    if (options.length < 2 || options.length > 6) errors.push('Options must contain between 2 and 6 choices.');
    if (options.some((o) => !o.content)) errors.push('An option is empty.');
    const uniq = new Set(options.map((o) => o.content.toLowerCase().replace(/\s+/g, ' ')));
    if (uniq.size !== options.length) errors.push('Two options are identical.');

    const chosen = Array.isArray(rawAnswer.options) ? rawAnswer.options.map((x) => String(x).trim().toUpperCase()) : [];
    const mapped = [...new Set(chosen.map((c) => labelMap.get(c) ?? c))].sort();
    if (mapped.length === 0) errors.push('The answer key marks no correct option.');
    if (mapped.some((m) => !options.some((o) => o.label === m))) errors.push('The answer key refers to an option that does not exist.');
    if (expectedType === 'single' && mapped.length !== 1) errors.push('A single-correct question must have exactly one correct option.');
    if (expectedType === 'multiple' && mapped.length === options.length && options.length > 0) {
      flags.push('all_options_correct');
    }
    answer = { options: mapped };
  } else {
    if (Array.isArray(q.options) && q.options.length > 0) flags.push('options_dropped_for_numerical');
    const value = typeof rawAnswer.value === 'number' ? rawAnswer.value : Number(rawAnswer.value);
    const tol = rawAnswer.tolerance == null ? 0 : Number(rawAnswer.tolerance);
    if (!Number.isFinite(value)) errors.push('The numerical answer is missing or not a number.');
    if (expectedType === 'integer' && Number.isFinite(value) && !Number.isInteger(value)) {
      errors.push('An integer-type answer must be a whole number.');
    }
    if (!Number.isFinite(tol) || tol < 0) errors.push('Tolerance must be zero or a positive number.');
    answer = expectedType === 'integer' ? { value } : { value, tolerance: Number.isFinite(tol) ? tol : 0 };
  }

  // ---- independent calculation check ----
  let computed: number | undefined;
  const ver = (q.verification ?? null) as { expression?: unknown; variables?: unknown } | null;
  if (ver && typeof ver.expression === 'string' && ver.expression.trim()) {
    try {
      const vars: Record<string, number> = {};
      for (const [k, v] of Object.entries((ver.variables ?? {}) as Record<string, unknown>)) {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`variable ${k} is not a number`);
        vars[k] = n;
      }
      computed = evaluate(ver.expression, vars);
      checks.computed = String(computed);
    } catch (e) {
      flags.push('verification_unparseable');
      checks.calculation = `could not evaluate verification expression: ${(e as Error).message}`;
    }
  }

  if (expectedType === 'integer' || expectedType === 'numerical') {
    if (computed === undefined && !flags.includes('verification_unparseable')) {
      flags.push('unverified_calculation');
      checks.calculation = 'no verification expression supplied';
    } else if (computed !== undefined && answer.value !== undefined && Number.isFinite(answer.value)) {
      if (close(computed, answer.value, answer.tolerance ?? 0)) {
        checks.calculation = 'verified';
      } else {
        flags.push('calculation_mismatch');
        checks.calculation = `computed ${computed} but the key says ${answer.value}`;
      }
    }
    if (answer.value !== undefined && Number.isFinite(answer.value)) {
      const v = answer.value;
      const shown = [String(v), v.toFixed(1), v.toFixed(2), String(Math.round(v))];
      if (!shown.some((s) => solution.includes(s))) flags.push('answer_not_stated_in_solution');
    }
  } else if (computed !== undefined && answer.options?.length === 1) {
    const values = options.map((o) => numberInText(o.content));
    const idx = options.findIndex((o) => o.label === answer.options![0]);
    const near = (a: number | null) => a !== null && Math.abs(a - computed!) <= Math.max(1e-9, Math.abs(computed!) * 0.005);
    if (near(values[idx])) {
      checks.calculation = 'verified against the correct option';
    } else if (values.some((v, i) => i !== idx && near(v))) {
      flags.push('calculation_points_to_other_option');
      checks.calculation = `computed ${computed} matches a different option`;
    } else {
      flags.push('computed_value_not_in_options');
      checks.calculation = `computed ${computed} does not match any option`;
    }
  }

  // ---- originality ----
  if (excerpts.length && sharesLongRun(`${statement} ${options.map((o) => o.content).join(' ')}`, excerpts)) {
    flags.push('possible_verbatim_copy');
  }

  const verdict: ValidationReport['verdict'] = errors.length
    ? 'fail'
    : flags.some((f) => CRITICAL_FLAGS.has(f)) ? 'needs_review' : 'pass';
  const report: ValidationReport = { verdict, errors, flags, checks, ...(computed !== undefined ? { computed_value: computed } : {}) };

  if (errors.length) return { report, normalized: null };
  return {
    report,
    normalized: {
      statement,
      type: expectedType,
      difficulty: expectedDifficulty,
      subtopic: typeof q.subtopic === 'string' ? q.subtopic.slice(0, 200) : undefined,
      learning_objective: typeof q.learning_objective === 'string' ? q.learning_objective.slice(0, 500) : undefined,
      options: expectedType === 'single' || expectedType === 'multiple' ? options : [],
      answer,
      solution,
      concepts: typeof q.concepts === 'string' ? q.concepts.slice(0, 2000) : undefined,
      verification: ver && typeof ver.expression === 'string'
        ? { expression: ver.expression, variables: (ver.variables ?? {}) as Record<string, number> } : null,
      source_excerpts: Array.isArray(q.source_excerpts) ? q.source_excerpts.map(String).slice(0, 10) : [],
    },
  };
}
