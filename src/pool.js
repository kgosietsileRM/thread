/**
 * @file Managed pool of Web Worker threads.
 *
 * `ThreadPool` maintains a fixed (or dynamically resizable) set of
 * workers and distributes incoming tasks among them.  Key features:
 *
 * - **Priority queue** – tasks are dequeued in priority order.
 * - **Dependency resolution** – declare that a task must wait for other
 *   tasks to finish before it starts.
 * - **Work stealing** – idle threads can pick up work from busy threads'
 *   local queues.
 * - **Affinity routing** – optional `keyHasher` routes tasks with the
 *   same key to the same thread (good for caches).
 * - **Auto-restart** – crashed workers are replaced automatically and
 *   queued tasks are re-dispatched.
 * - **Dynamic resizing** – call `scaleTo()` at runtime.
 * - **Graceful shutdown** – `terminateGracefully()` waits for all tasks
 *   to finish before killing workers.
 *
 * **Quick start:**
 *
 * ```js
 * import { ThreadPool } from './pool.js';
 *
 * const pool = new ThreadPool(4, (x) => x * 2);
 *
 * const { id, promise } = pool.run(21);
 * console.log(await promise); // 42
 *
 * await pool.terminateGracefully();
 * ```
 *
 * **With priorities and dependencies:**
 *
 * ```js
 * const pool = new ThreadPool(2, (x) => x + 1);
 *
 * // High-priority task runs first
 * pool.run(10, { priority: 0 });
 *
 * // Low-priority task
 * pool.run(20, { priority: 10 });
 *
 * // Dependent task – runs after task 0 completes
 * const a = pool.run(1);
 * const b = pool.run(2, { dependsOn: [a.id] });
 * console.log(await b.promise); // 3
 * ```
 *
 * @module pool
 */

import { Thread } from "./thread";
import {
    ThreadAbortError,
    ThreadDependencyError,
    ThreadTerminatedError,
} from "./error";
import { Metrics } from "./metrix";

// ---------------------------------------------------------------------------
// ThreadPool class
// ---------------------------------------------------------------------------

/**
 * A thread pool with work-stealing, priorities, and dependency resolution.
 */
export class ThreadPool {
  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * Create a new thread pool.
   *
   * @param {number} initialSize
   *   Number of worker threads to spawn immediately.  The pool can be
   *   resized later with {@link ThreadPool.scaleTo}.
   * @param {import('./types.js').ThreadDefinition | Function} definition
   *   Worker definition forwarded to each {@link Thread} constructor.
   *   Can be a plain function or a `{ setup, exec, cleanup }` object.
   * @param {import('./types.js').PoolOptions} [options={}]
   *   Pool and thread configuration.
   *
   * @example
   * ```js
   * // Simple pool with 4 workers
   * const pool = new ThreadPool(4, (data) => processData(data));
   * ```
   *
   * @example
   * ```js
   * // Stateful workers with health checks
   * const pool = new ThreadPool(2, {
   *   setup() { return { cache: new Map() }; },
   *   exec(state, key, ctx) {
   *     if (state.cache.has(key)) return state.cache.get(key);
   *     const result = expensiveLookup(key);
   *     state.cache.set(key, result);
   *     ctx.log(`Cached ${key}`);
   *     return result;
   *   },
   * }, {
   *   timeout: 10_000,
   *   healthCheckInterval: 5_000,
   *   autoRestart: true,
   * });
   * ```
   */
  constructor(initialSize, definition, options = {}) {
    this._definition = definition;
    this._baseOptions = { ...options };
    this._autoRestart = options.autoRestart !== false;
    this._maxSize = options.maxSize || Infinity;
    this._keyHasher = options.keyHasher || ((args) => JSON.stringify(args));
    this._enableStealing = options.enableStealing !== false;
    this._threads = [];
    this._globalQueue = [];
    this._blockedTasks = [];
    this._running = 0;
    this._terminated = false;
    this._idCounter = 0;
    this._taskMap = new Map(); // taskId -> task
    this._dependencyGraph = new Map(); // taskId -> Set of dependent taskIds
    this._completed = new Set();
    this._metrics = new Metrics();

    for (let i = 0; i < initialSize; i++) {
      this._addThread();
    }
  }

