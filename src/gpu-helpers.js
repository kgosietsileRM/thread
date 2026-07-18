/**
 * @file Pure utility functions for GPU compute — type helpers, auto-boxing,
 * JS→WGSL transpilation, and format detection.
 *
 * These functions have zero coupling to GPU state and can be used
 * independently of the {@link GPUCompute} class.
 *
 * @module gpu-helpers
 */

import { GPUComputeError } from './error.js';

// ---------------------------------------------------------------------------
// Output type helpers
// ---------------------------------------------------------------------------

/** Map of human-readable names to TypedArray constructors. */
export const OUTPUT_TYPES = {
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  f16: Float32Array, // JS has no Float16Array; use Float32Array
  f64: Float64Array,
};

/**
 * Resolve a type name or constructor to a TypedArray constructor.
 *
 * @param {string|typeof TypedArray} type
 * @returns {typeof TypedArray}
 */
export function resolveType(type) {
  if (typeof type === 'function') return type;
  const resolved = OUTPUT_TYPES[type];
  if (!resolved) throw new TypeError(`Unknown output type: "${type}"`);
  return resolved;
}

// ---------------------------------------------------------------------------
// Auto-boxing helpers
// ---------------------------------------------------------------------------

/**
 * Auto-box a value into a TypedArray.
 *
 * - `number` → `Float32Array([n])`
 * - `number[]` → `Float32Array(arr)`
 * - `TypedArray` → returned as-is
 *
 * @param {*} val
 * @returns {TypedArray}
 */
export function box(val) {
  if (val instanceof Float32Array || val instanceof Int32Array || val instanceof Uint32Array) return val;
  if (typeof val === 'number') return new Float32Array([val]);
  if (Array.isArray(val)) return new Float32Array(val);
  return val;
}

/**
 * Box all values in a plain object.
 *
 * @param {Object<string, *>} obj
 * @returns {Object<string, TypedArray>}
 */
export function boxAll(obj) {
  if (!obj) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = box(v);
  return out;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the second arg to `run()` is the old format
 * `{ inputs, uniforms, outputs, ... }` or the new flat format `inputs`.
 *
 * @param {*} arg
 * @returns {boolean}
 */
export function isOldRunFormat(arg) {
  return arg != null && typeof arg === 'object' && !ArrayBuffer.isView(arg) &&
    ('inputs' in arg || 'uniforms' in arg || 'outputBuffers' in arg || 'outputs' in arg);
}

// ---------------------------------------------------------------------------
// JS → WGSL transpilation
// ---------------------------------------------------------------------------

/**
 * Transpile a WGSL expression string (JS-flavored) to valid WGSL.
 *
 * Handles: ternary→select, ===→==, &&→&, ||→|, **→^,
 * Math.*→WGSL equivalents, integer→float literals.
 *
 * @param {string} expr - JS-flavored expression
 * @returns {string} Valid WGSL expression
 */
export function transpileExpression(expr) {
  const MATH_MAP = {
    'Math.sqrt': 'sqrt', 'Math.abs': 'abs', 'Math.sin': 'sin',
    'Math.cos': 'cos', 'Math.tan': 'tan', 'Math.asin': 'asin',
    'Math.acos': 'acos', 'Math.atan': 'atan', 'Math.atan2': 'atan2',
    'Math.exp': 'exp', 'Math.log': 'log', 'Math.log2': 'log2',
    'Math.log10': 'log10', 'Math.pow': 'pow', 'Math.max': 'max',
    'Math.min': 'min', 'Math.floor': 'floor', 'Math.ceil': 'ceil',
    'Math.round': 'round', 'Math.trunc': 'trunc', 'Math.sign': 'sign',
    'Math.PI': '3.14159265', 'Math.E': '2.71828182',
    'Math.tanh': 'tanh', 'Math.sinh': 'sinh', 'Math.cosh': 'cosh',
    'Math.cbrt': 'cbrt', 'Math.expm1': '(exp($1) - 1.0)',
    'Math.log1p': 'log(1.0 + $1)',
    'Math.hypot': 'sqrt($1 * $1 + $2 * $2)',
    'Math.random': 'fract(f32(hash(u32(i))))',
  };

  let wgsl = expr;

  // Replace ternary: `cond ? a : b` → `select(b, a, cond)`
  wgsl = wgsl.replace(
    /(.+?)\s*\?\s*(.+?)\s*:\s*(.+)/g,
    (_, cond, a, b) => `select(${b.trim()}, ${a.trim()}, ${cond.trim()})`,
  );

  // Replace JS comparison operators
  wgsl = wgsl.replace(/===/g, '==');
  wgsl = wgsl.replace(/!==/g, '!=');

  // Replace JS logical operators
  wgsl = wgsl.replace(/&&/g, '&');
  wgsl = wgsl.replace(/\|\|/g, '|');
  wgsl = wgsl.replace(/!(?=[a-zA-Z_])/g, '!');

  // Replace JS operators
  wgsl = wgsl.replace(/\*\*/g, '^');

  // Replace JS math calls with WGSL equivalents (longest first)
  const sortedKeys = Object.keys(MATH_MAP).sort((a, b) => b.length - a.length);
  for (const jsName of sortedKeys) {
    const wgslName = MATH_MAP[jsName];
    if (wgslName.includes('$')) {
      wgsl = wgsl.replace(
        new RegExp(jsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(([^,)]+),\\s*([^)]+)\\)', 'g'),
        wgslName.replace('$1', '$1').replace('$2', '$2'),
      );
      wgsl = wgsl.replace(
        new RegExp(jsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\(([^)]+)\\)', 'g'),
        wgslName.replace('$1', '$1').replace(/, *\$2.*/, ''),
      );
    } else {
      wgsl = wgsl.split(jsName).join(wgslName);
    }
  }

  // Replace bare integer literals in arithmetic with floats
  wgsl = wgsl.replace(/(?<=[^a-zA-Z_0-9.\[])(\d+)(?=[^a-zA-Z_0-9.\]$)])/g, '$1.0');
  wgsl = wgsl.replace(/true\.0/g, 'true').replace(/false\.0/g, 'false');
  wgsl = wgsl.replace(/(\d+\.\d+)\.0/g, '$1');

  return wgsl;
}

