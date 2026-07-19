/**
 * @file Config schema, defaults, and validation for the thread library.
 *
 * This module is the source of truth for the thread configuration shape.
 * It defines:
 *
 * - **`FRAMEWORKS`** — the list of supported UI frameworks
 * - **`STATE_MANAGERS`** — the list of supported state managers
 * - **`DEFAULTS`** — the default values for every config field
 * - **`validateConfig()`** — warns on unknown/invalid keys
 * - **`mergeWithDefaults()`** — deep-merges user config with defaults
 *
 * ## How validation works
 *
 * thread uses **soft validation** — invalid values don't throw.  Instead:
 *
 * 1. Unknown keys produce a warning (catches typos)
 * 2. Invalid enum values (e.g. `framework: 'Angular'`) warn and fall
 *    back to the default
 * 3. Invalid types (e.g. `gpu: 'fast'` instead of an object) warn and
 *    ignore the section
 *
 * This keeps the library functional even with a partially broken config.
 *
 * ## How merging works
 *
 * `mergeWithDefaults()` performs a **shallow merge per section**:
 *
 * ```js
 * // User config:
 * { gpu: { workgroupSize: 64 } }
 *
 * // Merged with defaults:
 * {
 *   gpu: {
 *     workgroupSize: 64,         ← user value
 *     maxBufferSize: 268435456,  ← default (preserved)
 *     entryPoint: 'main',        ← default (preserved)
 *     ...
 *   }
 * }
 * ```
 *
 * The user's section object is spread over the defaults, so any omitted
 * fields keep their default values.
 *
 * @module config/schema
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * List of supported UI frameworks.
 *
 * Each value maps to a dynamic import in `config/frameworks.js`:
 *
 * | Framework | Import path | Notes |
 * |-----------|------------|-------|
 * | `preact` | `preact/hooks` | Default. Full hook support. |
 * | `react` | `react` | Full hook support. |
 * | `svelte` | `svelte/reactivity` | Svelte 5 runes. Partial. |
 * | `vue` | `vue` | Composition API. Partial. |
 * | `solid` | `solid-js` | Full hook support. |
 * | `angular` | — | Not yet supported. Use `custom`. |
 * | `custom` | — | User provides `customHookSource`. |
 *
 * @type {string[]}
 *
 * @example
 * ```js
 * import { FRAMEWORKS } from 'thread/config';
 *
 * console.log(FRAMEWORKS);
 * // ['preact', 'react', 'svelte', 'vue', 'solid', 'angular', 'custom']
 * ```
 */
export const FRAMEWORKS = ['preact', 'react', 'svelte', 'vue', 'solid', 'angular', 'custom'];

/**
 * List of supported state managers.
 *
 * Each value maps to adapter constructors in `config/adapters.js`:
 *
 * | State Manager | Adapter type | Thread adapter | GPU adapter |
 * |--------------|-------------|---------------|-------------|
 * | `zustand` | action | `createZustandBinder` | `createGPUBinder` |
 * | `signals` | signal | `createSignalBinder` | `createGPUSignalBinder` |
 * | `redux` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 * | `jotai` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 * | `mobx` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 * | `vanilla` | setter | `createStoreBinder` | `createGPUStoreBinder` |
 * | `custom` | — | User provides `customAdapter` | — |
 *
 * @type {string[]}
 *
 * @example
 * ```js
 * import { STATE_MANAGERS } from 'thread/config';
 *
 * console.log(STATE_MANAGERS);
 * // ['zustand', 'signals', 'redux', 'jotai', 'mobx', 'vanilla', 'custom']
 * ```
 */
export const STATE_MANAGERS = ['zustand', 'signals', 'redux', 'jotai', 'mobx', 'vanilla', 'custom'];

/** @type {Set<string>} Known top-level config keys. */
const KNOWN_KEYS = new Set([
  'framework',
  'stateManager',
  'customHookSource',
  'customAdapter',
  'gpu',
  'thread',
  'pool',
  'dev',
]);

/** @type {Set<string>} Known keys inside the `gpu` section. */
const KNOWN_GPU_KEYS = new Set([
  'workgroupSize', 'maxBufferSize', 'entryPoint', 'powerPreference',
  'cpuFallback', 'adapterOptions', 'shader',
]);

