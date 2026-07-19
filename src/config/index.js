/**
 * @file Core config loader for the thread library.
 *
 * This is the central hub of the configuration system.  It:
 *
 * 1. **Loads** `thread.config.js` from the user's project root
 * 2. **Merges** it with built-in defaults
 * 3. **Caches** the resolved config for fast access
 * 4. **Resolves** framework hooks and state manager adapters on demand
 *
 * ## How config loading works
 *
 * The config file is loaded **synchronously** using `fs.readFileSync`.
 * This is intentional — the config must be available before any hooks
 * are called (hooks use top-level `await` to resolve the framework).
 *
 * If `thread.config.js` doesn't exist, the library uses built-in defaults
 * (Preact + Zustand).  This means **thread works out of the box** with
 * zero configuration.
 *
 * ## Caching
 *
 * - `getConfig()` — caches the resolved config object
 * - `getHooks()` — caches the resolved framework hooks (async import)
 * - `getResolvedAdapter()` — caches the resolved adapter constructors
 *
 * All caches are cleared by `setConfig()`, which should be called during
 * HMR (Hot Module Reload) to pick up config changes.
 *
 * @example
 * ```js
 * // Get the config
 * import { getConfig } from 'thread/config';
 *
 * const config = getConfig();
 * console.log(config.framework);  // 'react'
 * console.log(config.gpu.workgroupSize);  // 256
 * ```
 *
 * @example
 * ```js
 * // Force re-resolution (e.g. during HMR)
 * import { setConfig, getConfig } from 'thread/config';
 *
 * // User edits thread.config.js...
 * setConfig();  // Clear all caches
 * const fresh = getConfig();  // Re-reads the file
 * ```
 *
 * @module config/index
 */

import { mergeWithDefaults, validateConfig } from './schema.js';
import { resolveHooks } from './frameworks.js';
import { getAdapter } from './adapters.js';

// Re-export for consumers who need direct access
export { mergeWithDefaults, validateConfig } from './schema.js';
export { resolveHooks } from './frameworks.js';
export { getAdapter } from './adapters.js';
import { loadConfigFile, loadConfigWithOverride, setProgrammaticConfig, getProgrammaticConfig, clearProgrammaticConfig } from './env.js';

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

/** @type {import('../types.js').threadConfig|null} Resolved config cache. */
let _config = null;

/** @type {Object|null} Cached resolved framework hooks. */
let _hooks = null;

/** @type {Object|null} Cached resolved adapter constructors. */
let _adapter = null;

// ---------------------------------------------------------------------------
// Internal: config file loading (delegated to config/env.js)
// ---------------------------------------------------------------------------

/**
 * Load configuration from the environment.
 *
 * Delegates to the cross-environment config loader which handles
 * Node.js, Bun, Deno, and browser/edge environments.  In browser/edge,
 * returns the programmatic config if set, otherwise `null`.
 *
 * @returns {Record<string, any>|null}
 *   The parsed config object, or `null` if not found.
 * @private
 */
function _loadConfig() {
  return loadConfigWithOverride();
}

/**
 * Resolve the full configuration.
 *
 * Loads `thread.config.js` from the project root, validates it, and
 * merges it with defaults.  If the file doesn't exist, returns
 * the default config.
 *
 * @returns {import('../types.js').threadConfig}
 *   Fully resolved configuration.
 * @private
 */
export function resolveConfig() {
  const file = _loadConfig();
  const userConfig = file || {};

  validateConfig(userConfig);
  return mergeWithDefaults(userConfig);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the resolved thread configuration.
 *
 * On first call, loads and resolves `thread.config.js` from the project root.
 * Subsequent calls return the cached config (fast, no file I/O).
 *
 * If `thread.config.js` doesn't exist, returns the default config
 * (Preact + Zustand + default GPU/thread/pool settings).
 *
 * @returns {import('../types.js').threadConfig}
 *   The resolved configuration object.
 *
 * @example
 * ```js
 * import { getConfig } from 'thread/config';
 *
 * const config = getConfig();
 *
 * // Use config to decide behavior
 * if (config.framework === 'react') {
 *   // React-specific code
 * }
 *
 * // Access GPU defaults
 * console.log(config.gpu.workgroupSize);  // 256
 * ```
 *
 * @example
 * ```js
 * // Config is frozen — mutation attempts silently fail
 * const config = getConfig();
 * config.framework = 'vue';  // Error in strict mode, silent in sloppy
 * console.log(config.framework);  // Still 'preact'
 * ```
 */
export function getConfig() {
  if (!_config) {
    _config = resolveConfig();
  }
  return _config;
}

/**
 * Force re-resolution of the configuration.
 *
 * Clears all cached state (config, hooks, adapters).  The next call to
 * `getConfig()` will re-read `thread.config.js` from disk.
 *
 * **When to call this:**
 * - During HMR (Hot Module Reload) when the user edits `thread.config.js`
 * - In test teardown to reset state between tests
 * - When you need to programmatically change the config
 *
 * @example
 * ```js
 * import { setConfig, getConfig } from 'thread/config';
 *
 * // User edits thread.config.js...
 * setConfig();  // Clear caches
 *
 * // Next getConfig() reads the fresh file
 * const updated = getConfig();
 * ```
 */
export function setConfig() {
  _config = null;
  _hooks = null;
  _adapter = null;
}

/**
 * Get resolved framework hooks.
 *
 * On first call, dynamically imports the configured framework's hooks
 * module (e.g. `import('preact/hooks')`).  Subsequent calls return the
 * cached hooks (fast, no import overhead).
 *
 * This function is used by `src/hooks.js` and `src/gpu/hooks.js` at
 * module load time via top-level `await`:
 *
 * ```js
 * const { useState, useEffect, ... } = await getHooks();
 * ```
 *
 * @returns {Promise<import('./frameworks.js').FrameworkHooks>}
 *   The resolved hooks object with `useState`, `useEffect`, `useRef`,
 *   `useCallback`, and `useMemo`.
 *
 * @throws {Error} If the framework is unsupported or missing required hooks.
 *
 * @example
 * ```js
 * const hooks = await getHooks();
 * const { useState } = hooks;
 *
 * function Counter() {
 *   const [count, setCount] = useState(0);
 *   return <button onClick={() => setCount(count + 1)}>{count}</button>;
 * }
 * ```
 */
export async function getHooks() {
  if (!_hooks) {
    const config = getConfig();
    _hooks = await resolveHooks(config.framework, config.customHookSource);
  }
  return _hooks;
}

/**
 * Get resolved adapter constructors for the configured state manager.
 *
 * Returns the adapter constructors that match the configured state
 * manager, ready to bind threads/GPUs to your store.
 *
 * @returns {{ thread: Function, gpu: Function, type: string }}
 *   Adapter constructors and type hint.
 *
 * @example
 * ```js
 * import { getResolvedAdapter } from 'thread/config';
 *
 * const { thread: createBinder, gpu: createGPUBinder, type } = getResolvedAdapter();
 *
 * // Bind a thread to a store
 * const binder = createBinder(myThread, useStore, 'setData');
 * await binder.run('some data');
 * ```
 */
export function getResolvedAdapter() {
  if (!_adapter) {
    const config = getConfig();
    _adapter = getAdapter(config.stateManager, config.customAdapter);
  }
  return _adapter;
}

// Re-export programmatic config helpers for browser/edge environments
export { setProgrammaticConfig, getProgrammaticConfig, clearProgrammaticConfig } from './env.js';
