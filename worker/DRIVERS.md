# Writing a driver

A **driver** is the program the worker actually compiles and runs for one student answer. It is
one source file in the student's language. It contains the student's corrected code **unchanged**,
plus a few lines that read the test input, call the student's function, and print the result.

The worker checks that the student's corrected code appears in the driver exactly as given (only
line endings and blank space around the whole piece are ignored). If it does not, the answer is
marked as failed to grade. Never fix, reformat, rename or "improve" the student's code in the
driver.

## The convention (every language)

1. **Input.** The test input is **one JSON object on standard input**. Its keys are the
   signature's parameter names, for example `{"nums": [2, 7, 11], "target": 9}`.
2. **Call.** Pass the values to the student's function **in signature order**, using the function
   name the student wrote (it may differ from the signature's name, and so may the student's
   parameter names).
3. **Output.** Print the function's result as **one line of JSON** on standard output: no pretty
   printing, no extra text, no debug output, nothing before or after. Diagnostics go to standard
   error.
4. **Comparison.** The worker parses your output and the expected output as JSON and compares the
   **values**. Spacing, key order, a trailing newline and `2` versus `2.0` do not matter. `NaN`,
   `Infinity`, or anything that is not valid JSON counts as a wrong answer, so print integers as
   integers and make sure floating point results are finite.
5. **Types.** Use the types the student's function declares. Read each argument with the
   library's typed accessor so numbers arrive as the right type (64-bit integers where the
   student used `long`, `long long` or `int64`).
6. **Do not** read files, use the network, start threads or processes, or measure time. Each run
   has a time limit, a memory limit, no network and a read-only file system apart from its own
   working directory.

The examples below are complete, working drivers for the same tiny problem: the input is
`{"nums": [1, 2, 3]}` and the student's function returns the sum, so the program prints `6`.
The lines between the two marker comments are the student's code. The tests run every example in
this file, so they are known to compile and pass.

## Python

- **Library:** the standard library's `json`.
- **Import:** `import json` and `import sys`.
- **Run:** `python3 main.py` (Python 3.12). The file is checked with `python3 -m py_compile` first.
- Raise the recursion limit (`sys.setrecursionlimit(1_000_000)`) before calling code that
  recurses deeply.

```python example
import json
import sys

# ---- the student's code, copied exactly ----
def solve(nums):
    return sum(nums)
# ---- end of the student's code ----

data = json.loads(sys.stdin.read())
result = solve(data["nums"])
print(json.dumps(result))
```

## C++

- **Library:** [nlohmann/json](https://github.com/nlohmann/json) 3.12.0, a single header.
- **Include:** `#include <nlohmann/json.hpp>` (put it first).
- **Build:** `g++ -std=c++17 -O2 -pipe -I/opt/judge/include -o main main.cpp`. The file is
  `main.cpp` and it needs a `main` function.
- Read with `nlohmann::json::parse(std::cin)`, take values with `input.at("name").get<T>()`
  (for example `std::vector<long long>`, `std::vector<std::vector<int>>`, `std::string`), and print
  with `nlohmann::json(result).dump()`. `dump()` with no argument is a single line.
- Use `long long` for 64-bit integers.

```cpp example
#include <nlohmann/json.hpp>

#include <iostream>
#include <vector>

// ---- the student's code, copied exactly ----
long long solve(const std::vector<long long>& nums) {
    long long total = 0;
    for (long long x : nums) total += x;
    return total;
}
// ---- end of the student's code ----

int main() {
    nlohmann::json input = nlohmann::json::parse(std::cin);
    std::vector<long long> nums = input.at("nums").get<std::vector<long long>>();
    std::cout << nlohmann::json(solve(nums)).dump() << std::endl;
    return 0;
}
```

## Java

- **Library:** [Gson](https://github.com/google/gson) 2.14.0.
- **Imports:** `import com.google.gson.Gson;`, `import com.google.gson.JsonObject;` and
  `import com.google.gson.JsonParser;`.
- **Build:** `javac -cp /opt/judge/lib/gson.jar Main.java`, then
  `java -cp .:/opt/judge/lib/gson.jar Main` (Java 21). The file is `Main.java` and the one public
  class is `public class Main` with a `public static void main(String[] args)`. Helper classes the
  student wrote can be non-public classes in the same file or nested classes.
- Read with `JsonParser.parseReader(new InputStreamReader(System.in)).getAsJsonObject()`, take
  values with `gson.fromJson(input.get("name"), long[].class)` (or `int[].class`,
  `String.class`, `new TypeToken<List<List<Integer>>>() {}.getType()` with
  `com.google.gson.reflect.TypeToken`), and print with `System.out.println(gson.toJson(result))`.
  A default `Gson` prints on one line.

```java example
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStreamReader;

public class Main {
    // ---- the student's code, copied exactly ----
    static long solve(long[] nums) {
        long total = 0;
        for (long x : nums) total += x;
        return total;
    }
    // ---- end of the student's code ----

    public static void main(String[] args) throws IOException {
        JsonObject input = JsonParser.parseReader(new InputStreamReader(System.in)).getAsJsonObject();
        Gson gson = new Gson();
        long[] nums = gson.fromJson(input.get("nums"), long[].class);
        System.out.println(gson.toJson(solve(nums)));
    }
}
```

## Go

- **Library:** the standard library's `encoding/json`.
- **Imports:** `encoding/json`, `fmt`, `io` and `os` (and only those you use: an unused import
  does not compile).
- **Build:** `go build -o main main.go` (Go 1.23). The file is `main.go`, `package main`, with a
  `func main()`.
- Decode into a struct whose fields have `json:"name"` tags and the types the student's function
  takes (`[]int64`, `[][]int`, `string`...), call the function, and print `json.Marshal(result)`
  with `fmt.Println(string(out))`.

```go example
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// ---- the student's code, copied exactly ----
func solve(nums []int64) int64 {
	var total int64
	for _, x := range nums {
		total += x
	}
	return total
}
// ---- end of the student's code ----

func main() {
	data, _ := io.ReadAll(os.Stdin)
	var in struct {
		Nums []int64 `json:"nums"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		panic(err)
	}
	out, _ := json.Marshal(solve(in.Nums))
	fmt.Println(string(out))
}
```
