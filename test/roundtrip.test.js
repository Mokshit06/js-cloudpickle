import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dumps, loads, PicklingError, registerPickleByReference, registerReducer } from '../src/index.js';

const roundtrip = (v, options) => loads(dumps(v, options));

test('primitives', () => {
  assert.equal(roundtrip(42), 42);
  assert.equal(roundtrip('hello'), 'hello');
  assert.equal(roundtrip(true), true);
  assert.equal(roundtrip(null), null);
  assert.equal(roundtrip(undefined), undefined);
  assert.ok(Number.isNaN(roundtrip(NaN)));
  assert.equal(roundtrip(Infinity), Infinity);
  assert.equal(roundtrip(-Infinity), -Infinity);
  assert.ok(Object.is(roundtrip(-0), -0));
  assert.equal(roundtrip(123456789012345678901234567890n), 123456789012345678901234567890n);
});

test('plain data structures', () => {
  assert.deepEqual(roundtrip({ a: 1, b: [2, 3], c: { d: null } }), { a: 1, b: [2, 3], c: { d: null } });
  const m = roundtrip(new Map([['x', 1], [2, 'y']]));
  assert.ok(m instanceof Map);
  assert.equal(m.get('x'), 1);
  assert.equal(m.get(2), 'y');
  const s = roundtrip(new Set([1, 'a', null]));
  assert.ok(s instanceof Set && s.has('a'));
  const d = roundtrip(new Date(1234567890123));
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1234567890123);
  const re = roundtrip(/ab+c/gi);
  assert.ok(re instanceof RegExp);
  assert.equal(re.source, 'ab+c');
  assert.equal(re.flags, 'gi');
});

test('sparse arrays and extra props', () => {
  const arr = [1, , 3]; // eslint-disable-line no-sparse-arrays
  arr.tag = 'x';
  const out = roundtrip(arr);
  assert.equal(out.length, 3);
  assert.ok(!(1 in out));
  assert.equal(out.tag, 'x');
});

test('binary data', () => {
  const u8 = roundtrip(new Uint8Array([1, 2, 255]));
  assert.ok(u8 instanceof Uint8Array);
  assert.deepEqual([...u8], [1, 2, 255]);
  const f64 = roundtrip(new Float64Array([1.5, -2.25]));
  assert.deepEqual([...f64], [1.5, -2.25]);
  const buf = roundtrip(Buffer.from('hey'));
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'hey');
});

test('circular references and shared identity', () => {
  const shared = { n: 1 };
  const obj = { a: shared, b: shared };
  obj.self = obj;
  const out = roundtrip(obj);
  assert.equal(out.self, out);
  assert.equal(out.a, out.b);
  assert.equal(out.a.n, 1);
});

test('simple function', () => {
  const fn = roundtrip((a, b) => a + b);
  assert.equal(fn(2, 3), 5);
});

test('closure capture', () => {
  function makeAdder(n) {
    const offset = 100;
    return (x) => x + n + offset;
  }
  const add5 = roundtrip(makeAdder(5));
  assert.equal(add5(1), 106);
});

test('mutable closure state (counter)', () => {
  function makeCounter() {
    let count = 0;
    return () => ++count;
  }
  const counter = makeCounter();
  counter();
  counter(); // count = 2 at pickle time
  const revived = roundtrip(counter);
  assert.equal(revived(), 3);
  assert.equal(revived(), 4);
  assert.equal(counter(), 3, 'original is unaffected');
});

test('nested closures over objects', () => {
  const config = { greeting: 'hello', punctuation: '!' };
  const greet = (name) => `${config.greeting}, ${name}${config.punctuation}`;
  const out = roundtrip(greet);
  assert.equal(out('world'), 'hello, world!');
});

test('recursive function', () => {
  function fact(n) {
    return n <= 1 ? 1 : n * fact(n - 1);
  }
  assert.equal(roundtrip(fact)(6), 720);
});

test('mutually recursive closures', () => {
  function make() {
    const isEven = (n) => (n === 0 ? true : isOdd(n - 1));
    const isOdd = (n) => (n === 0 ? false : isEven(n - 1));
    return isEven;
  }
  assert.equal(roundtrip(make())(10), true);
  assert.equal(roundtrip(make())(7), false);
});

test('generators and async functions', async () => {
  function* gen(n) {
    for (let i = 0; i < n; i++) yield i * 2;
  }
  assert.deepEqual([...roundtrip(gen)(3)], [0, 2, 4]);
  const factor = 3;
  const afn = async (x) => x * factor;
  assert.equal(await roundtrip(afn)(4), 12);
});

test('functions using globals by reference', () => {
  const fn = (xs) => Math.max(...xs.map((x) => Math.abs(x))) + JSON.stringify(xs).length;
  const out = roundtrip(fn);
  assert.equal(out([-5, 2]), fn([-5, 2]));
});

test('function with attached properties', () => {
  const fn = (x) => x + 1;
  fn.meta = { version: 2 };
  const out = roundtrip(fn);
  assert.equal(out(1), 2);
  assert.deepEqual(out.meta, { version: 2 });
});

