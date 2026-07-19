/**
 * @file Configuration helper for the thread library.
 *
 * Provides the `defineConfig()` function — the recommended way to create
 * a `thread.config.js` file.  It validates the config, warns on unknown
 * keys (catching typos), applies sensible defaults for omitted fields,
 * and returns a frozen (immutable) config object.
 *
 * ## Why `defineConfig()`?
 *
 * You *could* write `export default { ... }` directly, but `defineConfig()`
 * gives you:
 *
 * - **Typo detection** — unknown keys trigger a console warning
 * - **Automatic defaults** — omit any field and it falls back to a sensible value
 * - **Immutability** — the returned config is frozen, preventing accidental mutation
 * - **Validation** — invalid enum values (e.g. `framework: ' angular'`) warn and
 *   fall back to the default
 *
 * ## How it works
 *
 * 1. The user creates `thread.config.js` in their project root
 * 2. They `import { defineConfig } from 'thread/config'` and call it
 * 3. At library load time, thread reads the file, parses the config object,
 *    and applies it globally
 * 4. All hooks and adapters use the resolved config to pick the right
 *    framework and state manager
 *
 * @example
 * ```js
 * // thread.config.js — in your project root
 * import { defineConfig } from 'thread/config';
 *
 * export default defineConfig({
 *   // Pick your UI framework — hooks are auto-resolved
 *   framework: 'react',
 *
 *   // Pick your state manager — adapter shortcuts are auto-selected
 *   stateManager: 'zustand',
 *
 *   // GPU compute defaults (used by all GPUCompute instances)
 *   gpu: {
 *     workgroupSize: 256,
 *     powerPreference: 'high-performance',
 *   },
 *
 *   // Thread defaults
 *   thread: { timeout: 10_000 },
 *
 *   // Pool defaults
 *   pool: { autoRestart: true, enableStealing: true },
 *
 *   // Development options
 *   dev: { log: true, metrics: true },
 * });
 * ```
 *
 * @example
 * ```js
 * // Minimal config — everything else uses defaults
 * import { defineConfig } from 'thread/config';
 *
 * export default defineConfig({
 *   framework: 'svelte',
 *   stateManager: 'signals',
 * });
 * ```
 *
 * @example
 * ```js
 * // Custom framework with your own hooks
 * import { defineConfig } from 'thread/config';
 *
 * export default defineConfig({
 *   framework: 'custom',
 *   customHookSource: async () => {
 *     const mod = await import('my-framework/hooks');
 *     return {
 *       useState: mod.useState,
 *       useEffect: mod.useEffect,
 *       useRef: mod.useRef,
 *       useCallback: mod.useCallback,
 *       useMemo: mod.useMemo,
 *     };
 *   },
 * });
 * ```
 *
 * @module config/define
 */

import { mergeWithDefaults, validateConfig } from './schema.js';

// ---------------------------------------------------------------------------
// defineConfig
// ---------------------------------------------------------------------------

/**
 * Define a thread configuration object.
 *
 * Returns a **frozen** (immutable) config with all defaults applied.
 * Unknown top-level keys produce a console warning — this helps catch
 * typos like `framwork` instead of `framework`.
 *
 * Invalid values (e.g. `framework: 'Angular'` with wrong casing) are
 * replaced with the default and a warning is logged.  This keeps the
 * library functional even with a partially incorrect config.
 *
 * @param {Record<string, any>} [config={}]
 *   User configuration.  All fields are optional.  See {@link threadConfig}
 *   for the full schema.
 *
 * @returns {Readonly<import('../types.js').threadConfig>}
 *   Fully resolved, frozen configuration object.  Contains the user's
 *   values where valid, and built-in defaults everywhere else.
 *
 * @throws {TypeError} Never — invalid inputs are handled gracefully with
 *   warnings and fallbacks.
 *
 * @see {@link threadConfig} for the full type definition.
 * @see {@link DEFAULTS} for the default values.
 * @see {@link FRAMEWORKS} for the list of supported frameworks.
 * @see {@link STATE_MANAGERS} for the list of supported state managers.
 *
 * @example
 * ```js
 * import { defineConfig } from 'thread/config';
 *
 * export default defineConfig({
 *   framework: 'react',
 *   gpu: { powerPreference: 'low-power' },
 *   dev: { log: true },
 * });
 *
 * // Result:
 * // {
 * //   framework: 'react',
 * //   stateManager: 'zustand',       ← default
 * //   customHookSource: null,        ← default
 * //   customAdapter: null,            ← default
 * //   gpu: { workgroupSize: 256, maxBufferSize: 268435456, ... },
 * //   thread: { timeout: 30000 },     ← default
 * //   pool: { autoRestart: true },    ← default
 * //   dev: { log: true, metrics: false, warnOnLongTask: 0 },
 * // }
 * ```
 *
 * @example
 * ```js
 * // TypeScript — the return type is threadConfig
 * import { defineConfig } from 'thread/config';
 * import type { threadConfig } from 'thread/types';
 *
 * const config: threadConfig = defineConfig({
 *   framework: 'vue',
 *   stateManager: 'redux',
 * });
 * ```
 */
export function defineConfig(config = {}) {
  if (config !== null && typeof config !== 'object') {
    console.warn('[thread] defineConfig() expected an object, got:', typeof config);
    return Object.freeze(mergeWithDefaults({}));
  }

  validateConfig(config);

  const resolved = mergeWithDefaults(config);

  return Object.freeze(resolved);
}
