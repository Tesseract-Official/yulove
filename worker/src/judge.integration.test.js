// Judges real programs in the four languages. Runs only inside the worker image.
import { describe, expect, it } from 'vitest';
import { judge } from './judge.js';
import { runSetup } from './setup.js';
import { processesOfUid, slotIds } from './sandbox.js';
import { pythonReturning, sumProgram, sumTests } from './test-utils/programs.js';

const enabled = process.env.WORKER_SANDBOX_TESTS === '1';
const sandboxDescribe = describe.skipIf(!enabled);

const LANGUAGES = ['python', 'cpp', 'java', 'go'];

function job(language, kind, overrides = {}) {
  return {
    language,
    ...sumProgram(language, kind),
    tests: sumTests(),
    timeLimitMs: 1000,
    memoryMb: 256,
    compareMode: 'EXACT',
    slot: 1,
    ...overrides,
  };
}

const verdictsOf = (result) => result.verdicts.map((v) => v.verdict);

sandboxDescribe.each(LANGUAGES)('judging %s answers', (language) => {
  it('accepts a correct answer (AC)', async () => {
    const result = await judge(job(language, 'ac'));

    expect(result.outcome).toBe('COMPLETED');
    expect(verdictsOf(result)).toEqual(['AC', 'AC', 'AC']);
    expect(result.verdicts[0]).toEqual({ index: 0, kind: 'small', verdict: 'AC' });
    expect(result.verdicts[2]).toEqual({ index: 7, kind: 'large', verdict: 'AC' });
  });

  it('rejects a wrong answer (WA) and shows the student what happened', async () => {
    const result = await judge(job(language, 'wa'));

    expect(verdictsOf(result)).toEqual(['WA', 'WA', 'WA']);
    expect(result.verdicts[1]).toEqual({
      index: 1,
      kind: 'small',
      verdict: 'WA',
      input: '{"nums":[0,1]}',
      expected: '1',
      actual: '2\n',
    });
    // A large test keeps only its verdict.
    expect(result.verdicts[2]).toEqual({ index: 7, kind: 'large', verdict: 'WA' });
  });

  it('stops an endless loop (TLE)', async () => {
    const result = await judge(job(language, 'tle', { timeLimitMs: 400, tests: sumTests([0, 1]) }));
    expect(verdictsOf(result)).toEqual(['TLE', 'TLE']);
  });

  it('reports a crash (RE)', async () => {
    const result = await judge(job(language, 're'));
    expect(verdictsOf(result)).toEqual(['RE', 'RE', 'RE']);
  });

  it('reports a compile error (CE) for every test', async () => {
    const result = await judge(job(language, 'ce'));

    expect(verdictsOf(result)).toEqual(['CE', 'CE', 'CE']);
    expect(result.verdicts[0]).toMatchObject({ input: '{"nums":[0]}', expected: '0' });
    expect(result.verdicts[0]).not.toHaveProperty('actual');
  });
});

sandboxDescribe.each([['python'], ['cpp'], ['java'], ['go']])('memory limit in %s', (language) => {
  it('kills a program that uses too much memory (MLE)', async () => {
    const result = await judge(
      job(language, 'mle', { memoryMb: 64, timeLimitMs: 20_000, tests: sumTests([0]) }),
    );
    expect(verdictsOf(result)).toEqual(['MLE']);
  });
});

