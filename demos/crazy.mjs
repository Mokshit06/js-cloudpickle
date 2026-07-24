// Crazy demos: everything below is pickled with dumps() in THIS process and
// loaded + executed in a BRAND NEW `node` process each time.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dumps } from '../src/index.js';

const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function runElsewhere(payload, driverSrc) {
  const script = `
    import { loads } from ${JSON.stringify('file://' + indexPath)};
    const value = loads(${JSON.stringify(payload)});
    const driver = ${driverSrc};
    Promise.resolve(driver(value)).then((r) => console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2)));
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
}

function demo(title, fn) {
  console.log(`\n=== ${title} ===`);
  fn();
}

// ---------------------------------------------------------------------------
demo('1. Memoized fibonacci ships with a WARM cache', () => {
  const cache = new Map();
  const stats = { hits: 0 };
  const fib = (n) => {
    if (cache.has(n)) return (stats.hits++, cache.get(n));
    const v = n < 2 ? n : fib(n - 1) + fib(n - 2);
    cache.set(n, v);
    return v;
  };
  fib(30); // warm the cache here, in process A
  console.log(`process A: computed fib(30)=${fib(30)}, cache has ${cache.size} entries`);
  const out = runElsewhere(
    dumps({ fib, cache, stats }),
    `({ fib, cache, stats }) => {
       const warm = cache.size;
       const before = stats.hits;
       const v = fib(32); // only needs 2 new entries: the cache traveled!
       return \`process B: fib(32)=\${v}, arrived with \${warm} warm entries, \` +
              \`\${stats.hits - before} cache hits during fib(32)\`;
     }`
  );
  console.log(out);
});

// ---------------------------------------------------------------------------
demo('2. A perceptron TRAINED here keeps LEARNING over there', () => {
  // train a tiny neural unit on OR in process A
  const model = { w: [Math.random(), Math.random()], b: Math.random() };
  const predict = (x) => 1 / (1 + Math.exp(-(x[0] * model.w[0] + x[1] * model.w[1] + model.b)));
  const train = (data, epochs, lr = 0.5) => {
    for (let e = 0; e < epochs; e++) {
      for (const [x, y] of data) {
        const p = predict(x);
        const g = (p - y) * p * (1 - p);
        model.w = [model.w[0] - lr * g * x[0], model.w[1] - lr * g * x[1]];
        model.b -= lr * g;
      }
    }
  };
  const OR = [[[0, 0], 0], [[0, 1], 1], [[1, 0], 1], [[1, 1], 1]];
  train(OR, 500);
  console.log(`process A: trained on OR -> p([0,1]) = ${predict([0, 1]).toFixed(3)}`);
  const out = runElsewhere(
    dumps({ predict, train, weights: () => [...model.w, model.b] }),
    `({ predict, train, weights }) => {
       const before = predict([0, 0]).toFixed(3);
       train([[[0, 0], 0]], 300);                       // keep training in process B
       return \`process B: arrived with weights [\${weights().map(v => v.toFixed(2))}], \` +
              \`p([0,0]) \${before} -> \${predict([0, 0]).toFixed(3)} after 300 more epochs\`;
     }`
  );
  console.log(out);
});

// ---------------------------------------------------------------------------
demo('3. RPG battle: class hierarchy + live instances pickled MID-FIGHT', () => {
  class Entity {
    constructor(name, hp) {
      Object.assign(this, { name, hp, log: [] });
    }
    hit(other, dmg) {
      other.hp -= dmg;
      this.log.push(`${this.name} hits ${other.name} for ${dmg}`);
      return other.hp;
    }
    get alive() {
      return this.hp > 0;
    }
  }
  class Wizard extends Entity {
    constructor(name) {
      super(name, 30);
      this.mana = 50;
    }
    fireball(other) {
      this.mana -= 10;
      return super.hit(other, 12);
    }
  }
  class Golem extends Entity {
    constructor(name) {
      super(name, 60);
    }
    smash(other) {
      return super.hit(other, 8);
    }
  }
  const merlin = new Wizard('Merlin');
  const rocky = new Golem('Rocky');
  merlin.fireball(rocky);
  rocky.smash(merlin); // fight starts in process A
  console.log(`process A: mid-fight -> Merlin hp=${merlin.hp}, Rocky hp=${rocky.hp}`);
  const out = runElsewhere(
    dumps({ merlin, rocky, Wizard }),
    `({ merlin, rocky, Wizard }) => {
       while (merlin.alive && rocky.alive) { merlin.fireball(rocky); if (rocky.alive) rocky.smash(merlin); }
       const rookie = new Wizard('Rookie');   // the CLASS traveled too
       return ['process B finished the fight:', ...merlin.log, ...rocky.log,
               \`winner: \${merlin.alive ? 'Merlin' : 'Rocky'} | merlin instanceof Wizard: \${merlin instanceof Wizard} | new Wizard works: \${rookie.name} hp=\${rookie.hp}\`
              ].join('\\n  ');
     }`
  );
  console.log(out);
});

