// Prompt construction for question generation.
import type { Excerpt, Slot } from './types.ts';

export interface WorkItem {
  /** request id echoed back by the model, e.g. "Q1" */
  ref: string;
  slot: Slot;
}

const TYPE_TEXT: Record<string, string> = {
  single: 'single-correct MCQ with exactly 4 options (A–D) and exactly one correct option',
  multiple: 'one-or-more-correct MCQ with exactly 4 options (A–D) where one or more options are correct',
  integer: 'integer-answer question (answer is a single whole number; no options)',
  numerical: 'numerical-answer question (answer is a real number, give a sensible tolerance; no options)',
};

const DIFFICULTY_TEXT: Record<string, string> = {
  easy: 'easy — one concept, one or two steps, typical of the easier JEE Main questions',
  medium: 'medium — two connected ideas or 3–4 steps, typical JEE Main standard',
  hard: 'hard — combines multiple concepts, needs insight or careful multi-step reasoning, JEE Advanced standard',
};

export const SYSTEM_PROMPT = `You are an experienced setter of original practice problems for India's JEE Main and JEE Advanced examinations (Physics, Chemistry, Mathematics).

Rules you must follow:
- Write ORIGINAL questions. The study-material excerpts are only for concepts, notation and scope. Never copy a question, worked example or passage from them, and never reproduce questions from past official papers.
- Every question must be fully specified: all data needed to solve it is given, units are stated, and exactly the intended answer follows.
- Use standard constants unless stated (g = 10 m/s^2 only if you say so in the question). State every assumption in the question text.
- Distractors must be plausible (common mistakes), distinct from each other and from the correct answer.
- Write maths with LaTeX between $...$ (inline) or $$...$$ (display). Chemical formulas as $\\mathrm{H_2SO_4}$.
- The solution must be step-by-step and end with the final answer stated explicitly.
- For every question whose answer is numeric (and for MCQs whose options are numbers) give a "verification" object: a plain arithmetic expression (operators + - * / ^, parentheses, functions sqrt, cbrt, abs, exp, ln, log, sin, cos, tan in radians, sind/cosd/tand in degrees, fact, nCr, nPr, min, max; constants pi and e) plus the variable values, which evaluates to the correct answer. Otherwise set "verification" to null.
- Output ONLY one JSON object, no commentary. Inside JSON strings, write every LaTeX backslash doubled (\\\\frac, \\\\theta) and do not use raw line breaks.`;

export function buildUserPrompt(items: WorkItem[], excerpts: Excerpt[], subjectName: string): string {
  const reqLines = items.map((it) => {
    const s = it.slot;
    const topics = s.topic_names.length ? `; topics to draw on: ${s.topic_names.join(', ')}` : '';
    return `- ${it.ref}: ${TYPE_TEXT[s.type]}; chapter: ${s.chapter_names.join(', ')}${topics}; difficulty: ${DIFFICULTY_TEXT[s.difficulty]}.`;
  }).join('\n');

  const ex = excerpts.length
    ? excerpts.map((e, i) => {
      const pages = e.page_start ? ` p.${e.page_start}${e.page_end && e.page_end !== e.page_start ? `–${e.page_end}` : ''}` : '';
      return `[E${i + 1}] (${e.document_title}${pages}${e.heading ? ` — ${e.heading}` : ''})\n${e.content.slice(0, 2200)}`;
    }).join('\n\n')
    : '(No study-material excerpts are available; rely on the standard JEE syllabus.)';

  return `Subject: ${subjectName}

Write ${items.length} question(s), one for each request:
${reqLines}

Reference excerpts from the administrator's authorised study material (for concepts only, do not copy):
${ex}

Return JSON exactly in this shape:
{
  "questions": [
    {
      "ref": "Q1",
      "type": "single" | "multiple" | "integer" | "numerical",
      "difficulty": "easy" | "medium" | "hard",
      "subtopic": "short subtopic name",
      "learning_objective": "what this question tests, one sentence",
      "statement": "question text with LaTeX",
      "options": [ {"label": "A", "content": "..."}, {"label": "B", "content": "..."}, {"label": "C", "content": "..."}, {"label": "D", "content": "..."} ],
      "answer": { "options": ["B"] }  or  { "value": 12.5, "tolerance": 0.1 },
      "solution": "step-by-step solution ending with the final answer",
      "concepts": "the underlying concepts and why the common wrong answers are wrong",
      "verification": { "expression": "u^2/(2*g)", "variables": { "u": 20, "g": 10 } } or null,
      "source_excerpts": ["E1"]
    }
  ]
}
For integer and numerical questions use "options": [] and give "answer": {"value": ...}.`;
}
