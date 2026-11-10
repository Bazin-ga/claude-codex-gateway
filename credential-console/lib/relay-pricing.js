/**
 * A platform's own billing formula, read well enough to estimate a bill.
 *
 * new-api can price a model with an expression instead of ratios, e.g.
 *
 *   tier("base", p * 1 + c * 4 + cr * 0.02) * (hour("Asia/Shanghai") >= 9 && … ? 2 : 1)
 *
 * where `p`, `c`, `cr`, `cc` are prompt, completion, cache-read and
 * cache-write tokens — the prompt count excludes the cached ones, which have
 * their own term — and the result is dollars per million tokens before the
 * group ratio. The ratios the price list carries beside it are then stale:
 * for the model above they understate the output price by half and know
 * nothing of the peak-hour doubling. So the expression is evaluated, by a
 * small interpreter of exactly the grammar those formulas use. Nothing here
 * runs platform text as code, and a formula it cannot read is refused whole,
 * leaving the caller on the ratios.
 */
const MAX_EXPRESSION_LENGTH = 4000;
const MAX_DEPTH = 64;

const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||[<>=!]=|[-+*/%<>!?:(),]))/y;

function tokenize(text) {
  const tokens = [];
  const end = text.trimEnd().length;
  let at = 0;
  while (at < end) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(text);
    if (!match) throw new Error('unreadable billing expression');
    at = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'string', value: JSON.parse(match[2]) });
    else if (match[3] !== undefined) tokens.push({ type: 'name', value: match[3] });
    else tokens.push({ type: 'op', value: match[4] });
  }
  return tokens;
}

/** Wall-clock fields of an instant in an IANA zone, as the formulas ask for them. */
const zoneFormats = new Map();
function zoneParts(zone, atMs) {
  let format = zoneFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      day: 'numeric',
      month: 'numeric',
    });
    zoneFormats.set(zone, format);
  }
  const parts = {};
  for (const part of format.formatToParts(new Date(atMs))) parts[part.type] = part.value;
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    day: Number(parts.day),
    month: Number(parts.month),
    // Sunday is 0, as in the Go runtime these formulas were written for.
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

const CLOCK_FUNCTIONS = new Set(['hour', 'minute', 'day', 'month', 'weekday']);

function parse(tokens) {
  let at = 0;
  let depth = 0;
  const peek = () => tokens[at];
  const isOp = (value) => peek()?.type === 'op' && peek().value === value;
  const take = (value) => {
    if (!isOp(value)) throw new Error(`expected ${value}`);
    at += 1;
  };
  const binary = (next, operators) => () => {
    let left = next();
    while (peek()?.type === 'op' && operators.includes(peek().value)) {
      const op = tokens[at++].value;
      left = { type: 'binary', op, left, right: next() };
    }
    return left;
  };

  function primary() {
    const token = tokens[at++];
    if (!token) throw new Error('unexpected end of billing expression');
    if (token.type === 'number' || token.type === 'string') return { type: 'literal', value: token.value };
    if (token.type === 'name') {
      if (!isOp('(')) return { type: 'variable', name: token.value };
      at += 1;
      const args = [];
      if (!isOp(')')) {
        args.push(ternary());
        while (isOp(',')) {
          at += 1;
          args.push(ternary());
        }
      }
      take(')');
      return call(token.value, args);
    }
    if (token.type === 'op' && token.value === '(') {
      const inner = ternary();
      take(')');
      return inner;
    }
    throw new Error('unexpected token in billing expression');
  }

  function call(name, args) {
    if (name === 'tier') {
      // The label names the price tier for the platform's own log; the value is the price.
      if (args.length !== 2) throw new Error('tier takes a label and a value');
      return args[1];
    }
    if (CLOCK_FUNCTIONS.has(name)) {
      const zone = args.length === 0 ? 'UTC' : (args[0].type === 'literal' ? args[0].value : null);
      if (args.length > 1 || typeof zone !== 'string') throw new Error(`${name} takes a time zone`);
      // Throws on a zone this runtime does not know, which refuses the formula.
      zoneParts(zone, 0);
      return { type: 'clock', field: name, zone };
    }
    if ((name === 'max' || name === 'min') && args.length >= 1) return { type: name, args };
    throw new Error(`unknown function ${name}`);
  }

  function unary() {
    if (isOp('-') || isOp('!')) {
      const op = tokens[at++].value;
      return { type: 'unary', op, operand: unary() };
    }
    return primary();
  }

  const product = binary(unary, ['*', '/', '%']);
  const sum = binary(product, ['+', '-']);
  const comparison = binary(sum, ['<', '<=', '>', '>=']);
  const equality = binary(comparison, ['==', '!=']);
  const conjunction = binary(equality, ['&&']);
  const disjunction = binary(conjunction, ['||']);

  function ternary() {
    depth += 1;
    if (depth > MAX_DEPTH) throw new Error('billing expression nests too deeply');
    try {
      const condition = disjunction();
      if (!isOp('?')) return condition;
      at += 1;
      const whenTrue = ternary();
      take(':');
      return { type: 'ternary', condition, whenTrue, whenFalse: ternary() };
    } finally {
      depth -= 1;
    }
  }

  const tree = ternary();
  if (at !== tokens.length) throw new Error('trailing text in billing expression');
  return tree;
}

