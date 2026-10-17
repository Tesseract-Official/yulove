// Hand-written student answers and drivers for the sandbox tests. The problem is always
// "sum the numbers": the input is {"nums": [...]} and the program prints the sum as JSON.
// Each driver follows the input/output convention: read one JSON object from stdin, call the
// student's function, print its result as one line of JSON. C++ uses nlohmann/json and Java uses
// Gson (both installed in the image); Python and Go use their standard libraries.

/** The kinds of answer: correct, wrong, endless loop, crash, does not compile, uses lots of memory. */
export const KINDS = ['ac', 'wa', 'tle', 're', 'ce', 'mle'];

const python = {
  student(kind) {
    const bodies = {
      ac: '    return sum(nums)',
      wa: '    return sum(nums) + 1',
      tle: '    while True:\n        pass',
      re: '    return 1 // 0',
      mle: '    hog = []\n    while True:\n        hog.append(b"x" * 10_000_000)',
    };
    if (kind === 'ce') return 'def solve(nums:\n    return sum(nums)\n';
    return `def solve(nums):\n${bodies[kind]}\n`;
  },
  driver: (student) =>
    `import json, sys\n\n${student}\nprint(json.dumps(solve(json.loads(sys.stdin.read())["nums"])))\n`,
};

const cpp = {
  student(kind) {
    const bodies = {
      ac: '    long long total = 0;\n    for (long long x : nums) total += x;\n    return total;',
      wa: '    long long total = 1;\n    for (long long x : nums) total += x;\n    return total;',
      tle: '    volatile long long i = 0;\n    while (true) { i = i + 1; }\n    return 0;',
      re: '    std::abort();\n    return 0;',
      ce: '    return undefined_name;',
      mle:
        '    std::vector<char*> hog;\n' +
        '    while (true) {\n' +
        '        char* p = (char*)malloc(10000000);\n' +
        '        memset(p, 1, 10000000);\n' +
        '        hog.push_back(p);\n' +
        '    }\n' +
        '    return 0;',
    };
    return `long long solve(const std::vector<long long>& nums) {\n${bodies[kind]}\n}\n`;
  },
  driver: (student) => `#include <nlohmann/json.hpp>

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <vector>

${student}
int main() {
    nlohmann::json input = nlohmann::json::parse(std::cin);
    std::vector<long long> nums = input.at("nums").get<std::vector<long long>>();
    std::cout << nlohmann::json(solve(nums)).dump() << std::endl;
    return 0;
}
`,
};

const java = {
  student(kind) {
    const bodies = {
      ac: '        long total = 0;\n        for (long x : nums) total += x;\n        return total;',
      wa: '        long total = 1;\n        for (long x : nums) total += x;\n        return total;',
      tle: '        while (true) { }',
      re: '        throw new RuntimeException("boom");',
      ce: '        return undefinedName;',
      mle:
        '        java.util.List<byte[]> hog = new java.util.ArrayList<>();\n' +
        '        while (true) { hog.add(new byte[10_000_000]); }',
    };
    return `    static long solve(long[] nums) {\n${bodies[kind]}\n    }\n`;
  },
  driver: (student) => `import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStreamReader;

public class Main {
${student}
    public static void main(String[] args) throws IOException {
        JsonObject input = JsonParser.parseReader(new InputStreamReader(System.in)).getAsJsonObject();
        Gson gson = new Gson();
        long[] nums = gson.fromJson(input.get("nums"), long[].class);
        System.out.println(gson.toJson(solve(nums)));
    }
}
`,
};

const go = {
  student(kind) {
    const bodies = {
      ac: '\tvar total int64\n\tfor _, x := range nums {\n\t\ttotal += x\n\t}\n\treturn total',
      wa: '\tvar total int64 = 1\n\tfor _, x := range nums {\n\t\ttotal += x\n\t}\n\treturn total',
      tle: '\tfor {\n\t}',
      re: '\tpanic("boom")',
      ce: '\treturn undefinedName',
      mle:
        '\tvar hog [][]byte\n' +
        '\tfor {\n' +
        '\t\tchunk := make([]byte, 10000000)\n' +
        '\t\tfor i := range chunk {\n' +
        '\t\t\tchunk[i] = 1\n' +
        '\t\t}\n' +
        '\t\thog = append(hog, chunk)\n' +
        '\t}',
    };
    return `func solve(nums []int64) int64 {\n${bodies[kind]}\n}\n`;
  },
  driver: (student) => `package main

import (
\t"encoding/json"
\t"fmt"
\t"io"
\t"os"
)

${student}
func main() {
\tdata, _ := io.ReadAll(os.Stdin)
\tvar in struct {
\t\tNums []int64 \`json:"nums"\`
\t}
\tif err := json.Unmarshal(data, &in); err != nil {
\t\tpanic(err)
\t}
\tfmt.Println(solve(in.Nums))
}
`,
};

const BY_LANGUAGE = { python, cpp, java, go };

/** { correctedCode, driverCode } for one language and kind of answer. */
export function sumProgram(language, kind) {
  const lang = BY_LANGUAGE[language];
  const correctedCode = lang.student(kind);
  return { correctedCode, driverCode: lang.driver(correctedCode) };
}

/** A Python answer whose function returns a fixed value, printed as JSON. */
export function pythonReturning(expression) {
  const correctedCode = `def solve(nums):\n    return ${expression}\n`;
  return { correctedCode, driverCode: python.driver(correctedCode) };
}

/** Tests for the sum problem: two small ones and one large one. */
export function sumTests(indexes = [0, 1, 7]) {
  return indexes.map((index) => {
    const nums = Array.from({ length: index + 1 }, (_, i) => i);
    return {
      index,
      kind: index < 7 ? 'small' : 'large',
      input: JSON.stringify({ nums }),
      expected: String(nums.reduce((a, b) => a + b, 0)),
    };
  });
}
