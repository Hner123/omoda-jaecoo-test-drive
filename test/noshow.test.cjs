const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Q = require('../lib/queue');

function fixture() {
  return { ...Q.emptyState(), tickets: ['one', 'two', 'three'].map((id, i) => ({
    id, number: `J5-00${i + 1}`, model: 'J5', status: 'waiting', createdAt: i + 1,
    name: 'Guest', phone: '09171234567',
  })) };
}

test('no-show accepts waiting and called tickets, stamps completion and removes them from the line', () => {
  for (const status of ['waiting', 'called']) {
    const state = fixture();
    const ticket = state.tickets[0];
    if (status === 'called') Q.act(state, ticket.id, 'call');
    const before = Date.now();
    assert.equal(Q.act(state, ticket.id, 'noshow'), ticket);
    assert.equal(ticket.status, 'noshow');
    assert.ok(ticket.finishedAt >= before && ticket.finishedAt <= Date.now());
    if (status === 'waiting') assert.equal(ticket.calledAt, undefined);
    assert.equal(Q.position(state, ticket), 0);
    assert.equal(Q.position(state, state.tickets[1]), 1);
    assert.equal(Q.publicState(state).models.find((m) => m.id === 'J5').waitingCount, 2);
    assert.equal(Q.callNext(state, 'J5').id, 'two');
  }
  for (const status of ['driving', 'done', 'noshow', 'cancelled']) {
    const state = fixture();
    state.tickets[0].status = status;
    assert.throws(() => Q.act(state, 'one', 'noshow'), { status: 409 });
  }
});

test('requeue after a waiting no-show returns the guest to the end, including future queue keys', () => {
  const state = fixture();
  const ticket = state.tickets[0];
  state.tickets[2].queueAt = Date.now() + 100;
  Q.act(state, ticket.id, 'noshow');
  Q.act(state, ticket.id, 'requeue');
  assert.equal(ticket.status, 'waiting');
  assert.equal(ticket.createdAt, 1);
  assert.equal(Q.position(state, ticket), 3);
  assert.deepEqual(Q.waitingTickets(state, 'J5').map((t) => t.id), ['two', 'three', 'one']);
  assert.equal(Q.callNext(state, 'J5').id, 'two');
});

// Run the actual adapters and notification logic against in-memory storage and SMS.
// No listening sockets, disk writes or network calls are used.
for (const backend of ['server.js', 'netlify/functions/api.mjs']) {
  test(`${backend}: waiting no-show and customer cancel advance the line and notify the next guest once`, async () => {
    for (const route of ['/api/staff/tickets/one/noshow', '/api/tickets/one/cancel']) {
      const entry = path.resolve(__dirname, '..', backend);
      const nativeRequire = createRequire(entry);
      let stored = fixture();
      let handler;
      const sends = [];
      const notifyModule = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../lib/notify.js'), 'utf8'), {
        module: notifyModule,
        require: (id) => id === './queue' ? Q : {
          sendSms: async (phone, text) => { sends.push({ phone, text }); return { ok: true }; },
        },
      });
      const persist = (value) => { stored = structuredClone(value); };
      const require = (id) => /lib\/notify(?:\.js)?$/.test(id) ? notifyModule.exports
        : id === 'http' ? { createServer: (fn) => { handler = fn; return { listen() {} }; } }
          : id === 'fs' ? { readFileSync: () => JSON.stringify(stored), mkdirSync() {}, writeFileSync: (file, value) => persist(JSON.parse(value)) }
            : nativeRequire(id);
      let source = fs.readFileSync(entry, 'utf8');
      if (backend.endsWith('.mjs')) source = source.replace(/^import .*;\r?\n/gm, '')
        .replace('const require = createRequire(import.meta.url);', '')
        .replace('export const config', 'const config').replace('export default async', 'globalThis.handler = async');
      const context = vm.createContext({ __dirname: path.dirname(entry), URL, Response, Blob, Buffer, console, require,
        process: { env: { STAFF_PIN: '1234' } },
        getStore: () => ({ get: async () => structuredClone(stored), setJSON: async (key, value) => persist(value) }),
      });
      vm.runInContext(source, context);
      async function request(url) {
        if (backend.endsWith('.mjs')) return context.handler(new Request('https://queue.test' + url, {
          method: 'POST', headers: { 'x-staff-pin': '1234' },
        }));
        let status, body;
        await handler({ url, method: 'POST', headers: { 'x-staff-pin': '1234' } }, {
          writeHead(code) { status = code; }, end(value) { body = value; },
        });
        return new Response(body, { status });
      }
      assert.equal((await request(route)).status, 200);
      await new Promise(setImmediate); // Local notifications persist after responding.
      const removed = stored.tickets[0];
      assert.equal(removed.status, route.endsWith('noshow') ? 'noshow' : 'cancelled');
      assert.equal(Q.position(stored, removed), 0);
      assert.equal(Q.position(stored, stored.tickets[1]), 1);
      assert.equal(sends.length, 1);
      assert.match(sends[0].text, /J5-002, you're next/);
      assert.ok(stored.tickets[1].nextNotifiedAt);
      assert.equal((await request(route)).status, 409);
      assert.equal(sends.length, 1);
      assert.equal((await request('/api/staff/tickets/three/noshow')).status, 200);
      await new Promise(setImmediate);
      assert.equal(sends.length, 1, 'removing a guest behind the head sends no notification');
    }
  });
}
