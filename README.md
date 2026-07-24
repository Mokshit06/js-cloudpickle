# cloudpickle-js

JavaScript can't serialize a function. `JSON.stringify` drops it,
`structuredClone` throws, `postMessage` refuses it. So you send data across
process boundaries and keep the code on both sides.

This sends the code. Functions travel **with the variables they captured** —
along with classes, live instances and cyclic object graphs — as JSON that
another thread or process can load and run. (Python has this;
[cloudpickle](https://github.com/cloudpipe/cloudpickle) is what makes
`multiprocessing` and Spark able to ship a lambda to a worker.)

```js
// main.js
const factor = 3;
const scale = (xs) => xs.map((x) => x * factor); // captures `factor`

new Worker('./worker.js', { workerData: dumps(scale) });
```

```js
// worker.js
const scale = loads(workerData);
parentPort.postMessage(scale([1, 2, 3])); // [3, 6, 9] — `factor` came along
```

Captured state isn't just copied, it stays live:

```js
const count = makeCounter();
count(); count();          // 2

const revived = loads(dumps(count));
revived();                 // 3 — it resumes, it doesn't reset
```

## How it works

Start from what JavaScript will tell you about a function, which is its source:

```js
String(scale); // '(xs) => xs.map((x) => x * factor)'
```

That's not enough. Evaluate that string in another process and you get
`ReferenceError: factor is not defined`. The interesting half of a closure is
the part you can't see — and there's no API for it. `fn.length`, `fn.name`,
that's the whole reflection surface. Python hands you `fn.__closure__`; JS
hands you nothing.

Except your debugger shows you closed-over variables every time you hit a
breakpoint. It isn't guessing: V8 exposes them as an internal property called
`[[Scopes]]`, over the same inspector protocol Chrome DevTools speaks. Node
ships that protocol in-process:

```js
import inspector from 'node:inspector';
const session = new inspector.Session();
session.connect(); // to this thread's own inspector

session.post('Runtime.getProperties', { objectId }, (err, res) => {
  res.internalProperties; // includes [[Scopes]]: one entry per enclosing scope,
});                       // each holding the bindings — `factor: 3` among them
```

Two quirks make this usable. A session connected to its *own* thread runs that
callback before `post` returns, so `dumps` can stay synchronous. And the
protocol only addresses objects by id, with no way to hand it a local value —
so values get parked on `globalThis[Symbol.for('cloudpickle-js.hook')]` and
read back through `Runtime.evaluate`, which is silly but works in both
directions.

Now you have names and values. To put them back, you need to inject an object
into a function's scope chain, and there's exactly one construct that does
that:

```js
new Function('__scope__', `with (__scope__) { return (${src}); }`)(scope);
```

`with` is the villain of every ES5 blog post, and here it's the one thing that
makes this work. It resolves through a real object, so what comes back is a
*binding*, not a snapshot: assign to `factor` inside the revived function and
the scope object updates. That's why the counter above keeps counting.

### Three things get in the way

**V8 tells you too much.** It allocates one context per *scope*, shared by
every closure created in it, so `[[Scopes]]` reports variables belonging to the
function next door:

```js
function make() {
  const small = 1;
  const huge = new Array(1e7).fill(0);
  return () => small; // [[Scopes]] reports huge too
}
```

Serializing `huge` here is a waste; if the sibling had captured a socket it
would be a crash. So each name is kept only if it plausibly appears as an
identifier in the function's own source — a regex, with lookbehinds so
`obj.small` doesn't count and `...small` does, and a bail-out to keeping
everything if the source contains `eval`. It errs toward including too much: a
false positive costs bytes, a false negative costs a `ReferenceError`.

**Source isn't always an expression.** `String(fn)` on a method gives you
`greet() { … }`, which doesn't parse on its own. It gets re-hosted in an object
literal and pulled back out through its descriptor, which handles getters and
setters for free. Classes need more care: `class D extends mixin(Base) {}`
keeps the *resolved* parent in an internal slot, and re-running `mixin(Base)`
on the other side would throw or produce a different class and quietly break
`instanceof`. So the parent is serialized like any other value and the source
is rewritten to `class D extends __cpjs_super__ {…}`.

**Everything the closure points at has to travel too**, which is where this
stops being about closures and becomes an ordinary pickle: a flat heap with a
memo table, slots reserved before recursing so cycles terminate, `Math.max` and
friends encoded as paths instead of by value, prototypes encoded as *the class
they came from* so instances land on the same rebuilt class and `instanceof`
holds. Loading happens in passes — allocate empty shells first so cycles can be
wired unconditionally, then evaluate functions, then fill, then freeze — and
scope bindings resolve lazily, because `class A extends B` demands `B` while
the heap is still half-built.

One consequence worth noticing: nothing here requires the values to be in your
process. Source, `[[Scopes]]` and properties are all things CDP will tell you
about a *remote* target, so the same payload can be built against a browser
tab. `demos/browser-capture.mjs` lifts a closure out of a Chrome page — where
page JS could never introspect itself — and keeps calling it in Node, click
count intact.

## Sharp edges

- **Node ≥ 18 only.** Closure capture needs the V8 inspector.
- **`loads` evaluates code.** Only load payloads you trust, same as pickle.
- **Native and bound functions** have no source. Register them by reference.
- **Sibling closures stop sharing bindings.** They still see the same *values*
  (shared objects stay shared), but each revived function gets its own scope
  object, so one reassigning `count` no longer moves the other's `count`.
  Restoring that would mean rebuilding V8's context graph, not just scopes.
- **`this` in arrow functions** and live module-namespace bindings don't come
  back — internal slots, not `[[Scopes]]`.
- **Rejected outright:** `WeakMap`/`WeakSet`/`WeakRef`, pending promises, and
  classes that `extend` each other cyclically.
- **Identity is per-payload.** Two `loads` calls give you two unrelated graphs.
- **Cost scales with functions, not bytes** — a few inspector round-trips each.
  Data-only graphs never touch the inspector.

Everything else round-trips: async functions and generators, class hierarchies
with `super`, accessors, symbol keys, sparse arrays, `Map`/`Set`/`Date`/
`RegExp`/`Error`, typed arrays and `Buffer`, frozen objects, `-0`, `BigInt`,
mutually recursive closures, and cycles.

## API

Mirrors cloudpickle:

- `dumps(value, options?)` → payload string, `loads(payload)` → value
- `dump(value, stream, options?)` / `await load(streamOrString)`
- `new Pickler(options)` / `new Unpickler()` for reusable instances
  (`captureClosures: false` turns capture off)
- `registerReducer(Ctor, reduce)` — `__reduce__`. Returns `[restoreFn, args]`;
  the object comes back as `restoreFn(...args)`. `URL` uses it.
- `registerPickleByReference(path, value)` — for modules that should travel as
  a name; register the same path on the loading side.
- `inspectClosure(fn)` — `fn.__closure__`, finally. `[{ name, value }]` for
  every variable `fn` captured.

Failures are `PicklingError` / `UnpicklingError`, and they say what to do.

## Running it

```
npm test              # unit + cross-process tests (dumps here, loads in a fresh process)
node demos/crazy.mjs  # warm memo caches, half-trained models, mid-fight RPG instances
node demos/browser-capture.mjs [cdp-host:port]   # pickle a closure out of a Chrome tab
```
