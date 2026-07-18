/**
 * @file sewt — Enterprise Web Worker & GPU Compute Framework
 *
 * A modular, feature-rich library for running CPU-intensive work in
 * **Web Workers** and **WebGPU compute shaders**, with a thread pool,
 * work-stealing, dependency tracking, health checks, and framework
 * adapters for Preact, React, Zustand, and Preact Signals.
 *
 * ---
 *
 * ## Architecture
 *
 * ```
 * sewt
 * ├── Thread            – Single worker with full lifecycle management
 * ├── ThreadPool        – Pool with priority queue, deps, work-stealing
 * ├── GPUCompute        – WebGPU compute shader executor
 * │   ├── PipelineChain     – Fluent multi-step GPU pipelines
 * │   ├── DataPipelineChain – Data-carrying pipelines with named methods
 * │   └── 57+ built-in ops  – multiply, sqrt, ema, reduce, matmul, …
 * ├── Metrics           – Performance counters (avg, throughput, errors)
 * ├── Serializer        – JSON-safe serialization with function support
 * ├── Errors            – Typed error hierarchy (timeout, abort, GPU, …)
 * ├── Factories         – createThread, createPool, createGPUOp, …
 * ├── Hooks             – useThread, usePool, useGPU (Preact/React)
 * └── Adapters          – Zustand, Signals, generic store bindings
 * ```
 *
 * ---
 *
 * ## Quick start
 *
 * ### CPU workers
 *
 * ```js
 * import { createThread, createPool } from 'sewt';
 *
 * // Single thread
 * const t = createThread((x) => x * 2);
 * console.log(await t.run(5)); // 10
 *
 * // Thread pool
 * const pool = createPool(4, (x) => x + 1);
 * const { id, promise } = pool.run(1);
 * console.log(await promise); // 2
 * ```
 *
 * ### GPU compute
 *
 * ```js
 * import { createGPUOp } from 'sewt';
 *
 * // One-liner GPU operation
 * const gpu = createGPUOp('double', (data) => data.value * 2);
 * const result = await gpu.run('double', {
 *   inputs: { data: new Float32Array([1, 2, 3]) },
 *   outputs: { result: 3 },
 * });
 * console.log(result.result); // Float32Array [2, 4, 6]
 * ```
 *
 * ---
 *
 * ## Full feature tour
 *
 * ### 1. Stateful workers with setup / exec / cleanup
 *
 * ```js
 * import { createThread } from 'sewt';
 *
 * const db = createThread({
 *   setup() {
 *     return { conn: openDatabase() };
 *   },
 *   async exec(state, query, ctx) {
 *     ctx.log(`Running: ${query}`);
 *     return state.conn.query(query);
 *   },
 *   async cleanup(state) {
 *     await state.conn.close();
 *     ctx.log('Connection closed');
 *   },
 * }, { timeout: 10_000 });
 *
 * const rows = await db.run('SELECT * FROM users');
 * await db.terminateGracefully(); // cleanup runs
 * ```
 *
 * ### 2. Timeouts, abort, and retries
 *
 * ```js
 * import { createThread, ThreadTimeoutError, ThreadAbortError } from 'sewt';
 *
 * const t = createThread((data) => heavyProcess(data));
 * const controller = new AbortController();
 *
 * try {
 *   const result = await t.run(hugeData, {
 *     timeout: 30_000,
 *     signal: controller.signal,
 *     retries: 2,
 *     transfer: [hugeData.buffer],
 *   });
 * } catch (err) {
 *   if (err instanceof ThreadTimeoutError) {
 *     console.error('Too slow – aborting');
 *     controller.abort();
 *   }
 * }
 * ```
 *
 * ### 3. Pool with priorities and dependencies
 *
 * ```js
 * import { createPool } from 'sewt';
 *
 * const pool = createPool(4, (x) => x * 2);
 *
 * // High priority runs first
 * pool.run(urgent, { priority: 0 });
 * pool.run(batch,  { priority: 10 });
 *
 * // Dependency chain: fetch → transform → store
 * const fetched     = pool.run(url1);
 * const transformed = pool.run(fetchResult, { dependsOn: [fetched.id] });
 * const stored      = pool.run(transformed, { dependsOn: [transformed.id] });
 *
 * await stored.promise;
 * console.log('Pipeline complete');
 * ```
 *
 * ### 4. GPU — define ops from plain JS
 *
 * ```js
 * import { createGPUOp } from 'sewt';
 *
 * // EMA (Exponential Moving Average)
 * const gpu = createGPUOp('ema', (data, { alpha }) =>
 *   data.value * alpha + data.index * (1 - alpha)
 * );
 *
 * const result = await gpu.run('ema', {
 *   inputs:  { data: new Float32Array([100, 102, 101, 105, 107]) },
 *   uniforms: { alpha: new Float32Array([0.3]) },
 *   outputs: { result: 5 },
 * });
 * ```
 *
 * ### 5. GPU pipeline chaining
 *
 * ```js * import { GPUCompute } from 'sewt';
 *
 * const gpu = new GPUCompute();
 * gpu.define('ema', (data, { alpha }) => data.value * alpha);
 * gpu.define('double', (data) => data.value * 2);
 *
 * const chain = gpu.pipe()
 *   .add('ema', { inputs: { data: prices }, uniforms: { alpha: new Float32Array([0.3]) } })
 *   .add('double');
 *
 * const output = await chain.result();
 * ```
 *
 * ### 6. GPU fluent data pipeline
 *
 * ```js * const gpu = new GPUCompute();
 * gpu.define('ema', (data, { alpha }) => data.value * alpha);
 * gpu.define('double', (data) => data.value * 2);
 *
 * // Data-carrying chain with named methods
 * const output = await gpu.pipe(new Float32Array([1, 2, 3]))
 *   .ema({ alpha: 0.3 })
 *   .double()
 *   .result();
 * ```
 *
 * ### 7. GPU reductions and special ops
 *
 * ```js
 * import { createGPUReducer } from 'sewt';
 *
 * const gpu = createGPUReducer();
 * const data = new Float32Array([1, 2, 3, 4, 5]);
 *
 * const sum = await gpu.run('reduce_sum', {
 *   inputs: { data },
 *   outputs: { result: 5 },
 * });
 * // sum.result → Float32Array([15])
 *
 * const max = await gpu.run('reduce_max', {
 *   inputs: { data },
 *   outputs: { result: 5 },
 * });
 * // max.result → Float32Array([5])
 * ```
 *
 * ### 8. GPU map() — parallel element-wise transform
 *
 * ```js * const gpu = new GPUCompute();
 * const result = await gpu.map(
 *   new Float32Array([1, 4, 9, 16]),
 *   (x) => Math.sqrt(x)
 * );
 * // result → Float32Array([1, 2, 3, 4])
 * ```
 *
 * ### 9. Preact / React hooks
 *
 * ```jsx
 * import { useGPU, useThread, usePool } from 'sewt';
 *
 * function GPUDemo({ prices }) {
 *   const { run, result, loading, error, status } = useGPU();
 *
 *   return (
 *     <div>
 *       <p>GPU: {status}</p>
 *       <button onClick={() => run('ema', { inputs: { data: prices }, ... })} disabled={loading}>
 *         {loading ? 'Computing...' : 'Run EMA'}
 *       </button>
 *       {error && <p className="error">{error}</p>}
 *     </div>
 *   );
 * }
 * ```
 *
 * ### 10. Zustand / Signal adapters
 *
 * ```js
 * import { createGPUBinder, createGPUSignalBinder } from 'sewt';
 * import { signal } from '@preact/signals';
 *
 * // Bind GPU to Zustand store
 * const binder = createGPUBinder(gpu, useStore, 'setData', {
 *   errorAction: 'setError',
 * });
 * await binder.run('ema', { inputs: { data: prices }, ... });
 *
 * // Bind GPU to a Preact Signal
 * const dataSignal = signal(null);
 * const sigBinder = createGPUSignalBinder(gpu, dataSignal);
 * await sigBinder.run('ema', { inputs: { data: prices }, ... });
 * console.log(dataSignal.value);
 * ```
 *
 * ---
 *
 * ## TypeScript
 *
 * Import types from `sewt/types`:
 *
 * ```ts
 * import type {
 *   ThreadDefinition,
 *   ThreadOptions,
 *   ThreadRunOptions,
 *   PoolOptions,
 *   PoolRunOptions,
 *   PoolTaskResult,
 *   PoolStatus,
 *   MetricsSnapshot,
 *   ThreadEventName,
 *   GPUComputeOptions,
 *   GPUComputeInput,
 *   GPUComputeSnapshot,
 *   OpDeclaration,
 *   UseThreadReturn,
 *   UsePoolReturn,
 *   UseGPUReturn,
 *   ZustandBinderOptions,
 *   SignalBinderOptions,
 *   StoreBinderOptions,
 *   BinderHandle,
 *   Signal,
 * } from 'sewt/types';
 * ```
 *
 * ---
 *
 * ## Error handling
 *
 * All errors extend `ThreadError`:
 *
 * | Error                    | When                                      |
 * |--------------------------|-------------------------------------------|
 * | `ThreadTimeoutError`     | Task exceeded its timeout                 |
 * | `ThreadAbortError`       | Task was aborted via AbortController      |
 * | `ThreadTerminatedError`  | Thread/pool was terminated                |
 * | `ThreadHealthError`      | Health check failed (internal)            |
 * | `ThreadDependencyError`  | A dependency task failed                  |
 * | `GPUComputeError`        | Shader compilation, buffer, or dispatch   |
 *
 * ```js
 * import { ThreadError, ThreadTimeoutError, GPUComputeError } from 'sewt';
 *
 * try {
 *   await gpu.run('myOp', input);
 * } catch (err) {
 *   if (err instanceof GPUComputeError) {
 *     console.error(`GPU failed: ${err.message}`);
 *   } else if (err instanceof ThreadTimeoutError) {
 *     console.error('Timed out');
 *   }
 * }
 * ```
 *
 * ---
 *
 * @module sewt
 */

