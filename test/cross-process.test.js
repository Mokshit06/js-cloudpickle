// The whole point of cloudpickle: ship code to another process and run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dumps } from '../src/index.js';

const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function runInFreshProcess(payload, driverSrc) {
  const script = `
    import { loads } from ${JSON.stringify('file://' + indexPath)};
    const payload = ${JSON.stringify(payload)};
    const value = loads(payload);
    const driver = ${driverSrc};
    Promise.resolve(driver(value)).then((r) => console.log(JSON.stringify(r)));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim());
}

test('closure executes in a fresh process', () => {
  const rates = { usd: 1, eur: 0.9 };
  function makeConverter(target) {
    return (amount) => Math.round(amount * rates[target] * 100) / 100;
  }
  const payload = dumps(makeConverter('eur'));
  assert.equal(runInFreshProcess(payload, '(fn) => fn(150)'), 135);
});

test('stateful counter continues in a fresh process', () => {
  function makeCounter() {
    let n = 0;
    return () => ++n;
  }
  const c = makeCounter();
  c();
  c();
  const payload = dumps(c);
  assert.deepEqual(runInFreshProcess(payload, '(fn) => [fn(), fn(), fn()]'), [3, 4, 5]);
});

test('class hierarchy with instances works in a fresh process', () => {
  class Shape {
    constructor(name) {
      this.name = name;
    }
    describe() {
      return `${this.name}: area=${this.area()}`;
    }
  }
  class Circle extends Shape {
    constructor(r) {
      super('circle');
      this.r = r;
    }
    area() {
      return Math.round(Math.PI * this.r ** 2);
    }
  }
  const payload = dumps({ Circle, unit: new Circle(1) });
  const out = runInFreshProcess(
    payload,
    '({ Circle, unit }) => [unit.describe(), new Circle(2).describe(), unit instanceof Circle]'
  );
  assert.deepEqual(out, ['circle: area=3', 'circle: area=13', true]);
});

test('async pipeline with captured config runs in a fresh process', () => {
  const config = { retries: 2, transform: (x) => x.toUpperCase() };
  const pipeline = async (items) => items.map((i) => `${config.transform(i)}/${config.retries}`);
  const payload = dumps(pipeline);
  assert.deepEqual(runInFreshProcess(payload, "(fn) => fn(['a', 'b'])"), ['A/2', 'B/2']);
});
