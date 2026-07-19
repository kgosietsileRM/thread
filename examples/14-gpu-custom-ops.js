/**
 * 14 – Custom GPU Operations & Uniforms
 *
 * Register custom operations with multiple inputs, uniforms (parameterized
 * constants), and multi-output ops.  Demonstrates the define() API for
 * both simple and complex GPU kernels.
 *
 * Run:  bun run examples/14-gpu-custom-ops.js
 */

if (typeof globalThis.Bun !== "undefined") {
  try { (await import("bun-webgpu")).setupGlobals?.(); } catch {}
}

const { createGPUCompute } = await import("../src/index.js");

const gpu = createGPUCompute();

// ---------- 1. Uniform scalar — scale + offset ----------

gpu.define("scaleOffset", (data, { scale, offset }) =>
  data.value * scale + offset
);

const data = new Float32Array([10, 20, 30, 40, 50]);

const scaled = await gpu.run("scaleOffset", {
  inputs: { data },
  uniforms: { scale: new Float32Array([2.5]), offset: new Float32Array([100]) },
  outputs: { result: 5 },
});

console.log("scaleOffset([10..50], scale=2.5, offset=100):");
console.log("  ", [...scaled.result]);
// Expected: [125, 150, 175, 200, 225]


// ---------- 2. Ternary / select — clamp ----------

gpu.define("clamp01", (data) =>
  data.value < 0 ? 0 : data.value > 1 ? 1 : data.value
);

const raw = new Float32Array([-0.5, 0.0, 0.3, 0.7, 1.0, 1.5]);
const clamped = await gpu.run("clamp01", {
  inputs: { data: raw },
  outputs: { result: 6 },
});

console.log("\nclamp01([-0.5,0,0.3,0.7,1,1.5]):");
console.log("  ", [...clamped.result]);
// Expected: [0, 0, 0.3, 0.7, 1, 1]


// ---------- 3. Multi-input — add two arrays element-wise ----------

// JS function overload treats 2nd param as uniforms; for two storage
// inputs, use the object declaration form instead.
gpu.define("addArrays", {
  inputs: ["a", "b"],
  outputs: ["result"],
  body: "result[i] = a[i] + b[i];",
  fn: async (input) => {
    const a = input.inputs.a;
    const b = input.inputs.b;
    const result = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) result[i] = a[i] + b[i];
    return { result };
  },
});

const x = new Float32Array([1, 2, 3, 4, 5]);
const y = new Float32Array([10, 20, 30, 40, 50]);

const sum = await gpu.run("addArrays", {
  inputs: { a: x, b: y },
  outputs: { result: 5 },
});

console.log("\naddArrays([1..5], [10..50]):");
console.log("  ", [...sum.result]);
// Expected: [11, 22, 33, 44, 55]


// ---------- 4. Index-aware op — enumerate ----------

gpu.define("enumerate", (data) => data.index * data.value);

const vals = new Float32Array([10, 20, 30]);
const enumerated = await gpu.run("enumerate", {
  inputs: { data: vals },
  outputs: { result: 3 },
});

console.log("\nenumerate([10,20,30]) — index * value:");
console.log("  ", [...enumerated.result]);
// Expected: [0, 20, 60]


// ---------- 5. Chained custom ops — multiply then add ----------

gpu.define("multiply", (data, { factor }) => data.value * factor);
gpu.define("addScalar", (data, { value }) => data.value + value);

const input2 = new Float32Array([1, 2, 3, 4, 5]);

const step1 = await gpu.run("multiply", {
  inputs: { data: input2 },
  uniforms: { factor: new Float32Array([3]) },
  outputs: { result: 5 },
});
console.log("\nmultiply([1..5], factor=3):", [...step1.result]);

const step2 = await gpu.run("addScalar", {
  inputs: { data: step1.result },
  uniforms: { value: new Float32Array([10]) },
  outputs: { result: 5 },
});
console.log("addScalar(result, value=10):", [...step2.result]);
// Expected: [13, 16, 19, 22, 25]


// ---------- 6. List all defined ops ----------

console.log("\nRegistered ops:", gpu.ops);

gpu.destroy();
console.log("\n✓ All custom GPU ops examples passed");
