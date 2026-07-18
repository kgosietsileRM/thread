/**
 * @file Central type definitions for the sewt library.
 *
 * Import these types in TypeScript projects for full editor intellisense:
 *
 * ```ts
 * import type {
 *   // Thread & Pool
 *   ThreadDefinition,
 *   ThreadOptions,
 *   ThreadRunOptions,
 *   PoolOptions,
 *   PoolRunOptions,
 *   PoolTaskResult,
 *   PoolStatus,
 *   // GPU
 *   GPUComputeOptions,
 *   GPUComputeInput,
 *   GPUComputeSnapshot,
 *   OpDeclaration,
 *   // Hooks
 *   UseThreadReturn,
 *   UsePoolReturn,
 *   UseGPUReturn,
 *   UseGPURunReturn,
 *   // Adapters
 *   ZustandBinderOptions,
 *   SignalBinderOptions,
 *   StoreBinderOptions,
 *   BinderHandle,
 *   Signal,
 *   // Common
 *   MetricsSnapshot,
 *   ThreadEventName,
 * } from 'sewt/types';
 * ```
 *
 * @module types
 */

// ---------------------------------------------------------------------------
// Thread definition (what the worker executes)
// ---------------------------------------------------------------------------

/**
 * An object describing the worker's lifecycle and execution logic.
 *
 * Use this form when you need **persistent state** that survives across task
 * invocations.  The `setup` function runs exactly once when the worker starts,
 * and its return value becomes `state` – the first argument to every `exec`
 * call.  `cleanup` runs right before the worker is terminated.
 *
 * @example
 * // A counter that remembers its count between calls.
 * const definition = {
 *   setup() {
 *     return { count: 0 };
 *   },
 *   exec(state, delta) {
 *     state.count += delta;
 *     return state.count;
 *   },
 *   cleanup(state) {
 *     console.log('Final count:', state.count);
 *   },
 * };
 *
 * @typedef {Object} ThreadDefinition
 * @property {((state: any) => any | Promise<any>) | null} [setup]
 *   Runs once when the worker starts.  Return value is stored as `state`
 *   and passed as the first argument to every `exec` call.
 * @property {(state: any, ...args: any[], ctx: ThreadContext) => any | Promise<any>} exec
 *   Runs on every task invocation.  Receives `state` (from `setup`),
 *   then any arguments supplied to `thread.run(...)`, and finally a
 *   `ctx` context object for reporting progress and logs.
 * @property {((state: any) => void | Promise<void>) | null} [cleanup]
 *   Runs once before the worker is terminated.  Useful for flushing
 *   buffers, closing connections, etc.
 */

/**
 * Context object passed as the **last** argument to every `exec` call.
 * Provides the worker-side API for communicating back to the host.
 *
 * @example
 * exec(state, items, ctx) {
 *   for (let i = 0; i < items.length; i++) {
 *     ctx.reportProgress(i / items.length);
 *     ctx.log(`Processing item ${i}`);
 *   }
 *   ctx.reportMemory();
 *   return items.length;
 * }
 *
 * @typedef {Object} ThreadContext
 * @property {(value: number) => void} reportProgress
 *   Report a progress value (0–1) back to the host.  Only delivered
 *   if the caller registered a `progress` listener or passed
 *   `hasProgress: true`.
 * @property {(message: string) => void} log
 *   Send a log message back to the host.  Delivered to every `log`
 *   listener registered on the Thread.
 * @property {() => void} reportMemory
 *   Request a memory report from the worker.  Delivered to every
 *   `memory` listener (browser-only, requires `performance.memory`).
 */

// ---------------------------------------------------------------------------
// Thread options
// ---------------------------------------------------------------------------

