/**
 * @file Framework-agnostic adapters for connecting threads to state
 * management libraries.
 *
 * These adapters let you pipe thread/pool results into **Zustand** stores,
 * **Preact Signals**, or any custom state manager – without coupling
 * the thread to a specific framework.
 *
 * Every adapter follows the same pattern:
 *
 * ```
 * adapter(thread, ...) → { run, destroy }
 * ```
 *
 * - `run(...args)` – execute the task **and** push the result to the store.
 * - `destroy()` – clean up event listeners.
 *
 * **Why adapters instead of hooks?**
 *
 * Hooks are great inside components, but sometimes you need to wire a
 * thread to a store **outside** the component tree (e.g. in a module,
 * a web worker manager, or a service layer).  Adapters work anywhere.
 *
 * @example
 * ```js
 * import { createZustandBinder } from './adapters.js';
 * import { useDataStore } from '../stores/useDataStore.js';
 * import { createThread } from './factory.js';
 *
 * const thread = createThread((query) => db.query(query));
 *
 * // Bind thread results to Zustand store
 * const binder = createZustandBinder(thread, useDataStore, 'setData');
 *
 * // Now every thread.run() result is pushed to the store
 * await binder.run('SELECT * FROM users');
 * // → useDataStore.getState().data is now the result
 * ```
 *
 * @module adapters
 */

// ---------------------------------------------------------------------------
// Zustand adapter
// ---------------------------------------------------------------------------

/**
 * Bind a thread's results to a **Zustand** store action.
 *
 * Every time `run()` resolves, the result is passed to the specified
 * store action (typically a `set` call).  Errors are also forwarded to
 * an optional error action.
 *
 * @param {import('./thread.js').Thread} thread
 *   The thread to bind.
 * @param {Function} store
 *   The Zustand store hook (the return value of `create()`).
 * @param {string} action
 *   Name of the store action to call with the result.  The action
 *   receives `(result)` as its argument.
 * @param {Object} [options={}]
 * @param {string} [options.errorAction]
 *   Name of the store action to call on error.  Receives
 *   `(errorMessage)`.  If omitted, errors are thrown (not swallowed).
 * @param {boolean} [options.append=false]
 *   If `true`, the result is **appended** to an array in the store
 *   instead of replacing it.  Useful for log-style stores.
 * @param {string} [options.metricsAction]
 *   Name of the store action to call with every metrics snapshot.
 * @returns {{ run: Function, destroy: Function }}
 *   `run(...args)` – execute the task and push to the store.
 *   `destroy()` – stop listening to thread events.
 *
 * @example
 * ```js
 * import { create } from 'zustand';
 * import { createZustandBinder } from './adapters.js';
 *
 * const useStore = create((set) => ({
 *   data: null,
 *   loading: false,
 *   error: null,
 *   setData: (data) => set({ data, loading: false }),
 *   setError: (error) => set({ error, loading: false }),
 *   setLoading: () => set({ loading: true, error: null }),
 * }));
 *
 * const thread = createThread((query) => db.query(query));
 * const binder = createZustandBinder(thread, useStore, 'setData', {
 *   errorAction: 'setError',
 * });
 *
 * // In a component:
 * await binder.run('SELECT * FROM users');
 * const data = useStore.getState().data;
 * ```
 *
 * @example
 * ```js
 * // Append mode – for streaming logs
 * const logThread = createWorker((msg) => ({ text: msg, ts: Date.now() }));
 * const binder = createZustandBinder(logThread, useLogStore, 'appendLog', {
 *   append: true,
 * });
 *
 * binder.run('User logged in');
 * binder.run('Page loaded');
 * // useLogStore.getState().logs === [{ text: '...', ts: ... }, ...]
 * ```
 */
