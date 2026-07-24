// By-reference registry, the analogue of cloudpickle pickling importable
// modules/functions "by reference" (import path) instead of by value.
//
// Well-known globals (Math, console, JSON, the builtin constructors, ...) are
// encoded as a path like "Math" or "Math.max" and re-resolved at load time.

const valueToPath = new Map();
const pathToValue = new Map();

function isRegistrable(value) {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  );
}

function register(path, value) {
  if (!isRegistrable(value)) return;
  if (!valueToPath.has(value)) valueToPath.set(value, path);
  pathToValue.set(path, value);
}

function registerNamespace(path, ns, depth) {
  register(path, ns);
  if (depth <= 0) return;
  let names;
  try {
    names = Object.getOwnPropertyNames(ns);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'globalThis') continue;
    let value;
    try {
      const desc = Object.getOwnPropertyDescriptor(ns, name);
      if (!desc || (!('value' in desc) && !desc.get)) continue;
      if (!('value' in desc)) continue; // skip accessor-backed globals
      value = desc.value;
    } catch {
      continue;
    }
    if (!isRegistrable(value)) continue;
    const childPath = path === '' ? name : `${path}.${name}`;
    if (valueToPath.has(value)) {
      pathToValue.set(childPath, value);
      continue;
    }
    register(childPath, value);
    if (typeof value === 'symbol') continue;
    // Recurse one level into namespace-like globals (Math, JSON, console,
    // constructors and their prototypes/statics).
    if (depth > 1 || typeof value === 'function' || path === '') {
      registerNamespace(childPath, value, depth - 1);
    }
  }
}

let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  registerNamespace('', globalThis, 2);
  // prototypes of the primary constructors are frequent proto targets
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const ctor = globalThis[name];
    if (typeof ctor === 'function' && ctor.prototype) {
      register(`${name}.prototype`, ctor.prototype);
    }
  }
}

/** Path for a value that should be pickled by reference, or undefined. */
export function globalPathFor(value) {
  ensureInitialized();
  return valueToPath.get(value);
}

/** Resolve a by-reference path back to the live global. */
export function resolveGlobalPath(path) {
  ensureInitialized();
  if (pathToValue.has(path)) return pathToValue.get(path);
  // Fall back to walking from globalThis (covers globals added after init on
  // the loading side).
  let target = globalThis;
  for (const part of path === '' ? [] : path.split('.')) {
    if (target == null) break;
    target = target[part];
  }
  if (target === undefined && path !== 'undefined') {
    throw new Error(`cloudpickle-js: cannot resolve global "${path}" in this environment`);
  }
  return target;
}

/**
 * Register extra values to be pickled by reference under `path`
 * (e.g. a module namespace: `registerPickleByReference('myLib', myLib)`).
 * The same registration must exist on the loading side.
 */
export function registerPickleByReference(path, value) {
  ensureInitialized();
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('registerPickleByReference: path must be a non-empty string');
  }
  registerNamespace(path, value, 1);
}

/** Remove a by-reference registration (values under `path` pickle by value again). */
export function unregisterPickleByReference(path) {
  ensureInitialized();
  const prefix = `${path}.`;
  for (const [p, v] of [...pathToValue]) {
    if (p === path || p.startsWith(prefix)) {
      pathToValue.delete(p);
      if (valueToPath.get(v) === p) valueToPath.delete(v);
    }
  }
}