/**
 * Configuration for a {@link Thread} instance.
 *
 * @example
 * const thread = createThread((x) => x * 2, {
 *   timeout: 5000,           // reject if task takes >5s
 *   idleTimeout: 60_000,     // auto-terminate after 60s idle
 *   concurrency: 2,          // allow 2 concurrent tasks
 *   healthCheckInterval: 10_000,
 *   onLog: (msg) => console.log('[worker]', msg),
 *   onTiming: (ms) => console.log(`Task took ${ms.toFixed(1)}ms`),
 * });
 *
 * @typedef {Object} ThreadOptions
 * @property {number} [timeout=30000]
 *   Default timeout in milliseconds.  If a task does not resolve within
 *   this period, the promise rejects with a {@link ThreadTimeoutError}.
 *   Pass `{ timeout: n }` per-task to override.
 * @property {number} [idleTimeout=0]
 *   Automatically terminate the worker after this many milliseconds of
 *   inactivity.  `0` means **never** auto-terminate (the default).
 * @property {string[]} [imports]
 *   Script URLs to load via `importScripts()` inside the worker before
 *   any tasks run.  Useful for loading shared libraries.
 * @property {any[]} [initArgs]
 *   Arguments for a silent one-time initialisation run executed
 *   immediately after the worker starts.  The result is discarded.
 *   Useful for warming up WASM modules or opening IndexedDB stores.
 * @property {Transferable[]} [initTransfer]
 *   Transferables for the `initArgs` run.
 * @property {number} [healthCheckInterval=0]
 *   How often (in ms) to ping the worker to verify it is alive.
 *   `0` disables health checks.
 * @property {number} [healthCheckTimeout=5000]
 *   Max ms to wait for a health-check pong before declaring the
 *   worker unhealthy.
 * @property {number} [concurrency=1]
 *   Maximum number of tasks this worker can execute concurrently.
 *   Setting this >1 turns the single worker into a small N-worker.
 * @property {((args: any[]) => any[]) | null} [onBeforeRun]
 *   Hook called before each task.  Receives the argument array; return
 *   a new array to replace the arguments, or `undefined` to keep them.
 * @property {((result: any) => any) | null} [onAfterRun]
 *   Hook called after each successful task.  Return a new value to
 *   replace the result, or `undefined` to keep it.
 * @property {((result: any, event: MessageEvent) => void) | null} [onResult]
 *   Global listener invoked on every successful result.
 * @property {((info: {error: string, stack?: string}, event: MessageEvent) => void) | null} [onError]
 *   Global listener invoked on every error.
 * @property {((value: any, event: MessageEvent) => void) | null} [onProgress]
 *   Global listener invoked on every progress update.
 * @property {((durationMs: number, args: any[]) => void) | null} [onTiming]
 *   Listener invoked with the wall-clock duration of each task.
 * @property {((message: string, event: MessageEvent) => void) | null} [onLog]
 *   Listener invoked when the worker calls `ctx.log(msg)`.
 * @property {((memory: any, event: MessageEvent) => void) | null} [onMemory]
 *   Listener invoked when the worker calls `ctx.reportMemory()`.
 * @property {((snapshot: MetricsSnapshot) => void) | null} [onMetrics]
 *   Listener invoked after every completed task with the latest
 *   metrics snapshot.
 */

// ---------------------------------------------------------------------------
// Thread run options (per-task overrides)
// ---------------------------------------------------------------------------

/**
 * Per-task options passed as the **last** argument to `thread.run()`.
 *
 * @example
 * const controller = new AbortController();
 * const result = await thread.run(largeData, {
 *   timeout: 10_000,
 *   signal: controller.signal,
 *   retries: 2,
 *   transfer: [largeData.buffer],
 *   cacheTTL: 30_000,
 * });
 *
 * @typedef {Object} ThreadRunOptions
 * @property {number} [timeout]
 *   Override the thread's default timeout for this task (ms).
 * @property {Transferable[]} [transfer]
 *   Array of `Transferable` objects (e.g. `ArrayBuffer`) to transfer
 *   to the worker instead of copying.  Dramatically improves speed
 *   for large binary data.
 * @property {AbortSignal} [signal]
 *   An `AbortSignal` to cancel the task.  When `signal.abort()` fires,
 *   the task promise rejects with a {@link ThreadAbortError}.
 * @property {number} [retries]
 *   Number of times to retry the task if the worker crashes or the
 *   `postMessage` call fails.
 * @property {number} [cacheTTL]
 *   Cache the result for this many milliseconds.  Subsequent calls
 *   with identical arguments return the cached value instantly.
 *   `0` disables caching (the default).
 */

// ---------------------------------------------------------------------------
// Pool types
// ---------------------------------------------------------------------------

