// Capture closures OUT of a running Chrome tab, over the DevTools protocol,
// into a cloudpickle-js payload — then loads() and keep running them in Node.
//
// Page JS can't introspect its own closures, but anything holding a CDP
// connection (this script, a test harness, an extension via chrome.debugger)
// can read `[[Scopes]]` remotely. The captured values never enter this
// process as live objects; they are pickled entirely through the protocol.
//
// Usage: node demos/browser-capture.mjs [cdp-host:port] [page-expression]
import { loads } from '../src/index.js';

const CDP = process.argv[2] ?? 'localhost:29229';

// -- minimal CDP client over Node's builtin WebSocket ------------------------
const targets = await (await fetch(`http://${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('no debuggable page target found');
console.log(`attached to tab: ${page.title || page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

// -- a remote Pickler: same output format, but values stay in the browser ----
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result;
};

// stable per-object ids inside the page, for the memo table
await evaluate(`window.__cpjsId ??= ((m = new WeakMap(), i = 0) =>
  (v) => m.has(v) ? m.get(v) : (m.set(v, ++i), i))()`);
const idOf = async (objectId) => {
  const { result } = await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { return window.__cpjsId(this); }',
    returnByValue: true,
  });
  return result.value;
};

const heap = [];
const memo = new Map();

async function encRemote(remote) {
  if (remote.type === 'undefined') return ['undef'];
  if (remote.unserializableValue !== undefined) {
    const u = remote.unserializableValue;
    if (u === 'NaN') return ['nan'];
    if (u === 'Infinity') return ['inf'];
    if (u === '-Infinity') return ['-inf'];
    if (u === '-0') return ['-0'];
    if (remote.type === 'bigint') return ['bigint', u.replace(/n$/, '')];
  }
  if (remote.objectId === undefined) return remote.value;

  const memoKey = await idOf(remote.objectId);
  if (memo.has(memoKey)) return memo.get(memoKey);
  const idx = heap.length;
  heap.push(null);
  memo.set(memoKey, ['ref', idx]);

  if (remote.type === 'function') {
    const { internalProperties = [] } = await send('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties: true,
    });
    const scope = [];
    const scopesProp = internalProperties.find((p) => p.name === '[[Scopes]]');
    if (scopesProp?.value?.objectId) {
      const { result: scopeEntries = [] } = await send('Runtime.getProperties', {
        objectId: scopesProp.value.objectId,
        ownProperties: true,
      });
      const seen = new Set();
      for (const entry of scopeEntries) {
        const kind = String(entry.value?.description ?? '').split(/[\s(]/, 1)[0];
        if (!entry.value?.objectId || kind === 'Global') continue;
        const { result: vars = [] } = await send('Runtime.getProperties', {
          objectId: entry.value.objectId,
          ownProperties: true,
        });
        for (const v of vars) {
          if (v.value === undefined || seen.has(v.name)) continue;
          seen.add(v.name);
          scope.push([v.name, await encRemote(v.value)]);
        }
      }
    }
    heap[idx] = { t: 'function', kind: 'function', name: '', src: remote.description, scope };
    return ['ref', idx];
  }

  if (remote.subtype === 'array') {
    const { result: props = [] } = await send('Runtime.getProperties', {
      objectId: remote.objectId,
      ownProperties: true,
    });
    const items = [];
    for (const p of props) {
      if (/^\d+$/.test(p.name) && p.value) items[Number(p.name)] = await encRemote(p.value);
    }
    heap[idx] = { t: 'array', items };
    return ['ref', idx];
  }

  const { result: props = [] } = await send('Runtime.getProperties', {
    objectId: remote.objectId,
    ownProperties: true,
  });
  const encProps = [];
  for (const p of props) {
    if (!p.enumerable || !p.value) continue;
    encProps.push([p.name, await encRemote(p.value)]);
  }
  heap[idx] = { t: 'object', props: encProps };
  return ['ref', idx];
}

async function dumpsFromBrowser(expression) {
  heap.length = 0;
  memo.clear();
  const root = await encRemote(await evaluate(expression));
  return JSON.stringify({ cloudpickleJs: 1, root, heap });
}

// -- the demo -----------------------------------------------------------------
// A closure living purely inside the web page: a click tracker.
await evaluate(`
  (() => {
    let clicks = 0;
    const label = 'in-page button';
    window.trackClick = () => \`\${label} clicked \${++clicks} time(s)\`;
  })()
`);
console.log('page:', (await evaluate('window.trackClick()')).value);
console.log('page:', (await evaluate('window.trackClick()')).value);

const payload = await dumpsFromBrowser(process.argv[3] ?? 'window.trackClick');
console.log('\npayload pickled OUT of the browser tab:\n' + JSON.stringify(JSON.parse(payload), null, 2));

const trackClick = loads(payload);
console.log('\nnode:', trackClick());
console.log('node:', trackClick());
console.log('node:', trackClick());
console.log('\n(the browser closure kept its count of 2; Node continued from there)');
ws.close();
