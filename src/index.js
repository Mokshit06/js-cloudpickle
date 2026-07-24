// cloudpickle-js: cloudpickle, but for JavaScript.
//
// Serialize arbitrary JS values — including functions with the closures they
// capture, classes, and instances — by value, so they can be shipped to and
// executed by another Node process.

import { Pickler, PicklingError, registerReducer } from './pickler.js';
import { Unpickler, UnpicklingError } from './unpickler.js';
import { registerPickleByReference, unregisterPickleByReference } from './globals.js';
import { inspectClosure } from './inspector.js';

/** Serialize `value` to a string payload. */
export function dumps(value, options) {
  return new Pickler(options).dumps(value);
}

/** Rebuild a value from a payload produced by `dumps`. */
export function loads(payload) {
  return new Unpickler().loads(payload);
}

/** Serialize `value` and write it to `stream` (anything with `.write(str)`). */
export function dump(value, stream, options) {
  stream.write(dumps(value, options));
}

/** Read an entire readable stream (or string/bytes) and unpickle it. */
export async function load(source) {
  if (typeof source === 'string' || source instanceof Uint8Array) return loads(source);
  const chunks = [];
  for await (const chunk of source) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return loads(Buffer.concat(chunks).toString('utf8'));
}

export {
  Pickler,
  Unpickler,
  PicklingError,
  UnpicklingError,
  registerReducer,
  registerPickleByReference,
  unregisterPickleByReference,
  inspectClosure,
};

export default {
  dumps,
  loads,
  dump,
  load,
  Pickler,
  Unpickler,
  PicklingError,
  UnpicklingError,
  registerReducer,
  registerPickleByReference,
  unregisterPickleByReference,
  inspectClosure,
};
