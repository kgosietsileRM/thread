/**
 * @file Built-in shader generators and the high-level DSL for GPU compute.
 *
 * Instead of writing raw WGSL, users describe their operation in simple
 * terms and the module generates the shader automatically.
 *
 * **Three levels of abstraction:**
 *
 * ### 1. Built-in ops (zero shader code)
 *
 * ```js
 * const gpu = new GPUCompute();
 *
 * // Element-wise multiply
 * await gpu.run('multiply', {
 *   inputs: { data: new Float32Array([1, 2, 3]) },
 *   uniforms: { factor: new Float32Array([2.0]) },
 *   outputs: { result: 3 },
 * });
 * ```
 *
 * ### 2. Custom ops from a loop body
 *
 * ```js
 * gpu.define('scaleClamp', {
 *   inputs: ['data'],
 *   outputs: ['result'],
 *   uniforms: ['factor', 'maxVal'],
 *   body: `result[i] = min(data[i] * factor, maxVal);`,
 * });
 *
 * await gpu.run('scaleClamp', {
 *   inputs:  { data: new Float32Array([1, 2, 3, 4, 5]) },
 *   uniforms: { factor: new Float32Array([2.0]), maxVal: new Float32Array([6.0]) },
 *   outputs: { result: 5 },
 * });
 * ```
 *
 * ### 3. Custom ops from a JS function (CPU fallback)
 *
 * ```js
 * gpu.define('myOp', {
 *   inputs: ['x'],
 *   outputs: ['y'],
 *   body: `y[i] = sqrt(abs(x[i])) * 2.0;`,
 *   fn: (x) => Math.sqrt(Math.abs(x)) * 2,  // used when GPU unavailable
 *   type: 'f32',
 * });
 * ```
 *
 * **Built-in ops:**
 *
 * | Op             | Inputs | Uniforms | Description                        |
 * |----------------|--------|----------|------------------------------------|
 * | `multiply`     | `a`    | `b`      | `result[i] = a[i] * b`            |
 * | `divide`       | `a`    | `b`      | `result[i] = a[i] / b`            |
 * | `add`          | `a`    | `b`      | `result[i] = a[i] + b`            |
 * | `subtract`     | `a`    | `b`      | `result[i] = a[i] - b`            |
 * | `power`        | `a`    | `b`      | `result[i] = pow(a[i], b)`        |
 * | `sqrt`         | `data` | —        | `result[i] = sqrt(data[i])`       |
 * | `abs`          | `data` | —        | `result[i] = abs(data[i])`        |
 * | `negate`       | `data` | —        | `result[i] = -data[i]`            |
 * | `sin`          | `data` | —        | `result[i] = sin(data[i])`        |
 * | `cos`          | `data` | —        | `result[i] = cos(data[i])`        |
 * | `tan`          | `data` | —        | `result[i] = tan(data[i])`        |
 * | `exp`          | `data` | —        | `result[i] = exp(data[i])`        |
 * | `log`          | `data` | —        | `result[i] = log(data[i])`        |
 * | `clamp`        | `data` | `min,max`| `result[i] = clamp(data[i],mn,mx)`|
 * | `lerp`         | `a`    | `b,t`   | `result[i] = mix(a[i], b, t)`    |
 * | `sign`         | `data` | —        | `result[i] = sign(data[i])`       |
 * | `floor`        | `data` | —        | `result[i] = floor(data[i])`      |
 * | `ceil`         | `data` | —        | `result[i] = ceil(data[i])`       |
 * | `round`        | `data` | —        | `result[i] = round(data[i])`      |
 * | `fract`        | `data` | —        | `result[i] = fract(data[i])`      |
 * | `normalize`    | `data` | —        | `result[i] = data[i] / max(abs(data[i]), 1e-7)` |
 * | `reciprocal`   | `data` | —        | `result[i] = 1.0 / data[i]`      |
 * | `square`       | `data` | —        | `result[i] = data[i] * data[i]`  |
 * | `copy`         | `data` | —        | `result[i] = data[i]`            |
 * | `fill`         | —      | `value` | `result[i] = value`               |
 * | `scaleOffset`  | `data` | `scale,offset`| `result[i] = data[i] * scale + offset` |
 * | `max`          | `a`    | `b`      | `result[i] = max(a[i], b)`        |
 * | `min`          | `a`    | `b`      | `result[i] = min(a[i], b)`        |
 * | `equal`        | `a`    | `b`      | `result[i] = f32(a[i] == b)`      |
 * | `notEqual`     | `a`    | `b`      | `result[i] = f32(a[i] != b)`      |
 * | `greaterThan`  | `a`    | `b`      | `result[i] = f32(a[i] > b)`       |
 * | `lessThan`     | `a`    | `b`      | `result[i] = f32(a[i] < b)`       |
 * | `select`       | `a`    | `b,cond` | `result[i] = select(a[i], b, cond[i])` |
 *
 * @module shaders
 */