import {
    ThreadAbortError,
    ThreadDependencyError,
    ThreadError,
    ThreadHealthError,
    ThreadTerminatedError,
    ThreadTimeoutError,
    GPUComputeError,
} from "./error";
import {
    createPool,
    createThread,
    createWorker,
    createWorkerDef,
    createManagedThread,
    createGPUOp,
    createGPUPipeline,
    createGPUReducer,
} from "./factory";
import {
    useThread,
    usePool,
    useThreadMetrics,
    usePoolMetrics,
    useThreadWorker,
    useThreadEvent,
} from "./hooks";
import {
    createZustandBinder,
    createSignalBinder,
    createStoreBinder,
    createPoolBinder,
} from "./adapters";
import {
  GPUCompute,
  PipelineChain,
  DataPipelineChain,
    createGPUCompute,
    createGPUWithFallback,
    outputSpec,
    uniform,
} from "./gpu";
import {
    useGPU,
    useGPURun,
    useGPUMetrics,
    useGPUStatus,
} from "./gpu-hooks";
import {
    createGPUBinder,
    createGPUSignalBinder,
    createGPUStoreBinder,
} from "./gpu-adapters";
import { buildShader, BUILT_IN_OPS, BUILT_IN_OP_NAMES, SPECIAL_OPS } from "./shaders";
import { Metrics } from "./metrix";
import { ThreadPool } from "./pool";
import { Serializer } from "./serializer";
import { Thread } from "./thread";

