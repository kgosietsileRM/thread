/**
 * 09 – Hot-Swap, Events & Warmup
 *
 * Demonstrates reloading a worker's exec function at runtime,
 * the full event system (timing, metrics, progress, log), and
 * pre-warming a worker with warmup().
 *
 * Run:  bun run examples/09-hot-swap-events.js
 */

import { createThread } from "../src/index.js";

// ---------- 1. Warmup — eliminate JIT cold-start ----------

const warm = createThread(
  (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.sin(i);
    return sum;
  },
  { onTiming: (ms) => console.log(`  [warm timing] ${ms.toFixed(1)}ms`) },
);

console.log("Warming up worker...");
await warm.warmup();
console.log("  warmup done\n");

// First real run should be fast (JIT already compiled)
const warmResult = await warm.run(100_000);
console.log("  warm run result:", warmResult.toFixed(4));

await warm.terminate();


// ---------- 2. Event system — timing, metrics, log ----------

const logged = createThread(
  (data, ctx) => {
    ctx.log(`Processing ${data.length} items...`);
    const result = data.map((x) => x * 2);
    ctx.log(`Done — produced ${result.length} items`);
    return result;
  },
  {
    onLog: (msg) => console.log(`  [worker log] ${msg}`),
    onTiming: (ms) => console.log(`  [timing] ${ms.toFixed(1)}ms`),
    onMetrics: (snap) =>
      console.log(`  [metrics] count=${snap.count} avg=${snap.avg?.toFixed(1)}ms`),
  },
);

console.log("Events — processing data with logging:\n");

const data = Array.from({ length: 20 }, (_, i) => i + 1);
const result = await logged.run(data);
console.log("  result:", result.join(", "));

await logged.terminate();


// ---------- 3. Hot-swap — change exec function at runtime ----------

const adaptable = createThread((x) => x + 1);

console.log("\nHot-swap demo:");
console.log("  initial exec: (x) => x + 1");
console.log("  run(10) =", await adaptable.run(10)); // 11

// Swap to a different function
adaptable.reload((x) => x * 10);
console.log("  after reload: (x) => x * 10");
console.log("  run(10) =", await adaptable.run(10)); // 100

// Swap again
adaptable.reload((x) => x ** 2);
console.log("  after reload: (x) => x ** 2");
console.log("  run(10) =", await adaptable.run(10)); // 100

await adaptable.terminate();


// ---------- 4. Progress reporting ----------

const progressWorker = createThread(
  (total, ctx) => {
    for (let i = 1; i <= total; i++) {
      ctx.reportProgress(i / total);
    }
    return `processed ${total} items`;
  },
  {
    onProgress: (value) => {
      const pct = (value * 100).toFixed(0);
      process.stdout.write(`\r  progress: ${pct}%`);
    },
  },
);

console.log("\n\nProgress reporting:");
const msg = await progressWorker.run(50);
console.log(`\n  result: ${msg}`);

await progressWorker.terminate();

console.log("\n✓ All hot-swap & event examples passed");
