/**
 * 10 – Pool Pipeline: Priorities, Dependencies & Cancellation
 *
 * Demonstrates the pool's task scheduling features: priority ordering,
 * dependency chains, and cancelling queued tasks.
 *
 * Run:  bun run examples/10-pool-pipeline.js
 */

import {
  createPool,
  ThreadDependencyError,
  ThreadAbortError,
} from "../src/index.js";

// ---------- 1. Priority queue — high-priority tasks run first ----------

const pool = createPool(1, (task) => {
  console.log(`  executing: ${task.name}`);
  return `${task.name} done`;
});

console.log("Priority queue (single worker — order matters):\n");

// Submit tasks with different priorities (lower number = higher priority)
pool.run({ name: "low-priority-A" },   { priority: 10 });
pool.run({ name: "HIGH-priority-B" },  { priority: 0 });
pool.run({ name: "low-priority-C" },   { priority: 10 });
pool.run({ name: "MEDIUM-priority-D"}, { priority: 5 });

await pool.drain();
await pool.terminateGracefully();


// ---------- 2. Dependency chain — fetch → transform → store ----------

const pipeline = createPool(2, (step) => step);

console.log("\nDependency pipeline (A → B → C):\n");

const stepA = pipeline.run("fetch-data");
const stepB = pipeline.run("transform-data", { dependsOn: [stepA.id] });
const stepC = pipeline.run("store-data",     { dependsOn: [stepB.id] });

console.log("  A:", await stepA.promise);
console.log("  B:", await stepB.promise);
console.log("  C:", await stepC.promise);

await pipeline.terminateGracefully();


// ---------- 3. Fan-out / fan-in — parallel then merge ----------

const fan = createPool(4, (n) => {
  // Simulate variable-time computation
  let sum = 0;
  for (let i = 0; i < n * 10_000; i++) sum += Math.sin(i);
  return sum;
});

console.log("\nFan-out / fan-in (4 parallel tasks → merge):\n");

const t1 = fan.run(100);
const t2 = fan.run(200);
const t3 = fan.run(300);
const t4 = fan.run(400);

const results = await Promise.all([
  t1.promise, t2.promise, t3.promise, t4.promise,
]);

const merged = results.reduce((a, b) => a + b, 0);
console.log("  individual results:", results.map((r) => r.toFixed(2)).join(", "));
console.log("  merged sum:", merged.toFixed(2));

await fan.terminateGracefully();


// ---------- 4. Cancelling a queued task ----------

const single = createPool(1, (x) => {
  console.log("  running task:", x);
  return x;
});

console.log("\nCancellation:\n");

// First task occupies the only worker
const blocker = single.run("blocking-task");

// These tasks will queue
const toCancel1 = single.run("should-be-cancelled-1");
const toCancel2 = single.run("should-be-cancelled-2");

console.log("  cancelling task", toCancel1.id, "...");
const wasCancelled = single.cancel(toCancel1.id);
console.log("  cancelled?", wasCancelled);

try {
  await toCancel1.promise;
} catch (err) {
  console.log("  caught:", err.name, "-", err.message);
}

// Let the blocker finish
await blocker.promise;

// The second queued task should still run
const remaining = await toCancel2.promise;
console.log("  remaining task result:", remaining);

await single.terminateGracefully();


// ---------- 5. Dependency failure cascades ----------

const cascade = createPool(2, (step) => {
  if (step === "fail") throw new Error("step failed!");
  return step;
});

console.log("\nDependency failure cascade:\n");

const good = cascade.run("good-step");
const willFail = cascade.run("fail", { dependsOn: [good.id] });
const downstream = cascade.run("downstream", { dependsOn: [willFail.id] });

await good.promise;
console.log("  good:", await good.promise);

try {
  await willFail.promise;
} catch (err) {
  console.log("  willFail caught:", err.name);
}

try {
  await downstream.promise;
} catch (err) {
  console.log("  downstream caught:", err.name, "(cascade)");
}

await cascade.terminateGracefully();

console.log("\n✓ All pool pipeline examples passed");
