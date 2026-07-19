/**
 * @file Factory functions for creating threads, pools, and GPU compute instances.
 *
 * Factory functions provide a convenient, validated alternative to
 * directly instantiating `new Thread(...)`, `new ThreadPool(...)`, or
 * `new GPUCompute(...)`.  They perform input validation, apply sensible
 * defaults, and return ready-to-use instances.
 *
 * **When to use factories vs constructors:**
 *
 * | Situation                               | Use                        |
 * |-----------------------------------------|----------------------------|
 * | Need full control / subclassing         | `new Thread(...)`          |
 * | Want validation + ergonomic API         | `createThread()`           |
 * | Need a pool with defaults               | `createPool()`             |
 * | One-liner fire-and-forget worker        | `createWorker()`           |
 * | Repeatable worker from definition       | `createWorkerDef()`        |
 * | Thread with auto error handling         | `createManagedThread()`    |
 * | GPU with a single JS-defined op         | `createGPUOp()`            |
 * | GPU with multiple pre-registered ops    | `createGPUPipeline()`      |
 * | GPU ready for reductions                 | `createGPUReducer()`       |
 * | GPU with CPU fallback                   | `createGPUWithFallback()`  |
 *
 * @example
 * ```js
 * import {
 *   createThread, createPool,
 *   createGPUOp, createGPUPipeline, createGPUReducer,
 * } from './factory.js';
 *
 * // --- CPU workers ---
 * const t = createThread((x) => x * 2);
 * console.log(await t.run(5)); // 10
 *
 * const pool = createPool(4, heavyComputation, { autoRestart: true });
 *
 * // --- GPU compute ---
 * const gpu = createGPUOp('double', (data) => data.value * 2);
 * const result = await gpu.run('double', { inputs: { data: new Float32Array([1, 2, 3]) } });
 *
 * // GPU with multiple ops
 * const pipeline = createGPUPipeline([
 *   ['ema',     (data, { alpha }) => data.value * alpha + ...],
 *   ['squared', (data) => data.value * data.value],
 * ]);
 *
 * // GPU ready for reductions
 * const reducer = createGPUReducer();
 * const { result } = await reducer.run('reduce_sum', { inputs: { data: someFloat32 } });
 * ```
 *
 * @module factory
 */

import { ThreadPool } from "./pool";
import { Thread } from "./thread";
import { GPUCompute } from "./gpu/gpu.js";

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

/**
 * Create a validated {@link Thread} instance.
 *
 * This is the **recommended** way to create threads.  It validates the
 * definition and options, applies sensible defaults, and returns a
 * fully-initialised thread.
 *
 * @param {import('./types.js').ThreadDefinition | Function} definition
 *   A plain function (used as `exec`) or a `{ setup?, exec, cleanup? }`
 *   object.
 * @param {import('./types.js').ThreadOptions} [options={}]
 *   Configuration for timeouts, health checks, event hooks, etc.
 * @returns {Thread} A ready-to-use thread.
 *
 * @throws {TypeError} If `definition` is not a function or a valid
 *   `{ exec }` object.
 *
 *
 * ```js
 * // Minimal – just a function
 * const t = createThread((a, b) => a + b);
 * await t.run(3, 4); // 7
 * ```
 *
 * ```js
 * // Full-featured – with options
 * const t = createThread((data, ctx) => {
 *   ctx.log('Processing...');
 *   ctx.reportProgress(0.5);
 *   return data.map((x) => x * 2);
 * }, {
 *   timeout: 10_000,
 *   concurrency: 2,
 *   onLog: (msg) => console.log('[worker]', msg),
 *   onTiming: (ms) => console.log(`Done in ${ms.toFixed(1)}ms`),
 * });
 *
 * const result = await t.run([1, 2, 3]);
 * // [2, 4, 6]
 * ```
 *
 * @example
 * ```js
 * // TypeScript – full type safety via JSDoc
 * // @type {import('./types.js').ThreadDefinition}
 * const def = {
 *   setup() { return { count: 0 }; },
 *   exec(state, delta) {
 *     state.count += delta;
 *     return state.count;
 *   },
 * };
 * const t = createThread(def, { timeout: 5000 });
 * ```
 */