// ---------------------------------------------------------------------------
demo('4. A whole recursive-descent CALCULATOR (mutually recursive closures)', () => {
  // expr -> term (('+'|'-') term)* ; term -> factor (('*'|'/') factor)* ;
  // factor -> NUMBER | '(' expr ')' — four closures all referencing each other.
  const makeParser = () => {
    const st = { tokens: [], pos: 0 }; // shared object: identity survives pickling
    const peek = () => st.tokens[st.pos];
    const eat = () => st.tokens[st.pos++];
    const factor = () => {
      if (peek() === '(') {
        eat();
        const v = expr();
        eat();
        return v;
      }
      return Number(eat());
    };
    const term = () => {
      let v = factor();
      while (peek() === '*' || peek() === '/') v = eat() === '*' ? v * factor() : v / factor();
      return v;
    };
    const expr = () => {
      let v = term();
      while (peek() === '+' || peek() === '-') v = eat() === '+' ? v + term() : v - term();
      return v;
    };
    return (src) => {
      st.tokens = src.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
      st.pos = 0;
      return expr();
    };
  };
  const calc = makeParser();
  console.log(`process A: calc("2*(3+4)") = ${calc('2*(3+4)')}`);
  const out = runElsewhere(
    dumps(calc),
    `(calc) => 'process B: calc("(1+2)*(3+4)/2 - 5") = ' + calc('(1+2)*(3+4)/2 - 5')`
  );
  console.log(out);
});

// ---------------------------------------------------------------------------
demo('5. An entire mini EVENT FRAMEWORK with live subscribers', () => {
  const makeBus = () => {
    const handlers = new Map();
    const history = [];
    return {
      on(evt, fn) {
        (handlers.get(evt) ?? handlers.set(evt, []).get(evt)).push(fn);
      },
      emit(evt, data) {
        history.push([evt, data]);
        for (const fn of handlers.get(evt) ?? []) fn(data);
      },
      history: () => history,
    };
  };
  const bus = makeBus();
  const seen = [];
  bus.on('order', (o) => seen.push(`order#${o.id} for $${o.total}`));
  bus.on('order', (o) => o.total > 100 && seen.push(`  -> flagged big order #${o.id}`));
  bus.emit('order', { id: 1, total: 250 });
  console.log(`process A: emitted 1 event, log = ${JSON.stringify(seen)}`);
  const out = runElsewhere(
    dumps({ bus, seen }),
    `({ bus, seen }) => {
       bus.emit('order', { id: 2, total: 40 });   // subscribers + their captured 'seen' array traveled
       bus.emit('order', { id: 3, total: 999 });
       return 'process B: history=' + bus.history().length + ' events, log:\\n  ' + seen.join('\\n  ');
     }`
  );
  console.log(out);
});

// ---------------------------------------------------------------------------
demo('6. Poor-man\'s distributed map: same closure fanned out to 3 processes', () => {
  const salt = 'cluster-42';
  const shardWork = (shard) =>
    shard.map((s) => `${s.toUpperCase()}@${salt}:len${s.length}`);
  const shards = [['alpha', 'beta'], ['gamma'], ['delta', 'epsilon']];
  const payload = dumps(shardWork); // pickle ONCE, run anywhere
  const results = shards.map((shard, i) =>
    JSON.parse(runElsewhere(payload, `(fn) => fn(${JSON.stringify(shard)})`))
  );
  console.log('3 fresh worker processes returned:');
  for (const r of results) console.log(' ', r);
});

console.log('\nAll demos ran their payloads in fresh `node` processes. 🚀');
