# cloudpickle-js

JavaScript can't serialize a function. `JSON.stringify` drops it,
`structuredClone` throws `DataCloneError`, `postMessage` refuses it. So you
can't hand a worker a callback, or send a closure over the wire — you send data
and keep the code on both sides.

`cloudpickle-js` serializes functions **together with the variables they
captured**, plus classes, live instances and cyclic object graphs, into a JSON
payload another thread or process can load and run. (It's a port of Python's
[cloudpickle](https://github.com/cloudpipe/cloudpickle), which does the same
thing for `multiprocessing` and Spark.)

```js
// main.js
import { Worker } from 'node:worker_threads';
import { dumps } from 'cloudpickle-js';

const factor = 3;
const scale = (xs) => xs.map((x) => x * factor); // captures `factor`

new Worker('./worker.js', { workerData: dumps(scale) });
```

```js
// worker.js
import { workerData, parentPort } from 'node:worker_threads';
import { loads } from 'cloudpickle-js';

const scale = loads(workerData);
parentPort.postMessage(scale([1, 2, 3])); // [3, 6, 9] — `factor` came along
```

State comes along too, and stays live: closures keep their variables, not
copies of their values.

```js
function makeCounter() {
  let n = 0;
  return () => ++n;
}

const count = makeCounter();
count(); count();               // 2

const revived = loads(dumps(count));
revived();                      // 3 — it resumes where the original was
```

Same for a half-finished object graph: a memo cache arrives warm, a
half-trained model keeps training, and live class instances rebuild with their
prototypes intact — `instanceof` still holds, methods and `super` calls still
work, and the fight they were in the middle of finishes in the other process.
`node demos/crazy.mjs` runs all of those in freshly spawned `node` processes.

## How it works

Pickling a function by value needs its code, the variables it closed over, and
the graph those point into. CPython exposes all three (`__code__`,
`__closure__`, `cell_contents`). JavaScript exposes only the source text, via
`Function.prototype.toString()` — the environment record behind a closure is
internal to the engine.

It is reachable from *outside* the language, though: V8 exposes it as the
internal property `[[Scopes]]` over the inspector protocol, which is how
debuggers render a scope pane. `src/inspector.js` opens a `node:inspector`
session against its own thread — where `session.post` runs its callback before
returning, so `dumps` can stay synchronous — and walks
`Runtime.getProperties` → `[[Scopes]]` → each scope's bindings. Local values
are converted to protocol `objectId`s (and back) by parking them on
`globalThis[Symbol.for('cloudpickle-js.hook')]`; the protocol has no direct
bridge in either direction.

### Capture is too wide

V8 allocates one context per *scope*, shared by every closure created in it, so
`[[Scopes]]` reports variables belonging to sibling functions:

```js
function make() {
  const small = 1;
  const huge = new Array(1e7).fill(0);
  return () => small; // [[Scopes]] reports BOTH bindings
}
```

Each candidate is kept only if its name plausibly occurs as an identifier in
the function's own source: lookbehinds reject property accesses (`obj.small`)
but allow rest/spread, non-bindable and reserved names are dropped, and a
source containing `eval` disables the filter. Biased toward over-inclusion — a
false positive costs bytes, a false negative costs a `ReferenceError`. Classes
capture the union of the constructor's scopes and those of every own method,
since methods are separate function objects with their own `[[Scopes]]`.

### Rebinding on the other side

There is no `types.FunctionType`; the way back from text to a function is
evaluation, with the scope re-established by `with` — the only construct that
injects an object into the scope chain:

```js
new Function('__cpjs_scope__', `with (__cpjs_scope__) { return (${expr}); }`)(scope);
```

`scope` is null-prototype so `Object.prototype` members don't shadow globals,
and `new Function` bodies are sloppy mode, which `with` requires. Resolving
through a real object restores *bindings*, not just values: a pickled counter
keeps counting, and assignments to captured variables still work.

Scope entries are installed as lazy accessors rather than values. Evaluating a
class dereferences its heritage immediately (`class A extends B` needs `B`
now), so bindings can be read while the heap is still being built; deferring to
first read lets dependency order fall out, and a re-entrancy flag turns a
cyclic eager dependency into an `UnpicklingError` instead of a stack overflow.

### Making `toString()` output evaluatable

Method shorthand (`foo() {}`, `*gen() {}`, `get x() {}`) isn't an expression, so
it is re-hosted in an object literal and pulled back out of its descriptor
(`p.get ?? p.set ?? p.value`), which handles accessors in the same step.

A heritage clause is rewritten to `class D extends __cpjs_super__ {…}` with the
resolved parent pickled as an ordinary scope binding: the parent lives in an
internal slot, and re-running `extends mixin(Base)` on the loading side would
throw or produce a different class, breaking `instanceof`. Locating the end of
the heritage expression means scanning for the `{` that opens the body, past
brackets and strings (`class D extends f({a:1}) {}`).

### Format and graph rebuild

`dumps` emits a root value plus a flat heap. Primitives are inline, everything
else is a tagged array (`["ref", i]`, `["global", "Math.max"]`, `["bigint", …]`,
`["hole"]`, …); real arrays are always heap entries, so there's no ambiguity.
Slots are reserved before recursing, so cycles and shared structure resolve to
references — pickle's memo table.

```jsonc
{ "cloudpickleJs": 1, "root": ["ref", 0], "heap": [
  { "t": "function", "kind": "function", "src": "(a)=>a*rates[t]", "name": "",
    "scope": [["t", "eur"], ["rates", ["ref", 1]]] },
  { "t": "object", "props": [["usd", 1], ["eur", 0.9]] } ] }
```

`loads` runs four passes: allocate empty shells (identity before contents, so
cycles wire up unconditionally), force functions and reducers (evaluation
produces the object, it can't be split), fill properties and contents, then
apply `freeze`/`seal` last. Properties carry full descriptors when they need
to; a native accessor with no source (V8's lazy `error.stack`) is snapshotted to
a data property instead of failing the pickle. An object whose prototype is
some class's `.prototype` encodes as `["proto", Ctor]`, so instances attach to
the one rebuilt class and `instanceof` holds within a payload.

Globals are pickled by reference, cloudpickle-style: `globals.js` walks
`globalThis` two levels deep into a path↔value map, so `Math.max` or
`Symbol.iterator` travel as a path. `registerPickleByReference(path, value)`
extends that to your own modules; `registerReducer(Ctor, reduce)` is
`__reduce__` (`URL` and `URLSearchParams` use it).

### Pickling remotely

Nothing requires the values to live in this process — producing a payload only
needs `[[Scopes]]`, source and property enumeration, all of which CDP exposes
remotely. `demos/browser-capture.mjs` pickles a closure out of a Chrome tab
over a WebSocket and resumes calling it in Node, with its captured state
intact. Page JS can't introspect its own closures, but a debugger client can.

## What round-trips

| Category | Details |
| --- | --- |
| Primitives | strings, numbers (incl. `NaN`, `±Infinity`, `-0`), booleans, `null`, `undefined`, `BigInt`, symbols (`Symbol.for`, well-known, and unique-per-pickle) |
| Functions | arrows, declarations, async, generators, detached methods, getters/setters — with captured closure variables and mutable closure state |
| Classes | methods, static and instance fields, accessors, `extends` chains (incl. `super`), and runtime-attached properties |
| Instances | rebuilt with the correct prototype; `instanceof` holds within a pickle |
| Containers | `Object` (incl. null-prototype, accessors, symbol keys, frozen/sealed), `Array` (sparse, extra props), `Map`, `Set` |
| Builtins | `Date`, `RegExp`, `Error` subclasses (message/stack/custom props), `ArrayBuffer`, typed arrays, `DataView`, `Buffer`, `URL`, `URLSearchParams` |
| Graphs | circular references, shared identity, self-referential functions, mutually recursive closures |

## Limitations

- **Node.js only** (≥ 18). Closure capture needs the V8 inspector.
- `loads` evaluates code — only unpickle payloads you trust (true of pickle too).
- Native and bound functions have no source; register them by reference.
- Sibling closures keep shared *values* but not shared *bindings*: each rebuilt
  function gets its own scope object, so one reassigning a captured variable no
  longer affects the other. `this` captured by arrows (an internal slot, not
  `[[Scopes]]`) and live module-namespace bindings aren't restored either.
- `WeakMap`/`WeakSet`/`WeakRef` and pending `Promise`s are rejected, like locks
  and sockets in pickle. So are mutually `extends`-ing classes.
- Identity is per-payload: two `loads` calls produce disjoint graphs.
- Each function costs a few inspector round-trips, so `dumps` scales with the
  number of functions and scopes, not payload size. Data-only graphs never
  touch the inspector.

## API

Mirrors cloudpickle:

- `dumps(value, options?)` → payload string
- `loads(payload)` → value
- `dump(value, stream, options?)` / `await load(streamOrString)`
- `new Pickler(options)` / `new Unpickler()` — reusable instances
  (`captureClosures: false` forbids capture, `reducers` adds local hooks)
- `registerReducer(Ctor, reduce)` — the `__reduce__` analogue:
  `reduce(obj)` returns `[restoreFn, args]`; the object is rebuilt as
  `restoreFn(...args)`
- `registerPickleByReference(path, value)` / `unregisterPickleByReference(path)`
  — the inverse of cloudpickle's `register_pickle_by_value`; register the same
  path on the loading side
- `inspectClosure(fn)` — the `fn.__closure__` you always wanted: returns
  `[{ name, value }]` for every variable `fn` captured

Errors are `PicklingError` / `UnpicklingError`.

## Running it

```
npm test              # unit + cross-process tests (dumps in one process, loads in a fresh one)
node demos/crazy.mjs  # warm memo caches, half-trained models, mid-fight instances, parsers
node demos/browser-capture.mjs [cdp-host:port]   # pickle a closure out of a Chrome tab
```
