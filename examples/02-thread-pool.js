/**
 * 02 – Thread Pool
 *
 * Distribute work across multiple workers with createPool().
 * Tasks run in parallel and results are collected.
 *
 * Run:  bun run examples/02-thread-pool.js
 */

import { createPool } from "../src/index.js";

// ---------- 1. Simple parallel map ----------

const pool = createPool(4, (n) => {
  // Simulate CPU-heavy work
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sin(i);
  return sum;
});

const tasks = Array.from({ length: 8 }, (_, i) => pool.run(100_000 + i * 10_000));
const results = await Promise.all(tasks.map((t) => t.promise));

console.log(`Pool processed ${results.length} tasks`);
console.log("Results:", results.map((r) => r.toFixed(4)).join(", "));

await pool.terminateGracefully();


// ---------- 2. Task with priority ----------

const p2 = createPool(2, (x) => x * 10);

// High priority (0) runs before low priority (10)
const low = p2.run(1, { priority: 10 });
const high = p2.run(2, { priority: 0 });

console.log("high priority result =", await high.promise); // 20
console.log("low  priority result =", await low.promise);  // 10

await p2.terminateGracefully();


// ---------- 3. Dependency chain ----------

const p3 = createPool(2, (x) => x);

const step1 = p3.run("raw-data");
const step2 = p3.run((await step1.promise) + " → cleaned", { dependsOn: [step1.id] });
const step3 = p3.run((await step2.promise) + " → done",    { dependsOn: [step2.id] });

console.log("Pipeline:", await step3.promise);

await p3.terminateGracefully();


// ---------- 4. Pool status & metrics ----------

const p4 = createPool(2, (x) => x);

// Fire several tasks
for (let i = 0; i < 5; i++) p4.run(i);
await p4.drain();

const status = p4.status();
const metrics = p4.metrics;

console.log("Pool status:", status);
console.log("Metrics:", {
  count: metrics.count,
  avg: metrics.avg?.toFixed(2),
  throughput: metrics.throughput?.toFixed(2),
});

await p4.terminateGracefully();

console.log("\n✓ All thread pool examples passed");