/**
 * Configuration for a {@link ThreadPool}.
 *
 * @example
 * const pool = createPool(4, heavyComputation, {
 *   timeout: 30_000,
 *   autoRestart: true,
 *   maxSize: 8,
 *   healthCheckInterval: 5_000,
 *   enableStealing: true,
 *   keyHasher: (args) => String(args[0].id),  // route by entity id
 * });
 *
 * @typedef {Object} PoolOptions
 * @property {number} [timeout]
 *   Default timeout applied to every task (ms).  Individual tasks can
 *   override this via their own options.
 * @property {number} [idleTimeout]
 *   Idle timeout forwarded to each thread.
 * @property {string[]} [imports]
 *   Script URLs forwarded to each thread.
 * @property {boolean} [autoRestart=true]
 *   When a worker crashes, automatically replace it with a fresh
 *   worker and move any queued tasks back into the global queue.
 * @property {number} [maxSize=Infinity]
 *   Hard upper limit on the number of threads.  `scaleTo()` and
 *   auto-restart will never exceed this.
 * @property {number} [healthCheckInterval]
 *   Health-check interval forwarded to each thread.
 * @property {number} [healthCheckTimeout]
 *   Health-check timeout forwarded to each thread.
 * @property {((args: any[]) => string) | null} [keyHasher]
 *   Function that maps task arguments to a string key for affinity
 *   routing.  Tasks with the same key are preferentially routed to
 *   the same thread (useful for caches and connection pools).
 * @property {boolean} [enableStealing=true]
 *   Enable work-stealing: idle threads can steal queued tasks from
 *   busy threads' local queues.
 * @property {number} [concurrency]
 *   Max parallel tasks per worker (forwarded to each thread).
 */

/**
 * Options for a single {@link ThreadPool.run} call.
 *
 * @example
 * const { id, promise } = pool.run(data, {
 *   priority: 1,        // lower = higher priority
 *   dependsOn: [a, b],  // wait for tasks a and b to finish first
 *   timeout: 5000,
 *   retries: 1,
 * });
 *
 * @typedef {Object} PoolRunOptions
 * @property {number} [priority=0]
 *   Task priority.  Lower numbers are dequeued first.  Default is `0`.
 * @property {number[]} [dependsOn]
 *   Array of task IDs that must complete before this task starts.
 *   If any dependency fails, this task is rejected with a
 *   {@link ThreadDependencyError}.
 * @property {string} [key]
 *   Affinity key.  If a `keyHasher` is configured, this overrides it.
 * @property {number} [timeout]
 *   Per-task timeout (ms).  Overrides the pool default.
 * @property {Transferable[]} [transfer]
 *   Transferables for this task.
 * @property {AbortSignal} [signal]
 *   AbortSignal for this task.
 * @property {number} [retries]
 *   Retry count for this task.
 */

/**
 * The object returned by {@link ThreadPool.run}.  Contains both the
 * auto-generated task ID and the result promise.
 *
 * @example
 * const { id, promise } = pool.run(42);
 * const result = await promise; // 43
 *
 * // Use the id to set up dependencies:
 * const child = pool.run(100, { dependsOn: [id] });
 *
 * @typedef {Object} PoolTaskResult
 * @property {number} id
 *   Auto-incrementing task ID.  Used for dependency tracking and
 *   cancellation via `pool.cancel(id)`.
 * @property {Promise<any>} promise
 *   Resolves with the task result, or rejects with one of:
 *   - {@link ThreadTimeoutError} if the task exceeds its timeout
 *   - {@link ThreadAbortError} if the task was cancelled or aborted
 *   - {@link ThreadTerminatedError} if the pool was terminated
 *   - {@link ThreadDependencyError} if a dependency failed
 *   - {@link ThreadError} for worker-side errors
 */