sandboxDescribe('comparing real output', () => {
  it('accepts Java’s [1,2,3] against the reference’s [1, 2, 3]', async () => {
    // The expected output really comes from a Python reference run in the sandbox.
    const setup = await runSetup({
      referenceCode: 'import json\nprint(json.dumps([1, 2, 3]))\n',
      generatorCode: 'import json\nprint(json.dumps({"n": 1}))\n',
      smallInputs: Array(7).fill('{"n": 0}'),
      largeInputCount: 0,
      timeLimitMs: 1000,
      memoryMb: 128,
      slot: 2,
    });
    expect(setup.tests[0].expected).toBe('[1, 2, 3]');

    const correctedCode = '    static int[] solve() { return new int[] {1, 2, 3}; }\n';
    const driverCode = `import com.google.gson.Gson;\n\npublic class Main {\n${correctedCode}    public static void main(String[] a) { System.out.println(new Gson().toJson(solve())); }\n}\n`;
    const result = await judge({
      language: 'java',
      driverCode,
      correctedCode,
      tests: setup.tests.slice(0, 2),
      timeLimitMs: 1000,
      memoryMb: 128,
      compareMode: 'EXACT',
      slot: 1,
    });

    expect(verdictsOf(result)).toEqual(['AC', 'AC']);
  });

  it('accepts floating point output within 1e-6 in FLOAT mode but not in EXACT mode', async () => {
    const program = pythonReturning('[0.1 + 0.2]'); // prints [0.30000000000000004]
    const tests = [{ index: 0, kind: 'small', input: '{"nums":[]}', expected: '[0.3]' }];
    const base = {
      language: 'python',
      ...program,
      tests,
      timeLimitMs: 1000,
      memoryMb: 128,
      slot: 1,
    };

    expect(verdictsOf(await judge({ ...base, compareMode: 'FLOAT' }))).toEqual(['AC']);
    expect(verdictsOf(await judge({ ...base, compareMode: 'EXACT' }))).toEqual(['WA']);
  });

  it('accepts a different order in ANY_ORDER mode but not in EXACT mode', async () => {
    const program = pythonReturning('[3, 1, 2]');
    const tests = [{ index: 0, kind: 'small', input: '{"nums":[]}', expected: '[1, 2, 3]' }];
    const base = {
      language: 'python',
      ...program,
      tests,
      timeLimitMs: 1000,
      memoryMb: 128,
      slot: 1,
    };

    expect(verdictsOf(await judge({ ...base, compareMode: 'ANY_ORDER' }))).toEqual(['AC']);
    expect(verdictsOf(await judge({ ...base, compareMode: 'EXACT' }))).toEqual(['WA']);
  });

  it('treats output that is not JSON as a wrong answer', async () => {
    const program = pythonReturning('"x"');
    const driver = program.driverCode.replace('print(json.dumps(', 'print((');
    const tests = [{ index: 0, kind: 'small', input: '{"nums":[]}', expected: '"x"' }];
    // Prints x without quotes: not valid JSON.
    const result = await judge({
      language: 'python',
      driverCode: driver,
      correctedCode: program.correctedCode,
      tests,
      timeLimitMs: 1000,
      memoryMb: 128,
      compareMode: 'EXACT',
      slot: 1,
    });
    expect(verdictsOf(result)).toEqual(['WA']);
  });
});

sandboxDescribe('the JSON libraries handle real input types', () => {
  // Arrays of arrays, strings, a double and a boolean in; an object out.
  const input = '{"matrix":[[1,2],[3]],"name":"hi","ratio":1.5,"flag":true}';
  const expected = '{"rowSizes":[2,1],"upper":"HI","doubled":3.0,"negated":false}';
  const tests = [{ index: 0, kind: 'small', input, expected }];
  const base = { tests, timeLimitMs: 2000, memoryMb: 256, compareMode: 'EXACT', slot: 1 };

  it('nlohmann/json in C++', async () => {
    const correctedCode =
      'std::vector<int> rowSizes(const std::vector<std::vector<int>>& m) {\n    std::vector<int> sizes;\n    for (const auto& row : m) sizes.push_back((int)row.size());\n    return sizes;\n}\n';
    const driverCode = `#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

${correctedCode}
int main() {
    nlohmann::json in = nlohmann::json::parse(std::cin);
    std::string name = in.at("name").get<std::string>();
    std::transform(name.begin(), name.end(), name.begin(), ::toupper);
    nlohmann::json out = {
        {"rowSizes", rowSizes(in.at("matrix").get<std::vector<std::vector<int>>>())},
        {"upper", name},
        {"doubled", in.at("ratio").get<double>() * 2},
        {"negated", !in.at("flag").get<bool>()},
    };
    std::cout << out.dump() << std::endl;
}
`;
    const result = await judge({ ...base, language: 'cpp', correctedCode, driverCode });
    expect(verdictsOf(result)).toEqual(['AC']);
  });

  it('Gson in Java', async () => {
    const correctedCode =
      '    static int[] rowSizes(int[][] m) {\n        int[] sizes = new int[m.length];\n        for (int i = 0; i < m.length; i++) sizes[i] = m[i].length;\n        return sizes;\n    }\n';
    const driverCode = `import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.InputStreamReader;
import java.util.LinkedHashMap;
import java.util.Map;

public class Main {
${correctedCode}
    public static void main(String[] args) {
        JsonObject in = JsonParser.parseReader(new InputStreamReader(System.in)).getAsJsonObject();
        Gson gson = new Gson();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("rowSizes", rowSizes(gson.fromJson(in.get("matrix"), int[][].class)));
        out.put("upper", in.get("name").getAsString().toUpperCase());
        out.put("doubled", in.get("ratio").getAsDouble() * 2);
        out.put("negated", !in.get("flag").getAsBoolean());
        System.out.println(gson.toJson(out));
    }
}
`;
    const result = await judge({ ...base, language: 'java', correctedCode, driverCode });
    expect(verdictsOf(result)).toEqual(['AC']);
  });

  it('encoding/json in Go', async () => {
    const correctedCode =
      'func rowSizes(m [][]int) []int {\n\tsizes := []int{}\n\tfor _, row := range m {\n\t\tsizes = append(sizes, len(row))\n\t}\n\treturn sizes\n}\n';
    const driverCode = `package main

import (
\t"encoding/json"
\t"fmt"
\t"io"
\t"os"
\t"strings"
)

${correctedCode}
func main() {
\tdata, _ := io.ReadAll(os.Stdin)
\tvar in struct {
\t\tMatrix [][]int \`json:"matrix"\`
\t\tName   string  \`json:"name"\`
\t\tRatio  float64 \`json:"ratio"\`
\t\tFlag   bool    \`json:"flag"\`
\t}
\tif err := json.Unmarshal(data, &in); err != nil {
\t\tpanic(err)
\t}
\tout, _ := json.Marshal(map[string]any{
\t\t"rowSizes": rowSizes(in.Matrix),
\t\t"upper":    strings.ToUpper(in.Name),
\t\t"doubled":  in.Ratio * 2,
\t\t"negated":  !in.Flag,
\t})
\tfmt.Println(string(out))
}
`;
    const result = await judge({ ...base, language: 'go', correctedCode, driverCode });
    expect(verdictsOf(result)).toEqual(['AC']);
  });

  it('Python json', async () => {
    const correctedCode = 'def row_sizes(m):\n    return [len(r) for r in m]\n';
    const driverCode = `import json, sys\n\n${correctedCode}\ndata = json.loads(sys.stdin.read())\nprint(json.dumps({"rowSizes": row_sizes(data["matrix"]), "upper": data["name"].upper(), "doubled": data["ratio"] * 2, "negated": not data["flag"]}))\n`;
    const result = await judge({ ...base, language: 'python', correctedCode, driverCode });
    expect(verdictsOf(result)).toEqual(['AC']);
  });
});