export function createThread(definition, options = {}) {
  return new Thread(definition, options);
}

// ---------------------------------------------------------------------------
// createPool
// ---------------------------------------------------------------------------

/**
 * Create a validated {@link ThreadPool} instance.
 *
 * @param {number} size
 *   Initial number of worker threads.  Must be ≥ 1.
 * @param {import('./types.js').ThreadDefinition | Function} definition
 *   Worker definition forwarded to each thread.
 * @param {import('./types.js').PoolOptions} [options={}]
 *   Pool and thread configuration.
 * @returns {ThreadPool} A ready-to-use pool.
 *
 * @throws {TypeError} If `size` is not a positive integer.
 * @throws {TypeError} If `definition` is not a function or a valid
 *   `{ exec }` object.
 *
 * @example
 * ```js
 * // CPU-intensive work across 4 threads
 * const pool = createPool(4, (n) => {
 *   let sum = 0;
 *   for (let i = 0; i < n; i++) sum += Math.sqrt(i);
 *   return sum;
 * });
 *
 * const results = await Promise.all(
 *   Array.from({ length: 20 }, (_, i) => pool.run(1_000_000 + i).promise)
 * );
 * console.log('All done:', results.length);
 * ```
 *
 * @example
 * ```js
 * // With affinity routing – same entity always goes to same thread
 * const pool = createPool(4, processEntity, {
 *   keyHasher: (args) => String(args[0].entityId),
 * });
 *
 * // Entity 42 always lands on the same thread → cache-friendly
 * await pool.run({ entityId: 42, data: [...] });
 * ```
 *
 * @example
 * ```js
 * // Pipeline with dependencies
 * const pool = createPool(2, (x) => x);
 *
 * const step1 = pool.run('raw-data');
 * const step2 = pool.run(step1.id, { dependsOn: [step1.id] });
 * const step3 = pool.run(step2.id, { dependsOn: [step2.id] });
 *
 * console.log(await step3.promise); // 'raw-data'
 * ```
 */
export function createPool(size, definition, options = {}) {
  if (!Number.isInteger(size) || size < 1) {
    throw new TypeError(`size must be a positive integer, got ${size}`);
  }
  return new ThreadPool(size, definition, options);
}

// ---------------------------------------------------------------------------
// createWorker (convenience)
// ---------------------------------------------------------------------------

/**
 * Create a single-purpose thread from a function with built-in error
 * handling and logging.
 *
 * This is a convenience wrapper around {@link createThread} that:
 * - Registers an `onError` listener that logs to the console.
 * - Returns a thread that is "ready to use" with minimal boilerplate.
 *
 * Ideal for quick one-off tasks where you don't need fine-grained
 * control.
 *
 * @param {Function} fn
 *   The function to execute in the worker.  Receives the same arguments
 *   as `thread.run(...)`.
 * @param {import('./types.js').ThreadOptions} [options={}]
 *   Additional options forwarded to `createThread`.
 * @returns {Thread} A thread with error logging pre-configured.
 *
 * @example
 * ```js
 * import { createWorker } from './factory.js';
 *
 * const hasher = createWorker((data) => {
 *   // SHA-256 or whatever
 *   return crypto.subtle.digest('SHA-256', data);
 * }, { timeout: 5000 });
 *
 * const hash = await hasher.run(heavyBuffer);
 * hasher.terminate();
 * ```
 *
 * @example
 * ```js
 * // Use in a script – errors are logged automatically
 * const worker = createWorker((text) => text.toUpperCase());
 * console.log(await worker.run('hello')); // "HELLO"
 * ```
 */
export function createWorker(fn, options = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError(`createWorker expects a function, got ${typeof fn}`);
  }
  const opts = {
    onError: (info) => console.error('[worker error]', info.error, info.stack),
    ...options,
  };
  return createThread(fn, opts);
}

