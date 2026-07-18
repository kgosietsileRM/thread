/**
 * @file Preact / React hooks for GPU compute.
 *
 * Provides lifecycle-bound hooks that mirror the thread/pool hooks
 * but are specialised for {@link GPUCompute} instances.
 *
 * @module gpu-hooks
 */

import { useRef, useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { GPUCompute } from './gpu.js';

// ---------------------------------------------------------------------------
// useGPU
// ---------------------------------------------------------------------------

/**
 * Create and manage a {@link GPUCompute} instance bound to a component's
 * lifecycle.
 *
 * The GPU device is lazily initialised on the first `run()` call.
 * The instance is automatically destroyed on unmount.
 *
 * @param {import('./types.js').GPUComputeOptions & { destroy?: boolean }} [options={}]
 *   GPU options plus `destroy: false` to skip automatic cleanup.
 * @returns {{
 *   gpu: GPUCompute,
 *   run: (...args: any[]) => Promise<any>,
 *   pipe: (name?: string, count?: number) => import('./gpu-chains.js').DataPipelineChain,
 *   define: (name: string, fn: Function) => void,
 *   result: any,
 *   loading: boolean,
 *   error: string|null,
 *   status: string,
 *   metrics: import('./types.js').MetricsSnapshot,
 * }}
 *
 * @example
 * ```jsx
 * function GPUDemo({ prices }) {
 *   const { run, result, loading, error, status } = useGPU();
 *
 *   const handleEMA = () => {
 *     run('ema', new Float32Array(prices), { alpha: 0.3 });
 *   };
 *
 *   return (
 *     <div>
 *       <p>GPU: {status}</p>
 *       <button onClick={handleEMA} disabled={loading}>
 *         {loading ? 'Computing...' : 'Run EMA'}
 *       </button>
 *       {error && <p className="error">{error}</p>}
 *       {result && <pre>{JSON.stringify(Array.from(result))}</pre>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useGPU(options = {}) {
  const { destroy = true, ...gpuOpts } = options;

  const gpuRef = useRef(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('idle');
  const [metricsSnapshot, setMetricsSnapshot] = useState({});

  // Create instance once
  if (gpuRef.current === null) {
    gpuRef.current = new GPUCompute(gpuOpts);
  }
  const gpu = gpuRef.current;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (gpu && destroy) {
        gpu.destroy();
      }
    };
  }, [gpu, destroy]);

  // Poll metrics & status
  useEffect(() => {
    if (!gpu) return;
    const interval = setInterval(() => {
      setStatus(gpu.status);
      setMetricsSnapshot(gpu.metrics);
    }, 500);
    return () => clearInterval(interval);
  }, [gpu]);

  // Stable run function
  const run = useCallback(
    async (...args) => {
      setLoading(true);
      setError(null);
      setStatus(gpu.status);
      try {
        const res = await gpu.run(...args);
        setResult(res);
        setLoading(false);
        setStatus(gpu.status);
        setMetricsSnapshot(gpu.metrics);
        return res;
      } catch (err) {
        const msg = err.message || String(err);
        setError(msg);
        setLoading(false);
        setStatus(gpu.status);
        throw err;
      }
    },
    [gpu],
  );

  // Stable pipe
  const pipe = useCallback(
    (name, count) => gpu.pipe(name, count),
    [gpu],
  );

  // Stable define
  const define = useCallback(
    (name, fn) => gpu.define(name, fn),
    [gpu],
  );

  return { gpu, run, pipe, define, result, loading, error, status, metrics: metricsSnapshot };
}

// ---------------------------------------------------------------------------
// useGPURun
// ---------------------------------------------------------------------------

/**
 * Get a stable `run` wrapper around an existing {@link GPUCompute}
 * instance, with reactive loading / result / error state.
 *
 * Use this when you manage the GPU instance yourself (e.g. in a store
 * or module-level variable).
 *
 * @param {GPUCompute} gpu - Existing GPU instance.
 * @returns {{
 *   run: (...args: any[]) => Promise<any>,
 *   result: any,
 *   loading: boolean,
 *   error: string|null,
 * }}
 *
 * @example
 * ```jsx
 * // Shared GPU across components
 * const sharedGPU = new GPUCompute();
 *
 * function ComponentA() {
 *   const { run, result, loading } = useGPURun(sharedGPU);
 *   return <button onClick={() => run('add', data1, data2)}>A</button>;
 * }
 * ```
 */
export function useGPURun(gpu) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    async (...args) => {
      if (!gpu) {
        const msg = 'No GPU instance';
        setError(msg);
        throw new Error(msg);
      }
      setLoading(true);
      setError(null);
      try {
        const res = await gpu.run(...args);
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
    [gpu],
  );

  return useMemo(() => ({ run, result, loading, error }), [run, result, loading, error]);
}

// ---------------------------------------------------------------------------
// useGPUMetrics
// ---------------------------------------------------------------------------

/**
 * Subscribe to a {@link GPUCompute} instance's metrics and re-render
 * on updates.
 *
 * @param {GPUCompute} [gpu] - GPU instance.  If `null`/`undefined`,
 *   returns a zeroed snapshot.
 * @param {number} [intervalMs=500] - Polling interval in ms.
 * @returns {import('./types.js').MetricsSnapshot}
 *
 * @example
 * ```jsx
 * function GPUDashboard({ gpu }) {
 *   const metrics = useGPUMetrics(gpu, 250);
 *
 *   return (
 *     <div>
 *       <span>{metrics.count} dispatches</span>
 *       <span>{metrics.avg?.toFixed(1)}ms avg</span>
 *     </div>
 *   );
 * }
 * ```
 */
export function useGPUMetrics(gpu, intervalMs = 500) {
  const [snapshot, setSnapshot] = useState(
    gpu ? gpu.metrics : { count: 0, errors: 0, avg: 0, min: 0, max: 0, throughput: 0, errorRate: 0 },
  );

  useEffect(() => {
    if (!gpu) return;
    const interval = setInterval(() => {
      setSnapshot(gpu.metrics);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [gpu, intervalMs]);

  return snapshot;
}

// ---------------------------------------------------------------------------
// useGPUStatus
// ---------------------------------------------------------------------------

/**
 * Reactive status string for a {@link GPUCompute} instance.
 *
 * Returns one of: `'idle'`, `'running'`, `'error'`, `'unavailable'`.
 *
 * @param {GPUCompute} [gpu] - GPU instance.
 * @param {number} [intervalMs=500] - Polling interval in ms.
 * @returns {string}
 *
 * @example
 * ```jsx
 * function StatusBadge({ gpu }) {
 *   const status = useGPUStatus(gpu);
 *   return <span className={`badge badge-${status}`}>{status}</span>;
 * }
 * ```
 */
export function useGPUStatus(gpu, intervalMs = 500) {
  const [status, setStatus] = useState(gpu ? gpu.status : 'idle');

  useEffect(() => {
    if (!gpu) return;
    const interval = setInterval(() => {
      setStatus(gpu.status);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [gpu, intervalMs]);

  return status;
}
