const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const Q = require('../lib/queue');
const N = require('../lib/notify');

function fixture() {
  return { ...Q.emptyState(), tickets: ['a', 'b', 'c'].map((id, i) => ({
    id, number: `J5-00${i + 1}`, model: 'J5', status: 'waiting', createdAt: i + 1,
    name: 'Private Customer', phone: '09171234567', email: 'private@example.test',
    licenseNumber: 'PRIVATE', callSms: { state: 'Sent' },
  })) };
}
const ids = (state) => Q.waitingTickets(state, 'J5').map((t) => t.id);

test('reorder changes position, notification selection, public array order and callNext, preserving all other fields', () => {
  const state = fixture();
  const original = structuredClone(state.tickets);
  const changed = Q.reorder(state, 'J5', ['c', 'a', 'b']);
  assert.deepEqual(changed.map((t) => t.id), ['c', 'a', 'b']);
  assert.deepEqual(ids(state), ['c', 'a', 'b']);
  assert.deepEqual(state.tickets.map((t) => Q.position(state, t)), [2, 3, 1]);
  assert.equal(N.firstWaitingIds(state).J5, 'c');
  assert.deepEqual(Q.publicState(state).tickets.map((t) => t.number), ['J5-003', 'J5-001', 'J5-002']);
  assert.deepEqual(state.tickets.map(({ queueAt, ...t }) => t), original);
  assert.equal(Q.callNext(state, 'J5').id, 'c');
  assert.equal(Q.position(state, state.tickets[2]), 0);
  assert.deepEqual(Q.mergeDay(state.date, [state]).tickets.map((t) => t.id), ['a', 'b', 'c'], 'reports stay in registration order');
});

test('requeue sends to back without changing registration time, including colliding keys offset into the future', () => {
  const state = fixture();
  const ticket = Q.callNext(state, 'J5');
  const createdAt = ticket.createdAt;
  state.tickets[2].queueAt = Date.now() + 100;
  Q.act(state, ticket.id, 'requeue');
  assert.equal(ticket.createdAt, createdAt);
  assert.ok(ticket.queueAt >= Date.now());
  assert.deepEqual(ids(state), ['b', 'c', 'a']);
  assert.equal(Q.position(state, ticket), 3);
});

test('reorder ignores unknown, duplicate, other-model and non-waiting ids and keeps late joiners at the back', () => {
  const state = fixture();
  const clientIds = ['c', 'a', 'b'];
  state.tickets.push({ ...state.tickets[0], id: 'late', number: 'J5-004', createdAt: 4 },
    { ...state.tickets[0], id: 'called', status: 'called' },
    { ...state.tickets[0], id: 'other', model: 'J5EV' });
  const original = structuredClone(state.tickets);
  Q.reorder(state, 'J5', ['missing', 'called', 'other', ...clientIds, 'c']);
  assert.deepEqual(ids(state), ['c', 'a', 'b', 'late']);
  assert.deepEqual(state.tickets.slice(3), original.slice(3));
  assert.deepEqual(state.tickets.map(({ queueAt, ...t }) => t), original);
  assert.deepEqual(Q.reorder(state, 'J5', ['missing']), []);
  Q.reorder(state, 'J5', ['b']);
  assert.deepEqual(ids(state), ['b', 'c', 'a', 'late'], 'omitted tickets retain relative order after requested ids');
});

test('colliding legacy timestamps get strict keys and distinct positions; unchanged keys need no write', () => {
  const state = fixture();
  state.tickets.forEach((t) => { t.createdAt = 10; });
  assert.deepEqual(state.tickets.map((t) => Q.position(state, t)), [1, 2, 3]);
  Q.reorder(state, 'J5', ['c', 'b', 'a']);
  assert.deepEqual(Q.waitingTickets(state, 'J5').map(Q.orderKey), [10, 11, 12]);
  assert.deepEqual(state.tickets.map((t) => t.createdAt), [10, 10, 10]);
  assert.deepEqual(state.tickets.map((t) => Q.position(state, t)), [3, 2, 1]);
  assert.deepEqual(Q.reorder(state, 'J5', ['c', 'b', 'a']), []);
  assert.equal(Q.orderKey({ queueAt: 0, createdAt: 5 }), 0);
});

test('reorder validates before mutation', () => {
  const state = fixture();
  const before = structuredClone(state);
  for (const [model, list] of [['bad', []], ['J5', null], ['J5', 'a'], ['J5', [1]], ['J5', ['']], ['J5', Array(501).fill('a')]]) {
    assert.throws(() => Q.reorder(state, model, list), { status: 400 });
    assert.deepEqual(state, before);
  }
  assert.deepEqual(Q.reorder(state, 'J5', []), []);
});

