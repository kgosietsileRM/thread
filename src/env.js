/**
 * @file Environment detection for the thread library.
 *
 * Detects the current JavaScript runtime and exposes flags for
 * conditional code paths.  Used internally by Thread, GPUCompute,
 * and the config loader to pick the right APIs.
 *
 * Supported environments:
 * - **Browser** — Web Workers, Blob URLs, `navigator.gpu`
 * - **Node.js** — `worker_threads`, `node:worker_threads`
 * - **Bun** — `bun:ffi`, `node:worker_threads` (Bun's built-in)
 * - **Deno** — `Deno.Worker`, `Deno.openKv`, `navigator.gpu`
 * - **Cloudflare Workers** — `workers-runtime` (no `Worker` constructor)
 * - **Edge runtimes** — Vercel Edge, Netlify Edge, Deno Deploy
 *
 * @example
 * ```js
 * import { env } from './env.js';
 *
 * if (env.isNode) {
 *   const { Worker } = await import('node:worker_threads');
 * } else if (env.isBrowser) {
 *   const worker = new Worker(url);
 * }
 * ```
 *
 * @module env
 */

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/**
 * @type {'browser'|'node'|'bun'|'deno'|'edge'|'unknown'}
 * Detected runtime identifier.
 */
const runtime = (() => {
  // Bun — check first because Bun also satisfies Node checks
  if (typeof globalThis.Bun !== 'undefined') return 'bun';
  // Deno
  if (typeof globalThis.Deno !== 'undefined') return 'deno';
  // Node.js
  if (typeof globalThis.process !== 'undefined' && typeof globalThis.process.versions?.node !== 'undefined') return 'node';
  // Browser (including Web Workers, Service Workers)
  if (typeof globalThis.navigator !== 'undefined' || typeof globalThis.self !== 'undefined') {
    // Cloudflare Workers / Vercel Edge — no full `Worker` constructor
    if (typeof globalThis.caches !== 'undefined' && typeof globalThis.XMLHttpRequest === 'undefined') return 'edge';
    return 'browser';
  }
  // Edge runtime fallback
  if (typeof globalThis.EdgeRuntime !== 'undefined') return 'edge';
  return 'unknown';
})();

/**
 * @type {'main'|'worker'|'service-worker'|'unknown'}
 * Current execution context.
 */
const context = (() => {
  // Service Worker
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope) return 'service-worker';
  // Web Worker / Deno Worker / Node worker_threads
  if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope) return 'worker';
  if (typeof SharedWorkerGlobalScope !== 'undefined' && globalThis instanceof SharedWorkerGlobalScope) return 'worker';
  // Node.js worker_threads
  if (typeof globalThis.process !== 'undefined' && globalThis.process.env?.IS_WORKER_THREAD === '1') return 'worker';
  // Bun worker_threads
  if (typeof globalThis.Bun !== 'undefined' && typeof globalThis.Bun?.sleep === 'function' && typeof globalThis.self === 'undefined') return 'worker';
  // Main thread
  if (typeof window !== 'undefined' || typeof globalThis.window !== 'undefined') return 'main';
  if (typeof globalThis.process !== 'undefined' && typeof globalThis.process.argv !== 'undefined') return 'main';
  if (typeof globalThis.Deno !== 'undefined') return 'main';
  return 'unknown';
})();

// ---------------------------------------------------------------------------
// Feature detection (cached)
// ---------------------------------------------------------------------------

/** @type {boolean} `true` if the native `Worker` constructor is available. */
const hasWorker = (() => {
  if (typeof Worker !== 'undefined') return true;
  // Node.js worker_threads has Worker in newer versions
  try {
    if (typeof globalThis.require === 'function') {
      const wt = globalThis.require('node:worker_threads');
      return typeof wt.Worker === 'function';
    }
  } catch { /* ignore */ }
  return false;
})();

/** @type {boolean} `true` if WebGPU (`navigator.gpu`) is available. */
const hasGPU = (() => {
  if (typeof navigator !== 'undefined' && navigator.gpu) return true;
  // Deno
  if (typeof globalThis.Deno !== 'undefined' && globalThis.Deno?.gpu) return true;
  // Bun — check built-in gpu API
  if (typeof globalThis.Bun !== 'undefined' && globalThis.Bun?.gpu) return true;
  return false;
})();

/** @type {boolean} `true` if `fs` module is available (Node/Bun). */
const hasFS = (() => {
  if (typeof globalThis.require === 'function') {
    try { globalThis.require('node:fs'); return true; } catch { return false; }
  }
  if (typeof globalThis.Bun !== 'undefined') return true;
  return false;
})();

/** @type {boolean} `true` if `path` module is available (Node/Bun). */
const hasPath = (() => {
  if (typeof globalThis.require === 'function') {
    try { globalThis.require('node:path'); return true; } catch { return false; }
  }
  return false;
})();

/** @type {boolean} `true` if `performance.memory` is available (Chrome). */
const hasMemoryAPI = (() => {
  return typeof performance !== 'undefined' && typeof performance.memory !== 'undefined';
})();

/** @type {boolean} `true` if Blob and URL.createObjectURL are available. */
const hasBlob = (() => {
  return typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
})();

/** @type {boolean} `true` if dynamic `import()` is available. */
const hasDynamicImport = (() => {
  try {
    return typeof globalThis.import === 'function' || typeof Function('return import') === 'function';
  } catch { return false; }
})();

/** @type {boolean} `true` if the runtime is Bun. */
const isBun = runtime === 'bun';

/** @type {boolean} `true` if the runtime is Node.js. */
const isNode = runtime === 'node';

/** @type {boolean} `true` if the runtime is Deno. */
const isDeno = runtime === 'deno';

