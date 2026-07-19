/**
 * 13 – GPU Compute Basics
 *
 * Core GPUCompute API: create an instance, register operations with
 * define(), run them, use map() for element-wise transforms, and
 * inspect the internal state.  All ops provide CPU fallback so this
 * example runs with or without a WebGPU adapter.
 *
 * Run:  bun run examples/13-gpu-compute-basics.js
 */

// Optional: eagerly set up bun-webgpu for sync GPU detection.
// The library auto-detects and calls setupGlobals() during async init.
if (typeof globalThis.Bun !== "undefined") {
  try { (await import("bun-webgpu")).setupGlobals?.(); } catch {}
}

const { createGPUCompute } = await import("../src/index.js");

const gpu = createGPUCompute();
console.log("GPU available:", gpu.available);
console.log("GPU status:   ", gpu.status);
console.log();

// ---------- 1. Define an op from a JS function ----------

gpu.define("double", (data) => data.value * 2);

const N = 8;
const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

const doubled = await gpu.run("double", {
  inputs: { data: input },
  outputs: { result: N },
});

console.log("double([1..8]):", [...doubled.result]);


// ---------- 2. Built-in op: sqrt ----------

gpu.define("abs_val", (data) => Math.abs(data.value));

const negatives = new Float32Array([-4, -1, 0, 3, -9, 16, -25, 36]);
const absResult = await gpu.run("abs_val", {
  inputs: { data: negatives },
  outputs: { result: 8 },
});

console.log("abs([-4,-1,0,3,-9,16,-25,36]):", [...absResult.result]);


// ---------- 3. map() — one-liner element-wise transform ----------

const mapped = await gpu.map(new Float32Array([1, 4, 9, 16, 25]), (x) => Math.sqrt(x));
console.log("map(sqrt, [1,4,9,16,25]):", [...mapped]);

const scaled = await gpu.map(new Float32Array([10, 20, 30]), (x) => x * 0.1 + 5);
console.log("map(x*0.1+5, [10,20,30]):", [...scaled]);


// ---------- 4. Inspect internal state ----------

const snapshot = gpu.inspect();
console.log("\ninspect():");
console.log("  status:", snapshot.status);
console.log("  available:", snapshot.available);
console.log("  ready:", snapshot.ready);
console.log("  ops:", snapshot.ops);
console.log("  dispatchCount:", snapshot.dispatchCount);
console.log("  workgroupSize:", snapshot.workgroupSize);
console.log("  maxBufferSize:", snapshot.maxBufferSize);

// ---------- 5. Metrics ----------

console.log("\nmetrics:", gpu.metrics);

// ---------- 6. Cleanup ----------

gpu.destroy();
console.log("\nAfter destroy — status:", gpu.status);

console.log("\n✓ All GPU compute basics examples passed");
