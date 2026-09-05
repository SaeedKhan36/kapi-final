/** A test harness small enough that it never needs its own tests. */
let failures = 0;
let passes = 0;
let skips = 0;
let suite = "";

class SkipTest extends Error {}

export function skip(reason: string): never {
  throw new SkipTest(reason);
}

export function group(name: string) {
  suite = name;
  console.log(`\n  ${name}`);
}

export async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passes++;
    console.log(`    \x1b[32mok\x1b[0m   ${name}`);
  } catch (err) {
    if (err instanceof SkipTest) {
      skips++;
      console.log(`    \x1b[33mskip\x1b[0m ${name} (${err.message})`);
      return;
    }
    failures++;
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`    \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`         ${detail.replace(/\n/g, "\n         ")}`);
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export function equal<T>(actual: T, expected: T, message = "") {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

export function deepEqual(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

export async function throws(fn: () => unknown, message: string) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected a throw: ${message}`);
}

export function report(): never {
  console.log(
    failures === 0
      ? `\n  \x1b[32m${passes} passed\x1b[0m${skips ? `, \x1b[33m${skips} skipped\x1b[0m` : ""}\n`
      : `\n  \x1b[31m${failures} failed\x1b[0m, ${passes} passed${skips ? `, ${skips} skipped` : ""}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { suite };
