/**
 * 11 – Dynamic Pool Scaling & Graceful Shutdown
 *
 * Demonstrates runtime pool resizing with scaleTo(), waiting for
 * completion with drain(), and clean shutdown with
 * terminateGracefully().
 *
 * Run:  bun run examples/11-dynamic-pool.js
 */

import { createPool } from "../src/index.js";

// ---------- 1. Scale up and down ----------

const pool = createPool(2, (n) => {
  // Simulate work
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sin(i);
  return sum;
});

console.log("Dynamic scaling demo:\n");

let status = pool.status();
console.log(`  initial: ${status.total} threads, ${status.idle} idle`);

// Scale up to 4 threads
pool.scaleTo(4);
status = pool.status();
console.log(`  after scaleTo(4): ${status.total} threads, ${status.idle} idle`);

// Fire 8 tasks to utilise all threads
const tasks = [];
for (let i = 0; i < 8; i++) {
  tasks.push(pool.run(50_000 + i * 10_000));
}

// Check status while tasks are running
setTimeout(() => {
  const s = pool.status();
  console.log(`  during work: ${s.busy} busy, ${s.idle} idle, ${s.queued} queued`);
}, 50);

await Promise.all(tasks.map((t) => t.promise));

// Scale back down
pool.scaleTo(2);
status = pool.status();
console.log(`  after scaleTo(2): ${status.total} threads`);

await pool.terminateGracefully();


// ---------- 2. Drain — wait without terminating ----------

const drainPool = createPool(3, (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.cos(i);
  return sum;
});

console.log("\nDrain demo:\n");

// Submit tasks
for (let i = 0; i < 6; i++) {
  drainPool.run(20_000 + i * 5_000);
}

console.log("  submitted 6 tasks, waiting for drain...");
const before = Date.now();
await drainPool.drain();
const elapsed = Date.now() - before;
console.log(`  drain complete in ${elapsed}ms`);

// Pool is still alive after drain — can submit more
const extra = await drainPool.run(100).promise;
console.log("  extra task after drain:", extra);

await drainPool.terminateGracefully();


// ---------- 3. Warmup — pre-compile all workers ----------

const warmPool = createPool(4, (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sin(i);
  return sum;
});

console.log("\nPool warmup:\n");

console.log("  warming up 4 workers...");
const warmStart = Date.now();
await warmPool.warmup();
console.log(`  warmup done in ${Date.now() - warmStart}ms`);

// First real tasks should be fast
const warmTasks = [];
for (let i = 0; i < 4; i++) {
  warmTasks.push(warmPool.run(100_000));
}
const warmResults = await Promise.all(warmTasks.map((t) => t.promise));
console.log("  first batch results:", warmResults.map((r) => r.toFixed(2)).join(", "));

await warmPool.terminateGracefully();


// ---------- 4. Graceful shutdown — finish then clean up ----------

const shutdown = createPool(2, (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.sin(i);
  return sum;
});

console.log("\nGraceful shutdown:\n");

// Submit a burst of tasks
for (let i = 0; i < 10; i++) {
  shutdown.run(10_000 + i * 5_000);
}

console.log("  submitted 10 tasks, shutting down gracefully...");
const shutdownStart = Date.now();
await shutdown.terminateGracefully();
const shutdownTime = Date.now() - shutdownStart;

const m = shutdown.metrics;
console.log(`  shutdown complete in ${shutdownTime}ms`);
console.log(`  completed: ${m.count} tasks, avg ${m.avg?.toFixed(1)}ms`);

// Verify pool is dead
const postStatus = shutdown.status();
console.log(`  pool alive? ${postStatus.total} threads remaining`);

console.log("\n✓ All dynamic pool examples passed");
