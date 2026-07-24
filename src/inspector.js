// Closure introspection via the V8 inspector protocol.
//
// This is the JS equivalent of CPython exposing `fn.__code__` / `fn.__closure__`:
// V8 exposes a function's captured scopes as the internal `[[Scopes]]` property,
// readable through `Runtime.getProperties`. When an inspector session is
// connected to its own thread, `session.post` invokes callbacks synchronously,
// which lets us offer a synchronous `dumps` just like cloudpickle.

import inspector from 'node:inspector';

const HOOK = Symbol.for('cloudpickle-js.hook');

let session = null;

function getSession() {
  if (session === null) {
    session = new inspector.Session();
    session.connect();
  }
  return session;
}

function post(method, params) {
  let result;
  let error;
  let settled = false;
  getSession().post(method, params, (err, res) => {
    error = err;
    result = res;
    settled = true;
  });
  if (!settled) {
    throw new Error(
      `inspector ${method} did not complete synchronously; ` +
        'cloudpickle-js requires an inspector session on the current thread'
    );
  }
  if (error) throw new Error(`inspector ${method} failed: ${error.message ?? error}`);
  return result;
}

/** Obtain a RemoteObject for a local value by parking it on globalThis. */
function remoteObjectFor(value) {
  globalThis[HOOK] = value;
  try {
    const { result, exceptionDetails } = post('Runtime.evaluate', {
      expression: `globalThis[Symbol.for('cloudpickle-js.hook')]`,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result;
  } finally {
    delete globalThis[HOOK];
  }
}

/** Convert an inspector RemoteObject back into a live local value. */
function localValueOf(remote) {
  if (remote.type === 'undefined') return undefined;
  if (remote.unserializableValue !== undefined) {
    switch (remote.unserializableValue) {
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
      case '-0':
        return -0;
      default:
        if (remote.type === 'bigint') {
          return BigInt(remote.unserializableValue.replace(/n$/, ''));
        }
        throw new Error(`unhandled unserializable value: ${remote.unserializableValue}`);
    }
  }
  if (remote.objectId === undefined) return remote.value;
  // Objects, functions and symbols: pull the live reference back into our
  // realm by having the inspector assign `this` onto a global hook.
  post('Runtime.callFunctionOn', {
    objectId: remote.objectId,
    functionDeclaration: `function () { globalThis[Symbol.for('cloudpickle-js.hook')] = this; }`,
  });
  const value = globalThis[HOOK];
  delete globalThis[HOOK];
  return value;
}

function releaseObjectGroup() {
  try {
    post('Runtime.releaseObjectGroup', { objectGroup: 'cloudpickle-js' });
  } catch {
    // best effort
  }
}

const CAPTURABLE_SCOPES = new Set(['closure', 'local', 'block', 'module', 'script', 'catch', 'with']);

/**
 * Return the variables closed over by `fn` as a list of
 * `{ name, value }` records, innermost scope first. Variables shadowed by an
 * inner scope are reported once (the innermost binding wins).
 */
export function inspectClosure(fn) {
  if (typeof fn !== 'function') throw new TypeError('inspectClosure expects a function');
  const fnRemote = remoteObjectFor(fn);
  if (!fnRemote.objectId) return [];
  try {
    const { internalProperties = [] } = post('Runtime.getProperties', {
      objectId: fnRemote.objectId,
      ownProperties: true,
    });
    const scopesProp = internalProperties.find((p) => p.name === '[[Scopes]]');
    if (!scopesProp || !scopesProp.value?.objectId) return [];

    const { result: scopeEntries = [] } = post('Runtime.getProperties', {
      objectId: scopesProp.value.objectId,
      ownProperties: true,
    });

    const seen = new Set();
    const captured = [];
    for (const entry of scopeEntries) {
      if (!/^\d+$/.test(entry.name)) continue;
      const scope = entry.value;
      if (!scope?.objectId) continue;
      const description = String(scope.description ?? '');
      const kind = description.split(/[\s(]/, 1)[0].toLowerCase();
      if (kind === 'global' || !CAPTURABLE_SCOPES.has(kind)) continue;
      const { result: vars = [] } = post('Runtime.getProperties', {
        objectId: scope.objectId,
        ownProperties: true,
      });
      for (const v of vars) {
        if (v.value === undefined) continue; // TDZ or optimized-out binding
        if (seen.has(v.name)) continue;
        seen.add(v.name);
        captured.push({ name: v.name, value: localValueOf(v.value) });
      }
    }
    return captured;
  } finally {
    releaseObjectGroup();
  }
}

/**
 * Best-effort location info ({ scriptId, lineNumber, columnNumber }) — useful
 * for error messages. Returns null when unavailable.
 */
export function functionLocation(fn) {
  const fnRemote = remoteObjectFor(fn);
  if (!fnRemote.objectId) return null;
  try {
    const { internalProperties = [] } = post('Runtime.getProperties', {
      objectId: fnRemote.objectId,
      ownProperties: true,
    });
    const loc = internalProperties.find((p) => p.name === '[[FunctionLocation]]');
    return loc?.value?.value ?? null;
  } finally {
    releaseObjectGroup();
  }
}
