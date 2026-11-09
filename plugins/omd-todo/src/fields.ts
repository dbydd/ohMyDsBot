/**
 * One boundary read for untrusted records.
 *
 * The tool arguments, a board payload, and a stored plugin record are all
 * untrusted objects, and every field they carry must be type-checked before it
 * is used. This helper returns `unknown` for that check instead of casting the
 * object to a shape nobody validated.
 *
 * @module omd-todo/fields
 */

/**
 * Read one own field from an object.
 * @param value - a value already narrowed to a non-null object.
 * @param key - the field name.
 * @returns the field value, or undefined when the object does not own it.
 */
export function field(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}