/**
 * Snapshot of pool state returned by {@link ThreadPool.status}.
 *
 * @typedef {Object} PoolStatus
 * @property {number} total
 *   Total number of threads (including busy ones).
 * @property {number} busy
 *   Number of threads currently executing a task.
 * @property {number} idle
 *   `total - busy`.
 * @property {number} queued
 *   Number of tasks waiting in the global queue + blocked tasks
 *   waiting on dependencies.
 * @property {number} localQueued
 *   Sum of all threads' local queues (work-stealing candidates).
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Point-in-time metrics snapshot returned by {@link Metrics.snapshot}.
 *
 * **Note:** `avg`, `min`, `max`, and `throughput` are computed from
 * **successful** tasks only.  Errors are counted separately and do not
 * skew the averages.
 *
 * @example
 * const snap = thread.metrics;
 * console.log(`${snap.count} tasks, ${snap.avg.toFixed(1)}ms avg`);
 * console.log(`${(snap.errorRate * 100).toFixed(1)}% error rate`);
 *
 * @typedef {Object} MetricsSnapshot
 * @property {number} count
 *   Total number of recorded tasks (successes + errors).
 * @property {number} errors
 *   Number of failed tasks.
 * @property {number} avg
 *   Average duration of successful tasks in ms.  `0` if no successes.
 * @property {number} min
 *   Minimum duration of successful tasks in ms.  `0` if no successes.
 * @property {number} max
 *   Maximum duration of successful tasks in ms.  `0` if no successes.
 * @property {number} throughput
 *   Successful tasks per second.  `0` if no successes.
 * @property {number} errorRate
 *   Fraction of tasks that failed (0–1).  `0` if no tasks recorded.
 */

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * A value that has been serialized by {@link Serializer.serialize}.
 * Functions are converted into `{ __type: 'function', __value: string }`
 * objects; all other values pass through unchanged.
 *
 * @typedef {*} SerializedValue
 */

// ---------------------------------------------------------------------------
// Thread events
// ---------------------------------------------------------------------------

/**
 * Valid event names for {@link Thread.on} and {@link Thread.off}.
 *
 * | Event       | Callback signature                         | Description |
 * |-------------|--------------------------------------------|-------------|
 * | `result`    | `(result, event) => void`                  | Task succeeded |
 * | `error`     | `({error, stack}, event) => void`          | Task or worker error |
 * | `progress`  | `(value, event) => void`                   | Progress update |
 * | `terminate` | `() => void`                               | Thread terminated |
 * | `idle`      | `() => void`                               | Thread went idle |
 * | `timing`    | `(durationMs, args) => void`               | Task timing |
 * | `beforeRun` | `(args) => args \| undefined`               | Pre-task hook |
 * | `afterRun`  | `(result) => result \| undefined`           | Post-task hook |
 * | `log`       | `(message, event) => void`                 | Worker log |
 * | `memory`    | `(memory, event) => void`                  | Memory report |
 * | `health`    | `({status: 'ready'}) => void`              | Worker ready |
 * | `metrics`   | `(snapshot: MetricsSnapshot) => void`      | Metrics update |
 *
 * @typedef {'result'|'error'|'progress'|'terminate'|'idle'|'timing'|'beforeRun'|'afterRun'|'log'|'memory'|'health'|'metrics'} ThreadEventName
 */

// ---------------------------------------------------------------------------
// Thread instance shape (for consumers who use createThread)
// ---------------------------------------------------------------------------

/**
 * The public interface of a {@link Thread} instance.
 *
 * @typedef {Object} ThreadInstance
 * @property {(args: ...any) => Promise<any>} run
 *   Execute a task and return its result.
 * @property {(tasks: any[][], options?: ThreadRunOptions) => Promise<any[]>} runBatch
 *   Execute multiple argument sets in one worker call.
 * @property {(args: ...any) => void} runAsync
 *   Fire-and-forget: send a task without waiting.
 * @property {(initialValue: any, ...fns: Function[]) => Promise<any>} runChain
 *   Pipe a value through a sequence of functions, each in its own worker.
 * @property {(array: any[], chunkSize: number, processor: Function, options?: ThreadRunOptions) => AsyncGenerator<any>} runStreaming
 *   Process an array in chunks, yielding results as they complete.
 * @property {(newExec: Function) => void} reload
 *   Hot-swap the worker's exec function and restart.
 * @property {(timeout?: number) => Promise<void>} warmup
 *   Warm up the worker with a no-op task.
 * @property {() => Promise<void>} terminateGracefully
 *   Wait for pending tasks, run cleanup, then terminate.
 * @property {() => void} terminate
 *   Immediately terminate the worker and reject all pending tasks.
 * @property {(event: ThreadEventName, handler: Function) => ThreadInstance} on
 *   Register an event listener (chainable).
 * @property {(event: ThreadEventName, handler: Function) => ThreadInstance} off
 *   Remove an event listener (chainable).
 * @property {MetricsSnapshot} metrics
 *   Current metrics snapshot (getter).
 * @property {boolean} busy
 *   `true` if the thread has pending tasks (getter).
 * @property {boolean} terminated
 *   `true` if `terminate()` has been called (getter).
 */

// ---------------------------------------------------------------------------
// ThreadPool instance shape
// ---------------------------------------------------------------------------

