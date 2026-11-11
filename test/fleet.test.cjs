const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const Q = require('../lib/queue');

test('withFleet defaults, validates overrides and leaves source models untouched', () => {
  assert.deepEqual(Q.withFleet(Q.MODELS), Q.MODELS);
  const models = Q.withFleet(Q.MODELS, { J5: 5, J5EV: 0, EJ6: 50, J7SHS: '4', unknown: 9 });
  assert.deepEqual(models.map((m) => m.units), [5, 0, 50, 1]);
  for (const invalid of [-1, 51, 1.5, null, true, NaN, Infinity]) {
    assert.equal(Q.withFleet(Q.MODELS, { J5: invalid })[0].units, 1);
  }
  assert.ok(Q.MODELS.every((m) => m.units === 1));
});

function fixture() {
  return { ...Q.emptyState(), tickets: Array.from({ length: 6 }, (_, i) => ({
    id: 'private' + i, model: 'J5', number: 'J5-' + i, name: 'Private Guest',
    phone: '09171234567', status: 'waiting', createdAt: i,
  })) };
}

test('public and SMS wait estimates use fleet overrides and safely divide with zero cars', async () => {
  const state = fixture();
  assert.equal(Q.publicState(state, { J5: 5 }).models[0].estWaitMin, 40);
  assert.equal(Q.publicState(state, { J5: 0 }).models[0].estWaitMin, 120);
  assert.equal(Q.publicState(Q.emptyState(), { J5: 0 }).models[0].estWaitMin, 0);
  const messages = [];
  const entry = path.resolve(__dirname, '../lib/notify.js');
  const nativeRequire = createRequire(entry);
  const context = vm.createContext({ module: { exports: {} }, require: (id) => id === './sms'
    ? { sendSms: async (phone, text) => messages.push(text) } : nativeRequire(id) });
  vm.runInContext(fs.readFileSync(entry, 'utf8'), context);
  await context.module.exports.welcome(state, state.tickets[0], 6, { J5: 5 });
  await context.module.exports.welcome(state, state.tickets[0], 6, { J5: 0 });
  assert.match(messages[0], /est\. wait 20 min/);
  assert.match(messages[1], /est\. wait 100 min/);
  assert.doesNotMatch(messages.join(''), /NaN|Infinity/);
});

for (const backend of ['server.js', 'netlify/functions/api.mjs']) {
  test(`${backend}: fleet authorization, validation, persistence, reset/day rollover and public privacy`, async () => {
    const entry = path.resolve(__dirname, '..', backend);
    const nativeRequire = createRequire(entry);
    const files = new Map([[path.join(path.dirname(entry), 'data', 'queue.json'), fixture()]]);
    const blobs = new Map([[Q.today(), fixture()]]);
    let writes = 0;
    function boot() {
      let handler;
      const require = (id) => /lib\/notify(?:\.js)?$/.test(id) ? { refreshCallSms: async () => false }
        : id === 'http' ? { createServer: (fn) => { handler = fn; return { listen() {} }; } }
          : id === 'fs' ? {
            readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return JSON.stringify(files.get(file)); },
            mkdirSync() {}, existsSync: (file) => files.has(file),
            writeFileSync(file, value) { files.set(file, JSON.parse(value)); writes++; },
            renameSync(from, to) { assert.equal(from, to + '.tmp'); files.set(to, files.get(from)); files.delete(from); },
          } : nativeRequire(id);
      let source = fs.readFileSync(entry, 'utf8');
      if (backend.endsWith('.mjs')) source = source.replace(/^import .*;\r?\n/gm, '')
        .replace('const require = createRequire(import.meta.url);', '')
        .replace('export const config', 'const config').replace('export default async', 'globalThis.handler = async');
      const context = vm.createContext({ __dirname: path.dirname(entry), URL, Request, Response, Blob, Buffer,
        console, require, process: { env: { STAFF_PIN: '1234' } }, getStore: (options) => {
          assert.equal(options.consistency, 'strong');
          return { get: async (key) => structuredClone(blobs.get(key) || null),
            setJSON: async (key, value) => { blobs.set(key, structuredClone(value)); writes++; } };
        } });
      vm.runInContext(source, context);
      return async (route, { method = 'GET', pin = '1234', body } = {}) => {
        const headers = pin ? { 'x-staff-pin': pin } : {};
        if (backend.endsWith('.mjs')) return context.handler(new Request('https://queue.test' + route,
          { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }));
        const req = Readable.from(method === 'POST' ? [JSON.stringify(body)] : []);
        Object.assign(req, { url: route, method, headers });
        let status, result;
        await handler(req, { writeHead(code) { status = code; }, end(value) { result = value; } });
        return new Response(result, { status });
      };
    }
    let request = boot();
    const post = (body, pin) => request('/api/staff/fleet', { method: 'POST', body, pin });
    for (const pin of ['', 'wrong']) assert.equal((await post({ model: 'J5', units: 5 }, pin)).status, 401);
    for (const body of [null, [], {}, { model: 'unknown', units: 5 }, ...[-1, 51, 1.5, '5', true, null].map((units) => ({ model: 'J5', units })), { model: 'J5' }]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(writes, 0);
    assert.equal((await post({ model: 'J5EV', units: 0 })).status, 200);
    assert.equal((await post({ model: 'EJ6', units: 50 })).status, 200);
    const response = await post({ model: 'J5', units: 5 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, units: 5 });
    async function check() {
      for (const route of ['/api/state', '/api/staff/tickets']) {
        const result = await (await request(route)).json();
        assert.deepEqual(result.models.map((m) => m.units), [5, 0, 50, 1]);
        if (route === '/api/state') for (const ticket of result.tickets) {
          assert.equal('id' in ticket, false);
          assert.equal('phone' in ticket, false);
        }
      }
    }
    await check();
    request = boot(); // Fresh process/function context must read persistent settings.
    await check();
    assert.equal((await request('/api/staff/reset', { method: 'POST', body: {} })).status, 200);
    await check();
    // Local rollover archives yesterday; Netlify starts a missing day with an empty queue.
    const queueFile = path.join(path.dirname(entry), 'data', 'queue.json');
    files.set(queueFile, { ...fixture(), date: '2000-01-01' });
    blobs.delete(Q.today());
    request = boot();
    await check();
    assert.equal((await (await request('/api/state')).json()).tickets.length, 0);
  });
}
