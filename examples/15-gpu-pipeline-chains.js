/**
 * 15 – GPU Pipeline Chains
 *
 * Fluent API for composing multi-step GPU pipelines with pipe().
 * Each step's output feeds the next step's input automatically.
 * Demonstrates PipelineChain, DataPipelineChain, and JS function shorthand.
 *
 * Run:  bun run examples/15-gpu-pipeline-chains.js
 */

if (typeof globalThis.Bun !== "undefined") {
  try { (await import("bun-webgpu")).setupGlobals?.(); } catch {}
}

const { createGPUCompute } = await import("../src/index.js");

const gpu = createGPUCompute();

// Register ops used in the chains
gpu.define("double", (data) => data.value * 2);
gpu.define("addOne", (data) => data.value + 1);
gpu.define("negate", (data) => -data.value);
gpu.define("clampPos", (data) => (data.value < 0 ? 0 : data.value));
gpu.define("ema", (data, { alpha }) => data.value * alpha);

const data = new Float32Array([1, 2, 3, 4, 5]);

// ---------- 1. Basic chain — named ops ----------

console.log("=== Named op chain ===\n");

const chain1 = gpu.pipe()
  .add("double", { inputs: { data } })
  .add("addOne");

const r1 = await chain1.result();
console.log("double → addOne:", [...r1.result]);
// Expected: [3, 5, 7, 9, 11]


// ---------- 2. JS function shorthand ----------

console.log("\n=== JS function chain ===\n");

const chain2 = gpu.pipe()
  .add((x) => x * 2)
  .add((x) => x + 10)
  .add((x) => Math.sqrt(x));

const r2 = await chain2.result({ inputs: { data: new Float32Array([4, 9, 16, 25, 36]) } });
console.log("x*2 → x+10 → sqrt:", [...r2.result].map(v => v.toFixed(2)));
// Expected: sqrt([14, 19, 24, 30, 38]) ≈ [3.74, 4.36, 4.90, 5.48, 6.16]


// ---------- 3. Data-first chain (DataPipelineChain) ----------

console.log("\n=== Data-first chain ===\n");

const chain3 = gpu.pipe(new Float32Array([1, 4, 9, 16, 25]), 5)
  .double()
  .addOne();

const r3 = await chain3.result();
console.log("pipe([1,4,9,16,25]).double().addOne():", [...r3.result]);
// Expected: [3, 9, 19, 33, 51]


// ---------- 4. Chain with uniforms ----------

console.log("\n=== Chain with uniforms ===\n");

const chain4 = gpu.pipe()
  .add("ema", { inputs: { data: new Float32Array([100]) }, uniforms: { alpha: new Float32Array([0.5]) } })
  .add("double")
  .add("addOne");

const r4 = await chain4.result();
console.log("ema(100,0.5) → double → addOne:", [...r4.result]);
// Expected: [101]


// ---------- 5. Long chain — full transform pipeline ----------

console.log("\n=== Long chain (5 steps) ===\n");

const chain5 = gpu.pipe(new Float32Array([-3, -1, 0, 2, 5]), 5)
  .clampPos()     // [0, 0, 0, 2, 5]
  .double()       // [0, 0, 0, 4, 10]
  .addOne()       // [1, 1, 1, 5, 11]
  .negate()       // [-1, -1, -1, -5, -11]
  .clampPos();    // [0, 0, 0, 0, 0]

const r5 = await chain5.result();
console.log("clamp → double → addOne → negate → clamp:", [...r5.result]);
// Expected: [0, 0, 0, 0, 0]


// ---------- 6. Chain length ----------

console.log("\nChain1 steps:", chain1.length);
console.log("Chain5 steps:", chain5.length);

gpu.destroy();
console.log("\n✓ All GPU pipeline chain examples passed");
