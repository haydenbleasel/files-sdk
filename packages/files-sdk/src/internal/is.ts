// Named runtime type predicates. Adapters accept polymorphic inputs (a `Body`
// that may be a string, bytes, a Blob, or a stream; a thrown value that may be
// anything) and have to branch on what actually arrived. These predicates are
// the single place that branching lives, so the call sites read as domain
// checks (`isString(body)`) rather than representation probes.

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const isNumber = (value: unknown): value is number =>
  typeof value === "number";

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

/** A callable value. Callers narrow the signature via the owning type. */
export const isFunction = (
  value: unknown
): value is (...args: never[]) => void => typeof value === "function";

/** A non-null object (arrays included). Pair with `in` to read a property. */
export const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

/** A thenable — anything `await` would unwrap. */
export const isPromiseLike = (value: unknown): value is PromiseLike<void> =>
  isObject(value) && "then" in value && isFunction(value.then);
