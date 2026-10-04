/**
 * Typed stand-ins for tests.
 *
 * A test mock is a partial object on purpose: it holds only what the code
 * under test reads. `mock<T>()` states that once, here, so a test does not
 * cast at each call site.
 */

/** Use a partial object where the code under test expects a full `T`. */
export function mock<T>(partial: Partial<T>): T {
  return partial as T;
}

/** A function that records its calls. `calls` holds the arguments of each call. */
export interface Spy<A extends unknown[], R> {
  (...args: A): R;
  calls: A[];
}

/**
 * Make a spy. With `impl`, the spy calls it and returns its result; without
 * it, the spy returns undefined.
 */
export function spy<A extends unknown[] = unknown[], R = undefined>(
  impl?: (...args: A) => R,
): Spy<A, R> {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl ? impl(...args) : (undefined as R);
  };
  return Object.assign(fn, { calls });
}
