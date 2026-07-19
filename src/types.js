/**
 * @file Central type definitions for the thread library.
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
 * } from 'thread/types';
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

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Top-level thread configuration object.
 *
 * Created via {@link defineConfig} in `thread.config.js`.  All fields are
 * optional — omitted values use built-in defaults.
 *
 * The config is **frozen** (immutable) after creation.  Mutating it
 * has no effect.
 *
 * @typedef {Object} threadConfig
 *
 * @property {'preact'|'react'|'svelte'|'vue'|'solid'|'angular'|'custom'} [framework='preact']
 *   UI framework.  Determines which hooks (`useState`, `useEffect`, etc.)
 *   are imported at module load time.
 *
 *   The framework is resolved via dynamic `import()` — no hardcoded
 *   dependency.  Supported values:
 *
 *   | Value | Import path | Status |
 *   |-------|------------|--------|
 *   | `'preact'` | `preact/hooks` | Supported |
 *   | `'react'` | `react` | Supported |
 *   | `'svelte'` | `svelte/reactivity` | Supported (partial) |
 *   | `'vue'` | `vue` | Supported (partial) |
 *   | `'solid'` | `solid-js` | Supported |
 *   | `'angular'` | — | Coming soon |
 *   | `'custom'` | — | User provides `customHookSource` |
 *
 * @property {'zustand'|'signals'|'redux'|'jotai'|'mobx'|'vanilla'|'custom'} [stateManager='zustand']
 *   State manager.  Determines which adapter constructors are available
 *   for binding threads/GPUs to your store.
 *
 *   | Value | Adapter type | Thread adapter | GPU adapter |
 *   |-------|-------------|---------------|-------------|
 *   | `'zustand'` | action | `createZustandBinder` | `createGPUBinder` |
 *   | `'signals'` | signal | `createSignalBinder` | `createGPUSignalBinder` |
 *   | `'redux'` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 *   | `'jotai'` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 *   | `'mobx'` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 *   | `'vanilla'` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 *   | `'custom'` | — | User provides `customAdapter` | — |
 *
 * @property {Function|null} [customHookSource=null]
 *   Custom hook source function.  When `framework: 'custom'`, this
 *   function is called and must return an object with:
 *   `{ useState, useEffect, useRef, useCallback, useMemo }`.
 *
 *   @example
 *   ```js
 *   customHookSource: async () => {
 *     const mod = await import('my-framework/hooks');
 *     return {
 *       useState: mod.useState,
 *       useEffect: mod.useEffect,
 *       useRef: mod.useRef,
 *       useCallback: mod.useCallback,
 *       useMemo: mod.useMemo,
 *     };
 *   }
 *   ```
 *
 * @property {Function|null} [customAdapter=null]
 *   Custom adapter factory.  When `stateManager: 'custom'`, this
 *   function receives `(instance, store, action, options)` and must
 *   return `{ run: Function, destroy: Function }`.
 *
 *   @example
 *   ```js
 *   customAdapter: (instance, store, action) => ({
 *     run: async (...args) => {
 *       const result = await instance.run(...args);
 *       store.dispatch({ type: action, payload: result });
 *     },
 *     destroy: () => {},
 *   })
 *   ```
 *
 * @property {threadGPUConfig} [gpu={}]
 *   GPU compute defaults.  Applied to all `GPUCompute` instances created
 *   after the config is loaded.
 *
 * @property {threadThreadConfig} [thread={}]
 *   Thread defaults.  Applied to all threads created via factory functions.
 *
 * @property {threadPoolConfig} [pool={}]
 *   Pool defaults.  Applied to all thread pools created via factory functions.
 *
 * @property {threadDevConfig} [dev={}]
 *   Development options.  Controls logging, metrics, and debugging.
 *
 * @example
 * ```js
 * // thread.config.js
 * import { defineConfig } from 'thread/config';
 *
 * export default defineConfig({
 *   framework: 'react',
 *   stateManager: 'zustand',
 *   gpu: {
 *     workgroupSize: 256,
 *     powerPreference: 'high-performance',
 *   },
 *   thread: { timeout: 30_000 },
 *   pool: { autoRestart: true },
 *   dev: { log: true },
 * });
 * ```
 */

