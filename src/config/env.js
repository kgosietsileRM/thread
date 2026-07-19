/**
 * @file Cross-environment config loading for the thread library.
 *
 * Loads `thread.config.js` from the project root across different runtimes:
 * - **Node.js / Bun** — `fs.readFileSync` (synchronous, works with top-level await)
 * - **Deno** — `Deno.readTextFileSync`
 * - **Browser** — Skips file loading (config must be set programmatically)
 * - **Edge** — Skips file loading
 *
 * @module config/env
 */

import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

/**
 * Attempt to load `thread.config.js` from the project root.
 *
 * Uses the appropriate file system API for the current runtime.
 * Returns `null` if the file doesn't exist or can't be read.
 *
 * @param {string} [filename='thread.config.js'] - Config filename to look for.
 * @returns {Record<string, any>|null} Parsed config object, or `null`.
 *
 * @example
 * ```js
 * const file = loadConfigFile();
 * if (file) {
 *   console.log('Loaded config:', file);
 * } else {
 *   console.log('No config file found — using defaults');
 * }
 * ```
 */
export function loadConfigFile(filename = 'thread.config.js') {
  // --- Node.js / Bun ---
  if (env.isNode || env.isBun) {
    return _loadNodeConfig(filename);
  }

  // --- Deno ---
  if (env.isDeno) {
    return _loadDenoConfig(filename);
  }

  // --- Browser / Edge ---
  // Config must be set programmatically via setConfig()
  return null;
}

/**
 * @private
 */
function _loadNodeConfig(filename) {
  try {
    const fs = env.requireModule('node:fs');
    const path = env.requireModule('node:path');
    if (!fs || !path) return null;

    const cwd = env.getCwd();
    const configPath = path.resolve(cwd, filename);

    if (!fs.existsSync(configPath)) return null;

    const raw = fs.readFileSync(configPath, 'utf-8');
    return _parseConfig(raw);
  } catch {
    return null;
  }
}

/**
 * @private
 */
function _loadDenoConfig(filename) {
  try {
    if (typeof Deno === 'undefined' || typeof Deno.readTextFileSync !== 'function') {
      return null;
    }

    const cwd = env.getCwd();
    const configPath = `${cwd}/${filename}`;

    // Check if file exists
    try { Deno.statSync(configPath); } catch { return null; }

    const raw = Deno.readTextFileSync(configPath);
    return _parseConfig(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a config file string into an object.
 *
 * Strips `import` and `export default` statements, then evaluates
 * the remaining object literal.
 *
 * @param {string} raw - Raw file contents.
 * @returns {Record<string, any>|null} Parsed object, or `null` on failure.
 * @private
 */
function _parseConfig(raw) {
  try {
    // Strip ESM syntax
    const cleaned = raw
      .replace(/^import\s+.*$/gm, '')
      .replace(/^export\s+default\s+/, '')
      .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
      .trim();

    if (!cleaned) return null;

    // Evaluate the config object
    const fn = new Function(`return (${cleaned})`);
    const result = fn();

    // Handle defineConfig() return value (frozen object)
    if (result && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
      return Object.fromEntries(
        Object.entries(result).filter(([k]) => k !== 'then')
      );
    }

    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Programmatic config storage (for browser/edge environments)
// ---------------------------------------------------------------------------

/** @type {Record<string, any>|null} Programmatic config override. */
let _programmaticConfig = null;

/**
 * Set the configuration programmatically.
 *
 * Use this in browser/edge environments where file system access
 * is not available.  This overrides any `thread.config.js` file.
 *
 * @param {Record<string, any>} config - Configuration object.
 *
 * @example
 * ```js
 * import { setProgrammaticConfig } from './config/env.js';
 *
 * setProgrammaticConfig({
 *   framework: 'react',
 *   stateManager: 'zustand',
 *   gpu: { workgroupSize: 512 },
 * });
 * ```
 */
export function setProgrammaticConfig(config) {
  _programmaticConfig = config && typeof config === 'object' ? { ...config } : null;
}

/**
 * Get the programmatic config override (if set).
 *
 * @returns {Record<string, any>|null} The programmatic config, or `null`.
 */
export function getProgrammaticConfig() {
  return _programmaticConfig;
}

/**
 * Clear the programmatic config override.
 */
export function clearProgrammaticConfig() {
  _programmaticConfig = null;
}

/**
 * Load config with programmatic override support.
 *
 * Priority: programmatic config > file-based config > defaults.
 *
 * @param {string} [filename='thread.config.js'] - Config filename.
 * @returns {Record<string, any>|null} Loaded config, or `null`.
 *
 * @example
 * ```js
 * // In a browser environment
 * import { loadConfigWithOverride } from './config/env.js';
 *
 * // User sets config programmatically
 * setProgrammaticConfig({ framework: 'svelte' });
 *
 * // Config loader uses programmatic override
 * const config = loadConfigWithOverride();
 * console.log(config.framework); // 'svelte'
 * ```
 */
export function loadConfigWithOverride(filename = 'thread.config.js') {
  // Priority: programmatic > file
  if (_programmaticConfig) return _programmaticConfig;
  return loadConfigFile(filename);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  loadConfigFile,
  setProgrammaticConfig,
  getProgrammaticConfig,
  clearProgrammaticConfig,
  loadConfigWithOverride,
};