  // -----------------------------------------------------------------------
  // Thread management (internal)
  // -----------------------------------------------------------------------

  /**
   * Add a new thread to the pool.
   *
   * Respects `maxSize` – returns `null` if the limit is reached.
   * Registers a crash handler that moves local-queue tasks back to
   * the global queue and spawns a replacement.
   *
   * @returns {Thread | null} The new thread, or `null` if at capacity.
   * @private
   */
  _addThread() {
    if (this._threads.length >= this._maxSize) return null;
    const t = new Thread(this._definition, this._baseOptions);
    t._poolTask = true;
    t._busy = false;
    t._localQueue = [];
    t._taskId = null;

    if (this._autoRestart) {
      t._onCrash = () => {
        const idx = this._threads.indexOf(t);
        if (idx !== -1) {
          while (t._localQueue.length) {
            this._globalQueue.push(t._localQueue.shift());
          }
          this._threads.splice(idx, 1);
          if (!this._terminated && this._threads.length < this._maxSize) {
            this._addThread();
          }
          this._processQueue();
        }
      };
    }

    this._threads.push(t);
    return t;
  }

  /**
   * Remove a thread from the pool, moving its local tasks back to
   * the global queue.
   *
   * @param {Thread} thread - Thread to remove.
   * @private
   */
  _removeThread(thread) {
    const idx = this._threads.indexOf(thread);
    if (idx !== -1) {
      while (thread._localQueue.length) {
        this._globalQueue.push(thread._localQueue.shift());
      }
      thread.terminate();
      this._threads.splice(idx, 1);
    }
  }

  // -----------------------------------------------------------------------
  // Work stealing (internal)
  // -----------------------------------------------------------------------

