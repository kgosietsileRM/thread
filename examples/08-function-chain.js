/**
 * 08 – Function Chain Pipelines
 *
 * Use runChain() to pipe a value through a sequence of functions,
 * each running in its own temporary worker.
 *
 * Run:  bun run examples/08-function-chain.js
 */

import { createThread } from "../src/index.js";

// ---------- 1. Basic chain — sequential transforms ----------

const passthrough = createThread((x) => x);

const result = await passthrough.runChain(
  5,
  (x) => x + 3,        // 8
  (x) => x * 2,        // 16
  (x) => x - 1,        // 15
  (x) => x ** 2,       // 225
  (x) => x / 5,        // 45
);

console.log("Chain: 5 → +3 → ×2 → -1 → ² ÷5 =", result);

await passthrough.terminate();


// ---------- 2. Data pipeline — string transformations ----------

const strThread = createThread((x) => x);

const greeting = await strThread.runChain(
  "  hello world  ",
  (s) => s.trim(),
  (s) => s.toUpperCase(),
  (s) => s.replace(/\s+/g, "_"),
  (s) => `prefix_${s}_suffix`,
);

console.log('String chain:', greeting);

await strThread.terminate();


// ---------- 3. Async chain with heavy computation ----------

const heavy = createThread((x) => x);

const computed = await heavy.runChain(
  10,
  (n) => {
    // Factorial
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
  },
  (f) => f.toString().length,  // number of digits
  (digits) => digits * 100,     // scale
);

console.log("10! has", (10).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",").length - 2,
  "digits → chain result:", computed);

await heavy.terminate();


// ---------- 4. Chain with mixed sync/async workers ----------

const w1 = createThread((x) => x * 2);
const result2 = await w1.runChain(
  1,
  (x) => x + 10,   // 11
  (x) => x * 3,    // 33
);

console.log("Mixed chain: 1 → +10 → ×3 =", result2);

await w1.terminate();

console.log("\n✓ All function chain examples passed");
