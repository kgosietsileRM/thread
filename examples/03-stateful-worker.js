/**
 * 03 – Stateful Worker
 *
 * A worker with setup / exec / lifecycle.  setup() runs once and its
 * return value is passed as the first argument to every exec() call.
 *
 * Run:  bun run examples/03-stateful-worker.js
 */

import { createThread } from "../src/index.js";

// ---------- 1. Counter with persistent state ----------

const counter = createThread({
  setup() {
    return { count: 0 };
  },
  exec(state, delta) {
    state.count += delta;
    return state.count;
  },
  cleanup(state) {
    console.log("  [cleanup] final count:", state.count);
  },
});

console.log("counter +1 =", await counter.run(1));   // 1
console.log("counter +5 =", await counter.run(5));   // 6
console.log("counter +3 =", await counter.run(3));   // 9

await counter.terminateGracefully();


// ---------- 2. Cache worker ----------

const cachedLookup = createThread({
  setup() {
    return { cache: new Map() };
  },
  exec(state, key) {
    if (state.cache.has(key)) {
      return { value: state.cache.get(key), hit: true };
    }
    // Simulate expensive computation
    const value = key.split("").reverse().join("");
    state.cache.set(key, value);
    return { value, hit: false };
  },
});

console.log("lookup 'hello':", await cachedLookup.run("hello"));  // miss
console.log("lookup 'hello':", await cachedLookup.run("hello"));  // hit
console.log("lookup 'world':", await cachedLookup.run("world"));  // miss

await cachedLookup.terminateGracefully();


// ---------- 3. Reusable definition ----------

import { createWorkerDef, createPool } from "../src/index.js";

const mathWorker = createWorkerDef({
  setup() {
    return { calls: 0 };
  },
  exec(state, op, a, b) {
    state.calls++;
    if (op === "add") return a + b;
    if (op === "mul") return a * b;
    if (op === "pow") return a ** b;
    return null;
  },
});

// Reuse the same definition in a pool
const pool = createPool(2, mathWorker);

console.log("add:", (await pool.run("add", 3, 4).promise));
console.log("mul:", (await pool.run("mul", 5, 6).promise));
console.log("pow:", (await pool.run("pow", 2, 10).promise));

await pool.terminateGracefully();

console.log("\n✓ All stateful worker examples passed");
