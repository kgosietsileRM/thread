/**
 * @file Serialize and deserialize values that contain functions.
 *
 * JavaScript's built-in `JSON.stringify` silently drops functions.  The
 * `Serializer` utility converts functions into a safe string
 * representation (`{ __type: 'function', __value: '(x) => x + 1' }`) and
 * revives them later via `new Function()`.
 *
 * This is primarily used internally by the thread module to pass function
 * references across worker boundaries, but you can use it anywhere you
 * need JSON-like serialization with function support.
 *
 * **Security note:** Deserialization uses `new Function()` to evaluate
 * function strings.  Only deserialize data you trust – never use this
 * on user-supplied strings in production without sanitization.
 *
 * @example
 * ```js
 * import { Serializer } from './serializer.js';
 *
 * const data = {
 *   multiplier: 3,
 *   transform: (x) => x * 2,
 *   tags: ['a', 'b'],
 * };
 *
 * const serialized = Serializer.serialize(data);
 * // {
 * //   multiplier: 3,
 * //   transform: { __type: 'function', __value: '(x) => x * 2' },
 * //   tags: ['a', 'b'],
 * // }
 *
 * const restored = Serializer.deserialize(serialized);
 * console.log(restored.transform(5)); // 10
 * ```
 *
 * @module serializer
 */

/**
 * Utility for serializing/deserializing values containing functions.
 *
 * All methods are stateless – the object is used as a namespace, not
 * instantiated.
 */
export const Serializer = {
  /**
   * Serialize a value, converting functions to a portable representation.
   *
   * **What gets converted:**
   * - Functions → `{ __type: 'function', __value: fn.toString() }`
   * - Arrays → each element is recursively serialized
   * - Plain objects → each value is recursively serialized
   * - Primitives, `null`, `undefined` → passed through unchanged
   *
   * **Limitations:**
   * - Closures are **lost** – the deserialized function will not capture
   *   variables from its enclosing scope.
   * - `Date`, `RegExp`, `Map`, `Set` etc. are treated as plain objects
   *   and their internal state may not survive the round-trip.
   * - Circular references will cause a `TypeError` (not handled).
   *
   * @param {*} value - The value to serialize.
   * @returns {*} A JSON-safe copy of the value with functions replaced
   *   by marker objects.
   *
   * @example
   * ```js
   * Serializer.serialize((a, b) => a + b);
   * // { __type: 'function', __value: '(a, b) => a + b' }
   * ```
   *
   * @example
   * ```js
   * Serializer.serialize([1, { fn: () => {} }, 'hello']);
   * // [1, { fn: { __type: 'function', __value: '() => {}' } }, 'hello']
   * ```
   */
  serialize(value) {
    if (typeof value === 'function') {
      return { __type: 'function', __value: value.toString() };
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.serialize(v));
    }
    if (value && typeof value === 'object') {
      const obj = {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = this.serialize(v);
      }
      return obj;
    }
    return value;
  },

  /**
   * Deserialize a value, reviving functions from their string form.
   *
   * Inverse of {@link Serializer.serialize}.  The marker objects
   * `{ __type: 'function', __value: '...' }` are converted back into
   * callable functions via `new Function('return ' + value.__value)()`.
   *
   * **Warning:** This evaluates arbitrary code.  Only call on data you
   * serialized yourself or fully trust.
   *
   * @param {*} value - The serialized value.
   * @returns {*} The original value with functions restored.
   *
   * @example
   * ```js
   * const serialized = {
   *   handler: { __type: 'function', __value: '(x) => x * 2' },
   *   name: 'doubler',
   * };
   *
   * const restored = Serializer.deserialize(serialized);
   * console.log(typeof restored.handler); // "function"
   * console.log(restored.handler(21));    // 42
   * ```
   */
  deserialize(value) {
    if (value && typeof value === 'object' && value.__type === 'function') {
      // eslint-disable-next-line no-new-func
      return new Function('return ' + value.__value)();
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.deserialize(v));
    }
    if (value && typeof value === 'object') {
      const obj = {};
      for (const [k, v] of Object.entries(value)) {
        obj[k] = this.deserialize(v);
      }
      return obj;
    }
    return value;
  },
};