/**
 * The public interface of a {@link ThreadPool} instance.
 *
 * @typedef {Object} ThreadPoolInstance
 * @property {(args: ...any) => PoolTaskResult} run
 *   Submit a task.  Returns `{ id, promise }`.
 * @property {(taskId: number) => boolean} cancel
 *   Cancel a queued task by ID.
 * @property {(newSize: number) => void} scaleTo
 *   Dynamically resize the pool.
 * @property {() => Promise<void>} terminateGracefully
 *   Wait for all tasks to finish, then terminate every thread.
 * @property {() => void} terminateAll
 *   Immediately terminate all threads and reject queued tasks.
 * @property {() => PoolStatus} status
 *   Return current pool status.
 * @property {() => Promise<void>} drain
 *   Wait for all tasks to finish (without terminating).
 * @property {(timeout?: number) => Promise<void>} warmup
 *   Warm up every thread.
 * @property {MetricsSnapshot} metrics
 *   Cumulative pool-wide metrics snapshot (getter).
 */

// ---------------------------------------------------------------------------
// Hook return types (Preact / React)
// ---------------------------------------------------------------------------

/**
 * Return value of the {@link useThread} hook.
 *
 * @typedef {Object} UseThreadReturn
 * @property {ThreadInstance} thread
 *   The underlying thread instance.  Use for direct access to
 *   `thread.metrics`, `thread.busy`, etc.
 * @property {(args: ...any) => Promise<any>} run
 *   Execute a task and update reactive state (`result`, `error`,
 *   `loading`).  Returns a promise with the result.
 * @property {(args: ...any) => void} runAsync
 *   Fire-and-forget: send a task without waiting or updating state.
 * @property {any} result
 *   The result of the most recent successful `run()` call.
 *   `null` initially and after errors.
 * @property {string | null} error
 *   Error message from the most recent failed `run()` call.
 *   `null` when there is no error.
 * @property {boolean} loading
 *   `true` while a task is in flight.
 * @property {boolean} terminated
 *   `true` after the thread has been terminated (on unmount).
 */

/**
 * Return value of the {@link usePool} hook.
 *
 * @typedef {Object} UsePoolReturn
 * @property {ThreadPoolInstance} pool
 *   The underlying pool instance.
 * @property {(args: ...any) => PoolTaskResult} run
 *   Submit a task.  Returns `{ id, promise }`.
 * @property {(taskId: number) => boolean} cancel
 *   Cancel a queued task by ID.
 * @property {() => PoolStatus} status
 *   Get current pool status.
 * @property {MetricsSnapshot} metrics
 *   Live metrics snapshot, updated at the polling interval.
 * @property {boolean} terminated
 *   `true` after the pool has been terminated (on unmount).
 */

// ---------------------------------------------------------------------------
// Adapter types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createZustandBinder}.
 *
 * @typedef {Object} ZustandBinderOptions
 * @property {string} [errorAction]
 *   Store action name to call on error.  Receives `(errorMessage)`.
 * @property {boolean} [append=false]
 *   If `true`, results are passed to the action expecting to append
 *   to an existing array.
 * @property {string} [metricsAction]
 *   Store action name to call with metrics snapshots.
 */

/**
 * Configuration for {@link createSignalBinder}.
 *
 * @typedef {Object} SignalBinderOptions
 * @property {Object} [errorSignal]
 *   A Preact Signal to write error messages into.
 * @property {(result: any) => any} [transform]
 *   Transform the result before writing to the signal.
 */

/**
 * Configuration for {@link createStoreBinder}.
 *
 * @typedef {Object} StoreBinderOptions
 * @property {(error: string) => void} [onError]
 *   Called with the error message on failure.
 * @property {(result: any) => any} [transform]
 *   Transform the result before passing to the setter.
 * @property {(snapshot: MetricsSnapshot) => void} [onMetrics]
 *   Called with every metrics snapshot.
 */

/**
 * Configuration for {@link createPoolBinder}.
 *
 * @typedef {Object} PoolBinderOptions
 * @property {(error: string) => void} [onError]
 *   Called with the error message on failure.
 * @property {(snapshot: MetricsSnapshot) => void} [onMetrics]
 *   Called with every metrics snapshot.
 * @property {number} [batchInterval]
 *   If set, results are accumulated for this many ms and flushed as
 *   an array to the setter.
 */

