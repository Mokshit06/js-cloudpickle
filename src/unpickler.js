import { resolveGlobalPath } from './globals.js';
import { toExpression } from './function-source.js';
import { FORMAT_VERSION } from './pickler.js';

export class UnpicklingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnpicklingError';
  }
}

const HOLE = Symbol('cloudpickle-js.hole');

export class Unpickler {
  loads(payload) {
    const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new UnpicklingError(`invalid pickle payload: ${err.message}`);
    }
    if (parsed?.cloudpickleJs !== FORMAT_VERSION) {
      throw new UnpicklingError(
        `unsupported pickle format: expected version ${FORMAT_VERSION}, got ${parsed?.cloudpickleJs}`
      );
    }
    this.heap = parsed.heap;
    this.objects = new Array(this.heap.length);
    this.built = new Array(this.heap.length).fill(false);
    this.building = new Array(this.heap.length).fill(false);

    for (let i = 0; i < this.heap.length; i++) this.buildShell(i);
    for (let i = 0; i < this.heap.length; i++) this.get(i); // force functions/reduced
    for (let i = 0; i < this.heap.length; i++) this.fill(i);
    for (let i = 0; i < this.heap.length; i++) this.applyIntegrity(i);
    return this.dec(parsed.root);
  }

  buildShell(i) {
    const entry = this.heap[i];
    switch (entry.t) {
      case 'object':
        this.objects[i] = {};
        break;
      case 'array':
        this.objects[i] = [];
        break;
      case 'map':
        this.objects[i] = new Map();
        break;
      case 'set':
        this.objects[i] = new Set();
        break;
      case 'date':
        this.objects[i] = new Date(entry.ms);
        break;
      case 'regexp': {
        const re = new RegExp(entry.source, entry.flags);
        re.lastIndex = entry.lastIndex;
        this.objects[i] = re;
        break;
      }
      case 'symbol':
        this.objects[i] = Symbol(entry.description ?? undefined);
        break;
      case 'arraybuffer': {
        const bytes = Buffer.from(entry.data, 'base64');
        this.objects[i] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        break;
      }
      case 'typedarray': {
        const bytes = Buffer.from(entry.data, 'base64');
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const Base = globalThis[entry.base];
        if (typeof Base !== 'function') {
          throw new UnpicklingError(`unknown binary view type "${entry.base}"`);
        }
        this.objects[i] = new Base(buffer);
        break;
      }
      case 'function':
      case 'reduced':
        // Built on demand in get(); evaluating function source may eagerly
        // dereference scope values (e.g. `class A extends B`), so ordering is
        // resolved lazily through scope getters.
        break;
      default:
        throw new UnpicklingError(`unknown heap entry type "${entry.t}"`);
    }
    if (entry.t !== 'function' && entry.t !== 'reduced') this.built[i] = true;
  }

  get(i) {
    if (this.built[i]) return this.objects[i];
    const entry = this.heap[i];
    if (this.building[i]) {
      throw new UnpicklingError(
        `cyclic eager dependency while rebuilding ${entry.t} "${entry.name ?? ''}" ` +
          `(e.g. two classes extending each other)`
      );
    }
    this.building[i] = true;
    try {
      this.objects[i] = entry.t === 'function' ? this.buildFunction(entry, i) : this.buildReduced(entry);
      this.built[i] = true;
      return this.objects[i];
    } finally {
      this.building[i] = false;
    }
  }

  buildFunction(entry, index) {
    const scope = Object.create(null);
    for (const [name, encoded] of entry.scope) {
      let resolved = false;
      let cache;
      const self = this;
      Object.defineProperty(scope, name, {
        get() {
          if (!resolved) {
            // A function may close over itself; hand back the memo slot.
            cache = encoded[0] === 'ref' && encoded[1] === index ? self.objects[index] : self.dec(encoded);
            resolved = true;
          }
          return cache;
        },
        set(v) {
          cache = v;
          resolved = true;
        },
        enumerable: true,
        configurable: true,
      });
    }
    let factory;
    const expression = toExpression(entry.src);
    try {
      // eslint-disable-next-line no-new-func
      factory = new Function(
        '__cpjs_scope__',
        `with (__cpjs_scope__) { return (${expression}); }`
      );
    } catch (err) {
      throw new UnpicklingError(`cannot rebuild function "${entry.name}": ${err.message}\nsource: ${entry.src}`);
    }
    const fn = factory(scope);
    if (typeof fn !== 'function') {
      throw new UnpicklingError(`rebuilding "${entry.name}" did not produce a function`);
    }
    if (fn.name !== entry.name) {
      Object.defineProperty(fn, 'name', { value: entry.name, configurable: true });
    }
    return fn;
  }

  buildReduced(entry) {
    const restore = this.dec(entry.restore);
    if (typeof restore !== 'function') {
      throw new UnpicklingError('reduced entry has a non-function restorer');
    }
    return restore(...entry.args.map((a) => this.dec(a)));
  }

  fill(i) {
    const entry = this.heap[i];
    const obj = this.objects[i];
    switch (entry.t) {
      case 'object':
        if ('proto' in entry) Object.setPrototypeOf(obj, this.dec(entry.proto));
        this.defineProps(obj, entry.props);
        break;
      case 'array': {
        for (let k = 0; k < entry.items.length; k++) {
          const item = this.dec(entry.items[k]);
          if (item !== HOLE) obj[k] = item;
        }
        obj.length = entry.items.length;
        this.defineProps(obj, entry.props);
        if ('proto' in entry) Object.setPrototypeOf(obj, this.dec(entry.proto));
        break;
      }
      case 'map':
        for (const [k, v] of entry.entries) obj.set(this.dec(k), this.dec(v));
        this.defineProps(obj, entry.props);
        if ('proto' in entry) Object.setPrototypeOf(obj, this.dec(entry.proto));
        break;
      case 'set':
        for (const v of entry.values) obj.add(this.dec(v));
        this.defineProps(obj, entry.props);
        if ('proto' in entry) Object.setPrototypeOf(obj, this.dec(entry.proto));
        break;
      case 'function':
        this.defineProps(obj, entry.props);
        if (entry.protoProps && obj.prototype != null) this.defineProps(obj.prototype, entry.protoProps);
        break;
      case 'date':
      case 'regexp':
      case 'typedarray':
        this.defineProps(obj, entry.props);
        if ('proto' in entry) Object.setPrototypeOf(obj, this.dec(entry.proto));
        break;
      default:
        break;
    }
  }

  defineProps(target, props) {
    if (!props) return;
    for (const prop of props) {
      if (prop[0] === 'desc' && prop.length === 3) {
        const [, encKey, desc] = prop;
        const key = this.decKey(encKey);
        const descriptor = { enumerable: desc.enumerable, configurable: desc.configurable };
        if ('value' in desc) {
          descriptor.value = this.dec(desc.value);
          descriptor.writable = desc.writable;
        } else {
          descriptor.get = this.dec(desc.get);
          descriptor.set = this.dec(desc.set);
        }
        Object.defineProperty(target, key, descriptor);
      } else {
        const [encKey, encValue] = prop;
        Object.defineProperty(target, this.decKey(encKey), {
          value: this.dec(encValue),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
  }

  decKey(encKey) {
    return typeof encKey === 'string' ? encKey : this.dec(encKey);
  }

  applyIntegrity(i) {
    const { integrity } = this.heap[i];
    if (!integrity) return;
    const obj = this.objects[i];
    if (integrity === 'frozen') Object.freeze(obj);
    else if (integrity === 'sealed') Object.seal(obj);
    else Object.preventExtensions(obj);
  }

  dec(encoded) {
    if (encoded === null || typeof encoded !== 'object') return encoded;
    if (!Array.isArray(encoded)) throw new UnpicklingError('malformed encoded value');
    switch (encoded[0]) {
      case 'ref':
        return this.get(encoded[1]);
      case 'global':
        return resolveGlobalPath(encoded[1]);
      case 'proto': {
        const ctor = this.dec(encoded[1]);
        if (typeof ctor !== 'function') throw new UnpicklingError('proto tag did not resolve to a function');
        return ctor.prototype;
      }
      case 'undef':
        return undefined;
      case 'nan':
        return NaN;
      case 'inf':
        return Infinity;
      case '-inf':
        return -Infinity;
      case '-0':
        return -0;
      case 'bigint':
        return BigInt(encoded[1]);
      case 'symfor':
        return Symbol.for(encoded[1]);
      case 'hole':
        return HOLE;
      default:
        throw new UnpicklingError(`unknown tag "${encoded[0]}"`);
    }
  }
}
