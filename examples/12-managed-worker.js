/**
 * 12 – Managed Threads & Reusable Definitions
 *
 * Demonstrates createManagedThread (auto-logging, health checks,
 * metrics) and createWorkerDef (reusable definitions shared across
 * multiple pools).
 *
 * Run:  bun run examples/12-managed-worker.js
 */

import {
  createManagedThread,
  createWorkerDef,
  createPool,
  createThread,
  ThreadError,
  ThreadTimeoutError,
} from "../src/index.js";

// ---------- 1. Managed thread — auto-logging and health checks ----------

const managed = createManagedThread(
  (data) => data.map((x) => x * 2),
  {
    timeout: 5000,
    healthChecks: true,
    healthCheckInterval: 2000,
    onMetrics: (snap) => {
      if (snap.count > 0 && snap.count % 2 === 0) {
        console.log(`  [managed metrics] tasks=${snap.count} avg=${snap.avg?.toFixed(1)}ms`);
      }
    },
    onLog: (msg) => console.log(`  [managed log] ${msg}`),
  },
);

console.log("Managed thread with auto-logging:\n");

await managed.run([1, 2, 3]);
await managed.run([4, 5, 6]);

console.log("  managed metrics:", {
  count: managed.metrics.count,
  avg: managed.metrics.avg?.toFixed(1),
});

await managed.terminateGracefully();


// ---------- 2. Reusable definition — same logic, different pools ----------

const imageProcessor = createWorkerDef({
  setup() {
    return { processed: 0 };
  },
  exec(state, imageData) {
    state.processed++;
    // Simulate image processing
    return imageData.map((pixel) => ({
      r: pixel.r * 0.8,
      g: pixel.g * 1.2,
      b: pixel.b * 0.9,
    }));
  },
});

console.log("\nReusable definition across two pools:\n");

// Pool A — thumbnail generation
const thumbnailPool = createPool(2, imageProcessor);
// Pool B — full-size processing
const fullsizePool = createPool(2, imageProcessor);

const pixels = Array.from({ length: 5 }, (_, i) => ({
  r: 100 + i * 20,
  g: 150 + i * 10,
  b: 200 - i * 15,
}));

const thumbResult = await thumbnailPool.run(pixels).promise;
console.log("  thumbnail pool result:", thumbResult.length, "pixels processed");

const fullResult = await fullsizePool.run(pixels).promise;
console.log("  fullsize pool result:", fullResult.length, "pixels processed");

await thumbnailPool.terminateGracefully();
await fullsizePool.terminateGracefully();


// ---------- 3. Error hierarchy — catch specific error types ----------

const risky = createThread(
  (input) => {
    if (input === "timeout") {
      // Simulate a very slow task
      const start = Date.now();
      while (Date.now() - start < 10_000) { /* block */ }
      return "should not reach here";
    }
    if (input === "error") {
      throw new Error("deliberate worker error");
    }
    return `processed: ${input}`;
  },
  { timeout: 500 },
);

console.log("\nError hierarchy demo:\n");

// Case 1: Normal success
const success = await risky.run("hello");
console.log("  success:", success);

// Case 2: Worker error
try {
  await risky.run("error");
} catch (err) {
  if (err instanceof ThreadError) {
    console.log("  worker error:", err.name, "-", err.message);
  }
}

// Case 3: Timeout
try {
  await risky.run("timeout");
} catch (err) {
  if (err instanceof ThreadTimeoutError) {
    console.log("  timeout:", err.name, "-", err.message.slice(0, 50));
  }
}

await risky.terminate();


// ---------- 4. Stateful worker ----------

const counter = createThread({
  setup() {
    return { count: 0 };
  },
  exec(state, delta) {
    state.count += delta;
    return state.count;
  },
});

console.log("\nStateful worker with setup/exec:\n");

const r1 = await counter.run(100);
console.log("  0 + 100 =", r1);

const r2 = await counter.run(5);
console.log("  100 + 5 =", r2);

const r3 = await counter.run(10);
console.log("  105 + 10 =", r3);

await counter.terminateGracefully();


// ---------- 5. Concurrency — single thread, multiple in-flight ----------

const concurrent = createThread(
  (ms) => {
    // Simulate async work (setTimeout unavailable in worker eval context)
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
    return `waited ${ms}ms`;
  },
  {
    concurrency: 3,
    onTiming: (ms) => console.log(`  [timing] ${ms.toFixed(0)}ms`),
  },
);

console.log("\nConcurrency=3 — 3 tasks in parallel on one thread:\n");

const start = Date.now();
const [c1, c2, c3] = await Promise.all([
  concurrent.run(50),
  concurrent.run(50),
  concurrent.run(50),
]);
const elapsed = Date.now() - start;

console.log("  results:", c1, c2, c3);
console.log(`  total: ${elapsed}ms (parallel if < 150ms)`);

await concurrent.terminate();

console.log("\n✓ All managed worker examples passed");