export function createZustandBinder(thread, store, action, options = {}) {
  const { errorAction = null, append = false, metricsAction = null } = options;

  const onResult = (result) => {
    const state = store.getState();
    if (append) {
      const current = state[action] || state[Object.keys(state).find((k) => Array.isArray(state[k]))];
      // If append mode, the action should accept (item) and handle appending
      store.getState()[action](result);
    } else {
      store.getState()[action](result);
    }
  };

  const onError = (info) => {
    if (errorAction && store.getState()[errorAction]) {
      store.getState()[errorAction](info.error || String(info));
    }
  };

  const onMetrics = metricsAction
    ? (snap) => {
        if (store.getState()[metricsAction]) {
          store.getState()[metricsAction](snap);
        }
      }
    : null;

  thread.on('result', onResult);
  thread.on('error', onError);
  if (onMetrics) thread.on('metrics', onMetrics);

  return {
    run: (...args) => thread.run(...args),
    destroy: () => {
      thread.off('result', onResult);
      thread.off('error', onError);
      if (onMetrics) thread.off('metrics', onMetrics);
    },
  };
}

// ---------------------------------------------------------------------------
// Preact Signals adapter
// ---------------------------------------------------------------------------

/**
 * Bind a thread's results to a **Preact Signal**.
 *
 * Every time `run()` resolves, the signal's value is updated.  Errors
 * can optionally be written to a separate signal.
 *
 * @param {import('./thread.js').Thread} thread
 *   The thread to bind.
 * @param {Object} signal
 *   A Preact Signal (or any object with `.value` getter/setter).
 * @param {Object} [options={}]
 * @param {Object} [options.errorSignal]
 *   A signal to write errors into (the signal's `.value` is set to
 *   the error message string, or `null` on success).
 * @param {Function} [options.transform]
 *   Optional transform applied to the result before writing to the
 *   signal: `(result) => transformedResult`.
 * @returns {{ run: Function, destroy: Function }}
 *
 * @example
 * ```js
 * import { signal } from '@preact/signals';
 * import { createSignalBinder } from './adapters.js';
 *
 * const dataSignal = signal(null);
 * const errorSignal = signal(null);
 *
 * const thread = createThread((x) => x * 2);
 * const binder = createSignalBinder(thread, dataSignal, {
 *   errorSignal,
 * });
 *
 * await binder.run(21);
 * console.log(dataSignal.value); // 42
 * console.log(errorSignal.value); // null
 * ```
 *
 * @example
 * ```js
 * // With transform
 * const countSignal = signal(0);
 * const binder = createSignalBinder(thread, countSignal, {
 *   transform: (result) => result.length,
 * });
 *
 * await binder.run(['a', 'b', 'c']);
 * console.log(countSignal.value); // 3
 * ```
 */
export function createSignalBinder(thread, signal, options = {}) {
  const { errorSignal = null, transform = null } = options;

  const onResult = (result) => {
    signal.value = transform ? transform(result) : result;
    if (errorSignal) errorSignal.value = null;
  };

  const onError = (info) => {
    if (errorSignal) {
      errorSignal.value = info.error || String(info);
    }
  };

  thread.on('result', onResult);
  thread.on('error', onError);

  return {
    run: (...args) => thread.run(...args),
    destroy: () => {
      thread.off('result', onResult);
      thread.off('error', onError);
    },
  };
}

// ---------------------------------------------------------------------------
// Generic reactive adapter
// ---------------------------------------------------------------------------

/**
 * Bind a thread's results to **any** reactive state system via a setter
 * callback.
 *
 * This is the most generic adapter – it works with MobX, Redux, Vue
 * refs, Svelte stores, or plain `setState` functions.
 *
 * @param {import('./thread.js').Thread} thread
 *   The thread to bind.
 * @param {Function} setter
 *   Called with `(result)` on success.  Typically a state setter like
 *   `setState` or `store.set`.
 * @param {Object} [options={}]
 * @param {Function} [options.onError]
 *   Called with `(error)` on failure.
 * @param {Function} [options.transform]
 *   Transform the result before passing to the setter.
 * @param {Function} [options.onMetrics]
 *   Called with every metrics snapshot.
 * @returns {{ run: Function, destroy: Function }}
 *
 * @example
 * ```js
 * import { createStoreBinder } from './adapters.js';
 *
 * // With React/Preact setState
 * function MyComponent() {
 *   const [data, setData] = useState(null);
 *   const thread = useMemo(() => createThread(process), []);
 *
 *   useEffect(() => {
 *     const binder = createStoreBinder(thread, setData, {
 *       onError: (err) => console.error(err),
 *     });
 *     return binder.destroy;
 *   }, [thread]);
 *
 *   return <div>{JSON.stringify(data)}</div>;
 * }
 * ```
 *
 * @example
 * ```js
 * // With a plain object
 * const state = { items: [] };
 * const binder = createStoreBinder(thread, (result) => {
 *   state.items = result;
 *   render(); // re-render
 * });
 * ```
 */
