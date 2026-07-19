/**
 * @file Framework-agnostic hooks for the thread module.
 *
 * These hooks manage thread and pool lifecycles automatically – threads
 * are created on mount and terminated on unmount.  They also provide
 * reactive state for metrics, loading, and errors.
 *
 * The framework (Preact, React, etc.) is resolved at load time via the
 * thread config system.  No hardcoded framework dependency.
 *
 * @example
 * ```jsx
 * import { useThread, usePool, useThreadMetrics } from './hooks.js';
 *
 * function DataProcessor({ data }) {
 *   const { run, loading, error, result } = useThread(
 *     (items, ctx) => {
 *       ctx.log('Processing...');
 *       return items.map((x) => x * 2);
 *     },
 *     { timeout: 10_000 }
 *   );
 *
 *   const metrics = useThreadMetrics();
 *
 *   return (
 *     <div>
 *       {loading && <Spinner />}
 *       {error && <Error message={error} />}
 *       {result && <Results data={result} />}
 *       <MetricsBar avg={metrics.avg} throughput={metrics.throughput} />
 *     </div>
 *   );
 * }
 * ```
 *
 * @module hooks
 */

import { getHooks } from './config/index.js';
import { Thread } from "./thread.js";
import { ThreadPool } from "./pool.js";

// Resolve framework hooks at module load time (top-level await)
let useState, useEffect, useRef, useCallback, useMemo;
try {
  ({ useState, useEffect, useRef, useCallback, useMemo } = await getHooks());
} catch {
  const _stub = () => { throw new Error('[thread] No framework installed. Install preact or react to use hooks.'); };
  useState = _stub; useEffect = _stub; useRef = _stub; useCallback = _stub; useMemo = _stub;
}

// ---------------------------------------------------------------------------
// useThread
// ---------------------------------------------------------------------------

/**
 * Create and manage a Web Worker thread bound to a component's lifecycle.
 *
 * The thread is created on first render and **automatically terminated**
 * when the component unmounts.  Returns a stable `run` function and
 * reactive state for the latest result, error, and loading status.
 *
 * **Key behaviours:**
 * - The thread instance is stored in a ref – it does not change between
 *   renders.
 * - `run()` returns a promise **and** updates `result`/`error`/`loading`
 *   state for declarative rendering.
 * - The thread is terminated on unmount (via `terminate()` by default, or
 *   `terminateGracefully()` if `graceful: true` is set).
 * - The `definition` and `options` are captured once.  To change them,
 *   pass a `key` to force re-creation.
 *
 * @param {import('./types.js').ThreadDefinition | Function} definition
 *   Worker definition (function or `{ setup, exec, cleanup }` object).
 * @param {import('./types.js').ThreadOptions & { graceful?: boolean }} [options={}]
 *   Thread options plus `graceful: true` to use `terminateGracefully()`.
 * @returns {{
 *   thread: Thread,
 *   run: (...args: any[]) => Promise<any>,
 *   runAsync: (...args: any[]) => void,
 *   result: any,
 *   error: string | null,
 *   loading: boolean,
 *   terminated: boolean,
 * }}
 *
 * @example
 * ```jsx
 * const { run, result, loading, error } = useThread((x) => x * 2);
 *
 * return (
 *   <button onClick={() => run(21)} disabled={loading}>
 *     {loading ? 'Computing...' : result ?? 'Click to compute'}
 *   </button>
 * );
 * ```
 *
 * @example
 * ```jsx
 * // With stateful definition
 * const { run } = useThread({
 *   setup() { return { count: 0 }; },
 *   exec(state, delta) {
 *     state.count += delta;
 *     return state.count;
 *   },
 * }, { timeout: 5000 });
 * ```
 */
