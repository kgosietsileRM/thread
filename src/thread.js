/**
 * @file Single Web Worker wrapper with advanced features.
 *
 * `Thread` turns a plain JavaScript function (or a setup/exec/cleanup
 * definition) into a managed Web Worker that you can call from the main
 * thread.  Every `Thread` instance:
 *
 * - Spawns a real `Worker` from a Blob URL (zero network requests).
 * - Serialises your function and sends it to the worker automatically.
 * - Manages timeouts, abort signals, retries, and caching.
 * - Reports timing, progress, logs, and memory back to the host.
 * - Restarts automatically on crash with exponential back-off.
 * - Supports hot-reloading the exec function without re-creating the thread.
 *
 * **Quick start:**
 *
 * ```js
 * import { Thread } from './thread.js';
 *
 * const t = new Thread((x) => x * 2);
 * const result = await t.run(21); // 42
 * t.terminate();
 * ```
 *
 * **With stateful setup/exec/cleanup:**
 *
 * ```js
 * const t = new Thread({
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
 * });
 *
 * console.log(await t.run(1));  // 1
 * console.log(await t.run(5));  // 6
 * await t.terminateGracefully(); // logs "Final count: 6"
 * ```
 *
 * **How it works under the hood:**
 *
 * 1. Your function is converted to a string via `.toString()`.
 * 2. A small worker script is assembled that imports `importScripts`,
 *    initialises state via `setup`, and handles `onmessage`.
 * 3. The script is bundled into a `Blob` and loaded via
 *    `URL.createObjectURL`.
 * 4. When you call `run()`, the arguments are posted to the worker.
 *    The worker executes the function and posts the result back.
 * 5. On success the promise resolves; on error or timeout it rejects
 *    with one of the thread-specific error types.
 *
 * @module thread
 */

import {
    ThreadAbortError,
    ThreadError,
    ThreadDependencyError,
    ThreadHealthError,
    ThreadTerminatedError,
    ThreadTimeoutError
} from "./error";
import { Metrics } from "./metrix";
import { createWorker, terminateWorker, env } from "./worker-factory.js";

// ---------------------------------------------------------------------------
// Thread class
// ---------------------------------------------------------------------------

/**
 * A single Web Worker instance with advanced features.
 *
 * @see {@link ThreadOptions} for constructor configuration.
 * @see {@link ThreadRunOptions} for per-task overrides.
 */
export class Thread {
  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * Create a new managed Web Worker thread.
   *
   * @param {import('./types.js').ThreadDefinition | Function} definition
   *   Either a plain function (used as `exec` with no state) **or** an
   *   object with `setup`, `exec`, and `cleanup` methods.
   *
   *   When a function is passed, the worker has no persistent state –
   *   each invocation is independent.  When an object is passed, `setup`
   *   runs once and its return value is passed as the first argument to
   *   every `exec` call.
   *
   * @param {import('./types.js').ThreadOptions} [options={}]
   *   Configuration for timeouts, idle behaviour, health checks,
   *   event listeners, and more.
   *
   * @throws {TypeError} If `definition` is not a function or a valid
   *   `{ exec }` object.
   *
   * @example
   * ```js
   * // Simple function thread
   * const t1 = new Thread((a, b) => a + b);
   * await t1.run(2, 3); // 5
   * ```
   *
   * @example
   * ```js
   * // Stateful definition with lifecycle hooks
   * const t2 = new Thread({
   *   setup() { return { db: openDatabase() }; },
   *   async exec(state, query) {
   *     return state.db.query(query);
   *   },
   *   async cleanup(state) {
   *     await state.db.close();
   *   },
   * }, {
   *   timeout: 10_000,
   *   healthCheckInterval: 5_000,
   *   onLog: (msg) => console.log('[worker]', msg),
   *   onTiming: (ms) => console.log(`Query took ${ms.toFixed(1)}ms`),
   * });
   * ```
   */
  constructor(definition, options = {}) {
    // ---- options ----
    this._options = options;
    this._timeout = options.timeout || 30000;
    this._idleTimeout = options.idleTimeout || 0;
    this._imports = options.imports || [];
    this._healthCheckInterval = options.healthCheckInterval || 0;
    this._healthCheckTimeout = options.healthCheckTimeout || 5000;
    this._concurrency = options.concurrency || 1;
    this._activeTasks = 0;

    // ---- internal state ----
    this._nextId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer, abortHandler, startTime, args }
    this._listeners = {
      result: [],
      error: [],
      progress: [],
      terminate: [],
      idle: [],
      timing: [],
      beforeRun: [],
      afterRun: [],
      log: [],
      memory: [],
      health: [],
      metrics: [],
    };
    this._isTerminated = false;
    this._isIdle = true;
    this._idleTimer = null;
    this._healthTimer = null;
    this._crashes = 0;
    this._backoffTimer = null;
    this._isRestarting = false;
    this._cache = new Map(); // cacheKey -> { result, timestamp, ttl }