// ---------------------------------------------------------------------------
// createWorkerDef (reusable definition factory)
// ---------------------------------------------------------------------------

/**
 * Create a reusable thread **definition** object from setup/exec/cleanup
 * functions.
 *
 * The returned object can be passed to `createThread()` or
 * `createPool()` multiple times, creating independent workers with the
 * same logic.  This is useful when you want to stamp out many identical
 * workers without duplicating the definition.
 *
 * @param {Object} def
 * @param {Function} [def.setup]
 *   Runs once when the worker starts.  Return value becomes `state`.
 * @param {Function} def.exec
 *   Runs on every task.  Receives `(state, ...args, ctx)`.
 * @param {Function} [def.cleanup]
 *   Runs once before termination.
 * @returns {import('./types.js').ThreadDefinition} A definition object
 *   ready for use with `createThread` or `createPool`.
 *
 * @throws {TypeError} If `def.exec` is not a function.
 *
 * @example
 * ```js
 * import { createWorkerDef, createPool } from './factory.js';
 *
 * const imageProcessor = createWorkerDef({
 *   setup() {
 *     // load a WASM module, open a DB, etc.
 *     return { module: loadWasm() };
 *   },
 *   async exec(state, imageData, ctx) {
 *     ctx.log('Processing image...');
 *     const result = state.module.process(imageData);
 *     ctx.reportProgress(1);
 *     return result;
 *   },
 *   cleanup(state) {
 *     state.module.free();
 *   },
 * });
 *
 * // Reuse the same definition across multiple pools or threads
 * const pool = createPool(4, imageProcessor);
 * const standalone = createThread(imageProcessor);
 * ```
 */
export function createWorkerDef(def) {
  if (!def || typeof def !== 'object') {
    throw new TypeError('createWorkerDef expects an object');
  }
  if (typeof def.exec !== 'function') {
    throw new TypeError('def.exec must be a function');
  }
  return {
    setup: def.setup || null,
    exec: def.exec,
    cleanup: def.cleanup || null,
  };
}

// ---------------------------------------------------------------------------
// createManagedThread
// ---------------------------------------------------------------------------

/**
 * Create a thread with automatic logging, error handling, and optional
 * metrics collection.
 *
 * "Managed" means the thread comes with:
 * - **Error logging** – errors are logged to the console.
 * - **Timing** – every task's duration is logged.
 * - **Metrics listener** – optional callback receives live metrics.
 * - **Health checks** – enabled by default (every 10s).
 *
 * This is the recommended entry point when you want a thread that
 * "just works" without manual event wiring.
 *
 * @param {import('./types.js').ThreadDefinition | Function} definition
 *   Worker definition (same as `createThread`).
 * @param {Object} [options={}]
 * @param {number} [options.timeout=30000]
 *   Task timeout in ms.
 * @param {boolean} [options.healthChecks=true]
 *   Enable automatic health checks.
 * @param {number} [options.healthCheckInterval=10000]
 *   Health check interval in ms.
 * @param {Function} [options.onMetrics]
 *   Callback for live metrics snapshots.
 * @param {Function} [options.onLog]
 *   Callback for worker log messages.
 * @param {import('./types.js').ThreadOptions} [options.thread]
 *   Additional options forwarded to the Thread constructor.
 * @returns {Thread} A fully configured thread.
 *
 * @example
 * ```js
 * import { createManagedThread } from './factory.js';
 *
 * const t = createManagedThread((x) => x * 2, {
 *   timeout: 5000,
 *   onMetrics: (snap) => {
 *     dashboard.update(snap); // live dashboard
 *   },
 * });
 *
 * // Errors and timing are logged automatically
 * await t.run(21); // logs "Task completed in 2.3ms"
 * ```
 *
 * @example
 * ```js
 * // With stateful definition
 * const t = createManagedThread({
 *   setup() { return { cache: new Map() }; },
 *   exec(state, key) {
 *     if (state.cache.has(key)) return state.cache.get(key);
 *     const val = expensiveCompute(key);
 *     state.cache.set(key, val);
 *     return val;
 *   },
 * }, {
 *   timeout: 10_000,
 *   healthChecks: true,
 *   onMetrics: (snap) => console.log(`Pool avg: ${snap.avg}ms`),
 * });
 * ```
 */
