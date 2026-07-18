/**
 * @file Error hierarchy for the threat module.
 *
 * Every error in the threat system extends {@link ThreadError}, so a single
 * `catch (e) { if (e instanceof ThreadError) }` block handles them all.
 * Use the more specific subclasses to differentiate timeout, abort,
 * termination, health, and dependency failures.
 *
 * @example
 * ```js
 * import {
 *   ThreadError,
 *   ThreadTimeoutError,
 *   ThreadAbortError,
 *   ThreadTerminatedError,
 *   ThreadHealthError,
 *   ThreadDependencyError,
 * } from './error.js';
 *
 * try {
 *   await thread.run(hugeDataset, { timeout: 5000 });
 * } catch (err) {
 *   if (err instanceof ThreadTimeoutError) {
 *     console.warn('Task took too long – retrying with more time');
 *   } else if (err instanceof ThreadAbortError) {
 *     console.log('User cancelled – cleaning up');
 *   } else if (err instanceof ThreadTerminatedError) {
 *     console.error('Thread was killed');
 *   } else if (err instanceof ThreadError) {
 *     console.error('Worker error:', err.message);
 *   } else {
 *     throw err; // re-throw non-threat errors
 *   }
 * }
 * ```
 *
 * @module error
 */

// ---------------------------------------------------------------------------
// ThreadError – base class
// ---------------------------------------------------------------------------

/**
 * Base error class for all thread-related issues.
 *
 * This is the **parent** of every error the threat module can throw.
 * Catching `ThreadError` lets you handle any threat-specific failure in
 * one place; catching the subclasses lets you respond to specific failure
 * modes.
 *
 * @example
 * ```js
 * import { ThreadError } from './error.js';
 *
 * // Generic catch-all
 * try {
 *   await thread.run(data);
 * } catch (err) {
 *   if (err instanceof ThreadError) {
 *     // any threat error – safe to handle generically
 *     console.error(`[threat] ${err.name}: ${err.message}`);
 *   }
 * }
 * ```
 */
export class ThreadError extends Error {
  /**
   * @param {string} message - Human-readable description of the error.
   */
  constructor(message) {
    super(message);
    /** @readonly @type {'ThreadError'} */
    this.name = 'ThreadError';
  }
}

// ---------------------------------------------------------------------------
// ThreadTimeoutError
// ---------------------------------------------------------------------------

/**
 * Thrown when a task exceeds its allowed execution time.
 *
 * Every `thread.run()` and `pool.run()` accepts a `timeout` option (in ms).
 * If the worker does not respond within that window the task promise is
 * rejected with this error.
 *
 * **Common causes:**
 * - The worker function has an infinite loop or is blocking on I/O.
 * - The task is genuinely slow and needs a longer timeout.
 * - The worker crashed before it could respond (the error message will
 *   include the timeout value).
 *
 * @example
 * ```js
 * import { createThread, ThreadTimeoutError } from './index.js';
 *
 * const t = createThread((n) => {
 *   // Simulate a slow task
 *   const end = Date.now() + n;
 *   while (Date.now() < end) { busy_wait }
 *   return 'done';
 * });
 *
 * try {
 *   const result = await t.run(60_000, { timeout: 5000 });
 * } catch (err) {
 *   if (err instanceof ThreadTimeoutError) {
 *     console.error('Task exceeded 5s timeout:', err.message);
 *     // "Timed out after 5000ms"
 *   }
 * }
 * ```
 */