sandboxDescribe('hostile programs', () => {
  it('contains a fork bomb, leaving no process behind, and the slot still works', async () => {
    const bomb = {
      correctedCode: 'def solve(nums):\n    import os\n    while True:\n        os.fork()\n',
    };
    bomb.driverCode = `import json, sys\n\n${bomb.correctedCode}\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`;

    const result = await judge(
      job('python', 'ac', { ...bomb, memoryMb: 128, timeLimitMs: 1500, tests: sumTests([0]) }),
    );

    expect(['RE', 'TLE', 'MLE']).toContain(result.verdicts[0].verdict);
    expect(processesOfUid(slotIds(1).uid)).toEqual([]);

    const after = await judge(job('python', 'ac'));
    expect(verdictsOf(after)).toEqual(['AC', 'AC', 'AC']);
  });

  it('cannot write outside its working directory: the write fails and the answer is a runtime error', async () => {
    const correctedCode =
      'def solve(nums):\n    open("/etc/pwned", "w").write("x")\n    return sum(nums)\n';
    const driverCode = `import json, sys\n\n${correctedCode}\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`;

    const result = await judge(job('python', 'ac', { correctedCode, driverCode }));

    expect(verdictsOf(result)).toEqual(['RE', 'RE', 'RE']);
  });

  it('does not let a test see files left by the one before it', async () => {
    // Test 0 leaves a file; later tests would print it if they shared the directory.
    const correctedCode =
      'def solve(nums):\n    import os\n    seen = os.path.exists("left_behind")\n    open("left_behind", "w").write("x")\n    return 1 if seen else 0\n';
    const driverCode = `import json, sys\n\n${correctedCode}\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`;
    const tests = sumTests([0, 1, 2]).map((t) => ({ ...t, expected: '0' }));

    const result = await judge(job('python', 'ac', { correctedCode, driverCode, tests }));

    expect(verdictsOf(result)).toEqual(['AC', 'AC', 'AC']);
  });

  it('fails with DRIVER_MISMATCH when the driver changed the student’s code', async () => {
    const program = sumProgram('python', 'ac');
    const altered = program.driverCode.replace('sum(nums)', 'max(nums)');

    const result = await judge(job('python', 'ac', { driverCode: altered }));

    expect(result).toEqual({ outcome: 'FAILED', failReason: 'DRIVER_MISMATCH' });
  });
});

sandboxDescribe('a full 10-test judgement', () => {
  it('runs all 10 tests', async () => {
    const result = await judge(
      job('python', 'ac', { tests: sumTests([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) }),
    );

    expect(result.verdicts).toHaveLength(10);
    expect(result.verdicts.every((v) => v.verdict === 'AC')).toBe(true);
    expect(result.verdicts.slice(0, 7).every((v) => v.kind === 'small')).toBe(true);
    expect(result.verdicts.slice(7).every((v) => v.kind === 'large')).toBe(true);
  });
});