export function createManagedThread(definition, options = {}) {
  const {
    healthChecks = true,
    healthCheckInterval = 10_000,
    onMetrics = null,
    onLog = null,
    thread: extraThreadOpts = {},
    ...rest
  } = options;

  const threadOpts = {
    ...rest,
    ...extraThreadOpts,
    onError: (info) => console.error('[thread error]', info.error),
    onTiming: (ms) => console.log(`[thread] task completed in ${ms.toFixed(1)}ms`),
    ...(healthChecks ? { healthCheckInterval } : {}),
    ...(onMetrics ? { onMetrics } : {}),
    ...(onLog ? { onLog } : {}),
  };

  return createThread(definition, threadOpts);
}

// ---------------------------------------------------------------------------
// createGPUOp
// ---------------------------------------------------------------------------

/**
 * Create a {@link GPUCompute} instance with a single custom operation
 * already registered.
 *
 * This is the **quickest** way to get a GPU-accelerated operation running.
 * Pass a plain JS function — it is auto-transpiled to WGSL for the GPU
 * and also serves as the CPU fallback.
 *
 * @param {string} name
 *   Operation name (used in subsequent `gpu.run(name, ...)` calls).
 * @param {Function} fn
 *   A JS function `(data, uniforms) => expression`.
 *   - `data.value` → current element (auto-maps to `input[i]`)
 *   - `data.index` / `data.i` → current index
 *   - Second param is an object of uniform values
 * @param {import('./types.js').GPUComputeOptions} [options={}]
 *   Additional GPU options forwarded to the constructor.
 * @returns {GPUCompute} A GPU instance ready to `run(name, ...)`.
 *
 * @example
 * ```js
 * import { createGPUOp } from './factory.js';
 *
 * // EMA (Exponential Moving Average) — single line
 * const gpu = createGPUOp('ema', (data, { alpha }) =>
 *   data.value * alpha + data.index * (1 - alpha)
 * );
 *
 * const prices = new Float32Array([100, 102, 101, 105, 107]);
 * const result = await gpu.run('ema', {
 *   inputs: { data: prices },
 *   uniforms: { alpha: new Float32Array([0.3]) },
 *   outputs: { result: 5 },
 * });
 * // result.result → Float32Array of EMA values
 * ```
 *
 * @example
 * ```js
 * // Clamp values between 0 and 1
 * const gpu = createGPUOp('clamp01', (data) =>
 *   Math.min(Math.max(data.value, 0), 1)
 * );
 *
 * const noisy = new Float32Array([-0.5, 0.3, 1.2, 0.8]);
 * const result = await gpu.run('clamp01', {
 *   inputs: { data: noisy },
 *   outputs: { result: 4 },
 * });
 * // result.result → [0, 0.3, 1, 0.8]
 * ```
 *
 * @example
 * ```js
 * // Z-score normalization
 * const gpu = createGPUOp('zscore', (data, { mean, std }) =>
 *   (data.value - mean) / std
 * );
 *
 * const raw = new Float32Array([10, 20, 30, 40, 50]);
 * const result = await gpu.run('zscore', {
 *   inputs: { data: raw },
 *   uniforms: { mean: new Float32Array([30]), std: new Float32Array([14.14]) },
 *   outputs: { result: 5 },
 * });
 * ```
 */
export function createGPUOp(name, fn, options = {}) {
  const gpu = new GPUCompute(options);
  gpu.define(name, fn);
  return gpu;
}

// ---------------------------------------------------------------------------
// createGPUPipeline
// ---------------------------------------------------------------------------