export class ThreadTimeoutError extends ThreadError {
  /**
   * @param {string} message - Timeout description (usually includes ms).
   */
  constructor(message) {
    super(message);
    /** @readonly @type {'ThreadTimeoutError'} */
    this.name = 'ThreadTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// ThreadAbortError
// ---------------------------------------------------------------------------

/**
 * Thrown when a task is cancelled via an `AbortController` or the pool's
 * `cancel()` method.
 *
 * There are two ways to abort a task:
 * 1. **AbortController** – pass `signal` in run options.
 * 2. **Pool cancel** – call `pool.cancel(taskId)`.
 *
 * In both cases the task promise rejects with this error.
 *
 * @example
 * ```js
 * import { createThread, ThreadAbortError } from './index.js';
 *
 * const t = createThread((data) => process(data));
 * const controller = new AbortController();
 *
 * // Start a long-running task
 * const promise = t.run(hugeData, { signal: controller.signal });
 *
 * // User clicks "Cancel"
 * document.getElementById('cancel').onclick = () => controller.abort();
 *
 * try {
 *   await promise;
 * } catch (err) {
 *   if (err instanceof ThreadAbortError) {
 *     console.log('Task was cancelled by user');
 *   }
 * }
 * ```
 */
export class ThreadAbortError extends ThreadError {
  /**
   * @param {string} message - Abort description.
   */
  constructor(message) {
    super(message);
    /** @readonly @type {'ThreadAbortError'} */
    this.name = 'ThreadAbortError';
  }
}

// ---------------------------------------------------------------------------
// ThreadTerminatedError
// ---------------------------------------------------------------------------

/**
 * Thrown when you try to use a thread that has been terminated, or when
 * the pool shuts down while tasks are still queued.
 *
 * Once `thread.terminate()` or `pool.terminateAll()` is called, every
 * pending and future task promise rejects with this error.
 *
 * @example
 * ```js
 * import { createThread, ThreadTerminatedError } from './index.js';
 *
 * const t = createThread((x) => x * 2);
 * t.terminate();
 *
 * try {
 *   await t.run(5);
 * } catch (err) {
 *   if (err instanceof ThreadTerminatedError) {
 *     console.error('Cannot use a terminated thread');
 *   }
 * }
 * ```
 */
export class ThreadTerminatedError extends ThreadError {
  /**
   * @param {string} message - Termination description.
   */
  constructor(message) {
    super(message);
    /** @readonly @type {'ThreadTerminatedError'} */
    this.name = 'ThreadTerminatedError';
  }
}

// ---------------------------------------------------------------------------
// ThreadHealthError
// ---------------------------------------------------------------------------

/**
 * Thrown when a health check fails.
 *
 * When `healthCheckInterval` is set, the thread periodically pings the
 * worker.  If the worker does not respond within `healthCheckTimeout`,
 * or if the ping throws, the thread considers the worker dead and emits
 * this error.
 *
 * In practice this error is **not** thrown to your task promises.  Instead
 * it is logged internally and triggers an automatic restart.  You will
 * see it if you listen to the `error` event:
 *
 * @example
 * ```js
 * import { createThread, ThreadHealthError } from './index.js';
 *
 * const t = createThread((x) => x, {
 *   healthCheckInterval: 5000,
 *   healthCheckTimeout: 2000,
 * });
 *
 * t.on('error', (info) => {
 *   if (info.error instanceof ThreadHealthError) {
 *     console.warn('Worker is unhealthy, restarting...');
 *   }
 * });
 * ```
 */
export class ThreadHealthError extends ThreadError {
  /**
   * @param {string} message - Health check failure description.
   */
  constructor(message) {
    super(message);
    /** @readonly @type {'ThreadHealthError'} */
    this.name = 'ThreadHealthError';
  }
}

// ---------------------------------------------------------------------------
// ThreadDependencyError
// ---------------------------------------------------------------------------

/**
 * Thrown when a pool task's dependency fails.
 *
 * When you submit a task with `dependsOn: [taskId]` and the dependency
 * task fails (for any reason), the dependent task is automatically
 * rejected with this error instead of running.
 *
 * The error message includes the failed dependency's ID and the original
 * error message so you can trace the failure chain.
 *
 * @example
 * ```js
 * import { createPool, ThreadDependencyError } from './index.js';
 *
 * const pool = createPool(2, (x) => {
 *   if (x < 0) throw new Error('Negative input');
 *   return x * 2;
 * });
 *
 * const a = pool.run(-1);           // will fail: "Negative input"
 * const b = pool.run(10, {
 *   dependsOn: [a.id],              // depends on 'a'
 * });
 *
 * try {
 *   await b.promise;
 * } catch (err) {
 *   if (err instanceof ThreadDependencyError) {
 *     // "Dependency task 0 failed: Negative input"
 *     console.error(err.message);
 *   }
 * }
 * ```
 */
export class ThreadDependencyError extends ThreadError {
  /**
   * @param {string} message - Dependency failure description.
   */
  constructor(message) {
    super(message);
    /** @readonly @type {'ThreadDependencyError'} */
    this.name = 'ThreadDependencyError';
  }
}

// ---------------------------------------------------------------------------
// GPUComputeError
// ---------------------------------------------------------------------------

/**
 * Thrown when a GPU compute operation fails.
 *
 * Covers all GPU-specific failures: shader compilation errors, buffer
 * size violations, device loss, and dispatch failures.  The error's
 * `cause` property contains the original WebGPU error when available.
 *
 * @example
 * ```js
 * import { GPUComputeError } from './error.js';
 *
 * try {
 *   await gpu.compute({ inputs: {}, outputBuffers: {} });
 * } catch (err) {
 *   if (err instanceof GPUComputeError) {
 *     console.error(`GPU failed: ${err.message}`);
 *     if (err.cause) console.error('Original:', err.cause);
 *   }
 * }
 * ```
 */
export class GPUComputeError extends ThreadError {
  /**
   * @param {string} message - Human-readable GPU error description.
   * @param {Error} [cause] - Original WebGPU error (if any).
   */
  constructor(message, cause = undefined) {
    super(message);
    /** @readonly @type {'GPUComputeError'} */
    this.name = 'GPUComputeError';
    if (cause !== undefined) this.cause = cause;
  }
}
