/**
 * @file Framework adapters for GPU compute.
 *
 * These adapters bridge {@link GPUCompute} to Zustand, Preact Signals,
 * and any generic reactive setter.  Unlike the thread adapters which
 * rely on an event emitter, GPU adapters intercept `run()` calls
 * directly because {@link GPUCompute} does not emit events.
 *
 * @module gpu-adapters
 */

// ---------------------------------------------------------------------------
// Zustand adapter
// ---------------------------------------------------------------------------

/**
 * Bind a GPU compute instance's results to a **Zustand** store.
 *
 * Every time `binder.run()` resolves, the specified store action is
 * called with the result.  Errors can optionally be routed to a
 * separate action.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 *   The GPU instance to bind.
 * @param {Function} store
 *   The Zustand hook (e.g. `useStore`).
 * @param {string} action
 *   Name of the store action to call with results.
 * @param {Object} [options={}]
 * @param {string} [options.errorAction]
 *   Store action to call with error messages on failure.
 * @param {Function} [options.transform]
 *   Transform the result before writing to the store.
 * @param {string} [options.metricsAction]
 *   Store action to call with metrics snapshots.
 * @returns {{ run: Function, destroy: Function }}
 *
 * @example
 * ```js
 * import { create } from 'zustand';
 * import { createGPUCompute } from './gpu.js';
 * import { createGPUBinder } from './gpu-adapters.js';
 *
 * const useStore = create((set) => ({
 *   result: null,
 *   loading: false,
 *   error: null,
 *   setData: (data) => set({ result: data, loading: false }),
 *   setError: (err) => set({ error: err, loading: false }),
 *   setLoading: () => set({ loading: true, error: null }),
 * }));
 *
 * const gpu = createGPUCompute({ shader: myShader });
 * const binder = createGPUBinder(gpu, useStore, 'setData', {
 *   errorAction: 'setError',
 * });
 *
 * await binder.run('add', data1, data2);
 * const data = useStore.getState().result;
 * ```
 */
export function createGPUBinder(gpu, store, action, options = {}) {
  const { errorAction = null, transform = null, metricsAction = null } = options;

  const originalRun = gpu.run.bind(gpu);

  const wrappedRun = async (...args) => {
    const state = store.getState();
    if (state[action]) state[action].loading?.call ? undefined : undefined;
    if (state.setLoading) state.setLoading();

    try {
      const result = await originalRun(...args);
      const finalResult = transform ? transform(result) : result;
      store.getState()[action](finalResult);
      if (metricsAction && store.getState()[metricsAction]) {
        store.getState()[metricsAction](gpu.metrics);
      }
      return result;
    } catch (err) {
      if (errorAction && store.getState()[errorAction]) {
        store.getState()[errorAction](err.message || String(err));
      }
      throw err;
    }
  };

  return {
    run: wrappedRun,
    destroy: () => {
      // wrappedRun holds originalRun in closure — nothing to undo
    },
  };
}

// ---------------------------------------------------------------------------
// Preact Signals adapter
// ---------------------------------------------------------------------------

/**
 * Bind a GPU compute instance's results to a **Preact Signal**.
 *
 * Every time `binder.run()` resolves, the signal's value is updated.
 * Errors can optionally be written to a separate signal.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 *   The GPU instance to bind.
 * @param {Object} signal
 *   A Preact Signal (or any object with `.value` getter/setter).
 * @param {Object} [options={}]
 * @param {Object} [options.errorSignal]
 *   A signal to write errors into.
 * @param {Function} [options.transform]
 *   Transform the result before writing to the signal.
 * @param {Object} [options.loadingSignal]
 *   A signal to write loading state (boolean) into.
 * @returns {{ run: Function, destroy: Function }}
 *
 * @example
 * ```js
 * import { signal } from '@preact/signals';
 * import { createGPUCompute } from './gpu.js';
 * import { createGPUSignalBinder } from './gpu-adapters.js';
 *
 * const dataSignal = signal(null);
 * const errorSignal = signal(null);
 * const loadingSignal = signal(false);
 *
 * const gpu = createGPUCompute();
 * const binder = createGPUSignalBinder(gpu, dataSignal, {
 *   errorSignal,
 *   loadingSignal,
 * });
 *
 * await binder.run('ema', priceData, { alpha: 0.3 });
 * console.log(dataSignal.value); // Float32Array of EMA values
 * ```
 */
export function createGPUSignalBinder(gpu, signal, options = {}) {
  const { errorSignal = null, transform = null, loadingSignal = null } = options;

  const originalRun = gpu.run.bind(gpu);

  const wrappedRun = async (...args) => {
    if (loadingSignal) loadingSignal.value = true;
    if (errorSignal) errorSignal.value = null;

    try {
      const result = await originalRun(...args);
      signal.value = transform ? transform(result) : result;
      if (errorSignal) errorSignal.value = null;
      if (loadingSignal) loadingSignal.value = false;
      return result;
    } catch (err) {
      if (errorSignal) errorSignal.value = err.message || String(err);
      if (loadingSignal) loadingSignal.value = false;
      throw err;
    }
  };

  return {
    run: wrappedRun,
    destroy: () => {},
  };
}

// ---------------------------------------------------------------------------
// Generic reactive adapter
// ---------------------------------------------------------------------------

/**
 * Bind a GPU compute instance's results to **any** reactive state
 * system via a setter callback.
 *
 * Works with MobX, Redux, Vue refs, Svelte stores, or plain `setState`
 * functions.
 *
 * @param {import('./gpu.js').GPUCompute} gpu
 *   The GPU instance to bind.
 * @param {Function} setter
 *   Called with `(result)` on success.
 * @param {Object} [options={}]
 * @param {Function} [options.onError]
 *   Called with `(error)` on failure.
 * @param {Function} [options.transform]
 *   Transform the result before passing to the setter.
 * @param {Function} [options.onMetrics]
 *   Called with metrics snapshots after each run.
 * @returns {{ run: Function, destroy: Function }}
 *
 * @example
 * ```js
 * import { createGPUStoreBinder } from './gpu-adapters.js';
 *
 * const gpu = createGPUCompute();
 * const [data, setData] = useState(null);
 *
 * const binder = createGPUStoreBinder(gpu, setData, {
 *   onError: (err) => console.error(err),
 * });
 *
 * await binder.run('ema', priceData, { alpha: 0.3 });
 * // data is now set to the result
 * ```
 */
export function createGPUStoreBinder(gpu, setter, options = {}) {
  const { onError = null, transform = null, onMetrics = null } = options;

  const originalRun = gpu.run.bind(gpu);

  const wrappedRun = async (...args) => {
    try {
      const result = await originalRun(...args);
      setter(transform ? transform(result) : result);
      if (onMetrics) onMetrics(gpu.metrics);
      return result;
    } catch (err) {
      if (onError) onError(err.message || String(err));
      throw err;
    }
  };

  return {
    run: wrappedRun,
    destroy: () => {},
  };
}
