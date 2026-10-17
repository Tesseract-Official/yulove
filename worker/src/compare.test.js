import { describe, expect, it } from 'vitest';
import { compareOutputs, COMPARE_MODES, FLOAT_TOLERANCE, parseJsonValue } from './compare.js';

const { EXACT, ANY_ORDER, FLOAT } = COMPARE_MODES;
const same = (expected, actual, mode) => compareOutputs(expected, actual, mode).equal;

describe('parseJsonValue', () => {
  it.each(['', '   ', '1\n2', '[1,2', 'NaN', 'Infinity', '[1,]', "{'a':1}", 'undefined'])(
    'rejects %j',
    (text) => {
      expect(parseJsonValue(text).ok).toBe(false);
    },
  );

  it('accepts surrounding whitespace and a trailing newline', () => {
    expect(parseJsonValue('  [1, 2]\r\n\n')).toEqual({ ok: true, value: [1, 2] });
  });

  it('keeps integers beyond 2^53 exact', () => {
    expect(parseJsonValue('9007199254740993').value).toBe(9007199254740993n);
    expect(parseJsonValue('9007199254740991').value).toBe(9007199254740991);
    expect(parseJsonValue('1.5e300').value).toBe(1.5e300);
  });
});

describe('EXACT', () => {
  it.each([
    ['2', '2'],
    ['2', '2.0'],
    ['2.0', '2'],
    ['2', '2e0'],
    ['[1, 2, 3]', '[1,2,3]'],
    ['[1,2,3]', ' [ 1 , 2 , 3 ] \n'],
    ['{"a": 1, "b": [2]}', '{"b":[2.0],"a":1}'],
    ['"hi"', '"hi"'],
    ['null', 'null'],
    ['true', 'true'],
    ['[]', '[ ]'],
    ['{}', '{ }'],
    ['0', '-0'],
    ['[[1,2],[3]]', '[[1.0,2],[3]]'],
  ])('%s equals %s', (expected, actual) => {
    expect(same(expected, actual, EXACT)).toBe(true);
  });

  it.each([
    ['2', '3'],
    ['[1,2,3]', '[3,2,1]'],
    ['[1,2,3]', '[1,2]'],
    ['[1,2]', '[1,2,3]'],
    ['"2"', '2'],
    ['2', '"2"'],
    ['null', '0'],
    ['null', 'false'],
    ['[]', '{}'],
    ['{"a":1}', '{"a":1,"b":2}'],
    ['{"a":1,"b":2}', '{"a":1}'],
    ['{"a":1}', '{"b":1}'],
    ['true', '1'],
    ['0.1', '0.10000001'],
    ['[1,[2,3]]', '[1,[3,2]]'],
  ])('%s differs from %s', (expected, actual) => {
    const result = compareOutputs(expected, actual, EXACT);
    expect(result).toEqual({ equal: false, reason: 'mismatch' });
  });

  it('compares 64-bit integers exactly', () => {
    expect(same('9223372036854775807', '9223372036854775807', EXACT)).toBe(true);
    expect(same('9223372036854775807', '9223372036854775806', EXACT)).toBe(false);
    // These two differ, though both round to the same double.
    expect(same('9007199254740993', '9007199254740992', EXACT)).toBe(false);
  });

  it('is the default mode', () => {
    expect(compareOutputs('[1,2]', '[2,1]').equal).toBe(false);
    expect(compareOutputs('[1,2]', '[1, 2]').equal).toBe(true);
  });
});