    // ---- metrics ----
    this._metrics = new Metrics();

    // ---- normalise definition ----
    if (typeof definition === 'function') {
      this._setupFn = null;
      this._execFn = definition;
      this._cleanupFn = null;
    } else if (typeof definition === 'object' && definition !== null) {
      this._setupFn = definition.setup || null;
      this._execFn = definition.exec;
      this._cleanupFn = definition.cleanup || null;
      if (typeof this._execFn !== 'function') {
        throw new TypeError('exec must be a function');
      }
    } else {
      throw new TypeError('definition must be a function or { setup?, exec?, cleanup? }');
    }

    // ---- build worker script and spawn via factory ----
    this._workerScript = this._buildWorkerScript();
    this._spawnWorker();

    // ---- register global listeners ----
    if (options.onBeforeRun) this.on('beforeRun', options.onBeforeRun);
    if (options.onAfterRun) this.on('afterRun', options.onAfterRun);
    if (options.onResult) this.on('result', options.onResult);
    if (options.onError) this.on('error', options.onError);
    if (options.onProgress) this.on('progress', options.onProgress);
    if (options.onTiming) this.on('timing', options.onTiming);
    if (options.onLog) this.on('log', options.onLog);
    if (options.onMemory) this.on('memory', options.onMemory);
    if (options.onMetrics) this.on('metrics', options.onMetrics);

    // ---- start timers ----
    this._resetIdleTimer();
    if (this._healthCheckInterval > 0) this._startHealthChecks();

