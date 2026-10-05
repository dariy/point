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

/** An in-memory Storage over `store`. A test can read or clear `store` directly. */
export function memoryStorage(store = new Map<string, string>()): Storage {
  return {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

/** Use an array where the code under test expects a NodeList. */
export function nodeList<T extends Node>(items: T[]): NodeListOf<T> {
  const item = (i: number): T => {
    const it = items[i];
    if (!it) throw new RangeError(`no node at ${i}`);
    return it;
  };
  const list: NodeListOf<T> = mock<NodeListOf<T>>({
    ...items,
    length: items.length,
    item,
    forEach(cb, thisArg) { items.forEach((n, i) => cb.call(thisArg, n, i, list)); },
    [Symbol.iterator]: () => items[Symbol.iterator](),
  });
  return list;
}
