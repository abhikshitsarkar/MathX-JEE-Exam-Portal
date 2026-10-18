# Question import / export format

**Admin → Question bank → Import** accepts a JSON array; **Export** produces the same format, so you can round-trip, back up, or move questions between projects. Up to 500 questions per request; the page splits larger files automatically. Each item is validated independently, and failures are reported by position without stopping the rest.

```json
[
  {
    "subject_code": "PHY",
    "chapter_name": "Kinematics",
    "topic_name": "Projectile motion",
    "subtopic": "Range on level ground",
    "type": "single",
    "difficulty": "medium",
    "statement": "A projectile is launched at $45^\\circ$ with speed $20\\ \\text{m s}^{-1}$ ($g = 10\\ \\text{m s}^{-2}$). Its range is:",
    "options": [
      { "label": "A", "content": "$20\\ \\text{m}$" },
      { "label": "B", "content": "$40\\ \\text{m}$" },
      { "label": "C", "content": "$80\\ \\text{m}$" },
      { "label": "D", "content": "$20\\sqrt2\\ \\text{m}$" }
    ],
    "answer": { "options": ["B"] },
    "solution": "$R = \\dfrac{u^2 \\sin 2\\theta}{g} = \\dfrac{400 \\cdot 1}{10} = 40\\ \\text{m}$.",
    "concepts": "Range formula for level ground.",
    "marks": 4,
    "negative_marks": 1,
    "learning_objective": "Apply the range formula.",
    "tags": ["projectile"],
    "status": "approved"
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `subject_code` | yes | `PHY`, `CHE` or `MAT` (or `subject_id`) |
| `chapter_name` | for approval | Matched case-insensitively; created if missing (or `chapter_id`) |
| `topic_name` | no | Created under the chapter if missing (or `topic_id`) |
| `type` | yes | `single`, `multiple`, `integer`, `numerical` |
| `difficulty` | no | `easy`, `medium` (default), `hard` |
| `statement` | yes | Text with LaTeX between `$…$` or `$$…$$`. In JSON, write each backslash twice (`\\frac`). |
| `options` | MCQ only | 2–6 options; labels A–F. Must be empty for integer/numerical. |
| `answer` | for approval | MCQ `{"options": ["A","C"]}` · integer `{"value": 13}` · numerical `{"value": 9.81, "tolerance": 0.05}` or a range `{"min": 9.7, "max": 9.9}` |
| `solution` | for approval | Step-by-step solution shown after results are released |
| `marks`, `negative_marks` | no | Defaults 4 and 0; exam versions can override per question |
| `status` | no | `draft` (default) or `approved`. Approval runs the same checks as the editor (answer key, options, solution, chapter). |
| `image_path` | no | Path of an image already uploaded to the `question-images` bucket |

Imported questions are marked with origin `import`. To avoid duplicates, export first and compare, or use the duplicate check in the question editor.
