/**
 * Frontend debug logging — compiled in only for the *debug* build.
 *
 * `__DEBUG__` is a build-time constant substituted by esbuild's `--define`
 * (see scripts/build-js.sh):
 *   - release build → `false`. Every logger returned here is a shared no-op,
 *     and the code below that builds the real console wrappers becomes dead
 *     code that minification drops — no log strings ship in the release bundle.
 *   - debug build → `true`. Loggers write to the console.
 *
 * Which bundle the browser receives is decided entirely on the backend
 * (FRONTEND_DEBUG env → frontend/js-debug vs frontend/js). There is no runtime
 * switch and no `window` flag, so a visitor cannot turn logging on.
 *
 * The `typeof` guard keeps the module safe if the raw source is ever served
 * without esbuild (resolveJSDir's frontend/src fallback), where `__DEBUG__` is
 * not defined.
 */

const ENABLED = typeof __DEBUG__ !== "undefined" && __DEBUG__ === true;

/** True only in the debug build — guard expensive debug-only work with this. */
export const DEBUG = ENABLED;

const NOOP = () => {};
const NOOP_LOG = Object.assign(NOOP, {
  warn: NOOP,
  error: NOOP,
  group: NOOP,
  groupEnd: NOOP,
  table: NOOP,
});

/**
 * Create a namespaced logger: `const log = debugLog("PluginHost")`.
 *   log(...)          → console.debug
 *   log.warn(...)     → console.warn
 *   log.error(...)    → console.error
 *   log.group(...) / log.groupEnd() / log.table(data)
 *
 * In the release build this returns the shared no-op and the wrappers below are
 * stripped by dead-code elimination.
 */
export function debugLog(scope) {
  if (!ENABLED) return NOOP_LOG;
  const prefix = `%c[${scope}]`;
  const style = "color:#7aa2f7;font-weight:bold";
  const log = (...args) => console.debug(prefix, style, ...args);
  log.warn = (...args) => console.warn(prefix, style, ...args);
  log.error = (...args) => console.error(prefix, style, ...args);
  log.group = (...args) => console.group(prefix, style, ...args);
  log.groupEnd = () => console.groupEnd();
  log.table = (data) => console.table(data);
  return log;
}