/**
 * Transpile a `define(name, fn)` function body to a WGSL assignment expression.
 *
 * Converts `data.value` → `inputName[i]`, `data.index`/`data.i` → `f32(i)`,
 * then runs the result through {@link transpileExpression}.
 *
 * @param {Function} fn - The JS function `(data, { uniform }) => expression`
 * @param {string} inputName - The storage buffer name (first param name)
 * @returns {string} WGSL body like `result[i] = data[i] * alpha + ...;`
 */
export function transpileDefineBody(fn, inputName) {
  const src = fn.toString();

  // Extract body from arrow function
  let body;
  const arrowMatch = src.match(/=>\s*\{?\s*(?:return\s+)?(.+?);?\s*\}?\s*$/);
  if (arrowMatch) {
    body = arrowMatch[1].trim();
  } else {
    throw new GPUComputeError(`Cannot parse define function: ${src}`);
  }

  // Replace data proxy references with WGSL equivalents
  // data.value → inputName[i]
  body = body.replace(/data\.value/g, `${inputName}[i]`);
  // data.index → f32(i)
  body = body.replace(/data\.index/g, 'f32(i)');
  // data.i → f32(i) (but not data.index which was already handled)
  body = body.replace(/data\.i\b(?!\w)/g, 'f32(i)');

  // Run through expression transpiler for math, ternary, etc.
  return transpileExpression(body);
}

/**
 * Convert a JS function body to a WGSL expression.
 *
 * Handles common patterns:
 *   `x => Math.sqrt(x)`         → `sqrt(x)`
 *   `x => x * 2 + 1`           → `x * 2.0 + 1.0`
 *   `x => Math.max(0, x)`      → `max(0.0, x)`
 *   `(a, b) => a + b`          → `a + b`
 *   `x => x > 0 ? x : 0`      → select(0.0, x, x > 0.0)
 *   `x => x === 0 ? 1 : 0`    → select(0.0, 1.0, x == 0.0)
 *   `x => !x ? 1 : 0`          → select(0.0, 1.0, !x)
 *
 * @param {Function} fn
 * @returns {string} WGSL expression
 */
export function jsToWgsl(fn) {
  const src = fn.toString();

  // Extract the body — works for `x => expr` and `(x) => { return expr; }`
  let body;
  const arrowMatch = src.match(/=>\s*\{?\s*(?:return\s+)?(.+?);?\s*\}?\s*$/);
  if (arrowMatch) {
    body = arrowMatch[1].trim();
  } else {
    throw new GPUComputeError(`Cannot parse function body: ${src}`);
  }

  return transpileExpression(body);
}

/**
 * Extract parameter names from a JS function's signature.
 *
 * @param {Function} fn
 * @returns {string[]}
 */
export function getParamNames(fn) {
  const src = fn.toString();
  const match = src.match(/\(([^)]*)\)/);
  if (!match) return ['x'];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}
