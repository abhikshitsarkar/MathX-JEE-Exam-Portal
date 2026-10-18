// A small, safe arithmetic evaluator used to independently check numeric
// answers produced by the AI. No `eval`, no property access — only numbers,
// named variables, + - * / ^, parentheses and a whitelist of functions.

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sind: (x) => Math.sin((x * Math.PI) / 180), cosd: (x) => Math.cos((x * Math.PI) / 180),
  tand: (x) => Math.tan((x * Math.PI) / 180),
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow,
  fact: (n) => {
    if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
  nCr: (n, r) => {
    if (!Number.isInteger(n) || !Number.isInteger(r) || r < 0 || n < r || n > 1000) return NaN;
    let res = 1;
    for (let i = 1; i <= r; i++) res = (res * (n - r + i)) / i;
    return Math.round(res);
  },
  nPr: (n, r) => {
    if (!Number.isInteger(n) || !Number.isInteger(r) || r < 0 || n < r || n > 1000) return NaN;
    let res = 1;
    for (let i = 0; i < r; i++) res *= n - i;
    return res;
  },
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  if (src.length > 500) throw new Error('Expression too long');
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if (src.startsWith('**', i)) { out.push({ t: 'op', v: '^' }); i += 2; continue; }
    if ('+-*/^(),×÷'.includes(c)) {
      out.push({ t: 'op', v: c === '×' ? '*' : c === '÷' ? '/' : c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}'`);
  }
  return out;
}

/** Evaluate an arithmetic expression with the given variables. Throws on invalid input. */
export function evaluate(expr: string, vars: Record<string, number> = {}): number {
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected '${v}'`);
    p++;
  };

  // expr := term (('+'|'-') term)*
  function expr0(): number {
    let v = term();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  // term := unary (('*'|'/') unary | implicit-multiplication)*
  function term(): number {
    let v = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const op = toks[p++].v;
        const r = unary();
        v = op === '*' ? v * r : v / r;
      } else if (peek() && (peek().t === 'num' || peek().t === 'id' || isOp('('))) {
        v = v * unary(); // implicit multiplication like 2pi or 3(x+1)
      } else break;
    }
    return v;
  }
  function unary(): number {
    if (isOp('-')) { p++; return -unary(); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  // power := primary ('^' unary)?   (right-associative)
  function power(): number {
    const base = primary();
    if (isOp('^')) { p++; return Math.pow(base, unary()); }
    return base;
  }
  function primary(): number {
    const tk = peek();
    if (!tk) throw new Error('Unexpected end of expression');
    if (tk.t === 'num') { p++; return tk.v; }
    if (tk.t === 'op' && tk.v === '(') {
      p++;
      const v = expr0();
      expect(')');
      return v;
    }
    if (tk.t === 'id') {
      p++;
      if (isOp('(')) {
        const fn = FUNCS[tk.v];
        if (!fn) throw new Error(`Unknown function '${tk.v}'`);
        p++;
        const args: number[] = [];
        if (!isOp(')')) {
          args.push(expr0());
          while (isOp(',')) { p++; args.push(expr0()); }
        }
        expect(')');
        return fn(...args);
      }
      if (Object.prototype.hasOwnProperty.call(vars, tk.v)) return Number(vars[tk.v]);
      if (Object.prototype.hasOwnProperty.call(CONSTS, tk.v)) return CONSTS[tk.v];
      throw new Error(`Unknown variable '${tk.v}'`);
    }
    throw new Error(`Unexpected '${tk.v}'`);
  }

  const result = expr0();
  if (p !== toks.length) throw new Error('Unexpected trailing input');
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}

/** Relative/absolute closeness used when comparing computed and stated answers. */
export function close(a: number, b: number, tolerance = 0): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= Math.max(tolerance, 1e-6 * scale, 1e-9);
}

/** Pulls the first plain number out of an option like "$20\ \text{m}$" or "2.5 × 10^3". */
export function numberInText(text: string): number | null {
  const cleaned = text
    .replace(/\\(text|mathrm|mathbf|rm)\{[^}]*\}/g, ' ')
    .replace(/\\(times|cdot)\s*10\^\{?(-?\d+)\}?/g, 'e$2')
    .replace(/×\s*10\^\{?(-?\d+)\}?/g, 'e$1')
    .replace(/\\dfrac|\\tfrac|\\frac/g, 'frac')
    .replace(/[\\${}]/g, ' ');
  const frac = /frac\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(cleaned);
  if (frac) return parseFloat(frac[1]) / parseFloat(frac[2]);
  const m = /-?\d+(?:\.\d+)?(?:\s*e-?\d+)?/.exec(cleaned);
  if (!m) return null;
  const v = parseFloat(m[0].replace(/\s+/g, ''));
  return Number.isFinite(v) ? v : null;
}