test('classes round-trip with methods, statics, getters, inheritance', () => {
  const bonus = 10;
  class Animal {
    static kingdom = 'Animalia';
    constructor(name) {
      this.name = name;
    }
    speak() {
      return `${this.name} makes a sound`;
    }
    get loud() {
      return this.speak().toUpperCase();
    }
  }
  class Dog extends Animal {
    speak() {
      return `${super.speak()} (woof x${bonus})`;
    }
  }
  const RDog = roundtrip(Dog);
  const d = new RDog('rex');
  assert.equal(d.speak(), 'rex makes a sound (woof x10)');
  assert.equal(d.loud, 'REX MAKES A SOUND (WOOF X10)');
  assert.equal(RDog.kingdom, 'Animalia');
  assert.ok(d instanceof RDog);
});

test('class instances round-trip and keep instanceof within one pickle', () => {
  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
    norm() {
      return Math.hypot(this.x, this.y);
    }
  }
  const { p, P } = roundtrip({ p: new Point(3, 4), P: Point });
  assert.equal(p.norm(), 5);
  assert.ok(p instanceof P);
  assert.equal(Object.getPrototypeOf(p), P.prototype);
});

test('methods detached from objects', () => {
  const obj = {
    factor: 2,
    scale(x) {
      return x * this.factor;
    },
  };
  const out = roundtrip(obj);
  assert.equal(out.scale(21), 42);
});

test('getters/setters on plain objects', () => {
  const secret = 7;
  const obj = {
    _v: 1,
    get v() {
      return this._v * secret;
    },
    set v(x) {
      this._v = x;
    },
  };
  const out = roundtrip(obj);
  assert.equal(out.v, 7);
  out.v = 3;
  assert.equal(out.v, 21);
});

test('symbols', () => {
  assert.equal(roundtrip(Symbol.for('shared')), Symbol.for('shared'));
  assert.equal(roundtrip(Symbol.iterator), Symbol.iterator);
  const sym = Symbol('unique');
  const out = roundtrip({ a: sym, b: sym, [sym]: 1 });
  assert.equal(out.a, out.b, 'unique symbol identity preserved within a pickle');
  assert.equal(out.a.description, 'unique');
  assert.equal(out[out.a], 1);
});

test('errors round-trip', () => {
  const err = new TypeError('boom');
  err.code = 'E_BOOM';
  const out = roundtrip(err);
  assert.ok(out instanceof TypeError);
  assert.equal(out.message, 'boom');
  assert.equal(out.code, 'E_BOOM');
  assert.equal(typeof out.stack, 'string');
});

test('frozen and sealed objects', () => {
  const out = roundtrip(Object.freeze({ a: Object.seal({ b: 1 }) }));
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isSealed(out.a));
});

test('globals are pickled by reference', () => {
  assert.equal(roundtrip(Math), Math);
  assert.equal(roundtrip(console), console);
  assert.equal(roundtrip(Array.prototype), Array.prototype);
  assert.equal(roundtrip(Math.max), Math.max);
});

test('native functions without registration fail with a clear error', () => {
  const native = require_like();
  function require_like() {
    return setTimeout.bind(null);
  }
  assert.throws(() => dumps(native), PicklingError);
});

test('registerPickleByReference', () => {
  const myModule = { helper: (x) => x * 2 };
  registerPickleByReference('test.myModule', myModule);
  try {
    const payload = dumps(myModule.helper);
    assert.ok(payload.includes('test.myModule.helper'));
    assert.equal(loads(payload), myModule.helper);
  } finally {
    // no unregister needed for other tests; path is namespaced
  }
});

test('registerReducer (__reduce__ analogue)', () => {
  class Handle {
    constructor(id) {
      this.id = id;
      this.socket = Symbol('unpicklable resource');
    }
  }
  registerReducer(Handle, (h) => [(id) => new Handle(id), [h.id]]);
  const out = roundtrip(new Handle(7));
  assert.equal(out.id, 7);
  assert.equal(typeof out.socket, 'symbol');
});

test('URL and URLSearchParams built-in reducers', () => {
  const u = roundtrip(new URL('https://example.com/a?b=1'));
  assert.ok(u instanceof URL);
  assert.equal(u.href, 'https://example.com/a?b=1');
});

test('promises and weak collections are rejected', () => {
  assert.throws(() => dumps(Promise.resolve(1)), PicklingError);
  assert.throws(() => dumps(new WeakMap()), PicklingError);
});

test('null-prototype objects', () => {
  const o = Object.create(null);
  o.x = 1;
  const out = roundtrip(o);
  assert.equal(Object.getPrototypeOf(out), null);
  assert.equal(out.x, 1);
});

test('function closing over itself via named expression scope', () => {
  const fib = function fib(n) {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
  };
  assert.equal(roundtrip(fib)(10), 55);
});

test('closure over a class', () => {
  class Box {
    constructor(v) {
      this.v = v;
    }
  }
  const makeBox = (v) => new Box(v);
  const out = roundtrip(makeBox);
  assert.equal(out(5).v, 5);
});