/** @type {Set<string>} Known keys inside the `thread` section. */
const KNOWN_THREAD_KEYS = new Set([
  'timeout', 'idleTimeout', 'healthCheckInterval', 'healthCheckTimeout',
  'concurrency', 'imports', 'initArgs', 'initTransfer',
]);

/** @type {Set<string>} Known keys inside the `pool` section. */
const KNOWN_POOL_KEYS = new Set([
  'autoRestart', 'maxSize', 'enableStealing', 'keyHasher',
]);

/** @type {Set<string>} Known keys inside the `dev` section. */
const KNOWN_DEV_KEYS = new Set(['log', 'metrics', 'warnOnLongTask']);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Built-in default configuration.
 *
 * Applied when the user omits a field.  Every section is frozen to
 * prevent accidental mutation.
 *
 * @type {Readonly<import('../types.js').threadConfig>}
 *
 * @example
 * ```js
 * import { DEFAULTS } from 'thread/config';
 *
 * console.log(DEFAULTS.framework);      // 'preact'
 * console.log(DEFAULTS.gpu.workgroupSize); // 256
 * console.log(DEFAULTS.thread.timeout);    // 30000
 * console.log(DEFAULTS.pool.autoRestart);  // true
 * console.log(DEFAULTS.dev.log);           // false
 * ```
 */
export const DEFAULTS = Object.freeze({
  framework: 'preact',
  stateManager: 'zustand',
  customHookSource: null,
  customAdapter: null,

  gpu: Object.freeze({
    workgroupSize: 256,
    maxBufferSize: 256 * 1024 * 1024,
    entryPoint: 'main',
    powerPreference: 'high-performance',
    cpuFallback: null,
    adapterOptions: {},
    shader: null,
  }),

  thread: Object.freeze({
    timeout: 30_000,
  }),

  pool: Object.freeze({
    autoRestart: true,
    enableStealing: true,
  }),

  dev: Object.freeze({
    log: false,
    metrics: false,
    warnOnLongTask: 0,
  }),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Warn about unknown top-level or nested config keys.
 *
 * This is a **development aid** — it catches typos like `framwork`
 * or `workgroup_Size` before they cause silent bugs.
 *
 * @param {Record<string, any>} config - The raw user config.
 * @private
 */
function warnUnknownKeys(config) {
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`[thread] Unknown config key: "${key}". Did you mean one of: ${[...KNOWN_KEYS].join(', ')}?`);
    }
  }

  if (config.gpu && typeof config.gpu === 'object') {
    for (const key of Object.keys(config.gpu)) {
      if (!KNOWN_GPU_KEYS.has(key)) {
        console.warn(`[thread] Unknown gpu config key: "${key}". Known keys: ${[...KNOWN_GPU_KEYS].join(', ')}`);
      }
    }
  }

  if (config.thread && typeof config.thread === 'object') {
    for (const key of Object.keys(config.thread)) {
      if (!KNOWN_THREAD_KEYS.has(key)) {
        console.warn(`[thread] Unknown thread config key: "${key}". Known keys: ${[...KNOWN_THREAD_KEYS].join(', ')}`);
      }
    }
  }

  if (config.pool && typeof config.pool === 'object') {
    for (const key of Object.keys(config.pool)) {
      if (!KNOWN_POOL_KEYS.has(key)) {
        console.warn(`[thread] Unknown pool config key: "${key}". Known keys: ${[...KNOWN_POOL_KEYS].join(', ')}`);
      }
    }
  }

  if (config.dev && typeof config.dev === 'object') {
    for (const key of Object.keys(config.dev)) {
      if (!KNOWN_DEV_KEYS.has(key)) {
        console.warn(`[thread] Unknown dev config key: "${key}". Known keys: ${[...KNOWN_DEV_KEYS].join(', ')}`);
      }
    }
  }
}