/** @type {boolean} `true` if the runtime is a browser (including Web Workers). */
const isBrowser = runtime === 'browser';

/** @type {boolean} `true` if the runtime is an edge function. */
const isEdge = runtime === 'edge';

/** @type {boolean} `true` if running in a worker context (not main thread). */
const isWorker = context === 'worker';

/** @type {boolean} `true` if running on the main thread. */
const isMainThread = context === 'main';

// ---------------------------------------------------------------------------
// Platform-specific require/import helpers
// ---------------------------------------------------------------------------

/**
 * Safely require a Node.js built-in module.
 *
 * Returns the module if available, `null` otherwise.  Works in Node.js,
 * Bun, and environments where `globalThis.require` is defined.
 *
 * @param {string} moduleId - Module name (e.g. `'node:fs'`, `'node:path'`).
 * @returns {any|null} The required module, or `null`.
 *
 * @example
 * ```js
 * const fs = requireModule('node:fs');
 * if (fs) {
 *   const data = fs.readFileSync('config.json', 'utf-8');
 * }
 * ```
 */
function requireModule(moduleId) {
  try {
    if (typeof globalThis.require === 'function') {
      return globalThis.require(moduleId);
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Get the current working directory.
 *
 * Works across Node.js, Bun, Deno, and browser environments.
 *
 * @returns {string} The best-effort working directory.
 *
 * @example
 * ```js
 * const cwd = getCwd();
 * console.log('Working from:', cwd);
 * ```
 */
function getCwd() {
  // Node.js / Bun
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    return process.cwd();
  }
  // Deno
  if (typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.cwd === 'function') {
    return globalThis.Deno.cwd();
  }
  // Browser — use document.baseURI or location
  if (typeof document !== 'undefined' && document.baseURI) {
    try { return new URL(document.baseURI).pathname; } catch { /* ignore */ }
  }
  if (typeof location !== 'undefined' && location.href) {
    try { return new URL(location.href).pathname; } catch { /* ignore */ }
  }
  return '.';
}

/**
 * Read a file synchronously.
 *
 * Uses `fs.readFileSync` in Node/Bun, `Deno.readTextFileSync` in Deno,
 * or returns `null` in browser environments.
 *
 * @param {string} filePath - Absolute or relative file path.
 * @returns {string|null} File contents, or `null` if not readable.
 *
 * @example
 * ```js
 * const content = readFileSync('./config.json');
 * if (content) {
 *   const config = JSON.parse(content);
 * }
 * ```
 */
function readFileSync(filePath) {
  // Node.js / Bun
  const fs = requireModule('node:fs');
  if (fs && typeof fs.readFileSync === 'function') {
    return fs.readFileSync(filePath, 'utf-8');
  }
  // Deno
  if (typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.readTextFileSync === 'function') {
    try { return globalThis.Deno.readTextFileSync(filePath); } catch { return null; }
  }
  return null;
}

/**
 * Check if a file exists.
 *
 * @param {string} filePath - Path to check.
 * @returns {boolean} `true` if the file exists and is accessible.
 *
 * @example
 * ```js
 * if (fileExists('./thread.config.js')) {
 *   loadConfig();
 * }
 * ```
 */
function fileExists(filePath) {
  // Node.js / Bun
  const fs = requireModule('node:fs');
  if (fs && typeof fs.existsSync === 'function') {
    return fs.existsSync(filePath);
  }
  // Deno
  if (typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.statSync === 'function') {
    try { globalThis.Deno.statSync(filePath); return true; } catch { return false; }
  }
  return false;
}

/**
 * Resolve a file path relative to the current working directory.
 *
 * @param {string} ...segments - Path segments to join.
 * @returns {string} Resolved absolute path.
 *
 * @example
 * ```js
 * const configPath = resolvePath('thread.config.js');
 * const fullPath = resolvePath('src', 'config', 'index.js');
 * ```
 */
function resolvePath(...segments) {
  // Node.js / Bun
  const path = requireModule('node:path');
  if (path) {
    return path.resolve(getCwd(), ...segments);
  }
  // Deno
  if (typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.resolve === 'function') {
    return globalThis.Deno.resolve(...segments);
  }
  // Fallback — simple join
  return [getCwd(), ...segments].join('/').replace(/\/+/g, '/');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Comprehensive environment information for the thread library.
 *
 * Provides runtime detection, feature flags, and platform-specific
 * helpers for cross-environment compatibility.
 *
 * @type {{
 *   runtime: 'browser'|'node'|'bun'|'deno'|'edge'|'unknown',
 *   context: 'main'|'worker'|'service-worker'|'unknown',
 *   isBrowser: boolean,
 *   isNode: boolean,
 *   isBun: boolean,
 *   isDeno: boolean,
 *   isEdge: boolean,
 *   isWorker: boolean,
 *   isMainThread: boolean,
 *   hasWorker: boolean,
 *   hasGPU: boolean,
 *   hasFS: boolean,
 *   hasPath: boolean,
 *   hasMemoryAPI: boolean,
 *   hasBlob: boolean,
 *   hasDynamicImport: boolean,
 *   requireModule: function(string): any|null,
 *   getCwd: function(): string,
 *   readFileSync: function(string): string|null,
 *   fileExists: function(string): boolean,
 *   resolvePath: function(...string): string
 * }}
 */
export const env = Object.freeze({
  runtime,
  context,
  isBrowser,
  isNode,
  isBun,
  isDeno,
  isEdge,
  isWorker,
  isMainThread,
  hasWorker,
  hasGPU,
  hasFS,
  hasPath,
  hasMemoryAPI,
  hasBlob,
  hasDynamicImport,
  requireModule,
  getCwd,
  readFileSync,
  fileExists,
  resolvePath,
});

export default env;