describe('ANY_ORDER', () => {
  it.each([
    ['[1,2,3]', '[3,1,2]'],
    ['[1,2,3]', '[1,2,3]'],
    ['[1,1,2]', '[2,1,1]'],
    ['[]', '[]'],
    ['[[1,2],[3]]', '[[3],[1,2]]'],
    ['[{"a":1,"b":2},{"c":3}]', '[{"c":3},{"b":2,"a":1}]'],
    ['["b","a"]', '["a","b"]'],
    ['[1,2.0]', '[2,1.0]'],
  ])('%s equals %s', (expected, actual) => {
    expect(same(expected, actual, ANY_ORDER)).toBe(true);
  });

  it.each([
    ['[1,1,2]', '[1,2,2]'],
    ['[1,2,3]', '[1,2]'],
    ['[1,2]', '[1,2,3]'],
    ['[1,2,3]', '[1,2,4]'],
    ['[[1,2],[3]]', '[[2,1],[3]]'], // only the top level is unordered
    ['[1,2,3]', '{"a":1}'],
    ['[1,1]', '[1]'],
  ])('%s differs from %s', (expected, actual) => {
    expect(same(expected, actual, ANY_ORDER)).toBe(false);
  });

  it('counts duplicates (a multiset, not a set)', () => {
    expect(same('[1,1,2]', '[1,2,2]', ANY_ORDER)).toBe(false);
    expect(same('[1,1,2]', '[1,1,2]', ANY_ORDER)).toBe(true);
  });

  it('compares non-arrays exactly', () => {
    expect(same('5', '5.0', ANY_ORDER)).toBe(true);
    expect(same('5', '6', ANY_ORDER)).toBe(false);
    expect(same('{"a":[1,2]}', '{"a":[2,1]}', ANY_ORDER)).toBe(false);
  });

  it('treats a big integer and the same integer as a double alike', () => {
    expect(same('[1000000000000000000000]', '[1e21]', ANY_ORDER)).toBe(true);
  });
});

describe('FLOAT', () => {
  it('uses an absolute tolerance of 1e-6', () => {
    expect(FLOAT_TOLERANCE).toBe(1e-6);
  });

  it.each([
    ['0.3', '0.30000000000000004'],
    ['1.0', '1.0000005'],
    ['1', '0.9999995'],
    ['[0.1,0.2]', '[0.1000001,0.1999999]'],
    ['{"x":[1.5,{"y":2.5}]}', '{"x":[1.5000004,{"y":2.4999996}]}'],
    ['2', '2'],
    ['"a"', '"a"'],
    ['[1,2.0000001]', '[1,2]'],
  ])('%s is close to %s', (expected, actual) => {
    expect(same(expected, actual, FLOAT)).toBe(true);
  });

  it.each([
    ['1.0', '1.00001'],
    ['1', '1.0000011'],
    ['[0.1,0.2]', '[0.1,0.3]'],
    ['[1,2]', '[2,1]'], // arrays keep their order
    ['[1,2]', '[1,2,3]'],
    ['{"a":1}', '{"b":1}'],
    ['"1.0"', '1.0'],
    ['null', '0'],
  ])('%s is not close to %s', (expected, actual) => {
    expect(same(expected, actual, FLOAT)).toBe(false);
  });

  it('applies the tolerance only to numbers, not to strings or booleans', () => {
    expect(same('"1.0000001"', '"1.0"', FLOAT)).toBe(false);
    expect(same('true', 'false', FLOAT)).toBe(false);
  });

  it('is stricter than EXACT only where the values really differ', () => {
    expect(same('0.3', '0.30000000000000004', EXACT)).toBe(false);
    expect(same('0.3', '0.30000000000000004', FLOAT)).toBe(true);
  });
});

describe('invalid output', () => {
  it.each([
    ['empty output', ''],
    ['only whitespace', '  \n'],
    ['two lines', '1\n2'],
    ['two values on a line', '1 2'],
    ['text', 'hello'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['a cut-off array', '[1,2,'],
    ['a trailing comma', '[1,2,]'],
    ['single quotes', "['a']"],
    ['a Python repr', "{'a': True}"],
  ])('is a mismatch for %s in every mode', (_label, actual) => {
    for (const mode of [EXACT, ANY_ORDER, FLOAT]) {
      expect(compareOutputs('[1,2]', actual, mode)).toEqual({
        equal: false,
        reason: 'invalid-json',
      });
    }
  });

  it('reports an invalid expected output as a setup problem, not a wrong answer', () => {
    expect(compareOutputs('not json', '1', EXACT)).toEqual({
      equal: false,
      reason: 'expected-invalid',
    });
    expect(compareOutputs('', '1', EXACT)).toEqual({ equal: false, reason: 'expected-invalid' });
  });
});

describe('trailing whitespace', () => {
  it.each(['[1,2]', '[1,2]\n', '[1,2]\r\n', '[1,2]   \n\n', '\n[1,2]'])(
    '%j equals [1,2]',
    (actual) => {
      expect(same('[1,2]', actual, EXACT)).toBe(true);
    },
  );

  it('ignores whitespace in the expected text too', () => {
    expect(same('[1,2]\n', '[1,2]', EXACT)).toBe(true);
  });
});

describe('unknown mode', () => {
  it('throws', () => {
    expect(() => compareOutputs('1', '1', 'LOOSE')).toThrow(/Unknown compare mode/);
  });
});
