/**
 * 18 – GPU/CPU Fallback Workflow
 *
 * Graceful degradation: detect GPU availability, build operations that
 * work on both GPU and CPU, use createGPUWithFallback for explicit
 * fallback functions, and compare GPU vs CPU paths.
 *
 * Run:  bun run examples/18-gpu-fallback-workflow.js
 */

if (typeof globalThis.Bun !== "undefined") {
  try { (await import("bun-webgpu")).setupGlobals?.(); } catch {}
}

const {
  createGPUCompute,
  createGPUWithFallback,
  gpuEnv,
  isGPUAvailable,
  outputSpec,
  uniform,
} = await import("../src/index.js");


// ====================================================================
// 1. Environment detection
// ====================================================================

console.log("=== GPU Environment ===\n");

const available = await isGPUAvailable();
console.log("  isGPUAvailable():", available);
console.log("  gpuEnv.sync:", gpuEnv.sync);
console.log("  gpuEnv:", JSON.stringify(gpuEnv, null, 2));


// ====================================================================
// 2. createGPUWithFallback — explicit CPU function
// ====================================================================

console.log("\n=== createGPUWithFallback ===\n");

// The CPU fallback receives the same input object as the GPU path.
// Input keys must match what define() expects: first param name = "data".
function cpuMultiply(input) {
  const data = input.inputs.data;
  const factor = input.uniforms?.b?.[0] ?? 1;
  const result = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i] * factor;
  return { result };
}

const gpu2 = createGPUWithFallback(
  `/* WGSL would go here — ignored when GPU unavailable */`,
  cpuMultiply,
);

// "multiply" fn: (data, { b }) => data.value * b
// First param is "data", so the CPU fallback looks up inputs.data
gpu2.define("multiply", (data, { b }) => data.value * b);

const data = new Float32Array([1, 2, 3, 4, 5]);
const result = await gpu2.run("multiply", {
  inputs: { data },
  uniforms: { b: new Float32Array([7]) },
  outputs: { result: 5 },
});

console.log("multiply([1..5], 7):", [...result.result]);
// Expected: [7, 14, 21, 28, 35]


// ====================================================================
// 3. computeWithFallback — runtime fallback
// ====================================================================

console.log("\n=== computeWithFallback ===\n");

const gpu3 = createGPUCompute();

function cpuDouble(input) {
  const data = input.inputs.data;
  const result = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i] * 2;
  return { result };
}

gpu3._cpuFallback = cpuDouble;
gpu3.define("doubleFallback", (data) => data.value * 2);

const fbResult = await gpu3.run("doubleFallback", {
  inputs: { data: new Float32Array([10, 20, 30]) },
  outputs: { result: 3 },
});
console.log("doubleFallback([10,20,30]):", [...fbResult.result]);


// ====================================================================
// 4. Output spec & uniform helpers
// ====================================================================

console.log("\n=== outputSpec() & uniform() helpers ===\n");

const spec = outputSpec("result", 5);
console.log("outputSpec:", JSON.stringify(spec));

const u = uniform("scale", new Float32Array([3.14]));
console.log("uniform:", JSON.stringify({ scale: [...u.uniforms.scale] }));

// Using helpers with run()
gpu3.define("scale", (data, { factor }) => data.value * factor);

const helperResult = await gpu3.run("scale", {
  inputs: { data: new Float32Array([1, 10, 100]) },
  ...uniform("factor", new Float32Array([0.01])),
  ...outputSpec("result", 3),
});
console.log("scale([1,10,100], 0.01):", [...helperResult.result]);


// ====================================================================
// 5. Adaptive pipeline — pick GPU or CPU strategy
// ====================================================================

console.log("\n=== Adaptive pipeline ===\n");

async function adaptiveProcess(inputData, gpuInstance) {
  if (gpuInstance.available) {
    // GPU path: define and run GPU ops
    gpuInstance.define("processGPU", (data) => Math.sqrt(Math.abs(data.value)) * 10);
    return gpuInstance.run("processGPU", {
      inputs: { data: inputData },
      outputs: { result: inputData.length },
    });
  } else {
    // CPU path: pure JS
    const result = new Float32Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      result[i] = Math.sqrt(Math.abs(inputData[i])) * 10;
    }
    return { result };
  }
}

const adaptiveInput = new Float32Array([1, 4, 9, 16, 25]);
const adaptiveResult = await adaptiveProcess(adaptiveInput, gpu2);

console.log("adaptive sqrt*10:", [...adaptiveResult.result].map(v => v.toFixed(1)));
console.log("mode:", gpu2.available ? "GPU" : "CPU fallback");


// ====================================================================
// 6. Destroy and verify cleanup
// ====================================================================

console.log("\n=== Cleanup ===\n");

gpu2.destroy();
gpu3.destroy();

console.log("gpu2 status:", gpu2.status);
console.log("gpu3 status:", gpu3.status);
console.log("gpu2 available:", gpu2.available);

console.log("\n✓ All GPU/CPU fallback workflow examples passed");
