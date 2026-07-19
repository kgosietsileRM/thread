/**
 * @file Multi-pass GPU operations — reductions, matmul, histogram, argmax/min, scan.
 *
 * These are standalone functions that receive a {@link GPUCompute} instance
 * as their first argument, keeping the main class focused on single-pass compute.
 *
 * @module gpu/special
 */

import { GPUComputeError } from '../error.js';

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a special multi-pass operation.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 * @param {string} name - Operation name.
 * @param {Object} specialDef - Special op definition from SPECIAL_OPS.
 * @param {Object} input - User input.
 * @returns {Promise<Object<string, TypedArray>>}
 */
export async function runSpecial(gpu, name, specialDef, input) {
  const { signal } = input;

  if (signal?.aborted) {
    throw new GPUComputeError('Operation cancelled', signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  if (specialDef.special === 'matmul') {
    return runMatmul(gpu, input);
  }

  if (specialDef.special === 'histogram') {
    return runHistogram(gpu, input);
  }

  if (specialDef.special === 'argmax') {
    return runArgMaxMin(gpu, 'argmax', input);
  }

  if (specialDef.special === 'argmin') {
    return runArgMaxMin(gpu, 'argmin', input);
  }

  if (specialDef.special === 'scan') {
    return runScan(gpu, input);
  }

  // Reduction ops (reduce_sum, reduce_min, reduce_max)
  if (specialDef.special?.startsWith('reduce_')) {
    return runReduce(gpu, specialDef.special, input);
  }

  throw new GPUComputeError(`Unknown special op: "${name}"`);
}

// ---------------------------------------------------------------------------
// Matrix multiply
// ---------------------------------------------------------------------------

/**
 * Execute a matrix multiply.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 * @param {Object} input - { inputs: { A, B }, uniforms: { M, N, K } }
 * @returns {Promise<Object<string, TypedArray>>}
 */
export async function runMatmul(gpu, input) {
  const { A, B } = input.inputs || {};
  const { M, N, K } = input.uniforms || {};

  if (!A || !B) throw new GPUComputeError('matmul requires inputs A and B');
  if (!M || !N || !K) throw new GPUComputeError('matmul requires uniforms M, N, K');

  const mVal = M[0], nVal = N[0], kVal = K[0];

  // Build WGSL for this specific M, N, K
  const wgsl = buildMatmulShader(mVal, nVal, kVal);
  const pipelineName = `_matmul_${mVal}x${nVal}x${kVal}`;

  if (!gpu._pipelines.has(pipelineName)) {
    gpu._pipelines.set(pipelineName, { shader: wgsl, pipeline: null, entryPoint: 'main' });
    if (gpu._isInitialised && gpu._device) {
      const entry = gpu._pipelines.get(pipelineName);
      entry.pipeline = await gpu._compileShader(wgsl, 'main', pipelineName);
    }
  }

  gpu.setActive(pipelineName);

  const result = await gpu.compute({
    inputs: { A, B },
    uniforms: new Float32Array([mVal, nVal, kVal]),
    outputBuffers: { C: mVal * nVal },
    workgroups: [Math.ceil(nVal / 16), Math.ceil(mVal / 16), 1],
  });

  return { result: result.C };
}

/**
 * Build a WGSL shader for matrix multiply with specific dimensions.
 *
 * @param {number} M - Rows of A / C.
 * @param {number} N - Columns of B / C.
 * @param {number} K - Columns of A / Rows of B.
 * @returns {string} WGSL source.
 */
export function buildMatmulShader(M, N, K) {
  return `
    @group(0) @binding(0) var<storage, read>       A: array<f32>;
    @group(0) @binding(1) var<storage, read>       B: array<f32>;
    @group(0) @binding(2) var<uniform>             dims: vec3<f32>;
    @group(0) @binding(3) var<storage, read_write> C: array<f32>;

    @compute @workgroup_size(16, 16)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let row = id.y;
      let col = id.x;
      let m = u32(dims.x);
      let n = u32(dims.y);
      let k = u32(dims.z);

      if (row >= m || col >= n) { return; }

      var sum: f32 = 0.0;
      for (var i = 0u; i < k; i++) {
        sum += A[row * k + i] * B[i * n + col];
      }
      C[row * n + col] = sum;
    }
  `;
}

// ---------------------------------------------------------------------------
// Reduction (sum, min, max)
// ---------------------------------------------------------------------------

/**
 * Execute a reduction operation (sum, min, max).
 *
 * Two-pass approach:
 * 1. GPU reduces each workgroup into a partial result.
 * 2. CPU combines the partial results.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 * @param {string} opName - 'reduce_sum', 'reduce_min', or 'reduce_max'.
 * @param {Object} input - { inputs: { data } }
 * @returns {Promise<Object<string, TypedArray>>}
 */
export async function runReduce(gpu, opName, input) {
  const { signal } = input;
  const data = input.inputs?.data;
  if (!data) throw new GPUComputeError(`reduce requires inputs.data`);

  if (signal?.aborted) {
    throw new GPUComputeError('Operation cancelled', signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  const count = data.byteLength / (data.BYTES_PER_ELEMENT || 4);
  if (count === 0) {
    const identity = opName === 'reduce_min' ? Infinity : opName === 'reduce_max' ? -Infinity : 0;
    return { result: new Float32Array([identity]) };
  }

  const workgroupSize = 256;
  const numWorkgroups = Math.ceil(count / workgroupSize);

  // Build the reduction shader
  const reduceBody = getReduceBody(opName);
  const wgsl = `
    @group(0) @binding(0) var<storage, read>       data: array<f32>;
    @group(0) @binding(1) var<uniform>             count: vec4<u32>;
    @group(0) @binding(2) var<storage, read_write> partial: array<f32>;

    var<workgroup> shared_data: array<f32, 256>;

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) wg_id: vec3<u32>) {
      let tid = local_id.x;
      let i = id.x;
      let n = count.x;

      if (i < n) {
        shared_data[tid] = data[i];
      } else {
        shared_data[tid] = ${reduceBody.identity};
      }
      workgroupBarrier();

      for (var stride = 128u; stride > 0u; stride >>= 1u) {
        if (tid < stride) {
          shared_data[tid] = ${reduceBody.op};
        }
        workgroupBarrier();
      }

      if (tid == 0u) {
        partial[wg_id.x] = shared_data[0];
      }
    }
  `;

  const pipelineName = `_reduce_${opName}`;
  if (!gpu._pipelines.has(pipelineName)) {
    gpu._pipelines.set(pipelineName, { shader: wgsl, pipeline: null, entryPoint: 'main' });
    if (gpu._isInitialised && gpu._device) {
      const entry = gpu._pipelines.get(pipelineName);
      entry.pipeline = await gpu._compileShader(wgsl, 'main', pipelineName);
    }
  }

  gpu.setActive(pipelineName);

  // Pass 1: GPU reduction
  const partial = await gpu.compute({
    inputs: { data },
    uniforms: new Uint32Array([count, 0, 0, 0]),
    outputBuffers: { partial: numWorkgroups },
    workgroups: [numWorkgroups, 1, 1],
  });

  // Pass 2: CPU combine
  const partials = partial.partial;
  let result;
  switch (opName) {
    case 'reduce_sum':
      result = 0;
      for (let i = 0; i < partials.length; i++) result += partials[i];
      break;
    case 'reduce_min':
      result = Infinity;
      for (let i = 0; i < partials.length; i++) result = Math.min(result, partials[i]);
      break;
    case 'reduce_max':
      result = -Infinity;
      for (let i = 0; i < partials.length; i++) result = Math.max(result, partials[i]);
      break;
  }

  return { result: new Float32Array([result]) };
}

/**
 * Get the reduction operation body for a given op name.
 *
 * @param {string} opName
 * @returns {{ op: string, identity: string }}
 */
export function getReduceBody(opName) {
  switch (opName) {
    case 'reduce_sum':
      return { op: 'shared_data[tid] + shared_data[tid + stride]', identity: '0.0' };
    case 'reduce_min':
      return { op: 'min(shared_data[tid], shared_data[tid + stride])', identity: '3.4028235e+38' };
    case 'reduce_max':
      return { op: 'max(shared_data[tid], shared_data[tid + stride])', identity: '-3.4028235e+38' };
    default:
      throw new GPUComputeError(`Unknown reduce op: "${opName}"`);
  }
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

/**
 * Execute a histogram operation.
 *
 * Maps float data into bins and counts occurrences.
 * The data range [0, 1000] is mapped to [0, numBins).
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 * @param {Object} input - { inputs: { data }, uniforms?: { numBins } }
 * @returns {Promise<{ bins: Uint32Array, count: number }>}
 */
export async function runHistogram(gpu, input) {
  const { signal } = input;
  const data = input.inputs?.data;
  if (!data) throw new GPUComputeError('histogram requires inputs.data');

  if (signal?.aborted) {
    throw new GPUComputeError('Operation cancelled', signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  const count = data.byteLength / (data.BYTES_PER_ELEMENT || 4);
  const numBins = input.uniforms?.numBins?.[0] || 256;

  if (count === 0) {
    return { bins: new Uint32Array(numBins), count: 0 };
  }

  const workgroupSize = 256;
  const numWorkgroups = Math.ceil(count / workgroupSize);

  const wgsl = `
    @group(0) @binding(0) var<storage, read>       data: array<f32>;
    @group(0) @binding(1) var<uniform>             params: vec4<u32>;
    @group(0) @binding(2) var<storage, read_write> bins: array<u32>;

    var<workgroup> local_bins: array<u32, 256>;

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) wg_id: vec3<u32>) {
      let tid = local_id.x;
      let i = id.x;
      let n = params.x;
      let nb = params.y;

      if (tid < 256u) { local_bins[tid] = 0u; }
      workgroupBarrier();

      if (i < n && nb > 0u) {
        let bin = clamp(u32(f32(data[i]) / 1000.0 * f32(nb)), 0u, nb - 1u);
        atomicAdd(&local_bins[bin], 1u);
      }
      workgroupBarrier();

      if (tid < nb && tid < 256u) {
        atomicAdd(&bins[tid], local_bins[tid]);
      }
    }
  `;

  const pipelineName = '_histogram';
  if (!gpu._pipelines.has(pipelineName)) {
    gpu._pipelines.set(pipelineName, { shader: wgsl, pipeline: null, entryPoint: 'main' });
    if (gpu._isInitialised && gpu._device) {
      const entry = gpu._pipelines.get(pipelineName);
      entry.pipeline = await gpu._compileShader(wgsl, 'main', pipelineName);
    }
  }

  gpu.setActive(pipelineName);

  const result = await gpu.compute({
    inputs: { data },
    uniforms: new Uint32Array([count, numBins, 0, 0]),
    outputBuffers: { bins: numBins },
    workgroups: [numWorkgroups, 1, 1],
  });

  return { bins: new Uint32Array(result.bins), count };
}

// ---------------------------------------------------------------------------
// ArgMax / ArgMin
// ---------------------------------------------------------------------------

/**
 * Execute an argmax or argmin operation.
 *
 * Two-pass: GPU finds per-workgroup extreme + index, CPU combines.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 * @param {string} opName - 'argmax' or 'argmin'.
 * @param {Object} input - { inputs: { data } }
 * @returns {Promise<{ value: number, index: number }>}
 */
export async function runArgMaxMin(gpu, opName, input) {
  const { signal } = input;
  const data = input.inputs?.data;
  if (!data) throw new GPUComputeError(`${opName} requires inputs.data`);

  if (signal?.aborted) {
    throw new GPUComputeError('Operation cancelled', signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  const count = data.byteLength / (data.BYTES_PER_ELEMENT || 4);
  if (count === 0) {
    return { value: opName === 'argmax' ? -Infinity : Infinity, index: -1 };
  }

  const workgroupSize = 256;
  const numWorkgroups = Math.ceil(count / workgroupSize);
  const isMax = opName === 'argmax';

  const wgsl = `
    @group(0) @binding(0) var<storage, read>       data: array<f32>;
    @group(0) @binding(1) var<uniform>             count: vec4<u32>;
    @group(0) @binding(2) var<storage, read_write> partial_val: array<f32>;
    @group(0) @binding(3) var<storage, read_write> partial_idx: array<u32>;

    var<workgroup> shared_val: array<f32, 256>;
    var<workgroup> shared_idx: array<u32, 256>;

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) wg_id: vec3<u32>) {
      let tid = local_id.x;
      let i = id.x;
      let n = count.x;

      if (i < n) {
        shared_val[tid] = data[i];
        shared_idx[tid] = u32(i);
      } else {
        shared_val[tid] = ${isMax ? '-3.4028235e+38' : '3.4028235e+38'};
        shared_idx[tid] = 0u;
      }
      workgroupBarrier();

      for (var stride = 128u; stride > 0u; stride >>= 1u) {
        if (tid < stride) {
          let shouldSwap = ${isMax
            ? 'shared_val[tid + stride] > shared_val[tid]'
            : 'shared_val[tid + stride] < shared_val[tid]'};
          if (shouldSwap) {
            shared_val[tid] = shared_val[tid + stride];
            shared_idx[tid] = shared_idx[tid + stride];
          }
        }
        workgroupBarrier();
      }

      if (tid == 0u) {
        partial_val[wg_id.x] = shared_val[0];
        partial_idx[wg_id.x] = shared_idx[0];
      }
    }
  `;

  const pipelineName = `_${opName}`;
  if (!gpu._pipelines.has(pipelineName)) {
    gpu._pipelines.set(pipelineName, { shader: wgsl, pipeline: null, entryPoint: 'main' });
    if (gpu._isInitialised && gpu._device) {
      const entry = gpu._pipelines.get(pipelineName);
      entry.pipeline = await gpu._compileShader(wgsl, 'main', pipelineName);
    }
  }

  gpu.setActive(pipelineName);

  const result = await gpu.compute({
    inputs: { data },
    uniforms: new Uint32Array([count, 0, 0, 0]),
    outputBuffers: { partial_val: numWorkgroups, partial_idx: numWorkgroups },
    workgroups: [numWorkgroups, 1, 1],
  });

  // CPU combine
  const vals = result.partial_val;
  const idxs = result.partial_idx;
  let bestVal = isMax ? -Infinity : Infinity;
  let bestIdx = 0;
  for (let i = 0; i < vals.length; i++) {
    if (isMax ? vals[i] > bestVal : vals[i] < bestVal) {
      bestVal = vals[i];
      bestIdx = idxs[i];
    }
  }

  return { value: bestVal, index: bestIdx };
}

// ---------------------------------------------------------------------------
// Scan (parallel prefix sum)
// ---------------------------------------------------------------------------

/**
 * Execute a prefix sum (scan) operation.
 *
 * Computes inclusive prefix sum. Currently CPU-only for arbitrary sizes.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 * @param {Object} input - { inputs: { data } }
 * @returns {Promise<{ result: Float32Array }>}
 */
export async function runScan(gpu, input) {
  const { signal } = input;
  const data = input.inputs?.data;
  if (!data) throw new GPUComputeError('scan requires inputs.data');

  if (signal?.aborted) {
    throw new GPUComputeError('Operation cancelled', signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  const count = data.byteLength / (data.BYTES_PER_ELEMENT || 4);
  if (count === 0) {
    return { result: new Float32Array(0) };
  }

  // For simplicity, do the scan on CPU (GPU scan is very complex for arbitrary sizes)
  const result = new Float32Array(count);
  result[0] = data[0];
  for (let i = 1; i < count; i++) {
    result[i] = result[i - 1] + data[i];
  }

  return { result };
}
