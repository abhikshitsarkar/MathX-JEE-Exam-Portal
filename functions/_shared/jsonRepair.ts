// Models often emit LaTeX inside JSON strings with single backslashes
// ("\frac", "\theta"). Several of those are *valid* JSON escapes (\f, \t, \n,
// \r, \b) and silently corrupt the text, others are invalid and break
// JSON.parse. This repairs them before parsing.

// LaTeX commands that start with a letter JSON treats as an escape.
const LATEX_WITH_JSON_ESCAPE_PREFIX = new Set([
  'frac', 'dfrac', 'tfrac', 'forall', 'flat', 'frak', 'fbox',
  'theta', 'Theta', 'times', 'text', 'textbf', 'textit', 'textrm', 'tan', 'tanh', 'tau', 'to', 'top',
  'tilde', 'triangle', 'therefore', 'tfrac', 'texttt', 'tiny', 'tag', 'thinspace',
  'nu', 'neq', 'ne', 'nabla', 'not', 'notin', 'ni', 'nolimits', 'newline', 'nleq', 'ngeq', 'nmid',
  'rho', 'right', 'rightarrow', 'Rightarrow', 'rm', 'rangle', 'rceil', 'rfloor', 'rvert', 'rbrace',
  'beta', 'bar', 'binom', 'boxed', 'bf', 'bmod', 'bigl', 'bigr', 'big', 'Big', 'bigg', 'begin', 'bot',
  'backslash', 'because', 'bullet', 'bmatrix', 'boldsymbol', 'bigcup', 'bigcap', 'bot',
]);

export function repairLatexJson(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    if (c === '\n') { out += '\\n'; continue; } // raw newline inside a string
    if (c === '\t') { out += '\\t'; continue; }
    if (c !== '\\') { out += c; continue; }

    const next = raw[i + 1] ?? '';
    // already-escaped backslash or quote/slash: keep as-is
    if (next === '\\' || next === '"' || next === '/') {
      out += c + next;
      i++;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      out += raw.slice(i, i + 6);
      i += 5;
      continue;
    }
    const word = /^[A-Za-z]+/.exec(raw.slice(i + 1))?.[0] ?? '';
    if ('bfnrt'.includes(next) && next !== '') {
      // treat as LaTeX only when the whole word is a known command
      if (word && LATEX_WITH_JSON_ESCAPE_PREFIX.has(word)) {
        out += '\\\\';
        continue;
      }
      out += c; // genuine JSON escape like \n
      continue;
    }
    // any other backslash (\alpha, \sqrt, \{, \,) is a literal backslash
    out += '\\\\';
  }
  return out;
}

/** Extracts and parses the first JSON object in a model response. */
export function parseModelJson<T = unknown>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return a JSON object');
  const candidate = body.slice(start, end + 1);
  // Always repair first: a plain JSON.parse can "succeed" while turning
  // "\frac" into a form-feed character.
  try {
    return JSON.parse(repairLatexJson(candidate)) as T;
  } catch {
    return JSON.parse(candidate) as T;
  }
}