    // ---- silent initialisation ----
    if (options.initArgs !== undefined) {
      const args = Array.isArray(options.initArgs) ? options.initArgs : [options.initArgs];
      this.run(...args, { transfer: options.initTransfer || [] }).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Worker script generation (internal)
  // -----------------------------------------------------------------------

  /**
   * Build the JavaScript source for the Web Worker.
   *
   * The script is self-contained: it defines `onmessage`, handles
   * setup/cleanup, and provides `ctx.log()` and `ctx.reportMemory()`
   * helpers.  Your `exec` function is embedded as a string via
   * `.toString()`.
   *
   * @returns {string} The complete worker script.
   * @private
   */
  _buildWorkerScript() {
    const setupSrc = this._setupFn ? `(${this._setupFn.toString()})` : 'null';
    const execSrc = `(${this._execFn.toString()})`;
    const cleanupSrc = this._cleanupFn ? `(${this._cleanupFn.toString()})` : 'null';

    // Use globalThis for cross-environment compatibility (browser, Node, Deno, Bun)
    return `
      let state = null;
      let isInitialised = false;

      const g = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this;

      g.log = function(message) {
        g.postMessage({ type: 'log', message: String(message) });
      };
      g.reportMemory = function() {
        if (typeof performance !== 'undefined' && performance.memory) {
          g.postMessage({ type: 'memory', memory: performance.memory });
        }
      };

      const runSetup = async () => {
        if (${setupSrc} !== null) {
          try {
            state = await (${setupSrc})();
          } catch (err) {
            g.postMessage({ type: 'setupError', error: err.message || String(err) });
            throw err;
          }
        }
        isInitialised = true;
        g.postMessage({ type: 'ready' });
      };

      g.onmessage = async function(e) {
        const { id, args, transfer, hasProgress, isBatch, isHealthCheck, isCleanup } = e.data || {};

        if (isHealthCheck) {
          g.postMessage({ id, type: 'health' });
          return;
        }
        if (isCleanup) {
          if (${cleanupSrc} !== null && state !== null) {
            try { await (${cleanupSrc})(state); } catch (err) {
              g.postMessage({ type: 'cleanupError', error: err.message || String(err) });
            }
          }
          g.postMessage({ id, type: 'cleanupDone' });
          return;
        }

        if (!isInitialised) {
          try { await runSetup(); } catch (err) {
            g.postMessage({ id, type: 'error', error: err.message || String(err) });
            return;
          }
        }

        const context = {
          reportProgress: (value) => {
            if (hasProgress) g.postMessage({ id, type: 'progress', value });
          },
          log: g.log,
          reportMemory: g.reportMemory,
        };

        try {
          let result;
          if (isBatch) {
            result = await Promise.all(args.map((argSet) => (${execSrc})(state, ...argSet, context)));
          } else {
            result = await (${execSrc})(state, ...args, context);
          }
          g.postMessage({ id, type: 'result', result });
        } catch (err) {
          g.postMessage({
            id,
            type: 'error',
            error: err.message || String(err),
            stack: err.stack,
          });
        }
      };
    `;
  }

  // -----------------------------------------------------------------------
  // Worker lifecycle (internal)
  // -----------------------------------------------------------------------

  /**
   * Spawn (or re-spawn) the underlying Web Worker.
   *
   * If a worker already exists it is terminated first.  The new worker
   * is wired to {@link _handleMessage}, {@link _handleError}, and
   * `onmessageerror`.
   *
   * @private
   */
  _spawnWorker() {
    if (this._worker) terminateWorker(this._worker);
    const worker = createWorker(this._workerScript, { imports: this._imports });
    worker.onmessage = this._handleMessage.bind(this);
    worker.onerror = this._handleError.bind(this);
    worker.onmessageerror = this._handleError.bind(this);
    this._worker = worker;
    this._isTerminated = false;
    this._isRestarting = false;
  }

  /**
   * Process a message received from the worker.
   *
   * Dispatches by `type` field: `result`, `error`, `progress`, `log`,
   * `memory`, `health`, `ready`.  For `result`/`error` messages tied to
   * a pending task, the corresponding promise is resolved/rejected.
   *
   * @param {MessageEvent} event - The raw message event.
   * @private
   */
  _handleMessage(event) {
    const { id, type, result, error, value, stack, message, memory } = event.data || {};
    this._resetIdleTimer();

    // Health check response
    if (type === 'health' && id !== undefined && this._pending.has(id)) {
      const { resolve, timer } = this._pending.get(id);
      clearTimeout(timer);
      this._pending.delete(id);
      resolve(true);
      return;
    }
    // Log / memory / ready
    if (type === 'log') {
      this._listeners.log.forEach((h) => h(message, event));
      return;
    }
    if (type === 'memory') {
      this._listeners.memory.forEach((h) => h(memory, event));
      return;
    }
    if (type === 'ready') {
      this._crashes = 0;
      this._listeners.health.forEach((h) => h({ status: 'ready' }));
      return;
    }

    // Result / progress / error
    if (type === 'result') this._listeners.result.forEach((h) => h(result, event));
    else if (type === 'progress') this._listeners.progress.forEach((h) => h(value, event));
    else if (type === 'error' || type === 'setupError' || type === 'cleanupError') {
      this._listeners.error.forEach((h) => h({ error, stack }, event));
    }

    // Resolve pending promise
    if (id !== undefined && this._pending.has(id)) {
      const entry = this._pending.get(id);
      if (type === 'result' || type === 'error') {
        clearTimeout(entry.timer);
        if (entry.abortHandler) entry.abortHandler();
        this._pending.delete(id);
        this._isIdle = this._pending.size === 0;
        this._activeTasks--;

        // Metrics and timing
        if (type === 'result' && entry.startTime) {
          const duration = performance.now() - entry.startTime;
          this._metrics.record(duration, true);
          this._listeners.timing.forEach((h) => h(duration, entry.args));
          this._listeners.metrics.forEach((h) => h(this._metrics.snapshot()));
        }
        if (type === 'result') {
          let finalResult = result;
          for (const hook of this._listeners.afterRun) {
            const transformed = hook(finalResult);
            if (transformed !== undefined) finalResult = transformed;
          }
          entry.resolve(finalResult);
        } else {
          this._metrics.record(0, false);
          this._listeners.metrics.forEach((h) => h(this._metrics.snapshot()));
          const err = new ThreadError(error);
          err.stack = stack;
          entry.reject(err);
        }
      }
    }
  }

  /**
   * Handle a fatal worker error (uncaught exception, message error, etc.).
   *
   * All pending tasks are rejected immediately, the worker is destroyed,
   * and a restart is scheduled (unless the thread was intentionally
   * terminated).
   *
   * @param {ErrorEvent|MessageEvent} event - The error event.
   * @private
   */
  _handleError(event) {
    this._listeners.error.forEach((h) => h(event));
    for (const [id, { reject, timer, abortHandler }] of this._pending) {
      clearTimeout(timer);
      if (abortHandler) abortHandler();
      reject(new ThreadError(`Worker crashed: ${event.message || 'unknown'}`));
      this._metrics.record(0, false);
    }
    this._pending.clear();
    this._isIdle = true;
    this._activeTasks = 0;
    this._worker = null;
    if (typeof this._onCrash === 'function') this._onCrash();
    if (!this._isTerminated) this._scheduleRestart();
  }

  /**
   * Schedule a worker restart with exponential back-off.
   *
   * Delay formula: `min(1000 * 2^(crashes-1), 30000)` ms.  After the
   * delay, a fresh worker is spawned (unless the thread has been
   * terminated in the meantime).
   *
   * @private
   */
  _scheduleRestart() {
    if (this._isRestarting || this._isTerminated) return;
    this._isRestarting = true;
    this._crashes++;
    const delay = Math.min(1000 * Math.pow(2, this._crashes - 1), 30000);
    this._backoffTimer = setTimeout(() => {
      this._isRestarting = false;
      if (!this._isTerminated) {
        this._spawnWorker();
        if (this._healthCheckInterval > 0) this._startHealthChecks();
      }
    }, delay);
  }

  // -----------------------------------------------------------------------
  // Health checks (internal)
  // -----------------------------------------------------------------------

  /**
   * Start periodic health-check pings.
   *
   * Each ping sends a lightweight `isHealthCheck` message and waits for
   * a response within {@link _healthCheckTimeout}.  If the worker fails
   * to respond, it is killed and restarted.
   *
   * @private
   */
  _startHealthChecks() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = setInterval(() => {
      if (this._isTerminated || !this._worker) return;
      this._pingWorker()
        .then(() => (this._crashes = 0))
        .catch(() => {
          if (this._worker) {
            this._worker.terminate();
            this._worker = null;
            this._scheduleRestart();
          }
        });
    }, this._healthCheckInterval);
  }