// ---------------------------------------------------------------------------
// WGSL type helpers
// ---------------------------------------------------------------------------

const WGSL_TYPES = {
  f32:  { storage: 'f32',  uniform: 'f32',  array: 'array<f32>' },
  i32:  { storage: 'i32',  uniform: 'i32',  array: 'array<i32>' },
  u32:  { storage: 'u32',  uniform: 'u32',  array: 'array<u32>' },
  f64:  { storage: 'f32',  uniform: 'f32',  array: 'array<f32>' }, // WGSL has no f64
};

/**
 * Resolve a type name to its WGSL representation.
 *
 * @param {string} type
 * @returns {{ storage: string, uniform: string, array: string }}
 */
function wgslType(type) {
  return WGSL_TYPES[type] || WGSL_TYPES.f32;
}

// ---------------------------------------------------------------------------
// Shader builder
// ---------------------------------------------------------------------------

/**
 * Build a complete WGSL compute shader from a declaration.
 *
 * This is the core engine that turns simple descriptions into valid
 * WGSL.  You normally don't call this directly — use `gpu.define()`
 * or the built-in ops.
 *
 * @param {import('./types.js').ShaderDeclaration} decl
 * @returns {string} Complete WGSL shader source.
 *
 * @example
 * ```js
 * const wgsl = buildShader({
 *   inputs: ['data'],
 *   outputs: ['result'],
 *   uniforms: ['factor'],
 *   body: `result[i] = data[i] * factor;`,
 *   type: 'f32',
 *   workgroupSize: 256,
 * });
 * // → valid WGSL string
 * ```
 */
