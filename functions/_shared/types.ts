// Shared types for the generation engine. Runtime-agnostic (Deno + Node).

export type QuestionType = 'single' | 'multiple' | 'integer' | 'numerical';
export type Difficulty = 'easy' | 'medium' | 'hard';
export const QUESTION_TYPES: QuestionType[] = ['single', 'multiple', 'integer', 'numerical'];
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export interface TypeRule {
  marks: number;
  negative: number;
  unanswered?: number;
  partial?: 'none' | 'per_option';
  partial_per_option?: number;
}
export type MarkingRules = Partial<Record<QuestionType, TypeRule>>;

export interface SectionRequest {
  key: string;
  title: string;
  subject_code: string;
  type: QuestionType;
  count: number;
  marks: number;
  negative: number;
  /** chapters to draw from; empty = all chapters of the subject */
  chapter_ids?: string[];
  topic_ids?: string[];
}

export interface GenerationRequest {
  title: string;
  kind: 'jee_main' | 'jee_advanced' | 'custom';
  description?: string;
  instructions?: string;
  duration_minutes: number;
  /** optional target; validated against the sections */
  total_marks?: number;
  marking_rules: MarkingRules;
  sections: SectionRequest[];
  difficulty_mix: Record<Difficulty, number>;
  release_policy?: 'immediate' | 'on_close' | 'scheduled' | 'manual';
  release_at?: string | null;
  opens_at?: string | null;
  closes_at?: string | null;
  max_attempts?: number;
  /** if false, only the question bank is used */
  allow_ai?: boolean;
}

export interface Subject { id: string; code: string; name: string }
export interface Chapter { id: string; subject_id: string; name: string }
export interface Topic { id: string; chapter_id: string; name: string }
export interface Taxonomy { subjects: Subject[]; chapters: Chapter[]; topics: Topic[] }

export interface Slot {
  slot_id: string;
  section_key: string;
  label: string;
  subject_id: string;
  subject_code: string;
  chapter_ids: string[];
  chapter_names: string[];
  topic_ids: string[];
  topic_names: string[];
  type: QuestionType;
  difficulty: Difficulty;
  count: number;
  marks: number;
  negative_marks: number;
  question_ids?: string[];
  bank_ids?: string[];
  generated_ids?: string[];
}

export interface Blueprint {
  sections: { key: string; title: string; subject_code: string }[];
  slots: Slot[];
  totals: {
    questions: number;
    marks: number;
    by_subject: Record<string, { questions: number; marks: number }>;
    by_difficulty: Record<Difficulty, number>;
    by_type: Partial<Record<QuestionType, number>>;
  };
}

/** Shape the model must return for each question. */
export interface GeneratedQuestion {
  statement: string;
  type: QuestionType;
  difficulty: Difficulty;
  subtopic?: string;
  learning_objective?: string;
  options?: { label: string; content: string }[];
  answer: { options?: string[]; value?: number; tolerance?: number };
  solution: string;
  concepts?: string;
  verification?: { expression: string; variables?: Record<string, number> } | null;
  source_excerpts?: string[];
}

export interface ValidationReport {
  verdict: 'pass' | 'needs_review' | 'fail';
  errors: string[];
  flags: string[];
  checks: Record<string, string>;
  computed_value?: number;
}

export interface AiSettings {
  provider: 'mock' | 'anthropic' | 'openai_compatible';
  model: string;
  base_url?: string | null;
  max_output_tokens: number;
  temperature?: number | null;
  price_input_per_mtok: number;
  price_output_per_mtok: number;
  batch_size: number;
  max_questions_per_job: number;
  daily_question_quota: number;
  monthly_budget_usd: number;
  context_chunks: number;
}

export interface Excerpt {
  id: string;
  document_id: string;
  document_title: string;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  content: string;
}
