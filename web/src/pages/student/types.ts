export interface ExamListItem {
  version_id: string; exam_id: string; title: string; kind: string; description: string | null;
  duration_minutes: number; total_marks: number; opens_at: string | null; closes_at: string | null; max_attempts: number;
  release_policy: string; question_count: number; my_attempts: number; open_attempt_id: string | null;
  availability: 'open' | 'upcoming' | 'closed';
  /** the student's own practice paper (private to them) */
  is_mine?: boolean;
}
export interface AttemptListItem {
  attempt_id: string; version_id: string; title: string; attempt_no: number; status: string; started_at: string;
  submitted_at: string | null; deadline_at: string; released: boolean; score: number | null; max_score: number | null; percentage: number | null;
}
export interface Breakdown { key: string; label: string; score: number; max_score?: number; max?: number; total: number; correct: number;
  incorrect: number; partial: number; unanswered: number; accuracy?: number | null; score_pct?: number | null; time_spent?: number }
export interface Performance {
  attempts: number;
  trend: { attempt_id: string; title: string; date: string; score: number; max: number; percentage: number; accuracy: number | null }[];
  totals: { questions: number; correct: number; partial: number; incorrect: number; unanswered: number; time_spent: number } | null;
  by_subject: Breakdown[]; by_chapter: Breakdown[]; by_difficulty: Breakdown[]; weak_areas: Breakdown[];
}
