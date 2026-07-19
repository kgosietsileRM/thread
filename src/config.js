/**
 * @file Config entry point for `thread/config`.
 *
 * This is the public entry point for the thread configuration system.
 * Import from `thread/config` to access configuration utilities:
 *
 * ```js
 * import { defineConfig, getConfig, setConfig, DEFAULTS, FRAMEWORKS, STATE_MANAGERS } from 'thread/config';
 * ```
 *
 * ## What's exported
 *
 * | Export | Purpose |
 * |--------|---------|
 * | `defineConfig()` | Create a validated, frozen config object |
 * | `getConfig()` | Get the resolved config (cached) |
 * | `setConfig()` | Clear caches and force re-resolution |
 * | `getHooks()` | Get resolved framework hooks (async) |
 * | `getResolvedAdapter()` | Get adapter constructors for the state manager |
 * | `DEFAULTS` | Built-in default config values |
 * | `FRAMEWORKS` | List of supported frameworks |
 * | `STATE_MANAGERS` | List of supported state managers |
 *
 * ## Usage in `thread.config.js`
 *
 * ```js
 * import { defineConfig } from 'thread/config';
 *
 * export default defineConfig({
 *   framework: 'react',
 *   stateManager: 'zustand',
 *   gpu: { workgroupSize: 256 },
 * });
 * ```
 *
 * ## Usage in application code
 *
 * ```js
 * import { getConfig } from 'thread/config';
 *
 * const config = getConfig();
 * if (config.dev.log) {
 *   console.log('thread is in debug mode');
 * }
 * ```
 *
 * @module config
 */

export { defineConfig } from './config/define.js';
export { getConfig, setConfig, getHooks, getResolvedAdapter, mergeWithDefaults, validateConfig, resolveHooks, getAdapter } from './config/index.js';
export { DEFAULTS, FRAMEWORKS, STATE_MANAGERS } from './config/schema.js';