  /**
   * Send a single health-check ping and wait for the pong.
   *
   * @returns {Promise<boolean>} Resolves `true` on pong, rejects with
   *   {@link ThreadHealthError} on timeout.
   * @private
   */
  _pingWorker() {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new ThreadHealthError(`Health check timed out after ${this._healthCheckTimeout}ms`));
        }
      }, this._healthCheckTimeout);
      this._pending.set(id, { resolve, reject, timer, abortHandler: null, startTime: null, args: null });
      try {
        this._worker.postMessage({ id, isHealthCheck: true });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Idle timer (internal)
  // -----------------------------------------------------------------------

  /**
   * Reset the idle timer.  Called on every message from the worker.
   *
   * If `idleTimeout > 0` and no tasks are pending when the timer fires,
   * the thread terminates itself.
   *
   * @private
   */
  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._idleTimeout > 0 && !this._isTerminated) {
      this._idleTimer = setTimeout(() => {
        if (this._pending.size === 0) {
          this._isIdle = true;
          this._listeners.idle.forEach((h) => h());
          if (this._idleTimeout > 0) this.terminate();
        }
      }, this._idleTimeout);
    }
  }

  // -----------------------------------------------------------------------
  // Cache (internal)
  // -----------------------------------------------------------------------

  /**
   * Produce a JSON string key from the argument list.
   *
   * Returns `null` if the arguments are not JSON-serialisable (e.g.
   * contain functions or circular references).
   *
   * @param {any[]} args - Task arguments.
   * @returns {string | null} Cache key.
   * @private
   */
  _getCacheKey(args) {
    try {
      return JSON.stringify(args);
    } catch {
      return null;
    }
  }

  /**
   * Evict expired entries from the cache.
   *
   * @private
   */
  _clearExpiredCache() {
    const now = Date.now();
    for (const [key, entry] of this._cache) {
      if (entry.ttl && now - entry.timestamp > entry.ttl) this._cache.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // Public API – run
  // -----------------------------------------------------------------------

  /**
   * Run a single task on the worker.
   *
   * All arguments are forwarded to the worker's `exec` function.  If
   * the last argument is a {@link ThreadRunOptions} object (detected
   * by the presence of `timeout`, `transfer`, `signal`, `retries`, or
   * `cacheTTL` keys), it is consumed as options and **not** forwarded.
   *
   * @param {...any} args
   *   Arguments for the worker's `exec` function.  The last argument
   *   may be a {@link ThreadRunOptions} object.
   * @returns {Promise<any>}
   *   Resolves with the return value of `exec`, or rejects with:
   *   - {@link ThreadTimeoutError} – task exceeded its timeout
   *   - {@link ThreadAbortError} – task was aborted via `signal`
   *   - {@link ThreadTerminatedError} – thread was terminated
   *   - {@link ThreadError} – worker-side exception
   *
   * @example
   * ```js
   * const t = new Thread((a, b) => a + b);
   * const sum = await t.run(3, 4); // 7
   * ```
   *
   * @example
   * ```js
   * // With per-task options
   * const result = await t.run(data, {
   *   timeout: 5000,
   *   transfer: [data.buffer],
   *   retries: 2,
   *   cacheTTL: 60_000,
   * });
   * ```
   *
   * @example
   * ```js
   * // With AbortController
   * const controller = new AbortController();
   * setTimeout(() => controller.abort(), 1000);
   *
   * try {
   *   await t.run(slowWork, { signal: controller.signal });
   * } catch (err) {
   *   if (err instanceof ThreadAbortError) console.log('Cancelled');
   * }
   * ```
   */
  run(...args) {
    return this._runTask(false, ...args);
  }

  /**
   * Run multiple independent argument sets in a **single** worker call.
   *
   * The worker receives all argument sets at once and executes them in
   * parallel via `Promise.all`.  This is useful when you have many
   * small tasks and want to avoid the overhead of one `postMessage`
   * round-trip per task.
   *
   * @param {Array<Array>} tasks
   *   Array of argument arrays.  Each sub-array is spread as arguments
   *   to one `exec` invocation.
   * @param {import('./types.js').ThreadRunOptions & {_batch?: boolean}} [options={}]
   *   Options applied to the entire batch (timeout, transfer, etc.).
   * @returns {Promise<any[]>}
   *   Array of results in the same order as the input tasks.
   *
   * @throws {TypeError} If `tasks` is not an array.
   *
   * @example
   * ```js
   * const t = new Thread((x) => x * x);
   * const results = await t.runBatch([[2], [3], [4]]);
   * console.log(results); // [4, 9, 16]
   * ```
   */
  runBatch(tasks, options = {}) {
    if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
    options._batch = true;
    return this._runTask(true, tasks, options);
  }

  /**
   * Fire-and-forget: send a task **without waiting** for a reply.
   *
   * Useful for one-way messages where you don't need the result.  The
   * task runs with `id = -1` so the worker's response (if any) is
   * silently ignored.
   *
   * @param {...any} args
   *   Arguments; the last may contain `{ transfer }`.
   *
   * @example
   * ```js
   * // Send a log message to the worker without waiting
   * t.runAsync({ type: 'heartbeat' });
   * ```
   */
  runAsync(...args) {
    let options = {};
    const last = args[args.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last) && 'transfer' in last) {
      options = args.pop();
    }
    const transfer = options.transfer || [];
    if (this._isTerminated || !this._worker) return;
    try {
      this._worker.postMessage(
        {
          id: -1,
          args,
          transfer,
          hasProgress: false,
          isBatch: false,
        },
        transfer,
      );
    } catch (err) {
      // ignore
    }
  }

  /**
   * Run a chain of functions sequentially, each feeding its result
   * into the next.
   *
   * Every function in the chain is executed in its **own** temporary
   * thread, which is terminated after use.  This means each step runs
   * in a fresh worker – state does not carry over between steps (by
   * design).  The `initArgs`/`initTransfer` from the parent thread's
   * options are **not** forwarded to the temporary threads.
   *
   * @param {*} initialValue - The input to the first function.
   * @param {...Function} fns
   *   Functions to execute in order.  Each receives the previous
   *   result and returns the next result.
   * @returns {Promise<any>}
   *   The final result after all functions have been applied.
   *
   * @throws {TypeError} If any chain element is not a function.
   *
   * @example
   * ```js
   * const t = new Thread((x) => x);
   *
   * const result = await t.runChain(
   *   10,
   *   (x) => x + 5,    // 15
   *   (x) => x * 2,    // 30
   *   (x) => x - 3,    // 27
   * );
   * console.log(result); // 27
   * ```
   */
  async runChain(initialValue, ...fns) {
    let current = initialValue;
    const chainOptions = { ...this._options };
    delete chainOptions.initArgs;
    delete chainOptions.initTransfer;
    for (const fn of fns) {
      if (typeof fn !== 'function') throw new TypeError('Chain elements must be functions');
      const temp = new Thread(fn, chainOptions);
      try {
        current = await temp.run(current);
      } finally {
        temp.terminate();
      }
    }
    return current;
  }

  /**
   * Process an array in **chunks**, yielding results as they complete.
   *
   * This is an async generator – use `for await` to consume results.
   * Each chunk is sent to the thread sequentially (to avoid overhead).
   * For true parallelism, use a {@link ThreadPool} instead.
   *
   * @param {Array} array - Data to process.
   * @param {number} chunkSize - Number of elements per chunk (≥ 1).
   * @param {Function} processor
   *   Function that receives `(chunk, ctx)` and returns a result.
   *   Receives the same `ctx` object as `exec`.
   * @param {import('./types.js').ThreadRunOptions} [options={}]
   *   Options forwarded to each `run()` call.
   * @yields {*} The result of processing each chunk.
   *
   * @throws {TypeError} If `array` is not an array.
   * @throws {TypeError} If `chunkSize < 1`.
   * @throws {TypeError} If `processor` is not a function.
   *
   * @example
   * ```js
   * const t = new Thread((chunk) => chunk.reduce((a, b) => a + b, 0));
   * const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
   *
   * for await (const partial of t.runStreaming(data, 3, null)) {
   *   console.log('Chunk sum:', partial);
   * }
   * // Chunk sum: 6   (1+2+3)
   * // Chunk sum: 15  (4+5+6)
   * // Chunk sum: 24  (7+8+9)
   * // Chunk sum: 10  (10)
   * ```
   */
  async *runStreaming(array, chunkSize, processor, options = {}) {
    if (!Array.isArray(array)) throw new TypeError('array must be an array');
    if (chunkSize < 1) throw new TypeError('chunkSize must be >= 1');
    if (typeof processor !== 'function') throw new TypeError('processor must be a function');

    for (let i = 0; i < array.length; i += chunkSize) {
      const chunk = array.slice(i, i + chunkSize);
      const result = await this.run(chunk, { ...options, _batch: false });
      yield result;
    }
  }

  // -----------------------------------------------------------------------
  // Public API – lifecycle
  // -----------------------------------------------------------------------

  /**
   * Hot-swap the worker's `exec` function and restart.
   *
   * The old worker is terminated, a new Blob URL is created from the
   * updated script, and a fresh worker is spawned.  Pending tasks are
   * **not** preserved – they are rejected with {@link ThreadTerminatedError}.
   *
   * @param {Function} newExec - The new exec function.
   * @throws {ThreadTerminatedError} If the thread has already been terminated.
   * @throws {TypeError} If `newExec` is not a function.
   *
   * @example
   * ```js
   * const t = new Thread((x) => x + 1);
   * await t.run(5); // 6
   *
   * // Hot-swap to a new implementation
   * t.reload((x) => x * 10);
   * await t.run(5); // 50
   * ```
   */
  reload(newExec) {
    if (this._isTerminated) throw new ThreadTerminatedError('Thread terminated');
    if (typeof newExec !== 'function') throw new TypeError('newExec must be a function');
    this._execFn = newExec;
    // Rebuild script and restart
    this._workerScript = this._buildWorkerScript();

    if (this._worker) {
      terminateWorker(this._worker);
      this._worker = null;
    }
    this._spawnWorker();
    if (this._healthCheckInterval > 0) this._startHealthChecks();
  }

  /**
   * Warm up the worker by running a no-op task.
   *
   * Useful after creating the thread to force the worker to compile
   * your function and be ready for real tasks.
   *
   * @param {number} [timeout=5000] - Max ms to wait for the warmup.
   * @returns {Promise<void>}
   *
   * @example
   * ```js
   * const t = new Thread(heavyFunction);
   * await t.warmup(); // worker is now compiled and ready
   * const t0 = performance.now();
   * await t.run(input); // first call is fast
   * ```
   */
  warmup(timeout = 5000) {
    return this.run(undefined, { timeout });
  }

  /**
   * Gracefully terminate after running cleanup and waiting for
   * pending tasks.
   *
   * 1. Waits (polling every 50ms) until all pending tasks resolve.
   * 2. Sends an `isCleanup` message to the worker and waits for
   *    `cleanupDone` (or a 5s timeout).
   * 3. Calls {@link Thread.terminate} to kill the worker and release
   *    the Blob URL.
   *
   * @returns {Promise<void>}
   *
   * @example
   * ```js
   * const t = new Thread({
   *   setup() { return { conn: openDB() }; },
   *   exec(state, query) { return state.conn.query(query); },
   *   cleanup(state) { state.conn.close(); },
   * });
   *
   * // ... do work ...
   * await t.terminateGracefully(); // DB connection is properly closed
   * ```
   */
  async terminateGracefully() {
    if (this._isTerminated) return;
    while (this._pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this._worker && !this._isTerminated) {
      const cleanupId = this._nextId++;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new ThreadTimeoutError('Cleanup timed out')),
            5000,
          );
          const handler = (event) => {
            if (event.data && event.data.id === cleanupId && event.data.type === 'cleanupDone') {
              clearTimeout(timer);
              resolve();
            }
          };
          this._worker.addEventListener('message', handler, { once: true });
          this._worker.postMessage({ id: cleanupId, isCleanup: true });
        });
      } catch (_) {
        // ignore
      }
    }
    this.terminate();
  }

  /**
   * Immediately terminate the worker.
   *
   * - All pending task promises are rejected with
   *   {@link ThreadTerminatedError}.
   * - The worker is killed via `.terminate()`.
   * - The Blob URL is revoked.
   * - Idle and health-check timers are cleared.
   * - The cache is cleared.
   *
   * After calling this method, `thread.terminated` is `true` and no
   * further tasks can be submitted.
   *
   * @example
   * ```js
   * const t = new Thread((x) => x);
   * t.terminate();
   * console.log(t.terminated); // true
   * ```
   */
  terminate() {
    if (this._isTerminated) return;
    this._isTerminated = true;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._healthTimer) clearInterval(this._healthTimer);
    if (this._backoffTimer) clearTimeout(this._backoffTimer);

    if (this._worker) {
      terminateWorker(this._worker);
      this._worker = null;
    }
    for (const [id, { reject, timer, abortHandler }] of this._pending) {
      clearTimeout(timer);
      if (abortHandler) abortHandler();
      reject(new ThreadTerminatedError('Thread terminated'));
    }
    this._pending.clear();
    this._isIdle = true;
    this._activeTasks = 0;
    this._listeners.terminate.forEach((h) => h());
    this._cache.clear();
  }

  // -----------------------------------------------------------------------
  // Public API – events
  // -----------------------------------------------------------------------

  /**
   * Register an event listener.
   *
   * Returns `this` for method chaining.
   *
   * @param {import('./types.js').ThreadEventName} event - Event name.
   * @param {Function} handler - Callback function.
   * @returns {this} This thread instance (chainable).
   *
   * @throws {Error} If `event` is not a supported event name.
   *
   * @example
   * ```js
   * const t = new Thread((x) => x * 2);
   *
   * t
   *   .on('result', (result) => console.log('Result:', result))
   *   .on('error', (info) => console.error('Error:', info.error))
   *   .on('timing', (ms) => console.log(`${ms.toFixed(1)}ms`));
   *
   * await t.run(21); // logs "Result: 42" and "0.3ms"
   * ```
   *
   * @example
   * ```js
   * // Listen to all metrics updates
   * t.on('metrics', (snap) => {
   *   console.log(`${snap.count} tasks, avg ${snap.avg.toFixed(1)}ms`);
   * });
   * ```
   */
  on(event, handler) {
    if (this._listeners[event]) {
      this._listeners[event].push(handler);
    } else {
      throw new Error(`Unsupported event: ${event}`);
    }
    return this;
  }

  /**
   * Remove an event listener.
   *
   * The handler must be the same function reference that was passed to
   * {@link Thread.on}.  Returns `this` for method chaining.
   *
   * @param {import('./types.js').ThreadEventName} event - Event name.
   * @param {Function} handler - The handler to remove.
   * @returns {this} This thread instance (chainable).
   *
   * @example
   * ```js
   * const handler = (result) => console.log(result);
   * t.on('result', handler);
   * // later...
   * t.off('result', handler);
   * ```
   */
  off(event, handler) {
    if (this._listeners[event]) {
      const idx = this._listeners[event].indexOf(handler);
      if (idx !== -1) this._listeners[event].splice(idx, 1);
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Internal task runner
  // -----------------------------------------------------------------------

  /**
   * Core task execution logic shared by `run` and `runBatch`.
   *
   * Handles: argument parsing, cache lookup, concurrency gating,
   * beforeRun hooks, timeout/abort wiring, retry logic, and cache
   * storage.
   *
   * @param {boolean} isBatch - Whether this is a batch call.
   * @param {...any} args - Task arguments and optional options object.
   * @returns {Promise<any>}
   * @private
   */
  _runTask(isBatch, ...args) {
    let options = {};
    const last = args[args.length - 1];
    if (
      last &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      ('timeout' in last ||
        'transfer' in last ||
        'signal' in last ||
        'retries' in last ||
        '_batch' in last ||
        'cacheTTL' in last)
    ) {
      options = args.pop();
    }

    const timeout = options.timeout || this._timeout;
    const transfer = options.transfer || [];
    const signal = options.signal || null;
    const retries = options.retries || 0;
    const isBatchMode = options._batch || isBatch;
    const cacheTTL = options.cacheTTL || 0;

    const taskArgs = isBatchMode ? args[0] : args;

    // Cache check (only for non-batch)
    let cacheKey = null;
    if (cacheTTL > 0 && !isBatchMode) {
      this._clearExpiredCache();
      cacheKey = this._getCacheKey(taskArgs);
      if (cacheKey && this._cache.has(cacheKey)) {
        const entry = this._cache.get(cacheKey);
        return Promise.resolve(entry.result);
      }
    }

    return new Promise((resolve, reject) => {
      if (this._isTerminated) {
        return reject(new ThreadTerminatedError('Thread terminated'));
      }
      if (this._activeTasks >= this._concurrency) {
        return reject(new Error(`Concurrency limit ${this._concurrency} exceeded`));
      }

      // beforeRun hooks
      let finalArgs = taskArgs;
      for (const hook of this._listeners.beforeRun) {
        const transformed = hook(finalArgs);
        if (transformed !== undefined) finalArgs = transformed;
      }

      const id = this._nextId++;
      let attempts = 0;
      this._activeTasks++;

      const execute = () => {
        const startTime = performance.now();
        const timer = setTimeout(() => {
          if (this._pending.has(id)) {
            this._pending.delete(id);
            this._activeTasks--;
            reject(new ThreadTimeoutError(`Timed out after ${timeout}ms`));
          }
        }, timeout);

        let abortHandler = null;
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            this._activeTasks--;
            return reject(new ThreadAbortError('Task aborted'));
          }
          const onAbort = () => {
            if (this._pending.has(id)) {
              const { reject: r, timer: t } = this._pending.get(id);
              clearTimeout(t);
              this._pending.delete(id);
              this._activeTasks--;
              r(new ThreadAbortError('Task aborted'));
            }
          };
          signal.addEventListener('abort', onAbort);
          abortHandler = () => signal.removeEventListener('abort', onAbort);
        }

        this._pending.set(id, {
          resolve: (res) => {
            if (cacheTTL > 0 && cacheKey && !isBatchMode) {
              this._cache.set(cacheKey, { result: res, timestamp: Date.now(), ttl: cacheTTL });
            }
            resolve(res);
          },
          reject,
          timer,
          abortHandler,
          startTime,
          args: finalArgs,
        });

        try {
          this._worker.postMessage(
            {
              id,
              args: finalArgs,
              transfer,
              hasProgress: this._listeners.progress.length > 0,
              isBatch: isBatchMode,
            },
            transfer,
          );
        } catch (err) {
          clearTimeout(timer);
          if (abortHandler) abortHandler();
          this._pending.delete(id);
          this._activeTasks--;
          if (attempts < retries && !this._isTerminated) {
            attempts++;
            execute();
          } else {
            reject(err);
          }
        }
      };

      execute();
    });
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  /**
   * Current metrics snapshot for this thread.
   *
   * Equivalent to `this._metrics.snapshot()`.
   *
   * @type {import('./types.js').MetricsSnapshot}
   *
   * @example
   * ```js
   * console.log(thread.metrics.avg);     // 42.5
   * console.log(thread.metrics.throughput); // 150 tasks/sec
   * ```
   */
  get metrics() {
    return this._metrics.snapshot();
  }

  /**
   * Whether the thread has any pending (in-flight) tasks.
   *
   * @type {boolean}
   *
   * @example
   * ```js
   * console.log(thread.busy); // false
   * const p = thread.run(data);
   * console.log(thread.busy); // true
   * await p;
   * console.log(thread.busy); // false
   * ```
   */
  get busy() {
    return this._pending.size > 0;
  }

  /**
   * Whether the thread has been terminated.
   *
   * Once `true`, no further tasks can be submitted.
   *
   * @type {boolean}
   *
   * @example
   * ```js
   * console.log(thread.terminated); // false
   * thread.terminate();
   * console.log(thread.terminated); // true
   * ```
   */
  get terminated() {
    return this._isTerminated;
  }
}