export function useThread(definition, options = {}) {
  const { graceful = false, ...threadOpts } = options;

  const threadRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [terminated, setTerminated] = useState(false);

  // Create thread once
  if (threadRef.current === null) {
    threadRef.current = new Thread(definition, threadOpts);
  }
  const thread = threadRef.current;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (thread && !thread.terminated) {
        if (graceful) {
          thread.terminateGracefully();
        } else {
          thread.terminate();
        }
        setTerminated(true);
      }
    };
  }, [thread, graceful]);

  // Stable run function
  const run = useCallback(
    async (...args) => {
      if (thread.terminated) {
        const msg = "Thread is terminated";
        setError(msg);
        throw new Error(msg);
      }
      setLoading(true);
      setError(null);
      try {
        const res = await thread.run(...args);
        setResult(res);
        setLoading(false);
        return res;
      } catch (err) {
        const msg = err.message || String(err);
        setError(msg);
        setLoading(false);
        throw err;
      }
    },
    [thread],
  );

  // Fire-and-forget
  const runAsync = useCallback(
    (...args) => {
      thread.runAsync(...args);
    },
    [thread],
  );

  return { thread, run, runAsync, result, error, loading, terminated };
}

// ---------------------------------------------------------------------------
// usePool
// ---------------------------------------------------------------------------

/**
 * Create and manage a thread pool bound to a component's lifecycle.
 *
 * @param {number} size - Initial number of workers.
 * @param {import('./types.js').ThreadDefinition | Function} definition
 *   Worker definition.
 * @param {import('./types.js').PoolOptions & { graceful?: boolean }} [options={}]
 *   Pool options plus `graceful: true`.
 * @returns {{
 *   pool: ThreadPool,
 *   run: (...args: any[]) => { id: number, promise: Promise<any> },
 *   cancel: (taskId: number) => boolean,
 *   status: () => import('./types.js').PoolStatus,
 *   metrics: import('./types.js').MetricsSnapshot,
 *   terminated: boolean,
 * }}
 *
 * @example
 * ```jsx
 * function ParallelWorker({ items }) {
 *   const { run, status, metrics } = usePool(4, (item) => process(item));
 *
 *   const handleRunAll = () => {
 *     items.forEach((item) => run(item));
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleRunAll}>Process all</button>
 *       <p>{status().busy} threads busy</p>
 *       <p>Avg: {metrics.avg.toFixed(1)}ms</p>
 *     </div>
 *   );
 * }
 * ```
 */