export function buildShader(decl) {
  const {
    inputs = [],
    outputs = [],
    uniforms = [],
    body,
    type = 'f32',
    workgroupSize = 256,
    name = 'main',
  } = decl;

  if (!body || typeof body !== 'string') {
    throw new TypeError('Shader declaration requires a body string');
  }

  const t = wgslType(type);
  const lines = [];

  // -- Bind group declarations --
  let binding = 0;
  const bindings = [];

  for (const inputName of inputs) {
    lines.push(`@group(0) @binding(${binding}) var<storage, read> ${inputName}: ${t.array};`);
    bindings.push({ name: inputName, kind: 'input' });
    binding++;
  }

  for (const uniformName of uniforms) {
    // Multi-element uniforms use storage, single-element use uniform
    lines.push(`@group(0) @binding(${binding}) var<uniform> ${uniformName}: ${t.uniform};`);
    bindings.push({ name: uniformName, kind: 'uniform' });
    binding++;
  }

  for (const outputName of outputs) {
    lines.push(`@group(0) @binding(${binding}) var<storage, read_write> ${outputName}: ${t.array};`);
    bindings.push({ name: outputName, kind: 'output' });
    binding++;
  }

  lines.push('');

  // -- Entry point --
  lines.push(`@compute @workgroup_size(${workgroupSize})`);
  lines.push(`fn ${name}(@builtin(global_invocation_id) id: vec3<u32>) {`);
  lines.push(`  let i = id.x;`);

  // Bounds check based on the first output or input
  const firstArray = outputs.length > 0 ? outputs[0] : inputs[0];
  if (firstArray) {
    lines.push(`  if (i >= arrayLength(&${firstArray})) { return; }`);
  }

  lines.push('');
  lines.push(`  ${body.split('\n').join('\n  ')}`);
  lines.push('}');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Built-in operation definitions
// ---------------------------------------------------------------------------

/**
 * Built-in operation registry.  Each entry defines the inputs, uniforms,
 * outputs, and WGSL body for a common GPU operation.
 *
 * @type {Object<string, import('./types.js').BuiltInOp>}
 */
export const BUILT_IN_OPS = {
  // ---- Arithmetic (binary: input + uniform scalar/vector) ----
  multiply: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = a[i] * b;',
  },
  divide: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = a[i] / b;',
  },
  add: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = a[i] + b;',
  },
  subtract: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = a[i] - b;',
  },
  power: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = pow(a[i], b);',
  },
  max: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = max(a[i], b);',
  },
  min: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = min(a[i], b);',
  },

  // ---- Unary (single input, no uniforms) ----
  sqrt: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = sqrt(data[i]);',
  },
  abs: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = abs(data[i]);',
  },
  negate: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = -data[i];',
  },
  sin: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = sin(data[i]);',
  },
  cos: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = cos(data[i]);',
  },
  tan: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = tan(data[i]);',
  },
  asin: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = asin(data[i]);',
  },
  acos: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = acos(data[i]);',
  },
  atan: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = atan(data[i]);',
  },
  exp: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = exp(data[i]);',
  },
  log: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = log(data[i]);',
  },
  sign: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = sign(data[i]);',
  },
  floor: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = floor(data[i]);',
  },
  ceil: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = ceil(data[i]);',
  },
  round: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = round(data[i]);',
  },
  fract: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = fract(data[i]);',
  },
  reciprocal: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = 1.0 / data[i];',
  },
  square: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = data[i] * data[i];',
  },
  copy: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = data[i];',
  },
  normalize: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = data[i] / max(abs(data[i]), 0.0000001);',
  },

  // ---- Fill (no inputs, uniform value) ----
  fill: {
    uniforms: ['value'], outputs: ['result'],
    body: 'result[i] = value;',
  },

  // ---- Scale + offset ----
  scaleOffset: {
    inputs: ['data'], uniforms: ['scale', 'offset'], outputs: ['result'],
    body: 'result[i] = data[i] * scale + offset;',
  },

  // ---- Clamp ----
  clamp: {
    inputs: ['data'], uniforms: ['minVal', 'maxVal'], outputs: ['result'],
    body: 'result[i] = clamp(data[i], minVal, maxVal);',
  },

  // ---- Lerp / mix ----
  lerp: {
    inputs: ['a'], uniforms: ['b', 't'], outputs: ['result'],
    body: 'result[i] = mix(a[i], b, t);',
  },

  // ---- Comparison (output i32 as 0.0/1.0) ----
  equal: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = select(0.0, 1.0, a[i] == b);',
  },
  notEqual: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = select(0.0, 1.0, a[i] != b);',
  },
  greaterThan: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = select(0.0, 1.0, a[i] > b);',
  },
  lessThan: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = select(0.0, 1.0, a[i] < b);',
  },
  greaterThanEqual: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = select(0.0, 1.0, a[i] >= b);',
  },
  lessThanEqual: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = select(0.0, 1.0, a[i] <= b);',
  },

  // ---- Select ----
  select: {
    inputs: ['a', 'b', 'cond'], outputs: ['result'],
    body: 'result[i] = select(a[i], b[i], cond[i] > 0.0);',
  },

  // ---- Clamp to range (two-input with two uniforms) ----
  clampRange: {
    inputs: ['data'], uniforms: ['low', 'high'], outputs: ['result'],
    body: 'result[i] = clamp(data[i], low, high);',
  },

  // ---- Extended math (binary) ----
  atan2: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = atan2(a[i], b);',
  },
  hypot: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = sqrt(a[i] * a[i] + b * b);',
  },
  mod: {
    inputs: ['a'], uniforms: ['b'], outputs: ['result'],
    body: 'result[i] = a[i] - b * floor(a[i] / b);',
  },
  diff: {
    inputs: ['a', 'b'], outputs: ['result'],
    body: 'result[i] = a[i] - b[i];',
  },
  sum: {
    inputs: ['a', 'b'], outputs: ['result'],
    body: 'result[i] = a[i] + b[i];',
  },
  product: {
    inputs: ['a', 'b'], outputs: ['result'],
    body: 'result[i] = a[i] * b[i];',
  },

  // ---- Extended math (unary) ----
  cbrt: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = sign(data[i]) * pow(abs(data[i]), 1.0 / 3.0);',
  },
  log2: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = log2(data[i]);',
  },
  log10: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = log(data[i]) / log(10.0);',
  },
  exp2: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = exp2(data[i]);',
  },
  tanh: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = tanh(data[i]);',
  },
  sinh: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = sinh(data[i]);',
  },
  cosh: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = cosh(data[i]);',
  },
  trunc: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = trunc(data[i]);',
  },
  expm1: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = exp(data[i]) - 1.0;',
  },
  log1p: {
    inputs: ['data'], outputs: ['result'],
    body: 'result[i] = log(1.0 + data[i]);',
  },

  // ---- Interpolation ----
  smoothstep: {
    inputs: ['data'], uniforms: ['edge0', 'edge1'], outputs: ['result'],
    body: 'result[i] = smoothstep(edge0, edge1, data[i]);',
  },
  step: {
    inputs: ['data'], uniforms: ['edge'], outputs: ['result'],
    body: 'result[i] = step(edge, data[i]);',
  },

  // ---- Financial ----
  pctChange: {
    inputs: ['a', 'b'], outputs: ['result'],
    body: 'result[i] = (b[i] - a[i]) / max(abs(a[i]), 1e-10);',
  },
  ema: {
    inputs: ['prev', 'data'], uniforms: ['alpha'], outputs: ['result'],
    body: 'result[i] = alpha * data[i] + (1.0 - alpha) * prev[i];',
  },

  // ---- Vector-like (two-input element-wise) ----
  max2: {
    inputs: ['a', 'b'], outputs: ['result'],
    body: 'result[i] = max(a[i], b[i]);',
  },
  min2: {
    inputs: ['a', 'b'], outputs: ['result'],
    body: 'result[i] = min(a[i], b[i]);',
  },
};

