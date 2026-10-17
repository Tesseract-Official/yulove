// Compares a program's output with the expected output by parsed JSON value, never by raw text.
// Spacing, a trailing newline and number formatting (2 vs 2.0) therefore never matter.

/** Compare modes, named as in @yulove/shared (the worker is plain JavaScript and cannot import it). */
export const COMPARE_MODES = Object.freeze({
  EXACT: 'EXACT',
  ANY_ORDER: 'ANY_ORDER',
  FLOAT: 'FLOAT',
});

/** FLOAT mode: numbers are equal when they differ by at most this much. */
export const FLOAT_TOLERANCE = 1e-6;

/**
 * Parses JSON text. Integers too large for a double are kept exact as BigInt, so 64-bit values
 * compare correctly. Returns { ok: false } for anything that is not exactly one JSON value
 * (empty output, two lines, NaN, a cut-off array...).
 */
export function parseJsonValue(text) {
  try {
    const value = JSON.parse(text, (_key, parsed, context) => {
      if (
        typeof parsed === 'number' &&
        !Number.isSafeInteger(parsed) &&
        context?.source !== undefined &&
        /^-?\d+$/.test(context.source)
      ) {
        return BigInt(context.source);
      }
      return parsed;
    });
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

const isNumeric = (v) => typeof v === 'number' || typeof v === 'bigint';

function numbersEqual(a, b) {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const [big, other] = typeof a === 'bigint' ? [a, b] : [b, a];
    return Number.isInteger(other) && BigInt(other) === big;
  }
  return a === b; // 2 and 2.0 are the same JSON number
}

function numbersClose(a, b) {
  return Math.abs(Number(a) - Number(b)) <= FLOAT_TOLERANCE;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep equality of parsed JSON values; `numberEquals` decides when two numbers match. */
function deepEqual(a, b, numberEquals) {
  if (isNumeric(a) && isNumeric(b)) return numberEquals(a, b);
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i], numberEquals));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k], numberEquals));
  }
  return a === b;
}

/** A string that is the same for equal values, whatever the order of object keys or number format. */
function canonical(value) {
  if (isNumeric(value)) {
    // An integer-valued double and the same integer as a BigInt must agree.
    const text =
      typeof value === 'bigint' || Number.isInteger(value)
        ? BigInt(value).toString()
        : String(value);
    return `n:${text}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Top-level arrays as multisets. Anything else falls back to exact comparison. */
function unorderedEqual(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) {
    return deepEqual(expected, actual, numbersEqual);
  }
  if (expected.length !== actual.length) return false;

  const counts = new Map();
  for (const item of expected) {
    const key = canonical(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of actual) {
    const key = canonical(item);
    const left = counts.get(key);
    if (!left) return false;
    counts.set(key, left - 1);
  }
  return true;
}

/**
 * Compares expected and actual output text.
 *   { equal: true }
 *   { equal: false, reason: 'invalid-json' }      the program's output is not one JSON value (a WA)
 *   { equal: false, reason: 'mismatch' }          valid JSON, different value (a WA)
 *   { equal: false, reason: 'expected-invalid' }  the expected output itself is not JSON (a setup bug)
 */
export function compareOutputs(expectedText, actualText, mode = COMPARE_MODES.EXACT) {
  const expected = parseJsonValue(expectedText);
  if (!expected.ok) return { equal: false, reason: 'expected-invalid' };
  const actual = parseJsonValue(actualText);
  if (!actual.ok) return { equal: false, reason: 'invalid-json' };

  let equal;
  switch (mode) {
    case COMPARE_MODES.EXACT:
      equal = deepEqual(expected.value, actual.value, numbersEqual);
      break;
    case COMPARE_MODES.ANY_ORDER:
      equal = unorderedEqual(expected.value, actual.value);
      break;
    case COMPARE_MODES.FLOAT:
      equal = deepEqual(expected.value, actual.value, numbersClose);
      break;
    default:
      throw new Error(`Unknown compare mode ${String(mode)}`);
  }
  return equal ? { equal: true } : { equal: false, reason: 'mismatch' };
}