/**
 * Return value of all binder/adapter functions.
 *
 * @typedef {Object} BinderHandle
 * @property {Function} run
 *   Execute a task and push the result to the bound state.
 * @property {Function} [destroy]
 *   Remove all event listeners.  Call on cleanup / unmount.
 * @property {Function} [flush]
 *   Manually flush accumulated batch results (pool binder only).
 */

// ---------------------------------------------------------------------------
// Signal compatibility (Preact Signals, Solid signals, etc.)
// ---------------------------------------------------------------------------

/**
 * A reactive signal with a readable/writable `.value` property.
 * Compatible with `@preact/signals`, Solid.js signals, and similar.
 *
 * @typedef {Object} Signal
 * @property {any} value
 *   The current value.  Reading triggers tracking; writing triggers
 *   reactivity updates.
 */

// ---------------------------------------------------------------------------
// GPU Compute types
// ---------------------------------------------------------------------------

/**
 * Configuration for a {@link GPUCompute} instance.
 *
 * @example
 * ```js
 * // Option A: provide a raw WGSL shader
 * const gpu = new GPUCompute({
 *   shader: `@compute @workgroup_size(256) fn main(...) { ... }`,
 * });
 *
 * // Option B: no shader — use run() with built-in ops
 * const gpu = new GPUCompute();
 * ```
 *
 * @typedef {Object} GPUComputeOptions
 * @property {string} [shader]
 *   WGSL compute shader source code.  Optional if you only use
 *   `run()` with built-in or user-defined ops.
 * @property {number} [workgroupSize=256]
 *   Workgroup size matching `@workgroup_size(N)` in the shader.
 *   Used to auto-calculate dispatch dimensions.
 * @property {number} [maxBufferSize=268435456]
 *   Maximum buffer size in bytes (default 256 MB).  Buffers exceeding
 *   this are rejected.
 * @property {Object} [adapterOptions]
 *   Options passed to `navigator.gpu.requestAdapter()`.
 * @property {'low-power'|'high-performance'|undefined} [powerPreference]
 *   GPU power preference.  Default is `'high-performance'`.
 * @property {Function} [cpuFallback]
 *   Optional CPU fallback function.  Called with {@link GPUComputeInput}
 *   when WebGPU is unavailable or the GPU fails.
 * @property {string} [entryPoint]
 *   Shader entry point function name.  Default is `'main'`.
 */

/**
 * Input specification for {@link GPUCompute.compute}.
 *
 * @example
 * ```js
 * await gpu.compute({
 *   inputs:  { data: new Float32Array([1, 2, 3, 4]) },
 *   uniforms: { scale: new Float32Array([2.0]) },
 *   outputBuffers: { result: 4 },
 *   outputType: 'f32',
 *   workgroups: 1,
 * });
 * ```
 *
 * @typedef {Object} GPUComputeInput
 * @property {Object<string, TypedArray>} [inputs={}]
 *   Map of binding names to TypedArray data.  Each entry becomes a
 *   `storage` buffer bound at incrementing binding indices starting
 *   from `bindingStart`.
 * @property {Object<string, TypedArray>} [uniforms={}]
 *   Map of binding names to TypedArray data for uniform buffers.
 *   Uniforms are bound after inputs at incrementing indices.
 * @property {Object<string, number>} [outputBuffers={}]
 *   Map of output binding names to element counts (not bytes).  Each
 *   entry creates a `storage + copy_src` buffer.
 * @property {string|typeof TypedArray} [outputType='f32']
 *   TypedArray constructor or name for output buffers.  Accepts:
 *   `'f32'`, `'i32'`, `'u32'`, `'f64'`, or a constructor like
 *   `Float32Array`.
 * @property {number|null} [workgroups=null]
 *   Number of workgroups to dispatch.  If `null`, calculated
 *   automatically from the largest input/output length.
 * @property {number} [bindingStart=0]
 *   First binding index.  Useful when multiple compute passes share a
 *   bind group layout.
 */

/**
 * A named pipeline step for {@link GPUCompute.computeSequential}.
 *
 * @typedef {Object} GPUComputeStep
 * @property {string} [pipeline]
 *   Pipeline name to switch to (omit to keep the current active pipeline).
 * @property {Object<string, TypedArray>} [inputs]
 *   Additional inputs for this step.  Previous outputs with matching
 *   names are merged automatically.
 * @property {Object<string, TypedArray>} [uniforms]
 *   Uniform buffers for this step.
 * @property {Object<string, number>} outputBuffers
 *   Output buffer specifications (name -> element count).
 * @property {string|typeof TypedArray} [outputType='f32']
 *   Output type for this step.
 */

