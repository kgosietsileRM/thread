/**
 * 06 – Metrics
 *
 * Track task counts, throughput, error rates, and latency using
 * the Metrics class and thread/pool built-in metrics.
 *
 * Run:  bun run examples/06-metrics.js
 */

import { createThread, createPool, Metrics } from "../src/index.js";

// ---------- 1. Standalone Metrics class ----------

const m = new Metrics();

// Record some timings
m.record(12.5, true);
m.record(8.3, true);
m.record(45.1, true);
m.record(3.2, false);  // error

const snap = m.snapshot();
console.log("Metrics snapshot:");
console.log("  count:", snap.count);
console.log("  errors:", snap.errors);
console.log("  avg:", snap.avg?.toFixed(2), "ms");
console.log("  min:", snap.min?.toFixed(2), "ms");
console.log("  max:", snap.max?.toFixed(2), "ms");
console.log("  errorRate:", (snap.errorRate * 100).toFixed(1) + "%");
console.log("  throughput:", snap.throughput?.toFixed(2), "ops/s");

m.reset();
console.log("  After reset, count:", m.snapshot().count);


// ---------- 2. Thread with onTiming callback ----------

const worker = createThread(
  (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.sin(i);
    return sum;
  },
  {
    onTiming: (ms) => console.log(`  [thread timing] ${ms.toFixed(1)}ms`),
  },
);

for (let i = 0; i < 3; i++) {
  const result = await worker.run(100_000 + i * 50_000);
  console.log(`  task ${i + 1} result:`, result.toFixed(4));
}

console.log("Thread metrics:", {
  count: worker.metrics.count,
  avg: worker.metrics.avg?.toFixed(2),
  throughput: worker.metrics.throughput?.toFixed(2),
});

await worker.terminate();


// ---------- 3. Pool metrics ----------

const pool = createPool(3, (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.cos(i);
  return sum;
});

// Fire 6 tasks
const tasks = [];
for (let i = 0; i < 6; i++) {
  tasks.push(pool.run(50_000 + i * 25_000));
}
await Promise.all(tasks.map((t) => t.promise));

const poolMetrics = pool.metrics;
const poolStatus = pool.status();

console.log("\nPool metrics:");
console.log("  count:", poolMetrics.count);
console.log("  avg:", poolMetrics.avg?.toFixed(2), "ms");
console.log("  throughput:", poolMetrics.throughput?.toFixed(2), "ops/s");
console.log("  errorRate:", (poolMetrics.errorRate * 100).toFixed(1) + "%");
console.log("Pool status:", poolStatus);

await pool.terminateGracefully();

console.log("\n✓ All metrics examples passed");