/**
 * Create a {@link GPUCompute} instance with multiple operations
 * pre-registered from an array of `[name, declaration]` pairs.
 *
 * Ideal for building a reusable compute pipeline where several
 * operations are defined upfront and used interchangeably.
 *
 * @param {Array<[string, Function|import('./types.js').OpDeclaration]>} ops
 *   Array of `[name, declaration]` tuples.
 *   Each declaration can be a JS function or an `{ inputs, body, fn, ... }`
 *   object.
 * @param {import('./types.js').GPUComputeOptions} [options={}]
 *   Additional GPU options forwarded to the constructor.
 * @returns {GPUCompute} A GPU instance with all ops registered.
 *
 * @example
 * ```js
 * import { createGPUPipeline } from './factory.js';
 *
 * const gpu = createGPUPipeline([
 *   ['ema',    (data, { alpha }) => data.value * alpha],
 *   ['double', (data) => data.value * 2],
 *   ['negate', (data) => -data.value],
 *   ['sqrt',   (data) => Math.sqrt(Math.abs(data.value))],
 * ]);
 *
 * // Run any of them
 * await gpu.run('ema', { inputs: { data }, uniforms: { alpha: new Float32Array([0.5]) }, outputs: { result: 5 } });
 * await gpu.run('double', { inputs: { data }, outputs: { result: 5 } });
 *
 * console.log(gpu.ops); // ['ema', 'double', 'negate', 'sqrt']
 * ```
 *
 * @example
 * ```js
 * // Mix JS functions and WGSL body declarations
 * const gpu = createGPUPipeline([
 *   ['scale', (data, { factor }) => data.value * factor],
 *   ['clamp', {
 *     inputs: ['data'],
 *     outputs: ['result'],
 *     uniforms: ['minVal', 'maxVal'],
 *     body: 'result[i] = clamp(data[i], minVal, maxVal);',
 *   }],
 * ]);
 * ```
 */
export function createGPUPipeline(ops, options = {}) {
  const gpu = new GPUCompute(options);
  for (const [name, decl] of ops) {
    gpu.define(name, decl);
  }
  return gpu;
}

// ---------------------------------------------------------------------------
// createGPUReducer
// ---------------------------------------------------------------------------

/**
 * Create a {@link GPUCompute} instance ready for reduction operations.
 *
 * The `reduce_sum`, `reduce_min`, and `reduce_max` ops are already
 * built-in to {@link GPUCompute} as special multi-pass ops — this
 * factory simply returns an instance without requiring a shader,
 * so you can call `run('reduce_sum', …)` immediately.
 *
 * @param {import('./types.js').GPUComputeOptions} [options={}]
 *   Additional GPU options forwarded to the constructor.
 * @returns {GPUCompute} A GPU instance ready for reductions.
 *
 * @example
 * ```js
 * import { createGPUReducer } from './factory.js';
 *
 * const gpu = createGPUReducer();
 *
 * const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
 *
 * const sum = await gpu.run('reduce_sum', {
 *   inputs: { data },
 *   outputs: { result: 10 },
 * });
 * console.log(sum.result); // Float32Array([55])
 *
 * const max = await gpu.run('reduce_max', {
 *   inputs: { data },
 *   outputs: { result: 10 },
 * });
 * console.log(max.result); // Float32Array([10])
 * ```
 *
 * @example
 * ```js
 * // Combine with other ops for full data processing
 * const gpu = createGPUReducer();
 * gpu.define('normalize', (data, { mean, std }) =>
 *   (data.value - mean) / std
 * );
 *
 * const raw = new Float32Array([10, 20, 30, 40, 50]);
 *
 * // Normalize first, then find the sum
 * const norm = await gpu.run('normalize', {
 *   inputs: { data: raw },
 *   uniforms: { mean: new Float32Array([30]), std: new Float32Array([14.14]) },
 *   outputs: { result: 5 },
 * });
 *
 * const total = await gpu.run('reduce_sum', {
 *   inputs: { data: norm.result },
 *   outputs: { result: 5 },
 * });
 * ```
 */
export function createGPUReducer(options = {}) {
  return new GPUCompute(options);
}