export function usePool(size, definition, options = {}) {
  const { graceful = false, ...poolOpts } = options;

  const poolRef = useRef(null);
  const [metricsSnapshot, setMetricsSnapshot] = useState({});
  const [terminated, setTerminated] = useState(false);

  // Create pool once
  if (poolRef.current === null) {
    poolRef.current = new ThreadPool(size, definition, poolOpts);
  }
  const pool = poolRef.current;

  // Subscribe to metrics
  useEffect(() => {
    if (!pool) return;
    const interval = setInterval(() => {
      if (!pool.terminated) {
        setMetricsSnapshot(pool.metrics);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [pool]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pool) {
        if (graceful) {
          pool.terminateGracefully();
        } else {
          pool.terminateAll();
        }
        setTerminated(true);
      }
    };
  }, [pool, graceful]);

  // Stable run
  const run = useCallback(
    (...args) => pool.run(...args),
    [pool],
  );

  // Stable cancel
  const cancel = useCallback(
    (taskId) => pool.cancel(taskId),
    [pool],
  );

  // Stable status
  const status = useCallback(
    () => pool.status(),
    [pool],
  );

  return { pool, run, cancel, status, metrics: metricsSnapshot, terminated };
}

// ---------------------------------------------------------------------------
// useThreadMetrics
// ---------------------------------------------------------------------------

/**
 * Subscribe to a thread's metrics and re-render on updates.
 *
 * Polls `thread.metrics` at the given interval and triggers a re-render
 * when the snapshot changes.
 *
 * @param {Thread} [thread] - Thread instance.  If `null`/`undefined`,
 *   returns a zeroed snapshot.
 * @param {number} [intervalMs=1000] - Polling interval in ms.
 * @returns {import('./types.js').MetricsSnapshot}
 *
 * @example
 * ```jsx
 * function MetricsDisplay({ thread }) {
 *   const metrics = useThreadMetrics(thread, 500);
 *
 *   return (
 *     <div>
 *       <span>{metrics.count} tasks</span>
 *       <span>{metrics.avg.toFixed(1)}ms avg</span>
 *       <span>{(metrics.errorRate * 100).toFixed(1)}% errors</span>
 *     </div>
 *   );
 * }
 * ```
 */
export function useThreadMetrics(thread, intervalMs = 1000) {
  const [snapshot, setSnapshot] = useState(
    thread ? thread.metrics : { count: 0, errors: 0, avg: 0, min: 0, max: 0, throughput: 0, errorRate: 0 },
  );

  useEffect(() => {
    if (!thread) return;
    const interval = setInterval(() => {
      if (!thread.terminated) {
        setSnapshot(thread.metrics);
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [thread, intervalMs]);

  return snapshot;
}

// ---------------------------------------------------------------------------
// usePoolMetrics
// ---------------------------------------------------------------------------

/**
 * Subscribe to a pool's metrics and re-render on updates.
 *
 * @param {ThreadPool} [pool] - Pool instance.
 * @param {number} [intervalMs=1000] - Polling interval in ms.
 * @returns {import('./types.js').MetricsSnapshot}
 *
 * @example
 * ```jsx
 * function PoolDashboard({ pool }) {
 *   const metrics = usePoolMetrics(pool);
 *   const status = useMemo(() => pool.status(), [pool, metrics]);
 *
 *   return (
 *     <div>
 *       <p>{status.busy}/{status.total} threads busy</p>
 *       <p>Avg: {metrics.avg?.toFixed(1)}ms</p>
 *       <p>Throughput: {metrics.throughput?.toFixed(0)} t/s</p>
 *     </div>
 *   );
 * }
 * ```
 */
export function usePoolMetrics(pool, intervalMs = 1000) {
  const [snapshot, setSnapshot] = useState(
    pool ? pool.metrics : { count: 0, errors: 0, avg: 0, min: 0, max: 0, throughput: 0, errorRate: 0 },
  );

  useEffect(() => {
    if (!pool) return;
    const interval = setInterval(() => {
      setSnapshot(pool.metrics);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [pool, intervalMs]);

  return snapshot;
}

// ---------------------------------------------------------------------------
// useThreadWorker
// ---------------------------------------------------------------------------

/**
 * Get a stable reference to a thread's `run` function without managing
 * lifecycle (for use when you manage the thread yourself).
 *
 * Returns a memoised `run` callback that always uses the same thread.
 * Useful when the thread is created outside the component (e.g. in a
 * store or module-level variable).
 *
 * @param {Thread} thread - An existing thread instance.
 * @returns {{
 *   run: (...args: any[]) => Promise<any>,
 *   runAsync: (...args: any[]) => void,
 * }}
 *
 * @example
 * ```js
 * // Shared thread across components
 * const sharedThread = createWorker((x) => x * 2);
 *
 * function ComponentA() {
 *   const { run } = useThreadWorker(sharedThread);
 *   return <button onClick={() => run(5)}>A</button>;
 * }
 *
 * function ComponentB() {
 *   const { run } = useThreadWorker(sharedThread);
 *   return <button onClick={() => run(10)}>B</button>;
 * }
 * ```
 */
export function useThreadWorker(thread) {
  const run = useCallback(
    (...args) => thread.run(...args),
    [thread],
  );

  const runAsync = useCallback(
    (...args) => thread.runAsync(...args),
    [thread],
  );

  return useMemo(() => ({ run, runAsync }), [run, runAsync]);
}

// ---------------------------------------------------------------------------
// useThreadEvent
// ---------------------------------------------------------------------------

/**
 * Subscribe to a thread event and clean up on unmount.
 *
 * @param {Thread} thread - Thread instance.
 * @param {import('./types.js').ThreadEventName} event - Event name.
 * @param {Function} handler - Event handler.
 *
 * @example
 * ```jsx
 * function LogViewer({ thread }) {
 *   const [logs, setLogs] = useState([]);
 *
 *   useThreadEvent(thread, 'log', (msg) => {
 *     setLogs((prev) => [...prev, msg]);
 *   });
 *
 *   return (
 *     <pre>{logs.join('\n')}</pre>
 *   );
 * }
 * ```
 */
export function useThreadEvent(thread, event, handler) {
  useEffect(() => {
    if (!thread || !handler) return;
    thread.on(event, handler);
    return () => {
      thread.off(event, handler);
    };
  }, [thread, event, handler]);
}