/**
 * Diagnostic snapshot returned by {@link GPUCompute.inspect}.
 *
 * @typedef {Object} GPUComputeSnapshot
 * @property {'idle'|'running'|'error'|'unavailable'} status
 *   Current operational status.
 * @property {boolean} available
 *   Whether WebGPU is available in this environment.
 * @property {boolean} ready
 *   Whether the GPU device and pipelines are compiled.
 * @property {string} activePipeline
 *   Name of the currently active pipeline.
 * @property {string[]} pipelines
 *   Names of all registered pipelines.
 * @property {string[]} ops
 *   Names of all defined operations (built-in + custom).
 * @property {MetricsSnapshot} metrics
 *   Performance metrics snapshot.
 * @property {number} dispatchCount
 *   Total number of dispatches (successes + failures).
 * @property {number} bytesTransferred
 *   Approximate total bytes read/written to the GPU.
 * @property {number} bufferPoolEntries
 *   Number of pooled buffers available for reuse.
 * @property {number} workgroupSize
 *   Workgroup size configured on this instance.
 * @property {number} maxBufferSize
 *   Maximum buffer size in bytes.
 * @property {'low-power'|'high-performance'|undefined} powerPreference
 *   GPU power preference.
 */

/**
 * Declaration for a custom GPU operation passed to
 * {@link GPUCompute.define}.  Describes inputs, outputs, uniforms,
 * and the loop body that generates WGSL automatically.
 *
 * @example
 * ```js
 * gpu.define('scaleClamp', {
 *   inputs: ['data'],
 *   outputs: ['result'],
 *   uniforms: ['factor', 'maxVal'],
 *   body: `result[i] = min(data[i] * factor, maxVal);`,
 *   type: 'f32',
 *   fn: (input) => {
 *     const data = input.inputs.data;
 *     const factor = input.uniforms.factor[0];
 *     const maxVal = input.uniforms.maxVal[0];
 *     const result = new Float32Array(data.length);
 *     for (let i = 0; i < data.length; i++)
 *       result[i] = Math.min(data[i] * factor, maxVal);
 *     return { result };
 *   },
 * });
 * ```
 *
 * @typedef {Object} OpDeclaration
 * @property {string[]} [inputs=[]]
 *   Names of input storage bindings.  These become WGSL variables
 *   you reference in the body.
 * @property {string[]} [outputs=['result']]
 *   Names of output storage bindings.
 * @property {string[]} [uniforms=[]]
 *   Names of uniform bindings.
 * @property {string} body
 *   WGSL loop body.  The variable `i` (the element index) is
 *   pre-declared.  Reference binding names directly as variables.
 * @property {string} [type='f32']
 *   Element type: `'f32'`, `'i32'`, or `'u32'`.
 * @property {Function} [fn]
 *   Optional CPU fallback function.  Used when WebGPU is
 *   unavailable.  Receives `{ inputs, uniforms, outputs }` and
 *   should return `{ outputName: TypedArray }`.
 * @property {number} [workgroupSize]
 *   Override the instance's default workgroup size for this op.
 */

/**
 * A built-in operation definition (stored in `BUILT_IN_OPS`).
 *
 * @typedef {Object} BuiltInOp
 * @property {string[]} [inputs]
 *   Input binding names.
 * @property {string[]} [uniforms]
 *   Uniform binding names.
 * @property {string[]} outputs
 *   Output binding names.
 * @property {string} body
 *   WGSL loop body.
 */

/**
 * Low-level shader build declaration passed to {@link buildShader}.
 *
 * @typedef {Object} ShaderDeclaration
 * @property {string[]} [inputs=[]]
 *   Input binding names.
 * @property {string[]} [outputs=[]]
 *   Output binding names.
 * @property {string[]} [uniforms=[]]
 *   Uniform binding names.
 * @property {string} body
 *   WGSL loop body.
 * @property {string} [type='f32']
 *   Element type.
 * @property {number} [workgroupSize=256]
 *   Workgroup size.
 * @property {string} [name='main']
 *   Entry point function name.
 */

