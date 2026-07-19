/**
 * @file State manager adapter registry for the thread config system.
 *
 * Maps a state manager name (e.g. `'zustand'`, `'redux'`) to the
 * appropriate adapter constructors for threads and GPU.
 *
 * ## How adapters work
 *
 * Adapters bridge thread's thread/pool/GPU instances to your state manager.
 * They follow a consistent pattern:
 *
 * ```
 * adapter(threadOrGpu, store, action, options) → { run, destroy }
 * ```
 *
 * - `run(...args)` — execute the task **and** push the result to the store
 * - `destroy()` — clean up event listeners
 *
 * Different state managers have different update patterns:
 *
 * | Type | Pattern | Used by |
 * |------|---------|---------|
 * | `action` | Call a store action by name: `store.getAction('setData')(result)` | Zustand |
 * | `signal` | Write to a signal's `.value` property: `signal.value = result` | Preact Signals |
 * | `setter` | Call a setter callback: `setter(result)` | Redux, Jotai, MobX, vanilla |
 *
 * ## Why some adapters are the same
 *
 * Redux, Jotai, MobX, and vanilla JS all use the same adapter
 * (`createStoreBinder`) because they all accept a generic setter callback.
 * The difference is in how you *create* the store, not in how thread
 * pushes results to it.
 *
 * @example
 * ```js
 * // All of these use the same adapter under the hood:
 * import { getAdapter } from './config/adapters.js';
 *
 * const reduxAdapter = getAdapter('redux');
 * const jotaiAdapter = getAdapter('jotai');
 * const mobxAdapter = getAdapter('mobx');
 *
 * // reduxAdapter.thread === jotaiAdapter.thread === mobxAdapter.thread
 * // They're all `createStoreBinder`
 * ```
 *
 * @module config/adapters
 */

import {
  createZustandBinder,
  createSignalBinder,
  createStoreBinder,
} from '../adapters.js';

import {
  createGPUBinder,
  createGPUSignalBinder,
  createGPUStoreBinder,
} from '../gpu/adapters.js';

// ---------------------------------------------------------------------------
// Adapter map
// ---------------------------------------------------------------------------

/**
 * Mapping of state manager names to their adapter constructors.
 *
 * Each entry provides:
 * - `thread`: adapter constructor for thread/pool binding
 * - `gpu`: adapter constructor for GPU binding
 * - `type`: hint about the update pattern (`'action'` | `'signal'` | `'setter'`)
 *
 * @type {Record<string, { thread: Function, gpu: Function, type: string }>}
 * @private
 */
const ADAPTER_MAP = {
  zustand: {
    thread: createZustandBinder,
    gpu: createGPUBinder,
    type: 'action',
  },
  signals: {
    thread: createSignalBinder,
    gpu: createGPUSignalBinder,
    type: 'signal',
  },
  redux: {
    thread: createStoreBinder,
    gpu: createGPUStoreBinder,
    type: 'setter',
  },
  jotai: {
    thread: createStoreBinder,
    gpu: createGPUStoreBinder,
    type: 'setter',
  },
  mobx: {
    thread: createStoreBinder,
    gpu: createGPUStoreBinder,
    type: 'setter',
  },
  vanilla: {
    thread: createStoreBinder,
    gpu: createGPUStoreBinder,
    type: 'setter',
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get adapter constructors for a given state manager.
 *
 * Returns the thread and GPU adapter constructors, plus a type hint
 * that tells you how the adapter works.
 *
 * @param {string} stateManager
 *   State manager name.  Must be one of the values in {@link STATE_MANAGERS}.
 * @param {Function|null} [customAdapter=null]
 *   Optional custom adapter factory.  If provided, it is used for both
 *   thread and GPU adapters, overriding the registry lookup.
 *
 * @returns {{ thread: Function, gpu: Function, type: string }}
 *   Adapter constructors and type hint.
 *
 * @example
 * ```js
 * import { getAdapter } from './config/adapters.js';
 *
 * // Get Zustand adapters
 * const { thread, gpu, type } = getAdapter('zustand');
 * console.log(type); // 'action'
 *
 * // Use the thread adapter
 * const binder = thread(myThread, useStore, 'setData', {
 *   errorAction: 'setError',
 * });
 *
 * // Now every thread.run() result is pushed to the store
 * await binder.run('some data');
 * ```
 *
 * @example
 * ```js
 * // Get Redux adapters (generic setter pattern)
 * const { thread, type } = getAdapter('redux');
 * console.log(type); // 'setter'
 *
 * // The adapter works with any setter function:
 * const binder = thread(myThread, (result) => {
 *   dispatch({ type: 'SET_DATA', payload: result });
 * });
 * ```
 *
 * @example
 * ```js
 * // Custom adapter
 * const myAdapter = (instance, store, action) => ({
 *   run: async (...args) => {
 *     const result = await instance.run(...args);
 *     store.dispatch({ type: action, payload: result });
 *   },
 *   destroy: () => {},
 * });
 *
 * const { thread } = getAdapter('custom', myAdapter);
 * ```
 */
export function getAdapter(stateManager, customAdapter = null) {
  if (typeof customAdapter === 'function') {
    return { thread: customAdapter, gpu: customAdapter, type: 'custom' };
  }

  const entry = ADAPTER_MAP[stateManager];

  if (!entry) {
    console.warn(
      `[thread] Unknown stateManager: "${stateManager}". Falling back to "vanilla". ` +
      `Valid options: ${Object.keys(ADAPTER_MAP).join(', ')}`
    );
    return ADAPTER_MAP.vanilla;
  }

  return entry;
}
