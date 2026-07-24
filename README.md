# cloudpickle-js

You can't serialize a function in JavaScript:

```js
const factor = 3;
const scale = (xs) => xs.map((x) => x * factor);

JSON.stringify(scale);  // undefined
structuredClone(scale); // DataCloneError
```

So you can't hand a worker a function to run. You send data, and keep the code
on both sides.

cloudpickle-js serializes the function together with the variables it
captured, into a string that another process can load and call:

```js
// main.js
new Worker('./worker.js', { workerData: dumps(scale) });

// worker.js
const scale = loads(workerData);
scale([1, 2, 3]); // [3, 6, 9] — `factor` came along
```

Python has had this for years: [cloudpickle](https://github.com/cloudpipe/cloudpickle)
is how `multiprocessing` and Spark ship lambdas to workers. This is that, for
Node.

Captured variables stay *live*, not copied:

```js
const count = makeCounter();
count(); count();    // 2

const revived = loads(dumps(count));
revived();           // 3 — it resumes, it doesn't reset
```

Classes, instances, cycles, and shared references survive too.

## How it works

The only thing JavaScript will tell you about a function is its source:

```js
String(scale); // '(xs) => xs.map((x) => x * factor)'
```

That's not enough. Evaluate this string in another process and you get
`ReferenceError: factor is not defined`. The captured variables are the whole
point, and there is no API for them. Python has `fn.__closure__`. JavaScript
has nothing.

There is one program that can see captured variables: your debugger. Pause on
a breakpoint and there they are, in the Scope panel. The debugger isn't part
of the language, so it doesn't play by the language's rules. V8 exposes every
function's captured scopes as an internal property called
`[[Scopes]]`, through the same protocol Chrome DevTools uses. And Node ships
that protocol in-process, as `node:inspector`.

So a program can be its own debugger:

```js
import inspector from 'node:inspector';
const session = new inspector.Session();
session.connect();

session.post('Runtime.getProperties', { objectId: idOf(scale) }, (err, res) => {
  // res.internalProperties includes [[Scopes]],
  // and inside it: { name: 'factor', value: 3 }
});
```

Two details make this practical. First, a session connected to its own thread
runs the callback *before* `post` returns, so `dumps` can be synchronous.
Second, the protocol only speaks in object ids and can't be handed a local
value, so values are passed through a global
(`globalThis[Symbol.for('cloudpickle-js.hook')]`) in both directions. It's a
hack, but it works.

Now we can read a closure. How do we rebuild one? We have source text and a
bag of variables, and we need those names to resolve when the function runs.
Exactly one construct in JavaScript injects an object into the scope chain:

```js
new Function('scope', `with (scope) { return (${src}); }`)(scope);
```

`with` has been discouraged for so long that it's easy to forget what it does:
it resolves names through a real object. That means the revived function gets
*bindings*, not snapshots. Assigning to a captured variable writes back to the
scope object. This is why the counter above keeps counting instead of
resetting.

The rest of the library deals with three complications.

**V8 reports too much.** V8 doesn't allocate an environment per closure. It
allocates one per *scope*, shared by every function created there:

```js
function make() {
  const small = 1;
  const huge = new Array(1e7).fill(0);
  return () => small; // [[Scopes]] reports `huge` too
}
```

Serializing `huge` would be wasteful. Worse, if a sibling closure captured a
socket, serialization would fail. So a variable is kept only if its name
appears in the function's own source. (A regex checks this. `obj.small`
doesn't count,
`...small` does, and if the source contains `eval`, everything is kept.)

**Source isn't always an expression.** `String(fn)` on a method returns
`greet() { ... }`, which doesn't parse alone; it gets wrapped in an object
literal and pulled back out. Classes hide a subtler problem: in
`class D extends mixin(Base) {}`, the parent lives in an internal slot, and
re-running `mixin(Base)` elsewhere would throw, or quietly build a different
class. So the parent is serialized like any other captured value and
the source is rewritten to `extends __cpjs_super__`.

**Everything a closure touches must travel too.** From here it's an ordinary
pickle: a flat heap with a memo table, so cycles and shared references
survive. Globals like `Math` travel as names, not values. An instance's
prototype is encoded as the class it came from, so `instanceof` still holds
after loading.

Nothing above requires the function to live in *your* process. Chrome will
answer the same questions about a running tab: its source, its `[[Scopes]]`,
its properties. `demos/browser-capture.mjs` lifts a closure out of a web page
(which could never introspect itself) and keeps calling it in Node.

## What doesn't survive

- Native and bound functions. They have no source. Register them by reference
  instead.
- Shared bindings between sibling closures. Both still see the same objects,
  but each revived function gets its own scope, so reassigning a shared
  variable in one no longer moves it in the other.
- `this` in arrow functions and live module bindings. Those live in internal
  slots, not `[[Scopes]]`.
- `WeakMap`, `WeakSet`, pending promises. Rejected with an error, like locks
  and sockets in pickle.

Two more rules. `loads` evaluates code, so only load payloads you trust. And
it needs Node ≥ 18, because browsers don't let a page use the inspector on
itself.

## API

- `dumps(value)` → string, `loads(payload)` → value
- `inspectClosure(fn)` — the missing `fn.__closure__`: `[{ name, value }]` for
  every variable `fn` captured
- `registerReducer(Ctor, reduce)` — like `__reduce__`: return
  `[restoreFn, args]`, get back `restoreFn(...args)`
- `registerPickleByReference(path, value)` — serialize a module as a name;
  register the same path on the loading side

## Try it

```
npm test              # unit + cross-process tests
node demos/crazy.mjs  # warm caches, half-trained models, mid-fight RPG instances
node demos/browser-capture.mjs [cdp-host:port]   # pull a closure out of a Chrome tab
```
