import { describe, expect, it } from 'vitest';
import { readDriverExamples, readDriversDoc } from './drivers-doc.js';
import { containsUnchanged } from './judge.js';
import { CPP_INCLUDE_DIR, getLanguage, GSON_JAR } from './languages.js';

const doc = readDriversDoc();
const examples = readDriverExamples();

describe('DRIVERS.md', () => {
  it('has a complete example for every language', () => {
    expect(Object.keys(examples).sort()).toEqual(['cpp', 'go', 'java', 'python']);
  });

  it.each(['python', 'cpp', 'java', 'go'])(
    'the %s example contains the student code unchanged',
    (language) => {
      const { driverCode, correctedCode } = examples[language];
      expect(correctedCode.trim()).not.toBe('');
      expect(containsUnchanged(driverCode, correctedCode)).toBe(true);
    },
  );

  it.each(['python', 'cpp', 'java', 'go'])(
    'the %s example reads stdin and prints one line of JSON',
    (language) => {
      const { driverCode } = examples[language];
      expect(driverCode).toMatch(/stdin|std::cin|System\.in|os\.Stdin/);
      expect(driverCode).toMatch(/json\.dumps|\.dump\(\)|toJson|json\.Marshal/);
    },
  );

  it('names the library, the include or import line and the build command for each language', () => {
    expect(doc).toContain('`import json`');
    expect(doc).toContain('#include <nlohmann/json.hpp>');
    expect(doc).toContain('import com.google.gson.Gson;');
    expect(doc).toContain('encoding/json');
  });

  it('shows exactly the compile and run flags the worker uses', () => {
    const cpp = getLanguage('cpp').compile();
    expect(doc).toContain(`${cpp.command} ${cpp.args.join(' ')}`);
    expect(CPP_INCLUDE_DIR).toBe('/opt/judge/include');

    const javac = getLanguage('java').compile();
    expect(doc).toContain(`${javac.command} ${javac.args.join(' ')}`);
    expect(doc).toContain(`java -cp .:${GSON_JAR} Main`);

    const go = getLanguage('go').compile();
    expect(doc).toContain(`${go.command} ${go.args.join(' ')}`);
    expect(doc).toContain('python3 main.py');
  });

  it('states the convention', () => {
    expect(doc).toMatch(/one JSON object on standard input/);
    expect(doc).toMatch(/one line of JSON/);
    expect(doc).toMatch(/compares the\s+\*\*values\*\*/);
    expect(doc).toMatch(/in signature order/);
  });
});
