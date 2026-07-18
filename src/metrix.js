/**
 * @file Lightweight performance counter for threads and pools.
 *
 * `Metrics` tracks cumulative statistics about task execution – counts,
 * error rates, duration distributions, and throughput.  Every thread and
 * pool maintain an internal `Metrics` instance that is updated
 * automatically after each task.
 *
 * **Design note:** Error recordings (where `success = false`) increment
 * the counter and error tally but do **not** affect `avg`, `min`, `max`,
 * or `throughput`.  This keeps the timing statistics meaningful – a
 * crashed task that took 0 ms should not pull the average down.
 *
 * @example
 * ```js
 * import { Metrics } from './metrix.js';
 *
 * const m = new Metrics();
 *
 * m.record(120, true);   // successful task, 120ms
 * m.record(85, true);    // successful task, 85ms
 * m.record(0, false);    // failed task
 *
 * const snap = m.snapshot();
 * console.log(snap);
 * // {
 * //   count: 3,        ← total tasks (success + error)
 * //   errors: 1,       ← failed tasks
 * //   avg: 102.5,      ← (120+85)/2 – only successes
 * //   min: 85,         ← fastest success
 * //   max: 120,        ← slowest success
 * //   throughput: 9.76 ← ~9.76 tasks/sec (only successes)
 * //   errorRate: 0.33  ← 33% error rate
 * // }
 * ```
 *
 * @module metrix
 */

/**
 * Tracks performance metrics for a thread or pool.
 *
 * Instances are lightweight – no timers, no async work.  They simply
 * accumulate data that you can query at any time via getters or
 * {@link Metrics.snapshot}.
 */
export class Metrics {
  /** Create an empty metrics tracker. */
  constructor() {
    /** @type {number} Total tasks recorded (success + error). */
    this._count = 0;
    /** @type {number} Successful tasks recorded. */
    this._successCount = 0;
    /** @type {number} Failed tasks recorded. */
    this._errors = 0;
    /** @type {number} Cumulative duration of successful tasks (ms). */
    this._totalTime = 0;
    /** @type {number} Shortest successful task (ms). */
    this._min = Infinity;
    /** @type {number} Longest successful task (ms). */
    this._max = -Infinity;
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record a single task execution.
   *
   * Call this once per completed (or failed) task.  Successful tasks
   * update duration stats (`avg`, `min`, `max`, `throughput`); failed
   * tasks only increment the error counter.
   *
   * @param {number} duration - Wall-clock duration in **milliseconds**.
   *   For failed tasks this is typically `0` since no meaningful timing
   *   is available.
   * @param {boolean} [success=true] - Pass `false` for failed tasks.
   *
   * @example
   * ```js
   * const m = new Metrics();
   * const start = performance.now();
   * await doWork();
   * m.record(performance.now() - start, true);
   * ```
   *
   * @example
   * ```js
   * // Recording a failure
   * m.record(0, false);
   * ```
   */
  record(duration, success = true) {
    this._count++;
    if (!success) {
      this._errors++;
      return;
    }
    this._successCount++;
    this._totalTime += duration;
    if (duration < this._min) this._min = duration;
    if (duration > this._max) this._max = duration;
  }

  // -----------------------------------------------------------------------
  // Getters
  // -----------------------------------------------------------------------

  /**
   * Average duration of **successful** tasks in milliseconds.
   *
   * Returns `0` when no successful tasks have been recorded.
   *
   * @type {number}
   *
   * @example
   * ```js
   * m.record(100, true);
   * m.record(200, true);
   * console.log(m.avg); // 150
   * ```
   */
  get avg() {
    return this._successCount > 0 ? this._totalTime / this._successCount : 0;
  }

  /**
   * Throughput of **successful** tasks per second.
   *
   * Computed as `successCount / (totalTimeMs / 1000)`.  Returns `0`
   * when no successful tasks have been recorded.
   *
   * @type {number}
   *
   * @example
   * ```js
   * m.record(500, true); // 500ms
   * m.record(500, true); // 500ms → total 1s
   * console.log(m.throughput); // 2 (tasks per second)
   * ```
   */
  get throughput() {
    return this._successCount > 0 ? this._successCount / (this._totalTime / 1000) : 0;
  }

  /**
   * Error rate as a fraction between 0 and 1.
   *
   * Computed as `errors / totalCount`.  Returns `0` when no tasks have
   * been recorded.
   *
   * @type {number}
   *
   * @example
   * ```js
   * m.record(0, false);
   * m.record(0, false);
   * m.record(100, true);
   * console.log(m.errorRate); // 0.666… (2 errors out of 3 tasks)
   * ```
   */
  get errorRate() {
    return this._count > 0 ? this._errors / this._count : 0;
  }

  // -----------------------------------------------------------------------
  // Snapshot & reset
  // -----------------------------------------------------------------------

  /**
   * Return an immutable snapshot of all metrics as a plain object.
   *
   * The snapshot is a **copy** – mutating it has no effect on the
   * tracker.  `min` and `max` are `0` when no successful tasks exist
   * (instead of `Infinity` / `-Infinity`).
   *
   * @returns {import('./types.js').MetricsSnapshot} Current metrics state.
   *
   * @example
   * ```js
   * const snap = thread.metrics; // calls snapshot() internally
   * console.log(`Tasks: ${snap.count}, Avg: ${snap.avg.toFixed(1)}ms`);
   * console.log(`Error rate: ${(snap.errorRate * 100).toFixed(1)}%`);
   * ```
   */
  snapshot() {
    return {
      count: this._count,
      errors: this._errors,
      avg: this.avg,
      min: this._min === Infinity ? 0 : this._min,
      max: this._max === -Infinity ? 0 : this._max,
      throughput: this.throughput,
      errorRate: this.errorRate,
    };
  }

  /**
   * Reset all counters to their initial values.
   *
   * After calling `reset()`, the tracker is indistinguishable from a
   * freshly constructed one.
   *
   * @example
   * ```js
   * // Reset metrics at the start of each minute
   * setInterval(() => {
   *   console.log('Last minute:', thread.metrics);
   *   thread._metrics.reset(); // internal, but illustrates the idea
   * }, 60_000);
   * ```
   */
  reset() {
    this._count = 0;
    this._successCount = 0;
    this._errors = 0;
    this._totalTime = 0;
    this._min = Infinity;
    this._max = -Infinity;
  }
}