/**
 * GPU compute configuration section.
 *
 * These defaults are applied to all `GPUCompute` instances created
 * after the config is loaded.  Individual instances can override
 * these via their constructor options.
 *
 * @typedef {Object} threadGPUConfig
 *
 * @property {number} [workgroupSize=256]
 *   Workgroup size for compute shaders.  Must match the
 *   `@workgroup_size(N)` declaration in your WGSL shaders.
 *   Higher values use more GPU resources but may improve throughput
 *   for large datasets.
 *
 * @property {number} [maxBufferSize=268435456]
 *   Maximum buffer size in bytes (default 256 MB).  Buffers
 *   exceeding this limit are rejected.  Increase for large datasets.
 *
 * @property {string} [entryPoint='main']
 *   Shader entry point function name.  Must match the function
 *   name in your WGSL shader (e.g. `@compute @workgroup_size(256) fn main(…)`)
 *
 * @property {'low-power'|'high-performance'} [powerPreference='high-performance']
 *   GPU power preference.  `'high-performance'` uses the discrete GPU
 *   if available.  `'low-power'` uses the integrated GPU.
 *
 * @property {Function|null} [cpuFallback=null]
 *   CPU fallback function.  Called with the compute input when WebGPU
 *   is unavailable or the GPU fails.  Useful for development on
 *   machines without WebGPU support.
 *
 * @property {Object} [adapterOptions={}]
 *   Options passed to `navigator.gpu.requestAdapter()`.  Use this
 *   to select a specific GPU adapter.
 *
 * @property {string|null} [shader=null]
 *   Default WGSL compute shader source.  Optional if you only use
 *   `run()` with built-in ops.
 *
 * @example
 * ```js
 * gpu: {
 *   workgroupSize: 256,           // Match @workgroup_size(256) in shaders
 *   maxBufferSize: 512 * 1024 * 1024,  // 512 MB for large datasets
 *   powerPreference: 'low-power', // Prefer integrated GPU
 *   cpuFallback: (input) => {     // Fallback for no WebGPU
 *     return input.inputs.data.reduce((a, b) => a + b, 0);
 *   },
 * }
 * ```
 */

/**
 * Thread configuration section.
 *
 * These defaults are applied to all threads created via factory
 * functions (`createThread`, `createPool`, `createWorker`, etc.).
 * Individual threads can override these via their options.
 *
 * @typedef {Object} threadThreadConfig
 *
 * @property {number} [timeout=30000]
 *   Task timeout in milliseconds.  If a task runs longer than this,
 *   it is automatically aborted and a `ThreadTimeoutError` is thrown.
 *
 * @property {number} [idleTimeout]
 *   Idle timeout in milliseconds.  If a thread has no tasks for this
 *   duration, it is automatically terminated.  `undefined` = never idle timeout.
 *
 * @property {number} [healthCheckInterval]
 *   Health check interval in milliseconds.  The pool periodically
 *   pings each thread to ensure it's responsive.  `undefined` = no health checks.
 *
 * @property {number} [healthCheckTimeout]
 *   Health check timeout in milliseconds.  If a thread doesn't respond
 *   to a health check within this time, it's considered crashed.
 *
 * @property {number} [concurrency]
 *   Maximum concurrent tasks per thread.  Default is `1` (one task at a time).
 *
 * @example
 * ```js
 * thread: {
 *   timeout: 10_000,              // 10 second task timeout
 *   idleTimeout: 60_000,          // Kill idle threads after 60s
 *   healthCheckInterval: 5_000,   // Ping threads every 5s
 *   healthCheckTimeout: 2_000,    // Kill unresponsive threads after 2s
 * }
 * ```
 */

/**
 * Pool configuration section.
 *
 * These defaults are applied to all thread pools created via factory
 * functions.  Individual pools can override these via their options.
 *
 * @typedef {Object} threadPoolConfig
 *
 * @property {boolean} [autoRestart=true]
 *   Automatically restart crashed workers.  When a worker crashes,
 *   a replacement is spawned and pending tasks are re-queued.
 *
 * @property {boolean} [enableStealing=true]
 *   Enable work-stealing.  Idle threads can steal tasks from busy
 *   threads' queues, improving load balancing.
 *
 * @property {number} [maxSize]
 *   Maximum number of threads in the pool.  `undefined` = unlimited.
 *
 * @property {Function} [keyHasher]
 *   Function that maps task arguments to an affinity key.  Tasks with
 *   the same key are routed to the same thread (useful for stateful
 *   workers).  Default is `JSON.stringify`.
 *
 * @example
 * ```js
 * pool: {
 *   autoRestart: true,            // Replace crashed workers
 *   enableStealing: true,         // Allow work-stealing
 *   maxSize: 8,                   // Cap at 8 threads
 *   keyHasher: (args) => args[0]?.id ?? 'default',  // Route by ID
 * }
 * ```
 */