// ---------------------------------------------------------------------------
// Multi-pass operations (reduction, scan, etc.)
// ---------------------------------------------------------------------------
// These ops produce a single output from many inputs.  They use
// workgroup-level reduction with shared memory and return partial
// results that are combined on the CPU.

/**
 * Workgroup reduction shader — produces one value per workgroup.
 *
 * @type {Object}
 */
export const REDUCE_SHADER = {
  inputs: ['data'],
  uniforms: ['count'],
  outputs: ['partial'],
  body: `
    var<workgroup> shared_data: array<f32, 256>;

    let tid = local_id.x;
    let i = id.x;

    if (i < count) {
      shared_data[tid] = data[i];
    } else {
      shared_data[tid] = 0.0;
    }
    workgroupBarrier();

    for (var stride = 128u; stride > 0u; stride >>= 1u) {
      if (tid < stride) {
        shared_data[tid] = shared_data[tid] + shared_data[tid + stride];
      }
      workgroupBarrier();
    }

    if (tid == 0u) {
      partial[wg_id.x] = shared_data[0];
    }
  `,
  special: 'reduce_sum',
};

export const REDUCE_MIN_SHADER = {
  inputs: ['data'],
  uniforms: ['count'],
  outputs: ['partial'],
  body: `
    var<workgroup> shared_data: array<f32, 256>;

    let tid = local_id.x;
    let i = id.x;

    if (i < count) {
      shared_data[tid] = data[i];
    } else {
      shared_data[tid] = 3.4028235e+38;
    }
    workgroupBarrier();

    for (var stride = 128u; stride > 0u; stride >>= 1u) {
      if (tid < stride) {
        shared_data[tid] = min(shared_data[tid], shared_data[tid + stride]);
      }
      workgroupBarrier();
    }

    if (tid == 0u) {
      partial[wg_id.x] = shared_data[0];
    }
  `,
  special: 'reduce_min',
};

