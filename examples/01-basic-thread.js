/**
 * 01 – Basic Thread
 *
 * The simplest possible usage: pass a function to createThread(),
 * call run() with arguments, get the result back.
 *
 * Run:  bun run examples/01-basic-thread.js
 */

import { createThread, ThreadError } from "../src/index.js";

// ---------- 1. Single-argument thread ----------

const double = createThread((x) => x * 2);

const result = await double.run(21);
console.log("double(21) =", result); // 42

await double.terminate();


// ---------- 2. Multi-argument thread ----------

const add = createThread((a, b) => a + b);

console.log("add(3, 4) =", await add.run(3, 4)); // 7

await add.terminate();


// ---------- 3. Thread with options ----------

const slow = createThread(
  (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.sqrt(i);
    return sum;
  },
  {
    timeout: 10_000,
    onTiming: (ms) => console.log(`  [timing] completed in ${ms.toFixed(1)}ms`),
  },
);

const sum = await slow.run(500_000);
console.log("sqrt sum =", sum.toFixed(2));

await slow.terminate();


// ---------- 4. Error handling ----------

const fail = createThread(() => {
  throw new Error("boom");
});

try {
  await fail.run();
} catch (err) {
  if (err instanceof ThreadError) {
    console.log("caught ThreadError:", err.message);
  }
}

await fail.terminate();

console.log("\n✓ All basic thread examples passed");
