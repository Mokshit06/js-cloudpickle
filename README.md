# cloudpickle-js

[cloudpickle](https://github.com/cloudpipe/cloudpickle), but for JavaScript.

Serialize things standard serializers can't: **functions with the closures they
capture**, classes, instances, and arbitrary cyclic object graphs — by value —
so they can be shipped to and executed by another Node.js process.

```js
import { dumps, loads } from 'cloudpickle-js';

const rates = { usd: 1, eur: 0.9 };
function makeConverter(target) {
  return (amount) => amount * rates[target]; // closes over `rates` and `target`
}

const payload = dumps(makeConverter('eur')); // a JSON string

// ...in a completely different process:
const convert = loads(payload);
convert(150); // => 135
```

---

# How it works

## The problem

Pickling a function by value means capturing three things: its code, the
variables it closed over, and the graph those variables point into.

CPython hands you all three. `fn.__code__` is a first-class object,
`fn.__closure__` is a tuple of cells, and `cell_contents` reads a cell.
cloudpickle reconstructs a function by shipping the code object plus the cell
values and calling `types.FunctionType`.

JavaScript gives you one of the three. `Function.prototype.toString()` returns
source text, and that is the entire reflection surface: there is no standard
way to enumerate a closure. The environment record backing a closure is
internal to the engine, unreachable from the language.

**But it is reachable from outside the language.** Every debugger that shows
you a scope pane is reading a function's captured environment through the V8
inspector protocol, where it is exposed as the internal property `[[Scopes]]`.
Node ships that protocol in-process as `node:inspector`. So the missing
reflection is available — you just have to talk to your own VM over a debugger
socket to get it.

That is the whole trick. Everything else in this repo is the consequence of it.

## Architecture

| File | Role |
| --- | --- |
| `src/inspector.js` | Reads `[[Scopes]]` via the V8 inspector; the `fn.__closure__` substitute |
| `src/pickler.js` | Walks the object graph, memoizes, emits heap entries |
| `src/function-source.js` | Normalizes `toString()` output back into an evaluatable expression |
| `src/globals.js` | By-reference registry (cloudpickle's "importable → pickle by reference") |
| `src/unpickler.js` | Rebuilds the heap, re-binds closures, restores the graph |

## The wire format

`dumps` produces JSON: a root value plus a flat heap.

```jsonc
{
  "cloudpickleJs": 1,
  "root": ["ref", 0],
  "heap": [
    { "t": "function", "kind": "function", "name": "", "src": "(a)=>a*rates[t]",
      "scope": [["t", "eur"], ["rates", ["ref", 1]]] },
    { "t": "object", "props": [["usd", 1], ["eur", 0.9]] }
  ]
}
```

Values are encoded in one of two ways:

- **Inline** — strings, booleans, `null` and numbers other than `NaN`,
  `±Infinity` and `-0` are themselves.
- **Tagged array** — everything else: `["undef"]`, `["nan"]`, `["inf"]`,
  `["-inf"]`, `["-0"]`, `["bigint", "12n…"]`, `["symfor", key]`,
  `["global", path]`, `["proto", fn]`, `["hole"]` (array hole), and
  `["ref", i]` for a heap slot.

There is no ambiguity between the two: real arrays never appear inline, they
are heap entries (`{ t: "array" }`). Heap entries cover `object`, `array`,
`map`, `set`, `date`, `regexp`, `symbol`, `arraybuffer`, `typedarray`,
`function` and `reduced`.

Identity is preserved by the memo table. Before recursing into a value, the
pickler *reserves* its slot — pushes a placeholder onto the heap and records
`["ref", idx]` in the memo — so a cycle encountered further down resolves to
the reference instead of recursing forever. This is pickle's memo, with the
same consequence: shared structure stays shared, and `x.self === x` survives.

## Reading closures out of V8

`inspectClosure(fn)` is the interesting part of the library.

```js
const session = new inspector.Session();
session.connect(); // to this thread's own inspector
```

`session.connect()` attaches to the inspector of the *current* thread, and for
a same-thread session `session.post()` dispatches the message and invokes its
callback **before returning**. That is what makes a synchronous `dumps`
possible at all — the same signature cloudpickle has. The code asserts this
rather than assuming it: if the callback has not fired by the time `post`
returns, it throws instead of silently reading a stale value.

Getting a handle on a local function is the first awkward step. The protocol
addresses objects by `objectId`, and there is no "give me an id for this local
value" call. So the value is parked on a well-known global and read back:

```js
globalThis[Symbol.for('cloudpickle-js.hook')] = value;
post('Runtime.evaluate', { expression: `globalThis[Symbol.for('cloudpickle-js.hook')]` });
// -> { objectId: "…" }
```

With an `objectId`, the scopes follow:

1. `Runtime.getProperties(objectId, ownProperties: true)` → `internalProperties`
   contains `[[Scopes]]` (and `[[FunctionLocation]]`, exposed separately for
   diagnostics).
2. `Runtime.getProperties` on the scopes array → one entry per scope, innermost
   first, each described as `Closure (makeAdder)`, `Block`, `Script`, `Global`, …
3. `Runtime.getProperties` on each scope object → the bindings.

Scopes of kind `closure`, `local`, `block`, `module`, `script`, `catch` and
`with` are captured; `global` is skipped, since globals are handled by
reference. Names are deduplicated innermost-first, so a shadowed outer binding
never wins. Bindings that are in the temporal dead zone or that V8 optimized
out come back without a value and are skipped.

The reverse conversion — protocol `RemoteObject` back to a live local value —
is the same trick in the other direction: `Runtime.callFunctionOn` with a
function body that assigns `this` onto the hook global. Primitives arrive
inline; `NaN`, `±Infinity`, `-0` and BigInts arrive as `unserializableValue`
strings and are rehydrated by hand.

### Over-capture, and why the source is grepped

V8 does not allocate one environment per closure. It allocates one *context*
per scope, shared by every function created in that scope. `[[Scopes]]`
therefore reports everything the enclosing scope context-allocated — including
variables that belong to a sibling function and that this one never mentions:

```js
function make() {
  const small = 1;
  const huge = new Array(1e7).fill(0); // sibling's data
  const f = () => small;               // [[Scopes]] reports BOTH
  const g = () => huge.length;
  return f;
}
```

Pickling `f` should not drag in `huge` — and if the sibling had captured a
socket, it would not merely be wasteful, it would fail. So each candidate
binding is kept only if its name plausibly occurs as an identifier in the
function's own source (`sourceReferences`). The regex uses lookbehinds to
reject property accesses (`obj.small` doesn't count) while still allowing rest
and spread (`...small` does). Names that aren't valid bindable identifiers —
reserved words, `this`, synthetic V8 names — are dropped outright. If the
source contains `eval`, the filter is disabled and everything is kept, because
the reference could be dynamic.

This is a heuristic operating on text, and it is deliberately biased toward
over-inclusion: a false positive costs bytes, a false negative costs a
`ReferenceError` at call time.

### Classes capture in pieces

A class's methods are separate function objects, each with their own
`[[Scopes]]`. The class's `[[Scopes]]` says nothing about what its methods
closed over. So for `kind === 'class'`, capture is the union of the scopes of
the class itself and of every own function-valued property (values, getters and
setters) on both the constructor and its prototype.

## Rebuilding a function

There is no `types.FunctionType` here either — the only way back from source
text to a function is evaluation. The scope has to be re-established around it,
which `with` does:

```js
const factory = new Function('__cpjs_scope__',
  `with (__cpjs_scope__) { return (${expression}); }`);
const fn = factory(scope);
```

`with` is the one construct in the language that injects an arbitrary object
into the scope chain, which is exactly the primitive needed. Two details:

- `scope` is `Object.create(null)`, so `Object.prototype` members (`toString`,
  `constructor`, `valueOf`) don't leak into the scope chain and shadow globals.
- `new Function` bodies are sloppy mode, which `with` requires. The pickled
  function's own source keeps its own strictness — class bodies are still
  strict.

Because `with` resolves through a real object, this restores *bindings*, not
just values: assignments inside the function write back to the scope object, so
a pickled counter keeps counting and mutable closure state stays mutable.

Each scope entry is installed as an accessor, not a value:

```js
Object.defineProperty(scope, name, {
  get() { if (!resolved) { cache = self.dec(encoded); resolved = true; } return cache; },
  set(v) { cache = v; resolved = true; },
});
```

Laziness is required, not an optimization. Evaluating a class expression
eagerly dereferences its heritage (`class A extends B` needs `B` *now*), so a
function's scope values can be needed while the heap is still being built.
Deferring each binding to first read lets the dependency order fall out
naturally, and a `building[]` flag turns a genuinely cyclic eager dependency
(two classes extending each other) into a clear `UnpicklingError` instead of a
stack overflow. A function that closes over itself is special-cased to the memo
slot it is currently filling.

Finally, `fn.name` is non-configurable-by-assignment and gets lost for some
forms, so it is re-defined explicitly.

## Normalizing `toString()` output

`Function.prototype.toString()` returns the exact source text of the function,
which is frequently *not* a valid expression:

| Source form | Problem | Fix |
| --- | --- | --- |
| `(a) => a + 1`, `function f() {}`, `class C {}` | none | used as-is |
| `foo() {}`, `*gen() {}`, `get x() {}`, `[Symbol.iterator]() {}`, `async foo() {}` | method shorthand isn't an expression | re-host it |
| `class D extends someExpr {}` | heritage re-evaluated at load time | rewrite it |

Method shorthand is re-hosted inside an object literal and pulled back out
through its descriptor, which handles getters and setters in the same step:

```js
((o) => { const d = Object.getOwnPropertyDescriptors(o);
          const p = d[Reflect.ownKeys(d)[0]];
          return p.get ?? p.set ?? p.value; })({ get x() { … } })
```

The heritage clause needs surgery for a different reason. `class D extends
mixin(Base) {}` stores the *resolved* parent in an internal slot — it is not in
`[[Scopes]]`, and re-running `mixin(Base)` on the loading side would either
throw (nothing named `mixin` there) or produce a different class, breaking
`instanceof`. So the parent is pickled as an ordinary value under a synthetic
binding and the source is rewritten to `class D extends __cpjs_super__ {…}`.
Finding where the heritage expression ends means finding the `{` that opens the
class body, which is a small scanner tracking bracket depth and string
literals — `class D extends f({a:1}) {}` has three braces before the body.

## Rebuilding the graph

`loads` runs four passes over the heap before decoding the root:

1. **Shells** — allocate every data object empty (`{}`, `[]`, `new Map()`,
   `new Date(ms)`, …). Identity exists before any contents do, so cycles can be
   wired up unconditionally in pass 3.
2. **Force** — build `function` and `reduced` entries, which cannot be split
   into shell-then-fill because evaluation produces the object.
3. **Fill** — install properties, prototypes, map/set contents, array elements.
4. **Integrity** — apply `Object.freeze` / `seal` / `preventExtensions`, last,
   because a frozen object cannot be filled.

Properties are encoded either as `[key, value]` (the common
writable-enumerable-configurable case) or `['desc', key, descriptor]`, so
non-enumerable data, accessors and symbol keys all round-trip. One exception:
an accessor whose getter is a native function has no source to pickle — V8's
lazily materialized `error.stack` is the case that matters in practice — so its
current value is snapshotted into a data property instead of failing the pickle.

Prototypes are the mechanism behind `instanceof` surviving. When an object's
prototype is some class's `.prototype`, it is encoded as `['proto', <that
class>]` rather than as a plain object. The class is pickled once, rebuilt
once, and every instance in the payload is attached to *that* rebuilt class:

```js
const { p, Point } = loads(dumps({ p: new Point(1, 2), Point }));
p instanceof Point; // true
```

Within a payload. Two separate `loads` calls produce two unrelated classes —
the same rule pickle has always had.

## By reference vs. by value

cloudpickle pickles importable objects by reference (module path) and
everything else by value. The equivalent of an import path here is a path from
`globalThis`.

On first use, `globals.js` walks `globalThis` two levels deep — namespaces
(`Math`, `JSON`, `console`), constructors, their statics and their
`.prototype`s — building bidirectional maps between values and paths like
`Math.max` or `Array.prototype`. The first path registered for a value wins, so
encodings are stable. Anything found there encodes as `['global', path]` and
re-resolves on load, falling back to walking `globalThis` by path for globals
that didn't exist at init time.

Two escape hatches mirror cloudpickle's:

- `registerPickleByReference(path, value)` — the inverse of
  `register_pickle_by_value`. Mark a module namespace as by-reference and
  register the same path on the loading side; useful for native bindings and
  large shared libraries.
- `registerReducer(Ctor, reduce)` — `__reduce__`. `reduce(obj)` returns
  `[restoreFn, args]` and the object is rebuilt as `restoreFn(...args)`. The
  restore function is itself pickled, so it can travel by value. `URL` and
  `URLSearchParams` ship this way.

## The pickler doesn't have to run in-process

Nothing in the format requires the values being pickled to live in the same
realm — or the same process. Producing a payload only needs `[[Scopes]]`,
source text and property enumeration, and CDP exposes all three remotely.

`demos/browser-capture.mjs` is a ~100-line pickler that runs over a WebSocket
against a Chrome tab: it captures a closure defined purely inside the page,
emits the same JSON, and `loads` it in Node, where the closure keeps running
with the click count it accumulated in the browser. The captured values never
materialize as live objects in the pickling process.

This also delimits the browser story: page JS cannot introspect its own
closures, but anything holding a debugger connection to it can.

## What is and isn't preserved

Round-trips:

| Category | Details |
| --- | --- |
| Primitives | strings, numbers (incl. `NaN`, `±Infinity`, `-0`), booleans, `null`, `undefined`, `BigInt`, symbols (`Symbol.for`, well-known, and unique-per-pickle) |
| Functions | arrows, declarations, async, generators, detached methods, getters/setters — with captured closure variables and mutable closure state |
| Classes | methods, static and instance fields, accessors, `extends` chains (incl. `super`), and runtime-attached properties |
| Instances | rebuilt with the correct prototype; `instanceof` holds within a pickle |
| Containers | `Object` (incl. null-prototype, accessors, symbol keys, frozen/sealed), `Array` (sparse, extra props), `Map`, `Set` |
| Builtins | `Date`, `RegExp`, `Error` subclasses (message/stack/custom props), `ArrayBuffer`, typed arrays, `DataView`, `Buffer`, `URL`, `URLSearchParams` |
| Graphs | circular references, shared identity, self-referential functions, mutually recursive closures |

Does not:

- **Shared bindings between sibling closures.** Each rebuilt function gets its
  own scope object, so two functions that shared a variable still see the same
  *value* after a round-trip (memoized objects stay shared) but no longer share
  the *binding*: one reassigning `count = 5` doesn't change what the other
  reads. Reproducing this would mean reconstructing the context graph, not just
  per-function scopes.
- **`this` captured by arrow functions**, which lives in an internal slot
  rather than `[[Scopes]]`, and live module-namespace bindings.
- **Native and bound functions**, which have no source (`[native code]`).
  `dumps` fails loudly and points at `registerPickleByReference`.
- **`WeakMap` / `WeakSet` / `WeakRef`** (contents not enumerable) and pending
  **`Promise`s** (pickling is synchronous) — rejected, the way pickle rejects
  locks and sockets.
- **Cross-payload identity.** Two `loads` calls produce disjoint graphs.

## Cost

Every function costs several inspector round-trips (one to get an id, one for
internal properties, one for the scopes array, one per scope), so `dumps` scales
with the number of distinct functions and scopes rather than with payload bytes.
Data-only graphs never touch the inspector. Payloads are JSON: readable and
diffable, not compact.

## Security

`loads` evaluates code from the payload — necessarily, since that is what
restoring a function by value means. Same rule as pickle: only load payloads
you trust.

---

# API

Mirrors cloudpickle:

- `dumps(value, options?)` → payload string
- `loads(payload)` → value
- `dump(value, stream, options?)` / `await load(streamOrString)`
- `new Pickler(options)` / `new Unpickler()` — reusable instances.
  `options.captureClosures = false` forbids closure capture;
  `options.reducers` adds `__reduce__` hooks for one pickler.
- `registerReducer(Ctor, reduce)` — global `__reduce__` hook
- `registerPickleByReference(path, value)` / `unregisterPickleByReference(path)`
- `inspectClosure(fn)` — the `fn.__closure__` you always wanted: returns
  `[{ name, value }]` for every variable `fn` captured

Errors are `PicklingError` and `UnpicklingError`.

Node.js ≥ 18 only: closure capture needs the V8 inspector.

# Running it

```
npm test              # unit + cross-process round-trip tests
node demos/crazy.mjs  # pickles in this process, runs in fresh `node` processes
```

`demos/crazy.mjs` ships a warm memoization cache to another process, keeps
training a perceptron there, finishes an RPG fight mid-combat with live
instances, moves a four-closure recursive-descent parser, and fans one closure
out to three workers.

```
node demos/browser-capture.mjs [cdp-host:port]
```

Captures a closure out of a running Chrome tab over CDP and keeps calling it in
Node. Needs Chrome started with `--remote-debugging-port`.

# License

MIT