/**
 * Development configuration section.
 *
 * Controls logging, metrics, and debugging features.  These are
 * typically `false` in production.
 *
 * @typedef {Object} threadDevConfig
 *
 * @property {boolean} [log=false]
 *   Forward worker `console.log` messages to the main thread.
 *   Useful for debugging but noisy in production.
 *
 * @property {boolean} [metrics=false]
 *   Enable metrics collection.  When `true`, thread and pool instances
 *   track timing, throughput, and error rates.  Has a small performance
 *   overhead.
 *
 * @property {number} [warnOnLongTask=0]
 *   Warn if a task exceeds N milliseconds.  Set to `0` to disable.
 *   Useful for finding performance bottlenecks during development.
 *
 * @example
 * ```js
 * dev: {
 *   log: true,                    // See worker logs in console
 *   metrics: true,                // Track performance
 *   warnOnLongTask: 1_000,        // Warn if task > 1 second
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Environment detection types
// ---------------------------------------------------------------------------

/**
 * Environment detection result.
 *
 * Returned by {@link env} and used internally for cross-platform
 * compatibility decisions.
 *
 * @typedef {Object} threadEnv
 *
 * @property {'browser'|'node'|'bun'|'deno'|'edge'|'unknown'} runtime
 *   Detected JavaScript runtime.
 *
 * @property {'main'|'worker'|'service-worker'|'unknown'} context
 *   Current execution context (main thread vs worker).
 *
 * @property {boolean} isBrowser
 *   `true` if running in a browser environment (including Web Workers).
 *
 * @property {boolean} isNode
 *   `true` if running in Node.js.
 *
 * @property {boolean} isBun
 *   `true` if running in Bun.
 *
 * @property {boolean} isDeno
 *   `true` if running in Deno.
 *
 * @property {boolean} isEdge
 *   `true` if running in an edge runtime (Cloudflare Workers, Vercel Edge).
 *
 * @property {boolean} isWorker
 *   `true` if running in a worker context (not main thread).
 *
 * @property {boolean} isMainThread
 *   `true` if running on the main thread.
 *
 * @property {boolean} hasWorker
 *   `true` if the Worker API is available.
 *
 * @property {boolean} hasGPU
 *   `true` if WebGPU is available.
 *
 * @property {boolean} hasFS
 *   `true` if the `fs` module is available (Node/Bun).
 *
 * @property {boolean} hasPath
 *   `true` if the `path` module is available (Node/Bun).
 *
 * @property {boolean} hasMemoryAPI
 *   `true` if `performance.memory` is available (Chrome).
 *
 * @property {boolean} hasBlob
 *   `true` if `Blob` and `URL.createObjectURL` are available.
 *
 * @property {boolean} hasDynamicImport
 *   `true` if dynamic `import()` is available.
 *
 * @property {function(string): any|null} requireModule
 *   Safely require a Node.js built-in module.  Returns `null` if unavailable.
 *
 * @property {function(): string} getCwd
 *   Get the current working directory across environments.
 *
 * @property {function(string): string|null} readFileSync
 *   Read a file synchronously.  Returns `null` in browser environments.
 *
 * @property {function(string): boolean} fileExists
 *   Check if a file exists on disk.
 *
 * @property {function(...string): string} resolvePath
 *   Resolve a file path relative to the current working directory.
 */

/**
 * GPU environment detection result.
 *
 * Returned by {@link gpuEnv} and used for GPU availability checks.
 *
 * @typedef {Object} threadGPUEnv
 *
 * @property {Promise<boolean>} available
 *   Async GPU availability check (cached after first call).
 *
 * @property {boolean} sync
 *   Synchronous check for `navigator.gpu` presence.
 *
 * @property {string} runtime
 *   Current runtime identifier.
 *
 * @property {boolean} isBrowser
 *   `true` if in a browser environment.
 *
 * @property {boolean} isNode
 *   `true` if in Node.js or Bun.
 *
 * @property {boolean} isDeno
 *   `true` if in Deno.
 *
 * @property {function(Object=): Promise<GPUAdapter|null>} requestAdapter
 *   Request a GPU adapter from the current environment.
 *
 * @property {function(Object=): Promise<{adapter: GPUAdapter, device: GPUDevice}|null>} requestDevice
 *   Request a GPU device (adapter + device).
 *
 * @property {function(): Promise<Object>} info
 *   Get diagnostic GPU information.
 */

/**
 * Worker info result.
 *
 * Returned by {@link workerInfo} to describe Worker support.
 *
 * @typedef {Object} threadWorkerInfo
 *
 * @property {boolean} supported
 *   `true` if Worker creation is supported.
 *
 * @property {'browser'|'node'|'bun'|'deno'|'none'} type
 *   Type of Worker support detected.
 *
 * @property {string} details
 *   Human-readable description of the Worker implementation.
 */

/**
 * Worker interface (cross-platform).
 *
 * Unified API that works across browser, Node.js, Bun, and Deno.
 *
 * @typedef {Object} threadWorkerInterface
 *
 * @property {function(MessageEvent): void} onmessage
 *   Message handler (set by the host).
 *
 * @property {function(ErrorEvent): void} onerror
 *   Error handler (set by the host).
 *
 * @property {function(MessageEvent): void} onmessageerror
 *   Message error handler (set by the host).
 *
 * @property {function(*, Transferable[]=): void} postMessage
 *   Post a message to the worker.
 *
 * @property {function(): void} terminate
 *   Terminate the worker and clean up resources.
 */