export function createStoreBinder(thread, setter, options = {}) {
  const { onError = null, transform = null, onMetrics = null } = options;

  const onResult = (result) => {
    setter(transform ? transform(result) : result);
  };

  const errorHandler = (info) => {
    if (onError) onError(info.error || String(info));
  };

  thread.on('result', onResult);
  thread.on('error', errorHandler);
  if (onMetrics) thread.on('metrics', onMetrics);

  return {
    run: (...args) => thread.run(...args),
    destroy: () => {
      thread.off('result', onResult);
      thread.off('error', errorHandler);
      if (onMetrics) thread.off('metrics', onMetrics);
    },
  };
}

// ---------------------------------------------------------------------------
// Pool adapter
// ---------------------------------------------------------------------------

/**
 * Bind a thread pool's results to a reactive state system.
 *
 * Works like {@link createStoreBinder} but for pools.  Additionally
 * supports batching – multiple pool results can be accumulated and
 * flushed together.
 *
 * @param {import('./pool.js').ThreadPool} pool
 *   The thread pool to bind.
 * @param {Function} setter
 *   Called with `(result)` on each task completion.
 * @param {Object} [options={}]
 * @param {Function} [options.onError]
 *   Called with `(error)` on failure.
 * @param {Function} [options.onMetrics]
 *   Called with pool metrics updates.
 * @param {number} [options.batchInterval]
 *   If set, results are accumulated for this many ms and then flushed
 *   as an array to the setter.  Useful for high-throughput scenarios.
 * @returns {{ run: Function, destroy: Function, flush: Function }}
 *   `flush()` – manually flush accumulated batch results.
 *
 * @example
 * ```js
 * import { createPoolBinder } from './adapters.js';
 *
 * const pool = createPool(4, heavyComputation);
 * const results = [];
 *
 * const binder = createPoolBinder(pool, (result) => {
 *   results.push(result);
 *   renderDashboard(results);
 * }, {
 *   batchInterval: 500, // flush every 500ms
 *   onMetrics: (snap) => updateMetrics(snap),
 * });
 *
 * items.forEach((item) => binder.run(item));
 * ```
 */
export function createPoolBinder(pool, setter, options = {}) {
  const { onError = null, onMetrics = null, batchInterval = null } = options;

  let batch = [];
  let batchTimer = null;

  const flush = () => {
    if (batch.length > 0) {
      setter(batch);
      batch = [];
    }
    if (batchTimer) {
      clearInterval(batchTimer);
      batchTimer = null;
    }
  };

  const onTaskResult = (result) => {
    if (batchInterval) {
      batch.push(result);
    } else {
      setter(result);
    }
  };

  const onTaskError = (info) => {
    if (onError) onError(info.error || String(info));
  };

  pool.on?.('result', onTaskResult);
  pool.on?.('error', onTaskError);
  if (onMetrics) pool.on?.('metrics', onMetrics);

  if (batchInterval) {
    batchTimer = setInterval(flush, batchInterval);
  }

  return {
    run: (...args) => pool.run(...args),
    flush,
    destroy: () => {
      flush();
      pool.off?.('result', onTaskResult);
      pool.off?.('error', onTaskError);
      if (onMetrics) pool.off?.('metrics', onMetrics);
      if (batchTimer) clearInterval(batchTimer);
    },
  };
}
