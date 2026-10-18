// AI provider adapter. The provider and model come from the `ai` row of
// app_settings, so they can be changed from the admin panel without a
// rebuild. API keys come only from server-side secrets.
import type { AiSettings, Excerpt } from './types.ts';
import type { WorkItem } from './prompt.ts';

export interface ModelResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(message: string, public status = 502, public retryable = false) {
    super(message);
  }
}

export function costUsd(s: Pick<AiSettings, 'price_input_per_mtok' | 'price_output_per_mtok'>, inTok: number, outTok: number) {
  return (inTok * (s.price_input_per_mtok || 0) + outTok * (s.price_output_per_mtok || 0)) / 1_000_000;
}

/** Rough pre-flight estimate shown to the admin before a bulk run. */
export function estimateGeneration(settings: AiSettings, questions: number) {
  const batch = Math.max(1, settings.batch_size || 4);
  const batches = Math.ceil(questions / batch);
  const inputTokens = batches * (1400 + (settings.context_chunks || 0) * 650) + questions * 120;
  const outputTokens = questions * 1100;
  return {
    questions,
    batches,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    usd: settings.provider === 'mock' ? 0 : Math.round(costUsd(settings, inputTokens, outputTokens) * 10000) / 10000,
    provider: settings.provider,
    model: settings.model,
    note: settings.provider === 'mock'
      ? 'Mock provider: no paid calls are made. Questions are placeholders for testing.'
      : 'Estimate only; actual usage depends on the model and question complexity.',
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body?.error?.message ?? body?.message ?? JSON.stringify(body).slice(0, 300);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function callModel(
  settings: AiSettings, apiKey: string | undefined, system: string, user: string,
  fetchImpl: FetchLike = fetch, timeoutMs = 120_000,
): Promise<ModelResult> {
  if (settings.provider === 'mock') throw new ProviderError('Mock provider does not call a model', 500);
  if (!apiKey) throw new ProviderError('AI_API_KEY is not configured on the server. Add it as an Edge Function secret.', 500);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (settings.provider === 'anthropic') {
      const body: Record<string, unknown> = {
        model: settings.model,
        max_tokens: settings.max_output_tokens,
        system,
        messages: [{ role: 'user', content: user }],
      };
      if (settings.temperature != null) body.temperature = settings.temperature;
      const res = await fetchImpl(settings.base_url || 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`Anthropic API error: ${await readError(res)}`, res.status === 429 ? 429 : 502,
          res.status === 429 || res.status >= 500);
      }
      const data = await res.json();
      const text = (data.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
      return { text, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
    }

    if (settings.provider === 'openai_compatible') {
      if (!settings.base_url) throw new ProviderError('base_url is required for an OpenAI-compatible provider', 500);
      const body: Record<string, unknown> = {
        model: settings.model,
        max_tokens: settings.max_output_tokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      if (settings.temperature != null) body.temperature = settings.temperature;
      const res = await fetchImpl(`${settings.base_url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`AI provider error: ${await readError(res)}`, res.status === 429 ? 429 : 502,
          res.status === 429 || res.status >= 500);
      }
      const data = await res.json();
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    }
    throw new ProviderError(`Unknown AI provider "${settings.provider}"`, 500);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if ((e as Error).name === 'AbortError') throw new ProviderError('The AI provider timed out', 504, true);
    throw new ProviderError(`Could not reach the AI provider: ${(e as Error).message}`, 502, true);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Mock provider: deterministic, free, clearly-labelled placeholder questions
// with correct answers, so the whole pipeline can be exercised without a key.
// ---------------------------------------------------------------------------
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function mockModelResponse(items: WorkItem[], excerpts: Excerpt[], salt = ''): string {
  const questions = items.map((it) => {
    const rnd = seeded(`${it.slot.slot_id}|${it.ref}|${salt}`);
    const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const tag = `[Mock question — ${it.slot.chapter_names[0] || 'General'}, ${it.slot.difficulty}]`;
    const base = {
      ref: it.ref, type: it.slot.type, difficulty: it.slot.difficulty, subtopic: 'Mock practice',
      learning_objective: 'Placeholder generated by the mock provider for testing the workflow.',
      concepts: 'Generated by the mock provider. Replace with a real AI provider in Admin → Settings.',
      source_excerpts: excerpts.length ? ['E1'] : [],
    };
    if (it.slot.type === 'single') {
      const a = int(2, 9), b = int(3, 12), c = int(1, 20);
      const v = a * b + c;
      const opts = [v, v + a, v - c, a * (b + c)];
      const uniq: number[] = [];
      for (const o of opts) {
        let x = o;
        while (uniq.includes(x)) x += 7;
        uniq.push(x);
      }
      const order = [0, 1, 2, 3].sort(() => rnd() - 0.5);
      const labels = ['A', 'B', 'C', 'D'];
      const correct = labels[order.indexOf(0)];
      return {
        ...base,
        statement: `${tag} Evaluate $${a} \\times ${b} + ${c}$.`,
        options: order.map((k, i) => ({ label: labels[i], content: `$${uniq[k]}$` })),
        answer: { options: [correct] },
        solution: `Multiply first: $${a} \\times ${b} = ${a * b}$. Then add ${c}: the result is $${v}$.`,
        verification: { expression: 'a*b+c', variables: { a, b, c } },
      };
    }
    if (it.slot.type === 'multiple') {
      const k = int(3, 7);
      const m = int(2, 9);
      // two multiples of k and two non-multiples, all distinct
      const nums = [k * m, k * (m + 1) + 1, k * (m + 10), k * (m + 2) + 2];
      const labels = ['A', 'B', 'C', 'D'];
      const correct = labels.filter((_, i) => nums[i] % k === 0);
      return {
        ...base,
        statement: `${tag} Which of the following numbers are divisible by $${k}$?`,
        options: nums.map((n, i) => ({ label: labels[i], content: `$${n}$` })),
        answer: { options: correct },
        solution: `Check each number modulo ${k}: ${nums.map((n) => `${n} mod ${k} = ${n % k}`).join('; ')}. Options with remainder 0 are correct: ${correct.join(', ')}.`,
        verification: null,
      };
    }
    if (it.slot.type === 'integer') {
      const n = int(5, 10), r = int(2, 4);
      let v = 1;
      for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i;
      return {
        ...base,
        statement: `${tag} In how many ways can a committee of ${r} people be chosen from ${n} people?`,
        options: [],
        answer: { value: Math.round(v) },
        solution: `The order does not matter, so the count is $\\binom{${n}}{${r}} = ${Math.round(v)}$.`,
        verification: { expression: 'nCr(n, r)', variables: { n, r } },
      };
    }
    const a = int(2, 6), t = int(2, 8);
    const s = 0.5 * a * t * t;
    return {
      ...base,
      statement: `${tag} A body starts from rest and moves with a uniform acceleration of $${a}\\ \\text{m s}^{-2}$. Find the distance (in m) it covers in the first $${t}\\ \\text{s}$.`,
      options: [],
      answer: { value: s, tolerance: 0.01 },
      solution: `Using $s = ut + \\tfrac12 a t^2$ with $u = 0$: $s = \\tfrac12 \\times ${a} \\times ${t}^2 = ${s}$ m.`,
      verification: { expression: '0.5*a*t^2', variables: { a, t } },
    };
  });
  return JSON.stringify({ questions });
}