export const REDUCE_MAX_SHADER = {
  inputs: ['data'],
  uniforms: ['count'],
  outputs: ['partial'],
  body: `
    var<workgroup> shared_data: array<f32, 256>;

    let tid = local_id.x;
    let i = id.x;

    if (i < count) {
      shared_data[tid] = data[i];
    } else {
      shared_data[tid] = -3.4028235e+38;
    }
    workgroupBarrier();

    for (var stride = 128u; stride > 0u; stride >>= 1u) {
      if (tid < stride) {
        shared_data[tid] = max(shared_data[tid], shared_data[tid + stride]);
      }
      workgroupBarrier();
    }

    if (tid == 0u) {
      partial[wg_id.x] = shared_data[0];
    }
  `,
  special: 'reduce_max',
};

// ---------------------------------------------------------------------------
// Matrix multiply (tiled with shared memory)
// ---------------------------------------------------------------------------

export const MATMUL_SHADER = {
  inputs: ['A', 'B'],
  uniforms: ['M', 'N', 'K'],
  outputs: ['C'],
  body: `
    let TILE = 16u;
    var<workgroup> tileA: array<f32, 256>;
    var<workgroup> tileB: array<f32, 256>;

    let row = id.y;
    let col = id.x;
    let tid = local_id.y * 16u + local_id.x;

    var sum: f32 = 0.0;

    for (var t = 0u; t < (K + TILE - 1u) / TILE; t++) {
      let aCol = t * TILE + local_id.x;
      if (row < M && aCol < K) {
        tileA[tid] = A[row * K + aCol];
      } else {
        tileA[tid] = 0.0;
      }

      let bRow = t * TILE + local_id.y;
      if (bRow < K && col < N) {
        tileB[tid] = B[bRow * N + col];
      } else {
        tileB[tid] = 0.0;
      }

      workgroupBarrier();

      for (var k = 0u; k < TILE; k++) {
        sum += tileA[local_id.y * TILE + k] * tileB[k * TILE + local_id.x];
      }

      workgroupBarrier();
    }

    if (row < M && col < N) {
      C[row * N + col] = sum;
    }
  `,
  special: 'matmul',
  workgroupSize: 16,
  dispatch: [0, 0], // [Math.ceil(N/16), Math.ceil(M/16)]
};

// ---------------------------------------------------------------------------
// Histogram — count occurrences in bins
// ---------------------------------------------------------------------------

export const HISTOGRAM_SHADER = {
  inputs: ['data'],
  uniforms: ['count', 'numBins'],
  outputs: ['bins'],
  body: `
    var<workgroup> local_bins: array<u32, 256>;

    let tid = local_id.x;
    let i = id.x;
    let n = count;
    let nb = numBins;

    if (tid < 256u) { local_bins[tid] = 0u; }
    workgroupBarrier();

    if (i < n && nb > 0u) {
      let bin = clamp(u32(data[i] * f32(nb) / 1000.0), 0u, nb - 1u);
      atomicAdd(&local_bins[bin], 1u);
    }
    workgroupBarrier();

    if (tid < 256u) {
      atomicAdd(&bins[tid], local_bins[tid]);
    }
  `,
  special: 'histogram',
};