/**
 * Snapshot of GPU compute state returned by {@link GPUCompute.metrics}.
 *
 * @typedef {Object} GPUComputeMetrics
 * @property {number} count
 *   Total number of dispatches.
 * @property {number} errors
 *   Number of failed dispatches.
 * @property {number} avg
 *   Average dispatch duration in ms (successes only).
 * @property {number} min
 *   Minimum dispatch duration in ms (successes only).
 * @property {number} max
 *   Maximum dispatch duration in ms (successes only).
 * @property {number} throughput
 *   Dispatches per second (successes only).
 * @property {number} errorRate
 *   Fraction of dispatches that failed (0–1).
 */

// ---------------------------------------------------------------------------
// GPU Hook return types
// ---------------------------------------------------------------------------

/**
 * Return value of the {@link useGPU} hook.
 *
 * @typedef {Object} UseGPUReturn
 * @property {GPUCompute} gpu
 *   The underlying GPU instance.
 * @property {(args: ...any) => Promise<any>} run
 *   Execute a GPU operation and update reactive state.
 * @property {(name?: string, count?: number) => DataPipelineChain} pipe
 *   Start a fluent pipeline chain.
 * @property {(name: string, fn: Function) => void} define
 *   Register a new operation on the GPU instance.
 * @property {any} result
 *   The result of the most recent successful `run()` call.
 * @property {boolean} loading
 *   `true` while a GPU operation is in flight.
 * @property {string|null} error
 *   Error message from the most recent failed `run()` call.
 * @property {string} status
 *   Current GPU status: `'idle'`, `'running'`, `'error'`, or `'unavailable'`.
 * @property {MetricsSnapshot} metrics
 *   Live metrics snapshot, updated at the polling interval.
 */

/**
 * Return value of the {@link useGPURun} hook.
 *
 * @typedef {Object} UseGPURunReturn
 * @property {(args: ...any) => Promise<any>} run
 *   Execute a GPU operation and update reactive state.
 * @property {any} result
 *   The result of the most recent successful `run()` call.
 * @property {boolean} loading
 *   `true` while a GPU operation is in flight.
 * @property {string|null} error
 *   Error message from the most recent failed `run()` call.
 */

// ---------------------------------------------------------------------------
// GPU Adapter option types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createGPUBinder}.
 *
 * @typedef {Object} GPUBinderOptions
 * @property {string} [errorAction]
 *   Store action name to call on error.  Receives `(errorMessage)`.
 * @property {Function} [transform]
 *   Transform the result before writing to the store.
 * @property {string} [metricsAction]
 *   Store action name to call with metrics snapshots.
 */

/**
 * Configuration for {@link createGPUSignalBinder}.
 *
 * @typedef {Object} GPUSignalBinderOptions
 * @property {Object} [errorSignal]
 *   A Preact Signal to write error messages into.
 * @property {Function} [transform]
 *   Transform the result before writing to the signal.
 * @property {Object} [loadingSignal]
 *   A Preact Signal to write loading state (boolean) into.
 */

/**
 * Configuration for {@link createGPUStoreBinder}.
 *
 * @typedef {Object} GPUStoreBinderOptions
 * @property {Function} [onError]
 *   Called with the error message on failure.
 * @property {Function} [transform]
 *   Transform the result before passing to the setter.
 * @property {Function} [onMetrics]
 *   Called with metrics snapshots after each run.
 */

// ---------------------------------------------------------------------------
// Factory option types
// ---------------------------------------------------------------------------

/**
 * Options for {@link createManagedThread}.
 *
 * @typedef {Object} ManagedThreadOptions
 * @property {number} [timeout=30000]
 *   Task timeout in ms.
 * @property {boolean} [healthChecks=true]
 *   Enable automatic health checks.
 * @property {number} [healthCheckInterval=10000]
 *   Health check interval in ms.
 * @property {Function} [onMetrics]
 *   Callback for live metrics snapshots.
 * @property {Function} [onLog]
 *   Callback for worker log messages.
 * @property {ThreadOptions} [thread]
 *   Additional options forwarded to the Thread constructor.
 */

/**
 * Options for {@link createGPUOp}.
 *
 * @typedef {GPUComputeOptions} GPUOpOptions
 */

/**
 * Options for {@link createGPUPipeline}.
 *
 * @typedef {GPUComputeOptions} GPUPipelineOptions
 */

/**
 * Options for {@link createGPUReducer}.
 *
 * @typedef {GPUComputeOptions} GPUReducerOptions
 */
