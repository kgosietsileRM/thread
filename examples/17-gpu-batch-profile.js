/**
 * 17 – Batch Processing, Profiling & runMany
 *
 * Run the same operation on many input sets with runBatch(), profile
 * a multi-step pipeline with profile(), and run multiple different
 * operations with runMany().  All use ops with CPU fallback.
 *
 * Run:  bun run examples/17-gpu-batch-profile.js
 */

if (typeof globalThis.Bun !== "undefined") {
  try { (await import("bun-webgpu")).setupGlobals?.(); } catch {}
}

const { createGPUCompute } = await import("../src/index.js");

const gpu = createGPUCompute();

// Register ops
gpu.define("double", (data) => data.value * 2);
gpu.define("sqrt_val", (data) => Math.sqrt(Math.abs(data.value)));
gpu.define("clamp01", (data) => (data.value < 0 ? 0 : data.value > 1 ? 1 : data.value));
gpu.define("ema", (data, { alpha }) => data.value * alpha);


// ====================================================================
// 1. runBatch — same op, many inputs
// ====================================================================

console.log("=== runBatch ===\n");

const batches = [
  new Float32Array([1, 2, 3]),
  new Float32Array([10, 20, 30]),
  new Float32Array([100, 200, 300]),
];

const batchResults = await gpu.runBatch("double", batches);

for (let i = 0; i < batchResults.length; i++) {
  console.log(`  batch ${i}:`, [...batchResults[i].result]);
}
// Expected: [2,4,6], [20,40,60], [200,400,600]


// ====================================================================
// 2. runBatch with flat format and onProgress
// ====================================================================

console.log("\n=== runBatch with progress ===\n");

const moreBatches = [
  new Float32Array([1, 4, 9, 16]),
  new Float32Array([25, 36, 49, 64]),
  new Float32Array([81, 100, 121, 144]),
  new Float32Array([169, 196, 225, 256]),
];

const sqrtResults = await gpu.runBatch("sqrt_val", moreBatches, {
  onProgress: (done, total) => {
    console.log(`  progress: ${done}/${total}`);
  },
});

console.log("  sqrt batch 0:", [...sqrtResults[0].result].map(v => v.toFixed(1)));
console.log("  sqrt batch 3:", [...sqrtResults[3].result].map(v => v.toFixed(1)));


// ====================================================================
// 3. profile — timing breakdown
// ====================================================================

console.log("\n=== profile ===\n");

// profile() times each step individually.  Each step receives its own
// input, and the carried output from the previous step is merged in.
// We provide explicit inputs for clarity.

const profileInput = new Float32Array([0.1, 0.3, 0.5, 0.7, 0.9]);

const profileResult = await gpu.profile([
  {
    name: "ema",
    input: {
      inputs: { data: profileInput },
      uniforms: { alpha: new Float32Array([0.9]) },
      outputs: { result: 5 },
    },
  },
  {
    name: "sqrt_val",
    input: {
      inputs: { data: profileInput },
      outputs: { result: 5 },
    },
  },
  {
    name: "clamp01",
    input: {
      inputs: { data: profileInput },
      outputs: { result: 5 },
    },
  },
]);

console.log("  steps:");
for (const step of profileResult.steps) {
  console.log(`    ${step.name}: ${step.ms.toFixed(2)}ms`);
}
console.log(`  total: ${profileResult.totalMs.toFixed(2)}ms`);
console.log("  final result:", [...profileResult.results.result].map(v => v.toFixed(2)));


// ====================================================================
// 4. runMany — different ops in parallel
// ====================================================================

console.log("\n=== runMany ===\n");

const inputData = new Float32Array([4, 16, 36, 64, 100]);

const manyResults = await gpu.runMany([
  { name: "double", input: { inputs: { data: inputData }, outputs: { result: 5 } } },
  { name: "sqrt_val", input: { inputs: { data: inputData }, outputs: { result: 5 } } },
  {
    name: "ema",
    input: {
      inputs: { data: inputData },
      uniforms: { alpha: new Float32Array([0.25]) },
      outputs: { result: 5 },
    },
  },
]);

console.log("  double:", [...manyResults[0].result]);
console.log("  sqrt:  ", [...manyResults[1].result].map(v => v.toFixed(1)));
console.log("  ema:   ", [...manyResults[2].result].map(v => v.toFixed(1)));


// ====================================================================
// 5. runMany with object syntax
// ====================================================================

console.log("\n=== runMany (object form) ===\n");

const objResults = await gpu.runMany({
  double: { inputs: { data: inputData }, outputs: { result: 5 } },
  sqrt_val: { inputs: { data: inputData }, outputs: { result: 5 } },
});

console.log("  double:", [...objResults[0].result]);
console.log("  sqrt:  ", [...objResults[1].result].map(v => v.toFixed(1)));


// ====================================================================
// 6. Metrics after all operations
// ====================================================================

console.log("\n=== Final metrics ===\n");

const m = gpu.metrics;
console.log("  count:", m.count);
console.log("  avg:", m.avg, "ms");
console.log("  throughput:", m.throughput, "ops/s");

gpu.destroy();
console.log("\n✓ All batch/profile/runMany examples passed");
