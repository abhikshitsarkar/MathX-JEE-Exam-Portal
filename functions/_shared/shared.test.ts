import { describe, expect, it } from 'vitest';
import { apportion, buildBlueprint } from './blueprint.ts';
import { parseModelJson, repairLatexJson } from './jsonRepair.ts';
import { close, evaluate, numberInText } from './mathEval.ts';
import type { WorkItem } from './prompt.ts';
import { buildUserPrompt } from './prompt.ts';
import { callModel, estimateGeneration, mockModelResponse } from './providers.ts';
import type { AiSettings, GenerationRequest, Slot, Taxonomy } from './types.ts';
import { sharesLongRun, validateGenerated } from './validate.ts';

// ---------------------------------------------------------------- fixtures
const tax: Taxonomy = {
  subjects: [
    { id: 's-phy', code: 'PHY', name: 'Physics' },
    { id: 's-che', code: 'CHE', name: 'Chemistry' },
    { id: 's-mat', code: 'MAT', name: 'Mathematics' },
  ],
  chapters: [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `c-phy-${i}`, subject_id: 's-phy', name: `Physics ch ${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `c-che-${i}`, subject_id: 's-che', name: `Chemistry ch ${i}` })),
    ...Array.from({ length: 14 }, (_, i) => ({ id: `c-mat-${i}`, subject_id: 's-mat', name: `Maths ch ${i}` })),
  ],
  topics: [{ id: 't1', chapter_id: 'c-phy-0', name: 'Projectile motion' }],
};
const rules = {
  single: { marks: 4, negative: 1 }, multiple: { marks: 4, negative: 2 },
  integer: { marks: 4, negative: 1 }, numerical: { marks: 4, negative: 1 },
};
const mainLike: GenerationRequest = {
  title: 'Mock JEE Main 1', kind: 'jee_main', duration_minutes: 180, total_marks: 300, marking_rules: rules,
  difficulty_mix: { easy: 30, medium: 50, hard: 20 },
  sections: ['PHY', 'CHE', 'MAT'].flatMap((c) => [
    { key: `${c}-A`, title: `${c} A`, subject_code: c, type: 'single' as const, count: 20, marks: 4, negative: 1 },
    { key: `${c}-B`, title: `${c} B`, subject_code: c, type: 'numerical' as const, count: 5, marks: 4, negative: 1 },
  ]),
};
const settings: AiSettings = {
  provider: 'anthropic', model: 'claude-sonnet-5-5', base_url: null, max_output_tokens: 4000, temperature: null,
  price_input_per_mtok: 2, price_output_per_mtok: 10, batch_size: 4, max_questions_per_job: 90,
  daily_question_quota: 150, monthly_budget_usd: 10, context_chunks: 5,
};
function slot(type: Slot['type'], difficulty: Slot['difficulty'] = 'medium'): Slot {
  return {
    slot_id: `x:${type}`, section_key: 'X', label: 'X', subject_id: 's-phy', subject_code: 'PHY', chapter_ids: ['c-phy-0'],
    chapter_names: ['Kinematics'], topic_ids: [], topic_names: [], type, difficulty, count: 1, marks: 4, negative_marks: 1,
  };
}

// ---------------------------------------------------------------- mathEval
describe('mathEval', () => {
  it('respects precedence, powers and unary minus', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('(1+2)*(3+4)/7')).toBe(3);
  });
  it('supports variables, constants, functions and implicit multiplication', () => {
    expect(evaluate('u^2/(2*g)', { u: 20, g: 10 })).toBe(20);
    expect(close(evaluate('2pi'), 2 * Math.PI)).toBe(true);
    expect(close(evaluate('sind(30)'), 0.5)).toBe(true);
    expect(evaluate('nCr(5, 2)')).toBe(10);
    expect(evaluate('fact(5)/(fact(2)*fact(2))')).toBe(30);
    expect(evaluate('sqrt(16) + abs(-3)')).toBe(7);
    expect(evaluate('1.5e3 / 3')).toBe(500);
  });
  it('rejects anything that is not arithmetic', () => {
    expect(() => evaluate('process.exit()')).toThrow();
    expect(() => evaluate('constructor')).toThrow(/Unknown variable/);
    expect(() => evaluate('alert(1)')).toThrow(/Unknown function/);
    expect(() => evaluate('1/0')).toThrow(/finite/);
    expect(() => evaluate('2 +')).toThrow();
    expect(() => evaluate('a; b')).toThrow();
  });
  it('reads numbers out of option text', () => {
    expect(numberInText('$20\\ \\text{m}$')).toBe(20);
    expect(numberInText('$\\tfrac{1}{6}$')).toBeCloseTo(1 / 6);
    expect(numberInText('$2.5 \\times 10^{3}$ J')).toBe(2500);
    expect(numberInText('Frequency')).toBeNull();
  });
});

// ---------------------------------------------------------------- jsonRepair
describe('jsonRepair', () => {
  it('keeps LaTeX intact when backslashes are not doubled', () => {
    const raw = '{"s": "Find $\\frac{1}{2}\\theta$ and $\\alpha + \\nu$ with \\times"}';
    const out = parseModelJson<{ s: string }>(raw);
    expect(out.s).toBe('Find $\\frac{1}{2}\\theta$ and $\\alpha + \\nu$ with \\times');
  });
  it('keeps already-doubled backslashes and real escapes', () => {
    const raw = '{"s": "a\\\\frac{1}{2}\\nnext \\"q\\""}';
    expect(parseModelJson<{ s: string }>(raw).s).toBe('a\\frac{1}{2}\nnext "q"');
  });
  it('extracts JSON from fenced or chatty responses', () => {
    expect(parseModelJson<{ a: number }>('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson<{ a: number }>('Here: {"a": 2} done')).toEqual({ a: 2 });
    expect(() => parseModelJson('no json here')).toThrow();
  });
  it('escapes raw newlines inside strings', () => {
    expect(JSON.parse(repairLatexJson('{"s": "line1\nline2"}')).s).toBe('line1\nline2');
  });
});

// ---------------------------------------------------------------- blueprint
describe('blueprint', () => {
  it('apportions with largest remainder', () => {
    expect(apportion(20, [30, 50, 20])).toEqual([6, 10, 4]);
    expect(apportion(5, [30, 50, 20])).toEqual([2, 2, 1]);
    expect(apportion(5, [1, 1, 1]).reduce((a, b) => a + b)).toBe(5);
  });
  it('builds a consistent JEE-Main-style blueprint', () => {
    const { blueprint, errors } = buildBlueprint(mainLike, tax);
    expect(errors).toEqual([]);
    expect(blueprint!.totals.questions).toBe(75);
    expect(blueprint!.totals.marks).toBe(300);
    expect(blueprint!.totals.by_subject.PHY).toEqual({ questions: 25, marks: 100 });
    expect(blueprint!.totals.by_difficulty.easy + blueprint!.totals.by_difficulty.medium + blueprint!.totals.by_difficulty.hard).toBe(75);
    expect(blueprint!.slots.reduce((a, s) => a + s.count, 0)).toBe(75);
    expect(new Set(blueprint!.slots.map((s) => s.slot_id)).size).toBe(blueprint!.slots.length);
    // a 20-question section over 20 chapters spreads to one question per chapter
    const phyA = blueprint!.slots.filter((s) => s.section_key === 'PHY-A');
    expect(new Set(phyA.map((s) => s.chapter_ids[0])).size).toBe(20);
  });
  it('restricts to selected chapters and topics', () => {
    const req: GenerationRequest = {
      ...mainLike, total_marks: undefined,
      sections: [{ key: 'P', title: 'P', subject_code: 'PHY', type: 'single', count: 6, marks: 4, negative: 1,
        chapter_ids: ['c-phy-0', 'c-phy-1'], topic_ids: ['t1'] }],
    };
    const { blueprint } = buildBlueprint(req, tax);
    expect(blueprint!.slots.every((s) => ['c-phy-0', 'c-phy-1'].includes(s.chapter_ids[0]))).toBe(true);
    expect(blueprint!.slots.find((s) => s.chapter_ids[0] === 'c-phy-0')!.topic_ids).toEqual(['t1']);
  });
  it('reports inconsistent requirements', () => {
    const bad = buildBlueprint({ ...mainLike, total_marks: 280 }, tax);
    expect(bad.blueprint).toBeNull();
    expect(bad.errors.join(' ')).toMatch(/Marks do not add up: sections give 300/);
    const bad2 = buildBlueprint({
      ...mainLike, total_marks: undefined, marking_rules: { single: rules.single },
      sections: [{ key: 'X', title: 'X', subject_code: 'BIO', type: 'numerical', count: 0, marks: 0, negative: -1,
        chapter_ids: ['c-che-1'] }],
    }, tax);
    expect(bad2.errors.join(' ')).toMatch(/unknown subject/);
    expect(bad2.errors.join(' ')).toMatch(/count must be 1–100/);
    const bad3 = buildBlueprint({ ...mainLike, total_marks: undefined, release_policy: 'scheduled' }, tax);
    expect(bad3.errors.join(' ')).toMatch(/scheduled release/);
  });
});

// ---------------------------------------------------------------- validation
describe('validateGenerated', () => {
  const good = {
    type: 'single', difficulty: 'easy', statement: 'A ball is thrown up at 20 m/s with g = 10 m/s^2. Maximum height?',
    options: [{ label: 'A', content: '$10\\ \\text{m}$' }, { label: 'B', content: '$20\\ \\text{m}$' },
      { label: 'C', content: '$40\\ \\text{m}$' }, { label: 'D', content: '$80\\ \\text{m}$' }],
    answer: { options: ['B'] }, solution: 'h = u^2/2g = 400/20 = 20 m. The answer is B.',
    verification: { expression: 'u^2/(2*g)', variables: { u: 20, g: 10 } },
  };
  it('passes a correct, verified question', () => {
    const { report, normalized } = validateGenerated({ question: good, expectedType: 'single', expectedDifficulty: 'easy' });
    expect(report.verdict).toBe('pass');
    expect(report.checks.calculation).toMatch(/verified/);
    expect(normalized!.answer).toEqual({ options: ['B'] });
  });
  it('flags a key that disagrees with the computed value', () => {
    const { report } = validateGenerated({ question: { ...good, answer: { options: ['C'] } }, expectedType: 'single', expectedDifficulty: 'easy' });
    expect(report.verdict).toBe('needs_review');
    expect(report.flags).toContain('calculation_points_to_other_option');
  });
  it('fails structural problems', () => {
    const r1 = validateGenerated({ question: { ...good, answer: { options: ['A', 'B'] } }, expectedType: 'single', expectedDifficulty: 'easy' });
    expect(r1.report.verdict).toBe('fail');
    const r2 = validateGenerated({ question: { ...good, answer: { options: ['E'] } }, expectedType: 'single', expectedDifficulty: 'easy' });
    expect(r2.report.errors.join()).toMatch(/does not exist/);
    const dupOpts = { ...good, options: [good.options[0], good.options[0], good.options[2], good.options[3]] };
    expect(validateGenerated({ question: dupOpts, expectedType: 'single', expectedDifficulty: 'easy' }).report.errors.join()).toMatch(/identical/);
    expect(validateGenerated({ question: { ...good, solution: '' }, expectedType: 'single', expectedDifficulty: 'easy' }).report.verdict).toBe('fail');
    expect(validateGenerated({ question: good, expectedType: 'numerical', expectedDifficulty: 'easy' }).report.verdict).toBe('fail');
  });
  it('recomputes numerical answers independently', () => {
    const q = {
      type: 'numerical', difficulty: 'medium', statement: 'Two blocks 2 kg and 3 kg pushed with 10 N. Contact force in N?',
      options: [], answer: { value: 6, tolerance: 0 }, solution: 'Common acceleration a = 10/5 = 2 m/s^2, so the contact force N = 3 x 2 = 6 N.',
      verification: { expression: 'F*m2/(m1+m2)', variables: { F: 10, m1: 2, m2: 3 } },
    };
    expect(validateGenerated({ question: q, expectedType: 'numerical', expectedDifficulty: 'medium' }).report.verdict).toBe('pass');
    const wrong = validateGenerated({ question: { ...q, answer: { value: 4 } }, expectedType: 'numerical', expectedDifficulty: 'medium' });
    expect(wrong.report.flags).toContain('calculation_mismatch');
    const unverified = validateGenerated({ question: { ...q, verification: null }, expectedType: 'numerical', expectedDifficulty: 'medium' });
    expect(unverified.report.flags).toContain('unverified_calculation');
    const intBad = validateGenerated({ question: { ...q, type: 'integer', answer: { value: 6.5 } }, expectedType: 'integer', expectedDifficulty: 'medium' });
    expect(intBad.report.errors.join()).toMatch(/whole number/);
  });
  it('flags text copied from the study material', () => {
    const source = 'when a body is projected vertically upwards with an initial velocity it rises until its velocity becomes zero at the highest point';
    expect(sharesLongRun(`Consider this: ${source}. Find h.`, [source])).toBe(true);
    expect(sharesLongRun('A completely different original question about friction on an incline plane today.', [source])).toBe(false);
  });
});

// ---------------------------------------------------------------- providers
describe('providers', () => {
  it('mock output validates for every question type', () => {
    const items: WorkItem[] = (['single', 'multiple', 'integer', 'numerical'] as const).map((t, i) => ({ ref: `Q${i + 1}`, slot: slot(t) }));
    for (let salt = 0; salt < 25; salt++) {
      const parsed = parseModelJson<{ questions: unknown[] }>(mockModelResponse(items, [], String(salt)));
      parsed.questions.forEach((q, i) => {
        const { report } = validateGenerated({ question: q, expectedType: items[i].slot.type, expectedDifficulty: 'medium' });
        expect(report.errors).toEqual([]);
        expect(report.flags.filter((f) => f.startsWith('calculation'))).toEqual([]);
      });
    }
  });
  it('estimates cost and is zero for the mock provider', () => {
    const e = estimateGeneration(settings, 40);
    expect(e.batches).toBe(10);
    expect(e.usd).toBeGreaterThan(0);
    expect(estimateGeneration({ ...settings, provider: 'mock' }, 40).usd).toBe(0);
  });
  it('calls the Anthropic Messages API with the key in a header', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"questions":[]}' }], usage: { input_tokens: 10, output_tokens: 5 } }));
    };
    const r = await callModel(settings, 'sk-test', 'sys', 'user', fake);
    expect(r).toEqual({ text: '{"questions":[]}', inputTokens: 10, outputTokens: 5 });
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(JSON.parse(String(seen!.init.body)).model).toBe('claude-sonnet-5-5');
  });
  it('supports OpenAI-compatible endpoints and surfaces API errors', async () => {
    const ok = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    const r = await callModel({ ...settings, provider: 'openai_compatible', base_url: 'https://example.test/v1' }, 'k', 's', 'u', ok);
    expect(r.text).toBe('hi');
    const fail = async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
    await expect(callModel(settings, 'k', 's', 'u', fail)).rejects.toThrow(/rate limited/);
    await expect(callModel(settings, undefined, 's', 'u', ok)).rejects.toThrow(/AI_API_KEY/);
  });
  it('builds a prompt with requests and excerpts', () => {
    const p = buildUserPrompt([{ ref: 'Q1', slot: slot('integer', 'hard') }],
      [{ id: 'x', document_id: 'd', document_title: 'Notes', page_start: 4, page_end: 5, heading: 'Motion', content: 'Kinematics text' }], 'Physics');
    expect(p).toMatch(/Q1: integer-answer/);
    expect(p).toMatch(/\[E1\] \(Notes p\.4–5 — Motion\)/);
    expect(p).toMatch(/JEE Advanced standard/);
  });
});