function evaluate(node, variables, atMs) {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'variable':
      // A token class this gateway does not meter (audio, images) counts as none.
      return Number.isFinite(variables[node.name]) ? variables[node.name] : 0;
    case 'clock':
      return zoneParts(node.zone, atMs)[node.field];
    case 'max':
      return Math.max(...node.args.map((arg) => Number(evaluate(arg, variables, atMs))));
    case 'min':
      return Math.min(...node.args.map((arg) => Number(evaluate(arg, variables, atMs))));
    case 'unary': {
      const value = evaluate(node.operand, variables, atMs);
      return node.op === '-' ? -Number(value) : !value;
    }
    case 'ternary':
      return evaluate(node.condition, variables, atMs)
        ? evaluate(node.whenTrue, variables, atMs)
        : evaluate(node.whenFalse, variables, atMs);
    default: {
      if (node.op === '&&') return Boolean(evaluate(node.left, variables, atMs)) && Boolean(evaluate(node.right, variables, atMs));
      if (node.op === '||') return Boolean(evaluate(node.left, variables, atMs)) || Boolean(evaluate(node.right, variables, atMs));
      const left = evaluate(node.left, variables, atMs);
      const right = evaluate(node.right, variables, atMs);
      switch (node.op) {
        case '*': return left * right;
        case '/': return left / right;
        case '%': return left % right;
        case '+': return left + right;
        case '-': return left - right;
        case '<': return left < right;
        case '<=': return left <= right;
        case '>': return left > right;
        case '>=': return left >= right;
        case '==': return left === right;
        default: return left !== right;
      }
    }
  }
}

/**
 * A billing expression as a function of token counts and the instant billed,
 * or null when it is not one this module can read. The result is in the
 * formula's own unit: dollars per million tokens times tokens, before the
 * group ratio.
 */
export function compileBillingExpression(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_EXPRESSION_LENGTH) return null;
  let tree;
  try {
    tree = parse(tokenize(text));
  } catch {
    return null;
  }
  return ({ p = 0, c = 0, cr = 0, cc = 0 } = {}, atMs = Date.now()) => {
    const value = Number(evaluate(tree, { p, c, cr, cc }, atMs));
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
}

const HOUR_MS = 3_600_000;
// A Monday 00:00 UTC; any whole week will do.
const WEEK_START_MS = Date.UTC(2026, 0, 5);

/**
 * How a formula's price moves through a week: the multiplier of its dearest
 * hour over its cheapest, and the cheapest hour itself to quote prices at.
 * Formulas on this platform change by the hour, in whole-hour zones.
 */
export function billingWeekProfile(billing) {
  const sample = { p: 1e6, c: 1e6, cr: 1e6 };
  let low = null;
  let high = null;
  let lowAtMs = WEEK_START_MS;
  for (let hour = 0; hour < 168; hour += 1) {
    const atMs = WEEK_START_MS + hour * HOUR_MS;
    const value = billing(sample, atMs);
    if (value === null) return null;
    if (low === null || value < low) {
      low = value;
      lowAtMs = atMs;
    }
    if (high === null || value > high) high = value;
  }
  return { baseAtMs: lowAtMs, peakMultiplier: low > 0 ? high / low : 1 };
}