test('new tickets initialize queueAt from the same registration timestamp', () => {
  const state = Q.emptyState();
  const ticket = Q.createTicket(state, { model: 'J5', name: 'Customer', gender: 'female', phone: '09171234567',
    email: 'test@example.test', municipality: 'Makati', customerType: 'walk_in', dealer: 'OJ Makati',
    salesExecutive: 'Sales Person', testDriveResource: 'event', consent: true });
  assert.equal(ticket.queueAt, ticket.createdAt);
  assert.equal(typeof ticket.queueAt, 'number');
});

// Execute both real routing implementations with isolated storage and HTTP doubles.
// No server is started and every notification/network attempt is rejected.
for (const backend of ['server.js', 'netlify/functions/api.mjs']) {
  test(`${backend}: reorder authorization, validation, persistence, positions and public privacy; no SMS`, async (t) => {
    const entry = path.resolve(__dirname, '..', backend);
    const nativeRequire = createRequire(entry);
    let stored = fixture();
    let writes = 0;
    let handler;
    const notifications = { ...N };
    for (const name of ['welcome', 'yourTurn', 'notifyNext', 'refreshCallSms']) notifications[name] = () => assert.fail(`reorder called ${name}`);
    t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network/SMS request'));
    const persist = (value) => { stored = structuredClone(value); writes++; };
    let source = fs.readFileSync(entry, 'utf8');
    const require = (id) => /lib\/notify(?:\.js)?$/.test(id) ? notifications
      : id === 'http' ? { createServer: (fn) => { handler = fn; return { listen() {} }; } }
        : id === 'fs' ? { readFileSync: () => JSON.stringify(stored), mkdirSync() {}, writeFileSync: (file, value) => persist(JSON.parse(value)) }
          : nativeRequire(id);
    if (backend.endsWith('.mjs')) source = source.replace(/^import .*;\r?\n/gm, '')
      .replace('const require = createRequire(import.meta.url);', '')
      .replace('export const config', 'const config').replace('export default async', 'globalThis.handler = async');
    const context = vm.createContext({ __dirname: path.dirname(entry), URL, Request, Response, Blob, Buffer, console, require,
      process: { env: { STAFF_PIN: '1234' } },
      getStore: (options) => {
        assert.equal(options.consistency, 'strong');
        return { get: async () => structuredClone(stored), setJSON: async (key, value) => { assert.equal(key, Q.today()); persist(value); } };
      },
    });
    vm.runInContext(source, context);
    async function request(route, { method = 'POST', pin = '1234', body = '{}' } = {}) {
      const headers = pin ? { 'x-staff-pin': pin } : {};
      if (backend.endsWith('.mjs')) return context.handler(new Request('https://queue.test' + route, { method, headers, ...(method === 'POST' ? { body } : {}) }));
      let status, result;
      const req = Readable.from(method === 'POST' ? [body] : []);
      Object.assign(req, { url: route, method, headers });
      await handler(req, { writeHead(code) { status = code; }, end(value) { result = value; } });
      return new Response(result, { status });
    }
    const post = (body, pin) => request('/api/staff/reorder', { body: JSON.stringify(body), pin });
    for (const pin of ['', 'wrong']) assert.equal((await post({ model: 'J5', ids: ['b', 'a', 'c'] }, pin)).status, 401);
    for (const body of [null, [], {}, { model: 'bad', ids: [] }, { model: 'J5' }, { model: 'J5', ids: [false] }, { model: 'J5', ids: Array(501).fill('a') }]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await request('/api/staff/reorder', { body: '{broken' })).status, 400);
    assert.equal(writes, 0, 'rejected requests never write');
    const response = await post({ model: 'J5', ids: ['c', 'b', 'a'] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(writes, 1);
    assert.deepEqual(ids(stored), ['c', 'b', 'a']);
    assert.deepEqual(stored.tickets.map((ticket) => ticket.createdAt), [1, 2, 3]);
    const publicState = await (await request('/api/state', { method: 'GET' })).json();
    assert.deepEqual(publicState.tickets.map((ticket) => ticket.number), ['J5-003', 'J5-002', 'J5-001']);
    for (const ticket of publicState.tickets) {
      for (const key of ['id', 'queueAt', 'phone', 'email', 'licenseNumber', 'licenseExpiry', 'callSms']) assert.equal(key in ticket, false, key);
      assert.equal(ticket.name, 'Private');
    }
    const customer = await (await request('/api/tickets/a', { method: 'GET' })).json();
    assert.equal(customer.position, 3);
    assert.equal(writes, 1, 'reads do not write or notify');
  });
}