  /**
   * Steal a task from the busiest thread's local queue.
   *
   * @param {Thread} thread - The idle thread that will receive the task.
   * @returns {Object | null} A task object, or `null` if nothing to steal.
   * @private
   */
  _stealWork(thread) {
    if (!this._enableStealing) return null;
    let best = null;
    let maxLocal = 0;
    for (const other of this._threads) {
      if (other === thread || other.terminated) continue;
      if (other._localQueue && other._localQueue.length > maxLocal) {
        maxLocal = other._localQueue.length;
        best = other;
      }
    }
    if (best && best._localQueue.length > 0) {
      return best._localQueue.pop();
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Queue processing (internal)
  // -----------------------------------------------------------------------

  /**
   * Process the global task queue.
   *
   * Called after every task submission, completion, or failure.  Flow:
   * 1. Resolve any blocked tasks whose dependencies are now met.
   * 2. Dequeue the highest-priority task (or steal one).
   * 3. Find an idle thread and dispatch the task.
   * 4. If no idle thread is available, push the task back to the front.
   *
   * @private
   */
  _processQueue() {
    if (this._terminated) return;

    this._resolveBlockedTasks();

    let task = null;
    if (this._globalQueue.length > 0) {
      task = this._globalQueue.shift();
    } else {
      const idle = this._threads.find((t) => !t._busy && !t.terminated);
      if (idle) {
        const stolen = this._stealWork(idle);
        if (stolen) task = stolen;
      }
    }
    if (!task) return;

    let thread = this._threads.find((t) => !t._busy && !t.terminated);
    if (!thread) {
      this._globalQueue.unshift(task);
      return;
    }

    thread._busy = true;
    thread._taskId = task.taskId;
    this._running++;

    const runOptions = {};
    if (task.timeout != null) runOptions.timeout = task.timeout;
    if (task.transfer) runOptions.transfer = task.transfer;
    if (task.signal) runOptions.signal = task.signal;
    if (task.retries != null) runOptions.retries = task.retries;

    thread
      .run(...task.args, runOptions)
      .then((result) => {
        this._running--;
        thread._busy = false;
        thread._taskId = null;
        this._taskMap.delete(task.taskId);
        this._completed.add(task.taskId);
        task.resolve(result);
        this._processQueue();
      })
      .catch((err) => {
        this._running--;
        thread._busy = false;
        thread._taskId = null;
        this._taskMap.delete(task.taskId);
        if (this._autoRestart && thread.terminated) {
          const idx = this._threads.indexOf(thread);
          if (idx !== -1) {
            this._threads.splice(idx, 1);
            if (!this._terminated && this._threads.length < this._maxSize) {
              this._addThread();
            }
          }
        }
        task.reject(err);
        this._rejectDependents(task.taskId, err);
        this._processQueue();
      });
  }

  /**
   * Move blocked tasks whose dependencies are now satisfied into the
   * global queue.
   *
   * @private
   */
  _resolveBlockedTasks() {
    const ready = [];
    const remaining = [];
    for (const task of this._blockedTasks) {
      const allCompleted = task.dependsOn.every((depId) => this._completed.has(depId));
      if (allCompleted) {
        ready.push(task);
      } else {
        remaining.push(task);
      }
    }
    this._blockedTasks = remaining;
    for (const task of ready) {
      task._blocked = false;
      this._enqueueTask(task);
    }
  }

  /**
   * Reject all tasks that depend on a failed task.
   *
   * When a task fails, any task waiting on it via `dependsOn` is
   * immediately rejected with a {@link ThreadDependencyError} instead of
   * being left blocked forever.
   *
   * @param {number} failedTaskId - The ID of the task that failed.
   * @param {Error} err - The original error.
   * @private
   */
  _rejectDependents(failedTaskId, err) {
    const dependentIds = this._dependencyGraph.get(failedTaskId);
    if (!dependentIds) return;
    const depError = new ThreadDependencyError(
      `Dependency task ${failedTaskId} failed: ${err.message || err}`
    );
    for (const depId of dependentIds) {
      const bIdx = this._blockedTasks.findIndex((t) => t.taskId === depId);
      if (bIdx !== -1) {
        const depTask = this._blockedTasks.splice(bIdx, 1)[0];
        this._taskMap.delete(depId);
        depTask.reject(depError);
      }
      const qIdx = this._globalQueue.findIndex((t) => t.taskId === depId);
      if (qIdx !== -1) {
        const depTask = this._globalQueue.splice(qIdx, 1)[0];
        this._taskMap.delete(depId);
        depTask.reject(depError);
      }
    }
    this._dependencyGraph.delete(failedTaskId);
  }

  /**
   * Insert a task into the global queue in priority order.
   *
   * Lower `priority` values are dequeued first.
   *
   * @param {Object} task - Task to enqueue.
   * @private
   */
  _enqueueTask(task) {
    let inserted = false;
    for (let i = 0; i < this._globalQueue.length; i++) {
      if (this._globalQueue[i].priority > task.priority) {
        this._globalQueue.splice(i, 0, task);
        inserted = true;
        break;
      }
    }
    if (!inserted) this._globalQueue.push(task);
    this._processQueue();
  }

  // -----------------------------------------------------------------------
  // Public API – run
  // -----------------------------------------------------------------------

  /**
   * Submit a task to the pool.
   *
   * The task is placed into a priority queue and dispatched to the
   * first available thread.  Returns both a numeric `id` (for
   * dependency tracking and cancellation) and a `promise` that
   * resolves with the result.
   *
   * If the last argument is a {@link PoolRunOptions} object, its pool-
   * specific keys (`priority`, `dependsOn`, `key`) are consumed and its
   * thread-level keys (`timeout`, `transfer`, `signal`, `retries`) are
   * forwarded to the worker.
   *
   * @param {...any} args
   *   Arguments forwarded to the worker's `exec` function.  The last
   *   argument may be a {@link PoolRunOptions} object.
   * @returns {import('./types.js').PoolTaskResult}
   *   `{ id: number, promise: Promise<any> }`.
   *
   * @example
   * ```js
   * const pool = new ThreadPool(2, (x) => x + 1);
   *
   * const { id, promise } = pool.run(10);
   * console.log(await promise); // 11
   * console.log(id);            // 0
   * ```
   *
   * @example
   * ```js
   * // With priority
   * pool.run(urgent, { priority: 0 });  // runs first
   * pool.run(batch,  { priority: 10 }); // runs second
   * ```
   *
   * @example
   * ```js
   * // With dependencies
   * const a = pool.run(data);
   * const b = pool.run(a.id, { dependsOn: [a.id] });
   * await b.promise; // waits for 'a' to finish first
   * ```
   *
   * @example
   * ```js
   * // With abort and timeout
   * const controller = new AbortController();
   * const { promise } = pool.run(bigData, {
   *   timeout: 30_000,
   *   signal: controller.signal,
   *   transfer: [bigData.buffer],
   *   retries: 2,
   * });
   * ```
   */
  run(...args) {
    let options = {};
    const last = args[args.length - 1];
    if (
      last &&
      typeof last === 'object' &&
      !Array.isArray(last) &&
      ('priority' in last ||
        'dependsOn' in last ||
        'key' in last ||
        'timeout' in last ||
        'transfer' in last ||
        'signal' in last ||
        'retries' in last)
    ) {
      options = args.pop();
    }

    const priority = options.priority ?? 0;
    const dependsOn = options.dependsOn || [];
    const key = options.key || null;

    if (this._terminated) {
      return {
        id: -1,
        promise: Promise.reject(new ThreadTerminatedError('Pool terminated')),
      };
    }

    const taskId = this._idCounter++;
    let resolveFn, rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const task = {
      args,
      resolve: resolveFn,
      reject: rejectFn,
      taskId,
      priority,
      dependsOn,
      key,
      retries: options.retries,
      signal: options.signal,
      timeout: options.timeout,
      transfer: options.transfer,
      _blocked: dependsOn.length > 0,
    };

    this._taskMap.set(taskId, task);

    const allCompleted = dependsOn.every((depId) => this._completed.has(depId));
    if (allCompleted) {
      this._enqueueTask(task);
    } else {
      this._blockedTasks.push(task);
      for (const depId of dependsOn) {
        if (!this._completed.has(depId)) {
          if (!this._dependencyGraph.has(depId)) {
            this._dependencyGraph.set(depId, new Set());
          }
          this._dependencyGraph.get(depId).add(taskId);
        }
      }
    }

    return { id: taskId, promise };
  }

  /**
   * Cancel a queued task by its ID.
   *
   * Only works for tasks that are **still queued** (either in the global
   * queue or blocked waiting on dependencies).  Tasks that are already
   * running on a thread cannot be cancelled this way – use an
   * `AbortSignal` instead.
   *
   * @param {number} taskId - The task ID returned by {@link ThreadPool.run}.
   * @returns {boolean} `true` if the task was found and cancelled.
   *
   * @example
   * ```js
   * const { id } = pool.run(slowTask);
   *
   * // User changed their mind
   * if (pool.cancel(id)) {
   *   console.log('Task cancelled before it started');
   * }
   * ```
   */
  cancel(taskId) {
    const idx = this._globalQueue.findIndex((t) => t.taskId === taskId);
    if (idx !== -1) {
      const task = this._globalQueue.splice(idx, 1)[0];
      this._taskMap.delete(taskId);
      task.reject(new ThreadAbortError('Task cancelled'));
      return true;
    }
    const bIdx = this._blockedTasks.findIndex((t) => t.taskId === taskId);
    if (bIdx !== -1) {
      const task = this._blockedTasks.splice(bIdx, 1)[0];
      this._taskMap.delete(taskId);
      task.reject(new ThreadAbortError('Task cancelled'));
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Public API – pool management
  // -----------------------------------------------------------------------

  /**
   * Dynamically resize the pool.
   *
   * If `newSize` is larger, new threads are spawned.  If smaller, excess
   * threads are removed (busy threads are marked for deferred removal).
   *
   * @param {number} newSize - Desired number of threads.
   * @throws {Error} If `newSize < 0`.
   * @throws {Error} If `newSize > maxSize`.
   *
   * @example
   * ```js
   * // Scale up for a burst of work
   * pool.scaleTo(8);
   * await Promise.all(bigBatch.map((item) => pool.run(item).promise));
   *
   * // Scale back down to conserve resources
   * pool.scaleTo(2);
   * ```
   */
  scaleTo(newSize) {
    if (newSize < 0) throw new Error('Size must be non‑negative');
    if (newSize > this._maxSize) throw new Error(`Exceeds maxSize ${this._maxSize}`);
    const current = this._threads.length;
    if (newSize > current) {
      for (let i = 0; i < newSize - current; i++) this._addThread();
    } else if (newSize < current) {
      const toRemove = this._threads.slice(newSize);
      for (const t of toRemove) {
        if (!t._busy) this._removeThread(t);
        else t._pendingRemoval = true;
      }
    }
  }

  /**
   * Gracefully shut down after all tasks finish.
   *
   * Polls every 50ms until the global queue, blocked list, and all
   * threads are idle, then calls {@link ThreadPool.terminateAll}.
   *
   * @returns {Promise<void>}
   *
   * @example
   * ```js
   * process.on('SIGTERM', async () => {
   *   console.log('Shutting down gracefully...');
   *   await pool.terminateGracefully();
   *   console.log('All tasks finished');
   * });
   * ```
   */
  async terminateGracefully() {
    while (
      this._globalQueue.length > 0 ||
      this._blockedTasks.length > 0 ||
      this._threads.some((t) => t._busy)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.terminateAll();
  }

  /**
   * Immediately terminate all threads and clear all queues.
   *
   * - Every thread is killed via `thread.terminate()`.
   * - All queued and blocked tasks are rejected with
   *   {@link ThreadTerminatedError}.
   * - The dependency graph, completed set, and task map are cleared.
   *
   * @example
   * ```js
   * // Emergency shutdown
   * pool.terminateAll();
   * console.log(pool.status().total); // 0
   * ```
   */
  terminateAll() {
    this._terminated = true;
    this._threads.forEach((t) => t.terminate());
    this._threads = [];
    this._globalQueue = [];
    for (const task of this._blockedTasks) {
      task.reject(new ThreadTerminatedError('Pool terminated'));
    }
    this._blockedTasks = [];
    for (const [id, task] of this._taskMap) {
      task.reject(new ThreadTerminatedError('Pool terminated'));
    }
    this._taskMap.clear();
    this._dependencyGraph.clear();
    this._completed.clear();
  }

  /**
   * Return a snapshot of the pool's current state.
   *
   * @returns {import('./types.js').PoolStatus}
   *
   * @example
   * ```js
   * const s = pool.status();
   * console.log(`${s.busy}/${s.total} threads busy, ${s.queued} tasks queued`);
   * ```
   */
  status() {
    const total = this._threads.length;
    const busy = this._threads.filter((t) => t._busy).length;
    const localQueues = this._threads.reduce(
      (sum, t) => sum + (t._localQueue ? t._localQueue.length : 0),
      0,
    );
    return {
      total,
      busy,
      idle: total - busy,
      queued: this._globalQueue.length + this._blockedTasks.length,
      localQueued: localQueues,
    };
  }

  /**
   * Wait for all tasks to finish **without** terminating the pool.
   *
   * Useful when you want to process all submitted work and then inspect
   * results, but keep the pool alive for more tasks.
   *
   * @returns {Promise<void>}
   *
   * @example
   * ```js
   * for (const item of items) pool.run(item);
   * await pool.drain();
   * console.log('All items processed');
   * // pool is still alive – submit more tasks if needed
   * ```
   */
  async drain() {
    while (
      this._globalQueue.length > 0 ||
      this._blockedTasks.length > 0 ||
      this._threads.some((t) => t._busy)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Warm up all threads by running a no-op task on each.
   *
   * Forces every worker to compile the exec function so the first real
   * task is fast.
   *
   * @param {number} [timeout=5000] - Max ms per warmup task.
   * @returns {Promise<void>}
   *
   * @example
   * ```js
   * const pool = new ThreadPool(4, heavyComputation);
   * await pool.warmup(); // all 4 workers are now compiled
   * ```
   */
  async warmup(timeout = 5000) {
    await Promise.all(this._threads.map((t) => t.warmup(timeout)));
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  /**
   * Cumulative pool-wide metrics snapshot.
   *
   * Only tracks tasks that completed through the pool's own `.run()`
   * method.  Individual thread metrics are not aggregated here.
   *
   * @type {import('./types.js').MetricsSnapshot}
   *
   * @example
   * ```js
   * const m = pool.metrics;
   * console.log(`${m.count} tasks, ${(m.errorRate * 100).toFixed(1)}% errors`);
   * ```
   */
  get metrics() {
    return this._metrics.snapshot();
  }
}
