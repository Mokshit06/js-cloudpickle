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

## How it works

CPython lets cloudpickle introspect `fn.__code__` and `fn.__closure__`.
JavaScript has no such reflection — but **V8 does**: a function's captured
scopes are exposed as the internal `[[Scopes]]` property through the inspector
protocol. `cloudpickle-js` opens a `node:inspector` session on its own thread
(where protocol calls complete synchronously) and reads every variable a
function closed over, then recursively pickles those values too.

At load time, each function is re-evaluated from its source inside a
`with (scope)` wrapper, where `scope` is a live object holding the captured
variables. This restores not just the values but the *bindings*: a pickled
counter keeps counting, and assignments to captured variables keep working.

Everything else follows cloudpickle's playbook:

- **Memo table** — shared references and cycles are preserved exactly.
- **By reference when importable** — globals (`Math`, `console`, `Buffer`,
  `Symbol.iterator`, ...) are encoded as a path and re-resolved on load.
- **By value otherwise** — your functions, classes, and objects travel whole.

## What round-trips

| Category | Details |
| --- | --- |
| Primitives | strings, numbers (incl. `NaN`, `±Infinity`, `-0`), booleans, `null`, `undefined`, `BigInt`, symbols (`Symbol.for`, well-known, and unique-per-pickle) |
| Functions | arrows, declarations, async, generators, detached methods, getters/setters — **with captured closure variables and mutable closure state** |
| Classes | methods, static and instance fields, accessors, `extends` chains (incl. `super`), and runtime-attached properties |
| Instances | rebuilt with the correct prototype; `instanceof` holds within a pickle |
| Containers | `Object` (incl. null-prototype, accessors, symbol keys, frozen/sealed), `Array` (sparse, extra props), `Map`, `Set` |
| Builtins | `Date`, `RegExp`, `Error` subclasses (message/stack/custom props), `ArrayBuffer`, typed arrays, `DataView`, `Buffer`, `URL`, `URLSearchParams` |
| Graphs | circular references, shared identity, self-referential functions, mutually recursive closures |

## API

Mirrors cloudpickle:

- `dumps(value, options?)` → payload string
- `loads(payload)` → value
- `dump(value, stream, options?)` / `await load(streamOrString)`
- `new Pickler(options)` / `new Unpickler()` — reusable instances
- `registerReducer(Ctor, reduce)` — the `__reduce__` analogue:
  `reduce(obj)` returns `[restoreFn, args]`; the object is rebuilt as
  `restoreFn(...args)`. Used internally for `URL`/`URLSearchParams`.
- `registerPickleByReference(path, value)` — the inverse of cloudpickle's
  `register_pickle_by_value`: mark a module/object to be encoded as a named
  reference instead of by value (register the same path on the loading side).
- `inspectClosure(fn)` — the `fn.__closure__` you always wanted: returns
  `[{ name, value }]` for every variable `fn` captured.

## Limitations

- **Node.js only** (≥ 18). Closure capture needs the V8 inspector; browsers
  don't expose it to page code.
- `loads` evaluates code — only unpickle payloads you trust (true of pickle
  too).
- Native/bound functions can't be pickled by value; register them by
  reference.
- Closure *bindings* shared between two sibling functions become independent
  after a round-trip (values are still shared); `this` captured by arrow
  functions and live module-namespace bindings are not restored.
- `WeakMap`/`WeakSet`/`WeakRef` and pending `Promise`s are rejected, like
  locks and sockets in pickle.

## Tests

```
npm test
```

Includes cross-process tests that `dumps` in one Node process and `loads` +
execute in a fresh one.