/**
 * Validate a config object, warning on invalid values.
 *
 * Uses **soft validation** — no errors are thrown.  Invalid values are
 * replaced with defaults and a warning is logged.  This keeps the library
 * functional even with a partially incorrect config.
 *
 * @param {Record<string, any>} config - The raw user config to validate.
 *
 * @example
 * ```js
 * // These all produce warnings but don't throw:
 *
 * validateConfig({ framework: ' angular' });    // typo in casing
 * validateConfig({ stateManager: 'REDUX' });    // wrong casing
 * validateConfig({ gpu: 'fast' });              // wrong type
 * validateConfig({ unknownKey: true });         // unknown key
 * ```
 */
export function validateConfig(config) {
  warnUnknownKeys(config);

  if (config.framework !== undefined && !FRAMEWORKS.includes(config.framework)) {
    console.warn(
      `[thread] Invalid framework: "${config.framework}". Falling back to "preact". ` +
      `Valid options: ${FRAMEWORKS.join(', ')}`
    );
  }

  if (config.stateManager !== undefined && !STATE_MANAGERS.includes(config.stateManager)) {
    console.warn(
      `[thread] Invalid stateManager: "${config.stateManager}". Falling back to "zustand". ` +
      `Valid options: ${STATE_MANAGERS.join(', ')}`
    );
  }

  if (config.gpu !== undefined && typeof config.gpu !== 'object') {
    console.warn('[thread] gpu config must be an object. Ignoring.');
  }

  if (config.thread !== undefined && typeof config.thread !== 'object') {
    console.warn('[thread] thread config must be an object. Ignoring.');
  }

  if (config.pool !== undefined && typeof config.pool !== 'object') {
    console.warn('[thread] pool config must be an object. Ignoring.');
  }

  if (config.dev !== undefined && typeof config.dev !== 'object') {
    console.warn('[thread] dev config must be an object. Ignoring.');
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Deep-merge user config with built-in defaults.
 *
 * Merge rules:
 * - **Scalars** (string, boolean, number): user value wins if valid
 * - **Objects** (gpu, thread, pool, dev): merged recursively — user's
 *   fields override, omitted fields keep defaults
 * - **Functions** (customHookSource, customAdapter): user value wins as-is
 * - **Invalid values**: default wins
 *
 * @param {Record<string, any>} userConfig
 *   The raw user config (may be empty `{}`).
 *
 * @returns {import('../types.js').threadConfig}
 *   Fully resolved config with all defaults applied.
 *
 * @example
 * ```js
 * // Partial user config
 * const user = { framework: 'react', gpu: { workgroupSize: 64 } };
 *
 * const merged = mergeWithDefaults(user);
 *
 * console.log(merged.framework);             // 'react' (user value)
 * console.log(merged.stateManager);           // 'zustand' (default)
 * console.log(merged.gpu.workgroupSize);      // 64 (user value)
 * console.log(merged.gpu.maxBufferSize);      // 268435456 (default)
 * console.log(merged.gpu.powerPreference);    // 'high-performance' (default)
 * ```
 *
 * @example
 * ```js
 * // Empty config — everything uses defaults
 * const merged = mergeWithDefaults({});
 * // equivalent to DEFAULTS
 * ```
 */
export function mergeWithDefaults(userConfig) {
  const fw = userConfig.framework;
  const sm = userConfig.stateManager;

  return Object.freeze({
    framework: (fw && FRAMEWORKS.includes(fw)) ? fw : DEFAULTS.framework,
    stateManager: (sm && STATE_MANAGERS.includes(sm)) ? sm : DEFAULTS.stateManager,
    customHookSource: userConfig.customHookSource ?? DEFAULTS.customHookSource,
    customAdapter: userConfig.customAdapter ?? DEFAULTS.customAdapter,

    gpu: Object.freeze({
      ...DEFAULTS.gpu,
      ...(typeof userConfig.gpu === 'object' ? userConfig.gpu : {}),
    }),

    thread: Object.freeze({
      ...DEFAULTS.thread,
      ...(typeof userConfig.thread === 'object' ? userConfig.thread : {}),
    }),

    pool: Object.freeze({
      ...DEFAULTS.pool,
      ...(typeof userConfig.pool === 'object' ? userConfig.pool : {}),
    }),

    dev: Object.freeze({
      ...DEFAULTS.dev,
      ...(typeof userConfig.dev === 'object' ? userConfig.dev : {}),
    }),
  });
}