export {
  // Errors
  ThreadError,
  ThreadTimeoutError,
  ThreadAbortError,
  ThreadTerminatedError,
  ThreadHealthError,
  ThreadDependencyError,
  GPUComputeError,
  // Classes
  Metrics,
  Serializer,
  Thread,
  ThreadPool,
  GPUCompute,
  PipelineChain,
  DataPipelineChain,
  // CPU Factories
  createThread,
  createPool,
  createWorker,
  createWorkerDef,
  createManagedThread,
  // GPU Factories
  createGPUCompute,
  createGPUWithFallback,
  createGPUOp,
  createGPUPipeline,
  createGPUReducer,
  outputSpec,
  uniform,
  // Shaders
  buildShader,
  BUILT_IN_OPS,
  BUILT_IN_OP_NAMES,
  // Hooks (Preact / React)
  useThread,
  usePool,
  useThreadMetrics,
  usePoolMetrics,
  useThreadWorker,
  useThreadEvent,
  // GPU Hooks (Preact / React)
  useGPU,
  useGPURun,
  useGPUMetrics,
  useGPUStatus,
  // Adapters (framework-agnostic)
  createZustandBinder,
  createSignalBinder,
  createStoreBinder,
  createPoolBinder,
  // GPU Adapters
  createGPUBinder,
  createGPUSignalBinder,
  createGPUStoreBinder,
};

export default {
  // Errors
  ThreadError,
  ThreadTimeoutError,
  ThreadAbortError,
  ThreadTerminatedError,
  ThreadHealthError,
  ThreadDependencyError,
  GPUComputeError,
  // Classes
  Metrics,
  Serializer,
  Thread,
  ThreadPool,
  GPUCompute,
  PipelineChain,
  DataPipelineChain,
  // CPU Factories
  createThread,
  createPool,
  createWorker,
  createWorkerDef,
  createManagedThread,
  // GPU Factories
  createGPUCompute,
  createGPUWithFallback,
  createGPUOp,
  createGPUPipeline,
  createGPUReducer,
  outputSpec,
  uniform,
  // Shaders
  buildShader,
  BUILT_IN_OPS,
  BUILT_IN_OP_NAMES,
  // Hooks
  useThread,
  usePool,
  useThreadMetrics,
  usePoolMetrics,
  useThreadWorker,
  useThreadEvent,
  // GPU Hooks
  useGPU,
  useGPURun,
  useGPUMetrics,
  useGPUStatus,
  // Adapters
  createZustandBinder,
  createSignalBinder,
  createStoreBinder,
  createPoolBinder,
  // GPU Adapters
  createGPUBinder,
  createGPUSignalBinder,
  createGPUStoreBinder,
};