// ---------------------------------------------------------------------------
// ArgMax / ArgMin — find index of extreme value
// ---------------------------------------------------------------------------

export const ARGMAX_SHADER = {
  inputs: ['data'],
  uniforms: ['count'],
  outputs: ['partial_val', 'partial_idx'],
  body: `
    var<workgroup> shared_val: array<f32, 256>;
    var<workgroup> shared_idx: array<u32, 256>;

    let tid = local_id.x;
    let i = id.x;

    if (i < count) {
      shared_val[tid] = data[i];
      shared_idx[tid] = u32(i);
    } else {
      shared_val[tid] = -3.4028235e+38;
      shared_idx[tid] = 0u;
    }
    workgroupBarrier();

    for (var stride = 128u; stride > 0u; stride >>= 1u) {
      if (tid < stride) {
        if (shared_val[tid + stride] > shared_val[tid]) {
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
  `,
  special: 'argmax',
};

export const ARGMIN_SHADER = {
  inputs: ['data'],
  uniforms: ['count'],
  outputs: ['partial_val', 'partial_idx'],
  body: `
    var<workgroup> shared_val: array<f32, 256>;
    var<workgroup> shared_idx: array<u32, 256>;

    let tid = local_id.x;
    let i = id.x;

    if (i < count) {
      shared_val[tid] = data[i];
      shared_idx[tid] = u32(i);
    } else {
      shared_val[tid] = 3.4028235e+38;
      shared_idx[tid] = 0u;
    }
    workgroupBarrier();

    for (var stride = 128u; stride > 0u; stride >>= 1u) {
      if (tid < stride) {
        if (shared_val[tid + stride] < shared_val[tid]) {
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
  `,
  special: 'argmin',
};

// ---------------------------------------------------------------------------
// Scan — parallel prefix sum
// ---------------------------------------------------------------------------

export const SCAN_SHADER = {
  inputs: ['data'],
  uniforms: ['count'],
  outputs: ['output'],
  body: `
    var<workgroup> temp: array<f32, 512>;

    let tid = local_id.x;
    let i = id.x;

    // Load into temp (double workgroup for scan)
    if (i < count) {
      temp[tid] = data[i];
    } else {
      temp[tid] = 0.0;
    }
    workgroupBarrier();

    // Up-sweep
    for (var stride = 1u; stride < 256u; stride <<= 1u) {
      let idx = (tid + 1u) * (stride * 2u) - 1u;
      if (idx < 512u && idx >= stride) {
        temp[idx] += temp[idx - stride];
      }
      workgroupBarrier();
    }

    // Clear last element
    if (tid == 0u) {
      temp[511u] = 0.0;
    }
    workgroupBarrier();

    // Down-sweep
    for (var stride = 256u; stride > 0u; stride >>= 1u) {
      let idx = (tid + 1u) * (stride * 2u) - 1u;
      if (idx < 512u && idx >= stride) {
        let t = temp[idx - stride];
        temp[idx - stride] = temp[idx];
        temp[idx] += t;
      }
      workgroupBarrier();
    }

    if (i < count) {
      output[i] = temp[tid + 1u];
    }
  `,
  special: 'scan',
};

// ---------------------------------------------------------------------------
// List of all built-in op names
// ---------------------------------------------------------------------------

/**
 * Array of all built-in operation names.
 *
 * @type {string[]}
 */
export const BUILT_IN_OP_NAMES = Object.keys(BUILT_IN_OPS);

/**
 * Multi-pass special operation registry.
 *
 * @type {Object<string, Object>}
 */
export const SPECIAL_OPS = {
  reduce_sum: REDUCE_SHADER,
  reduce_min: REDUCE_MIN_SHADER,
  reduce_max: REDUCE_MAX_SHADER,
  matmul: MATMUL_SHADER,
  histogram: HISTOGRAM_SHADER,
  argmax: ARGMAX_SHADER,
  argmin: ARGMIN_SHADER,
  scan: SCAN_SHADER,
};
