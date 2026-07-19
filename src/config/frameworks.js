/**
 * @file Framework resolver for the thread config system.
 *
 * Maps a framework name (e.g. `'preact'`, `'react'`) to a dynamic
 * `import()` that provides the five hooks the library needs:
 *
 * - **`useState`** — reactive state
 * - **`useEffect`** — side effects and cleanup
 * - **`useRef`** — mutable references
 * - **`useCallback`** — memoized callbacks
 * - **`useMemo`** — memoized values
 *
 * ## How it works
 *
 * Each framework has a **path** (the module to import) and an **extract**
 * function (which normalizes the module's exports into the expected shape).
 *
 * For example:
 * - **Preact** exports hooks directly from `preact/hooks`
 * - **React** exports hooks from `react`
 * - **Svelte 5** uses `svelte/reactivity` with different function names
 * - **Vue 3** uses the composition API with `ref()`, `watchEffect()`, etc.
 *
 * The `extract` function handles these differences, returning a consistent
 * `{ useState, useEffect, useRef, useCallback, useMemo }` shape.
 *
 * ## Adding a new framework
 *
 * To add a new framework:
 * 1. Add an entry to `FRAMEWORK_MAP` with the import path and extract function
 * 2. If the framework doesn't export React-style hooks, write an adapter
 *    in the `extract` function that wraps the framework's API
 *
 * @example
 * ```js
 * // Add Solid.js support (already included)
 * const FRAMEWORK_MAP = {
 *   solid: {
 *     path: 'solid-js',
 *     extract: (m) => m,  // Solid exports hooks directly
 *   },
 * };
 * ```
 *
 * @module config/frameworks
 */

// ---------------------------------------------------------------------------
// Framework map
// ---------------------------------------------------------------------------

/**
 * Mapping of framework names to their import configuration.
 *
 * Each entry has:
 * - `path`: the npm package/module to `import()` (e.g. `'preact/hooks'`)
 * - `extract`: function that receives the imported module and returns
 *   a normalized hooks object `{ useState, useEffect, useRef, useCallback, useMemo }`
 *
 * The `extract` function is needed because different frameworks export
 * their hooks differently:
 * - Preact: `import { useState } from 'preact/hooks'`
 * - React: `import { useState } from 'react'`
 * - Svelte: `import { state } from 'svelte/reactivity'`
 * - Vue: `import { ref, watchEffect } from 'vue'`
 *
 * @type {Record<string, { path: string|null, extract: Function|null }>}
 * @private
 */
const FRAMEWORK_MAP = {
  preact: {
    path: 'preact/hooks',
    extract: (m) => m,
  },
  react: {
    path: 'react',
    extract: (m) => m,
  },
  svelte: {
    // Svelte 5 reactivity primitives — different API shape
    path: 'svelte/reactivity',
    extract: (m) => ({
      // Svelte uses `state()` instead of `useState()`
      useState: m.state ?? m.writable ?? m.ref,
      // Svelte uses `effect()` instead of `useEffect()`
      useEffect: m.effect ?? (() => {}),
      // Svelte's `ref()` returns { value } not { current }
      useRef: m.ref ?? m.state ?? ((v) => ({ current: v })),
      // Svelte doesn't have useCallback — identity function
      useCallback: (fn) => fn,
      // Svelte doesn't have useMemo — call immediately
      useMemo: (fn) => fn(),
    }),
  },
  vue: {
    // Vue 3 Composition API — uses ref() and watchEffect()
    path: 'vue',
    extract: (m) => ({
      // Vue uses `ref()` for reactive state
      useState: m.ref ?? ((v) => ({ value: v, current: v })),
      // Vue uses `watchEffect()` or `watch()`
      useEffect: m.watchEffect ?? m.watch ?? (() => {}),
      // Vue's `ref()` returns { value } not { current }
      useRef: m.ref ?? ((v) => ({ current: v })),
      // Vue doesn't have useCallback — identity function
      useCallback: (fn) => fn,
      // Vue uses `computed()` for memoization
      useMemo: m.computed ?? ((fn) => ({ value: fn() })),
    }),
  },
  solid: {
    // Solid JS exports hooks directly (same API as React)
    path: 'solid-js',
    extract: (m) => m,
  },
  angular: {
    // Angular 16+ uses signals, not React-style hooks.
    // Not yet supported — users should use `custom` with a hook shim.
    path: null,
    extract: null,
  },
};

