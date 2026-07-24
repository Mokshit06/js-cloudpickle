import { inspectClosure } from './inspector.js';
import { globalPathFor } from './globals.js';
import { isNativeSource, isBindableName, sourceReferences, rewriteHeritage, SUPER_BINDING } from './function-source.js';

export const FORMAT_VERSION = 1;

export class PicklingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PicklingError';
  }
}

const defaultReducers = new Map();

/**
 * Register a `__reduce__`-style hook for instances of `Ctor`:
 * `reduce(obj)` must return `[restoreFn, argsArray]`; at load time the object
 * is rebuilt as `restoreFn(...argsArray)`. `restoreFn` itself is pickled
 * (by value or by reference), so it must be self-contained or global.
 */
export function registerReducer(Ctor, reduce) {
  if (typeof Ctor !== 'function' || typeof reduce !== 'function') {
    throw new TypeError('registerReducer(Ctor, reduce) expects two functions');
  }
  defaultReducers.set(Ctor, reduce);
}

registerReducer(URL, (u) => [(href) => new URL(href), [u.href]]);
registerReducer(URLSearchParams, (p) => [(s) => new URLSearchParams(s), [p.toString()]]);

const TYPED_ARRAY_TAGS = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
]);

function builtinTag(value) {
  return Object.prototype.toString.call(value).slice(8, -1);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export class Pickler {
  /**
   * @param {object} [options]
   * @param {Map<Function, Function>} [options.reducers] extra `__reduce__`-style hooks
   * @param {boolean} [options.captureClosures=true] set false to forbid closures
   */
  constructor(options = {}) {
    this.reducers = new Map([...defaultReducers, ...(options.reducers ?? new Map())]);
    this.captureClosures = options.captureClosures ?? true;
  }

  dumps(value) {
    this.memo = new Map();
    this.heap = [];
    const root = this.enc(value);
    return JSON.stringify({ cloudpickleJs: FORMAT_VERSION, root, heap: this.heap });
  }

  enc(value) {
    switch (typeof value) {
      case 'string':
        return value;
      case 'boolean':
        return value;
      case 'number':
        if (Number.isNaN(value)) return ['nan'];
        if (value === Infinity) return ['inf'];
        if (value === -Infinity) return ['-inf'];
        if (Object.is(value, -0)) return ['-0'];
        return value;
      case 'undefined':
        return ['undef'];
      case 'bigint':
        return ['bigint', value.toString()];
      case 'symbol':
        return this.encSymbol(value);
      case 'function':
      case 'object': {
        if (value === null) return null;
        const memoized = this.memo.get(value);
        if (memoized !== undefined) return memoized;
        const path = globalPathFor(value);
        if (path !== undefined) {
          const encoded = ['global', path];
          this.memo.set(value, encoded);
          return encoded;
        }
        return typeof value === 'function' ? this.encFunction(value) : this.encObject(value);
      }
      default:
        throw new PicklingError(`cannot pickle value of type ${typeof value}`);
    }
  }

  encSymbol(sym) {
    const memoized = this.memo.get(sym);
    if (memoized !== undefined) return memoized;
    const path = globalPathFor(sym);
    if (path !== undefined) return ['global', path];
    const registryKey = Symbol.keyFor(sym);
    if (registryKey !== undefined) return ['symfor', registryKey];
    const idx = this.reserve(sym);
    this.heap[idx] = { t: 'symbol', description: sym.description ?? null };
    return this.memo.get(sym);
  }

  reserve(value) {
    const idx = this.heap.length;
    this.heap.push(null);
    this.memo.set(value, ['ref', idx]);
    return idx;
  }

  reducerFor(value) {
    for (let proto = Object.getPrototypeOf(value); proto !== null; proto = Object.getPrototypeOf(proto)) {
      const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
      if (typeof ctor === 'function') {
        const reduce = this.reducers.get(ctor);
        if (reduce) return reduce;
      }
    }
    return undefined;
  }

  encFunction(fn) {
    const src = Function.prototype.toString.call(fn);
    if (isNativeSource(src)) {
      throw new PicklingError(
        `cannot pickle ${fn.name ? `"${fn.name}"` : 'anonymous function'}: it is a ` +
          `native or bound function with no source. Register it by reference with ` +
          `registerPickleByReference(path, fn) if it exists on the loading side.`
      );
    }
    const idx = this.reserve(fn);
    const kind = /^class[\s{]/.test(src.trim()) ? 'class' : 'function';

    const scope = [];
    if (this.captureClosures) {
      const seen = new Set();
      for (const { name, value } of this.capturedVariables(fn, kind)) {
        if (!isBindableName(name) || seen.has(name)) continue;
        if (!sourceReferences(src, name)) continue;
        seen.add(name);
        scope.push([name, value === fn ? ['ref', idx] : this.enc(value)]);
      }
    }

    const entry = { t: 'function', kind, name: fn.name ?? '', src, scope };

    if (kind === 'class') {
      // The heritage (`extends`) parent lives in an internal slot, not in
      // [[Scopes]]; pickle it explicitly and splice it back in at load time.
      const parent = Object.getPrototypeOf(fn);
      if (typeof parent === 'function' && parent !== Function.prototype) {
        entry.src = rewriteHeritage(src);
        if (entry.src !== src) {
          scope.push([SUPER_BINDING, parent === fn ? ['ref', idx] : this.enc(parent)]);
        }
      }
    }

    const props = this.encOwnProps(fn, {
      skip: new Set(['length', 'name', 'prototype', 'arguments', 'caller']),
      enumerableOnly: true,
    });
    if (props.length > 0) entry.props = props;

    const proto = fn.prototype;
    if (proto != null && (typeof proto === 'object' || typeof proto === 'function')) {
      const protoProps = this.encOwnProps(proto, {
        skip: new Set(['constructor']),
        enumerableOnly: true,
      });
      if (protoProps.length > 0) entry.protoProps = protoProps;
    }

    this.heap[idx] = entry;
    return ['ref', idx];
  }

  /**
   * Closure variables of `fn`. For classes, methods carry their own closure
   * scopes (they are separate function objects), so the union of the class's
   * and every own method's scopes is taken.
   */
  *capturedVariables(fn, kind) {
    yield* inspectClosure(fn);
    if (kind !== 'class') return;
    const holders = [fn, fn.prototype].filter((h) => h != null);
    for (const holder of holders) {
      for (const key of Reflect.ownKeys(holder)) {
        const desc = Object.getOwnPropertyDescriptor(holder, key);
        for (const method of [desc?.value, desc?.get, desc?.set]) {
          if (typeof method === 'function' && method !== fn) {
            const msrc = Function.prototype.toString.call(method);
            if (!isNativeSource(msrc)) yield* inspectClosure(method);
          }
        }
      }
    }
  }

  encOwnProps(obj, { skip = new Set(), enumerableOnly = false, skipIndices = false } = {}) {
    const out = [];
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key === 'string' && skip.has(key)) continue;
      if (skipIndices && typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (enumerableOnly && !desc.enumerable) continue;
      const encKey = typeof key === 'symbol' ? this.encSymbol(key) : key;
      if (desc.get || desc.set) {
        const accessorIsOpaque = [desc.get, desc.set].some(
          (f) =>
            typeof f === 'function' &&
            globalPathFor(f) === undefined &&
            isNativeSource(Function.prototype.toString.call(f))
        );
        if (accessorIsOpaque) {
          // e.g. V8's lazily-materialized `error.stack` accessor: snapshot the
          // current value instead of failing on the native getter.
          let snapshot;
          try {
            snapshot = obj[key];
          } catch {
            continue;
          }
          out.push([
            'desc',
            encKey,
            {
              value: this.enc(snapshot),
              writable: true,
              enumerable: desc.enumerable,
              configurable: desc.configurable,
            },
          ]);
          continue;
        }
        out.push([
          'desc',
          encKey,
          {
            get: desc.get ? this.enc(desc.get) : ['undef'],
            set: desc.set ? this.enc(desc.set) : ['undef'],
            enumerable: desc.enumerable,
            configurable: desc.configurable,
          },
        ]);
      } else if (desc.writable && desc.enumerable && desc.configurable) {
        out.push([encKey, this.enc(desc.value)]);
      } else {
        out.push([
          'desc',
          encKey,
          {
            value: this.enc(desc.value),
            writable: desc.writable,
            enumerable: desc.enumerable,
            configurable: desc.configurable,
          },
        ]);
      }
    }
    return out;
  }

  encPrototype(proto) {
    // A prototype whose constructor round-trips lets us preserve the
    // `instance instanceof Class` relationship through the class itself.
    if (proto === null) return null;
    const memoized = this.memo.get(proto);
    if (memoized !== undefined) return memoized;
    const path = globalPathFor(proto);
    if (path !== undefined) return ['global', path];
    const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
    if (typeof ctor === 'function' && ctor.prototype === proto) {
      const encoded = ['proto', this.enc(ctor)];
      this.memo.set(proto, encoded);
      return encoded;
    }
    return this.enc(proto);
  }

  integrityOf(obj) {
    if (Object.isFrozen(obj)) return 'frozen';
    if (Object.isSealed(obj)) return 'sealed';
    if (!Object.isExtensible(obj)) return 'preventExtensions';
    return undefined;
  }

  encObject(obj) {
    const reduce = this.reducerFor(obj);
    if (reduce) {
      const idx = this.reserve(obj);
      const [restore, args] = reduce(obj);
      this.heap[idx] = { t: 'reduced', restore: this.enc(restore), args: args.map((a) => this.enc(a)) };
      return ['ref', idx];
    }

    const tag = builtinTag(obj);
    switch (tag) {
      case 'Promise':
        throw new PicklingError('cannot pickle a Promise (pickling is synchronous; await it first)');
      case 'WeakMap':
      case 'WeakSet':
      case 'WeakRef':
        throw new PicklingError(`cannot pickle a ${tag}: its contents are not enumerable`);
      default:
        break;
    }

    const idx = this.reserve(obj);
    const proto = Object.getPrototypeOf(obj);
    let entry;

    if (Array.isArray(obj)) {
      entry = { t: 'array', items: [] };
      for (let i = 0; i < obj.length; i++) {
        entry.items.push(i in obj ? this.enc(obj[i]) : ['hole']);
      }
      const extra = this.encOwnProps(obj, { skip: new Set(['length']), skipIndices: true });
      if (extra.length > 0) entry.props = extra;
      if (proto !== Array.prototype) entry.proto = this.encPrototype(proto);
    } else if (obj instanceof Map) {
      entry = { t: 'map', entries: [...obj].map(([k, v]) => [this.enc(k), this.enc(v)]) };
      const extra = this.encOwnProps(obj, {});
      if (extra.length > 0) entry.props = extra;
      if (proto !== Map.prototype) entry.proto = this.encPrototype(proto);
    } else if (obj instanceof Set) {
      entry = { t: 'set', values: [...obj].map((v) => this.enc(v)) };
      const extra = this.encOwnProps(obj, {});
      if (extra.length > 0) entry.props = extra;
      if (proto !== Set.prototype) entry.proto = this.encPrototype(proto);
    } else if (tag === 'Date') {
      entry = { t: 'date', ms: obj.getTime() };
      const extra = this.encOwnProps(obj, {});
      if (extra.length > 0) entry.props = extra;
      if (proto !== Date.prototype) entry.proto = this.encPrototype(proto);
    } else if (tag === 'RegExp') {
      entry = { t: 'regexp', source: obj.source, flags: obj.flags, lastIndex: obj.lastIndex };
      const extra = this.encOwnProps(obj, { skip: new Set(['lastIndex']) });
      if (extra.length > 0) entry.props = extra;
      if (proto !== RegExp.prototype) entry.proto = this.encPrototype(proto);
    } else if (tag === 'ArrayBuffer') {
      entry = { t: 'arraybuffer', data: bytesToBase64(new Uint8Array(obj)) };
    } else if (TYPED_ARRAY_TAGS.has(tag) || tag === 'DataView') {
      entry = {
        t: 'typedarray',
        base: tag,
        data: bytesToBase64(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)),
      };
      const skip = new Set(['length', 'byteLength', 'byteOffset', 'buffer']);
      const extra = this.encOwnProps(obj, { skip, skipIndices: true });
      if (extra.length > 0) entry.props = extra;
      const base = globalThis[tag];
      if (base && proto !== base.prototype) entry.proto = this.encPrototype(proto);
    } else {
      entry = { t: 'object' };
      if (proto !== Object.prototype) entry.proto = this.encPrototype(proto);
      const props = this.encOwnProps(obj, {});
      if (props.length > 0) entry.props = props;
    }

    const integrity = this.integrityOf(obj);
    if (integrity) entry.integrity = integrity;

    this.heap[idx] = entry;
    return ['ref', idx];
  }
}