// ---------------------------------------------------------------------------
// Required hooks
// ---------------------------------------------------------------------------

/**
 * The five hooks that thread requires from any framework.
 *
 * If a framework's `extract` function returns an object missing any
 * of these, `resolveHooks()` throws a descriptive error.
 *
 * @type {string[]}
 * @private
 */
const REQUIRED_HOOKS = ['useState', 'useEffect', 'useRef', 'useCallback', 'useMemo'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve framework hooks by name or custom source.
 *
 * This is the core of the framework switching system.  Given a framework
 * name (from the config), it dynamically imports the right module and
 * returns normalized hooks.
 *
 * @param {string} framework
 *   Framework name.  Must be one of the values in {@link FRAMEWORKS}.
 * @param {Function|null} [customHookSource=null]
 *   Optional custom function that returns the hooks object.  If provided,
 *   it overrides the framework name entirely — no import is performed.
 *
 * @returns {Promise<FrameworkHooks>}
 *   A normalized hooks object with `useState`, `useEffect`, `useRef`,
 *   `useCallback`, and `useMemo`.
 *
 * @throws {Error} If the framework is unknown, not yet supported, or
 *   missing required hooks.
 *
 * @example
 * ```js
 * // Resolve React hooks
 * const hooks = await resolveHooks('react');
 * const { useState, useEffect } = hooks;
 *
 * // Use in a component
 * function Counter() {
 *   const [count, setCount] = useState(0);
 *   useEffect(() => console.log(count), [count]);
 * }
 * ```
 *
 * @example
 * ```js
 * // Use a custom hook source
 * const hooks = await resolveHooks('custom', async () => {
 *   const mod = await import('my-framework/hooks');
 *   return {
 *     useState: mod.useState,
 *     useEffect: mod.useEffect,
 *     useRef: mod.useRef,
 *     useCallback: mod.useCallback,
 *     useMemo: mod.useMemo,
 *   };
 * });
 * ```
 *
 * @example
 * ```js
 * // Error handling
 * try {
 *   await resolveHooks('angular');
 * } catch (err) {
 *   console.error(err.message);
 *   // '[thread] Framework "angular" is not supported yet. Use customHookSource to provide your own hooks.'
 * }
 * ```
 */
export async function resolveHooks(framework, customHookSource = null) {
  // Custom hook source overrides framework lookup
  if (typeof customHookSource === 'function') {
    const hooks = await customHookSource();
    validateHooks(hooks, 'custom');
    return hooks;
  }

  const entry = FRAMEWORK_MAP[framework];

  if (!entry) {
    throw new Error(
      `[thread] Unknown framework: "${framework}". ` +
      `Valid options: ${Object.keys(FRAMEWORK_MAP).join(', ')}`
    );
  }

  if (!entry.path) {
    throw new Error(
      `[thread] Framework "${framework}" is not supported yet. ` +
      `Use customHookSource to provide your own hooks.`
    );
  }

  const mod = await import(entry.path);
  const hooks = entry.extract(mod);
  validateHooks(hooks, framework);
  return hooks;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Validate that a hooks object has all required hooks.
 *
 * @param {Object} hooks - The hooks object to validate.
 * @param {string} source - Framework name for error messages.
 * @throws {Error} If any required hook is missing.
 * @private
 */
function validateHooks(hooks, source) {
  if (!hooks || typeof hooks !== 'object') {
    throw new Error(
      `[thread] Framework "${source}" did not return a valid hooks object.`
    );
  }

  for (const name of REQUIRED_HOOKS) {
    if (typeof hooks[name] !== 'function') {
      throw new Error(
        `[thread] Framework "${source}" is missing required hook: ${name}. ` +
        `Use customHookSource to provide your own implementation.`
      );
    }
  }
}

/**
 * @typedef {Object} FrameworkHooks
 * @property {Function} useState - Create reactive state.
 * @property {Function} useEffect - Run side effects with cleanup.
 * @property {Function} useRef - Create a mutable reference.
 * @property {Function} useCallback - Memoize a callback function.
 * @property {Function} useMemo - Memoize a computed value.
 */
