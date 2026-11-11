const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sendSms, smsStatus, provider } = require('../lib/sms');
const N = require('../lib/notify');
const Q = require('../lib/queue');

const envNames = ['SMS_PROVIDER', 'SMSGATE_USERNAME', 'SMSGATE_PASSWORD', 'SMSGATE_URL', 'SMSGATE_SIM', 'TRACCAR_KEY', 'SEMAPHORE_KEY'];
const original = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
const user = 'mock-user';
const pass = 'mock-password';
const authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const phone = '+639171234567';
let logs;
beforeEach((t) => {
  for (const key of envNames) delete process.env[key];
  process.env.SMSGATE_USERNAME = user;
  process.env.SMSGATE_PASSWORD = pass;
  logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  // Every test starts with a network guard; tests can replace it with their own mock.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected fetch'); });
});
afterEach(() => {
  for (const key of envNames) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function assertPrivateLogs() {
  const output = logs.join('\n');
  for (const secret of [user, pass, authorization, 'Authorization', phone, '09171234567', 'Private Customer']) {
    assert.ok(!output.includes(secret), 'logs must omit private data');
  }
  assert.ok(output.includes(Q.maskPhone(phone)));
}

test('provider auto-selection priority, incomplete credentials and explicit overrides', () => {
  process.env.TRACCAR_KEY = 'mock-traccar';
  process.env.SEMAPHORE_KEY = 'mock-semaphore';
  assert.equal(provider(), 'smsgate');
  delete process.env.SMSGATE_PASSWORD;
  assert.equal(provider(), 'traccar');
  process.env.SMSGATE_PASSWORD = pass;
  delete process.env.SMSGATE_USERNAME;
  assert.equal(provider(), 'traccar');
  delete process.env.TRACCAR_KEY;
  assert.equal(provider(), 'semaphore');
  delete process.env.SEMAPHORE_KEY;
  assert.equal(provider(), 'none');
  for (const which of ['smsgate', 'traccar', 'semaphore', 'none']) {
    process.env.SMS_PROVIDER = which;
    assert.equal(provider(), which);
  }
});

test('SMSGate POST URL, Basic auth, exact payload and any 2xx acceptance', async (t) => {
  for (const status of [200, 202, 204, 299]) {
    for (const override of [undefined, 'https://private.example.test/api/3rdparty/v1/messages']) {
      if (override) process.env.SMSGATE_URL = override;
      else delete process.env.SMSGATE_URL;
      let called = false;
      t.mock.method(globalThis, 'fetch', async (url, options) => {
        called = true;
        assert.equal(url, override || 'https://api.sms-gate.app/3rdparty/v1/messages');
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: authorization });
        assert.deepEqual(JSON.parse(options.body), { textMessage: { text: 'Ticket J5-001' }, phoneNumbers: [phone], withDeliveryReport: true });
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(status === 204 ? null : '{"id":"mock-id","state":"Pending"}', { status });
      });
      const result = await sendSms('09171234567', 'Ticket J5-001');
      assert.equal(called, true);
      assert.equal(result.ok, true);
      assert.equal(result.provider, 'smsgate');
      assert.equal(result.state, 'Pending');
      assert.equal(result.id, status === 204 ? undefined : 'mock-id');
    }
  }
  assertPrivateLogs();
});

test('SMSGate includes only valid trimmed SIM selections and safely logs invalid values', async (t) => {
  for (const sim of [undefined, '', '   ', '1', '2', ' 2 ', '3', 'abc', '0', '5', '2.0', '2abc']) {
    if (sim === undefined) delete process.env.SMSGATE_SIM;
    else process.env.SMSGATE_SIM = sim;
    logs.length = 0;
    let called = false;
    const valid = ['1', '2', '3'].includes((sim || '').trim());
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      called = true;
      const expected = { textMessage: { text: 'Ticket J5-001' }, phoneNumbers: [phone], withDeliveryReport: true };
      if (valid) expected.simNumber = Number(sim.trim());
      assert.deepEqual(JSON.parse(options.body), expected);
      return new Response('{}', { status: 202 });
    });
    assert.equal((await sendSms(phone, 'Ticket J5-001')).ok, true);
    assert.equal(called, true);
    const invalid = Boolean((sim || '').trim()) && !valid;
    assert.equal(logs.filter((line) => line === '[sms:smsgate] ignoring invalid SMSGATE_SIM').length, invalid ? 1 : 0);
    assertPrivateLogs();
  }
});

test('401 and thrown errors cannot leak echoed credentials, headers or customer data', async (t) => {
  const sensitive = `${user} ${pass} Authorization ${authorization} ${phone} Private Customer`;
  t.mock.method(globalThis, 'fetch', async () => new Response(sensitive, { status: 401 }));
  assert.equal((await sendSms(phone, 'Private Customer')).ok, false);
  assert.match(logs[0], /FAILED 401/);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(sensitive); });
  assert.deepEqual(await sendSms(phone, sensitive), { provider: 'smsgate', ok: false, state: 'Failed', error: 'request_failed' });
  assertPrivateLogs();
});

test('six-second timeout aborts the request and is handled without rejecting', async (t) => {
  // Accelerate only the SMS timer while verifying its configured duration.
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    assert.equal(delay, 6000);
    return realSetTimeout(fn, 1);
  });
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  assert.deepEqual(await sendSms(phone, 'Ticket J5-001'), { provider: 'smsgate', ok: false, state: 'Failed', error: 'timeout' });
  assert.match(logs[0], /ERROR timeout/);
  assertPrivateLogs();
});

test('explicit SMSGate without credentials fails safely; none skips without message text', async () => {
  process.env.SMS_PROVIDER = 'smsgate';
  delete process.env.SMSGATE_PASSWORD;
  assert.deepEqual(await sendSms(phone, 'Private Customer'), { provider: 'smsgate', ok: false, state: 'Failed', error: 'missing_credentials' });
  process.env.SMS_PROVIDER = 'none';
  assert.deepEqual(await sendSms(phone, 'Private Customer'), { provider: 'none', ok: false, state: 'Skipped' });
  assert.equal(logs.length, 2);
  assertPrivateLogs();
});

test('all providers mask phones and omit response/error bodies on success and failure', async (t) => {
  for (const which of ['smsgate', 'traccar', 'semaphore']) {
    process.env.SMS_PROVIDER = which;
    process.env.TRACCAR_KEY = 'mock-traccar';
    process.env.SEMAPHORE_KEY = 'mock-semaphore';
    for (const status of [200, 401]) {
      t.mock.method(globalThis, 'fetch', async () => new Response(`Private Customer ${phone} ${pass}`, { status }));
      assert.equal((await sendSms(phone, 'Private Customer')).ok, status === 200);
    }
    t.mock.method(globalThis, 'fetch', async () => { throw new Error(`${pass} ${phone}`); });
    assert.equal((await sendSms(phone, 'Private Customer')).ok, false);
  }
  assert.equal(logs.length, 9);
  assertPrivateLogs();
});

test('Traccar body verdict still detects a failed send with HTTP 200', async (t) => {
  process.env.SMS_PROVIDER = 'traccar';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    failureCount: 1, successCount: 0, responses: [{ error: { message: `${pass} Private Customer` } }],
  })));
  assert.equal((await sendSms(phone, 'Ticket J5-001')).ok, false);
  assertPrivateLogs();
});

test('registration wording stays unchanged; call/recall and next-in-line use event booth', async (t) => {
  const texts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    texts.push(JSON.parse(options.body).textMessage.text);
    return new Response('{}', { status: 202 });
  });
  const ticket = { id: 'one', model: 'J5', number: 'J5-001', phone, name: 'Private Customer', status: 'waiting', createdAt: 1 };
  const state = { tickets: [ticket] };
  await N.welcome(state, ticket, 1);
  await N.yourTurn(ticket);
  await N.yourTurn(ticket);
  assert.equal(await N.notifyNext(state, {}), true);
  assert.equal(await N.notifyNext(state, {}), false, 'next notification is sent once');
  assert.equal(texts[0], `OMODA & JAECOO Test Drive: You're in the ${Q.MODELS[0].name} queue as J5-001. You're first in line. We'll text you when it's your turn.`);
  const call = approvedCallMessage('Good day, Private Customer!', 'J5-001');
  assert.equal(texts[1], call);
  assert.equal(texts[2], call);
  assert.equal(texts[3], `OMODA & JAECOO Test Drive: J5-001, you're next for the ${Q.MODELS[0].name}. Please head back to the OMODA & JAECOO Booth now.`);
  assertPrivateLogs();
});

function approvedCallMessage(greeting, number = 'J5EV-001') {
  return `${greeting}\n\nWe would like to inform you that your Queue Number ${number} is now being called. Kindly proceed to the OMODA JAECOO Booth and approach our staff for assistance.\n\nPlease have your queue number ready and make sure to proceed within 10 minutes to avoid delays and cancelation in the process.\n\nThank you for your patience and cooperation. We look forward to assisting you!`;
}

test('SMSGate validates ids and parses response state', async (t) => {
  for (const id of ['valid_Ab-12', '', '../private', 'a'.repeat(65), 123, null]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ id, state: 'Processed' }));
    const result = await sendSms(phone, 'test');
    assert.equal(result.id, id === 'valid_Ab-12' ? id : undefined);
    assert.equal(result.state, 'Processed');
    assert.equal(result.provider, 'smsgate');
  }
});

test('smsStatus uses GET, auth and recipient verdict with sanitized errors', async (t) => {
  process.env.SMSGATE_URL = 'https://sms.example.test/messages/';
  for (const [data, expected] of [
    [{ state: 'Sent' }, { state: 'Sent' }],
    [{ state: 'Sent', recipients: [{ state: 'Delivered' }] }, { state: 'Delivered' }],
    [{ state: 'Sent', recipients: [{ state: 'Failed', error: '<bad> "SIM": unavailable!_' + 'x'.repeat(90) }] },
      { state: 'Failed', error: ('bad SIM: unavailable_' + 'x'.repeat(90)).slice(0, 80) }],
    [{ state: 'Delivered', recipients: [{ state: 42, error: {} }] }, { state: 'Delivered' }],
    [{ state: 'Cancelled' }, { state: 'Failed', error: 'cancelled' }],
    [{ state: 'Cancelling' }, { state: 'Failed', error: 'cancelled' }],
    [{ state: 'Unknown' }, { state: 'Failed', error: 'cancelled' }],
    [{ state: 'Processed', recipients: null }, { state: 'Processed' }],
  ]) {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://sms.example.test/messages/message_1');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, authorization);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(data);
    });
    assert.deepEqual(await smsStatus('message_1'), expected);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(pass); });
  assert.equal(await smsStatus('message_1'), null);
  assert.deepEqual(logs, []);
  t.mock.method(globalThis, 'fetch', async () => new Response(pass, { status: 401 }));
  assert.equal(await smsStatus('message_1'), null);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
  assert.equal(await smsStatus('../invalid'), null);
  process.env.SMS_PROVIDER = 'none';
  assert.equal(await smsStatus('message_1'), null);
});

test('smsStatus times out after five seconds without logging secrets', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    assert.equal(delay, 5000);
    return realSetTimeout(fn, 1);
  });
  t.mock.method(globalThis, 'fetch', (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  assert.equal(await smsStatus('one'), null);
  assert.deepEqual(logs, []);
});

test('refresh selects recent nonfinal records, throttles, runs in parallel and caps at ten', async (t) => {
  const now = Date.now();
  const ticket = (id, patch = {}) => ({ callSms: { id, at: now - 10000, checkedAt: now - 9000, state: 'Sent', ...patch } });
  const excluded = [{}, ...['Delivered', 'Failed', 'Skipped'].map((state) => ticket(state, { state })),
    ticket('old', { at: now - 3600001 }), ticket('future', { at: now + 1 }),
    ticket('fresh', { checkedAt: now - 8000 }), ticket('no-id', { id: undefined })];
  const before = JSON.stringify(excluded);
  const included = Array.from({ length: 12 }, (_, i) => ticket(`message_${i}`, { state: ['Pending', 'Processed', 'Sent'][i % 3], error: 'old_error' }));
  const state = { date: Q.today(), tickets: [...excluded, ...included] };
  const pending = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => pending.push(() => resolve(Response.json({ state: 'Delivered' })))));
  const refresh = N.refreshCallSms(state, now);
  assert.equal(pending.length, 10);
  pending.forEach((resolve) => resolve());
  assert.equal(await refresh, true);
  assert.equal(JSON.stringify(excluded), before);
  for (const ticket of included.slice(0, 10)) {
    assert.equal(ticket.callSms.state, 'Delivered');
    assert.equal(ticket.callSms.checkedAt, now);
    assert.equal(ticket.callSms.error, undefined);
  }
  assert.equal(included[10].callSms.checkedAt, now - 9000);
  assert.equal(await N.refreshCallSms({ ...state, date: '2000-01-01' }, now), false);
});

test('refresh failures change only checkedAt and suppress immediate retry', async (t) => {
  const now = Date.now();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error(pass); });
  const sms = { id: 'one', state: 'Sent', error: 'retained', at: now - 10000, checkedAt: now - 9000 };
  const state = { date: Q.today(), tickets: [{ callSms: sms }] };
  assert.equal(await N.refreshCallSms(state, now), true);
  assert.deepEqual(sms, { id: 'one', state: 'Sent', error: 'retained', at: now - 10000, checkedAt: now });
  assert.equal(await N.refreshCallSms(state, now + 100), false);
  assert.equal(calls, 1);
});

test('Recall replaces SMS metadata; public and customer tickets omit it', async (t) => {
  const ticket = { name: 'Private Customer', phone, model: 'J5', number: 'J5-001', callSms: { id: 'old', error: 'old' } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'new', state: 'Pending' }));
  await N.yourTurn(ticket);
  assert.equal(ticket.callSms.id, 'new');
  assert.equal(ticket.callSms.error, undefined);
  assert.ok(ticket.callSms.at <= ticket.callSms.checkedAt);
  const first = ticket.callSms;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error(pass); });
  await N.yourTurn(ticket);
  assert.notEqual(ticket.callSms, first);
  assert.equal(ticket.callSms.state, 'Failed');
  assert.equal(ticket.callSms.id, undefined);
  const visible = Q.publicState({ ...Q.emptyState(), tickets: [ticket] }).tickets[0];
  for (const key of ['callSms', 'phone', 'email', 'id']) assert.equal(key in visible, false);
  assert.equal('callSms' in Q.customerTicket(ticket), false);
});

test('call/recall uses exact approved wording and normalizes customer names', async (t) => {
  const texts = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    texts.push(JSON.parse(options.body).textMessage.text);
    return new Response('{}', { status: 202 });
  });
  for (const [name, greeting] of [
    ['Juan Dela Cruz', 'Good day, Juan Dela Cruz!'],
    ['', 'Good day!'],
    [' \t\n ', 'Good day!'],
    [undefined, 'Good day!'],
    ['  Juan\t Dela\n  Cruz  ', 'Good day, Juan Dela Cruz!'],
    [`  ${'A'.repeat(30)}\t\n${'B'.repeat(40)}  `, `Good day, ${'A'.repeat(30)} ${'B'.repeat(29)}!`],
  ]) {
    await N.yourTurn({ number: 'J5EV-001', name, phone });
    assert.equal(texts.at(-1), approvedCallMessage(greeting));
  }
  assert.equal(texts.length, 6);
});

test('Netlify awaits welcome, Call, Recall, call-next and notifyNext before responding, including failed SMS', async (t) => {
  // Execute the actual adapter with in-memory Blobs and controlled notification promises.
  const apiPath = path.resolve(__dirname, '../netlify/functions/api.mjs');
  const source = fs.readFileSync(apiPath, 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const require = createRequire(import.meta.url);', '')
    .replace('export const config', 'const config')
    .replace('export default async', 'globalThis.handler = async');
  let state;
  let pending;
  let expected;
  const calls = [];
  const notifications = { ...N };
  for (const name of ['welcome', 'yourTurn', 'notifyNext']) {
    notifications[name] = () => {
      calls.push(name);
      return name === expected ? new Promise((resolve) => { pending = resolve; }) : Promise.resolve(false);
    };
  }
  const nativeRequire = createRequire(apiPath);
  const context = vm.createContext({
    process: { env: { STAFF_PIN: '1234' } }, URL, Response, Blob, Buffer,
    require: (id) => id === '../../lib/notify.js' ? notifications : nativeRequire(id),
    getStore: () => ({ get: async (key) => key === Q.today() ? state : null,
      setJSON: async (key, value) => { state = value; }, set: async () => {} }),
  });
  vm.runInContext(source, context);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
  const registration = { model: 'J5', name: 'Private Customer', gender: 'female', phone: '09171234567',
    email: 'test@example.test', municipality: 'Makati', customerType: 'walk_in', dealer: 'OJ Makati',
    salesExecutive: 'Sales Person', testDriveResource: 'event', consent: true,
    licensePhoto: png, licensePhotoBack: png, signature: png };
  let scenario = 0;
  for (const [route, name, status, body] of [
    ['/api/tickets', 'welcome', 201, registration],
    ['/api/staff/tickets/one/call', 'yourTurn', 200],
    ['/api/staff/tickets/one/call', 'yourTurn', 200],
    ['/api/staff/next/J5', 'yourTurn', 200],
    ['/api/staff/tickets/one/call', 'notifyNext', 200],
    ['/api/tickets/one/cancel', 'notifyNext', 200],
  ]) {
    state = Q.emptyState();
    state.tickets = [{ id: 'one', model: 'J5', status: scenario++ === 2 ? 'called' : 'waiting', createdAt: 1 }];
    expected = name;
    pending = null;
    let settled = false;
    const responsePromise = context.handler(new Request('https://queue.test' + route, {
      method: 'POST', headers: { 'x-staff-pin': '1234' }, body: JSON.stringify(body || {}),
    })).then((response) => { settled = true; return response; });
    await new Promise(setImmediate);
    assert.equal(typeof pending, 'function', route);
    assert.equal(settled, false, `${route} must wait for ${name}`);
    pending(name === 'notifyNext' ? false : { ok: false, status: 401 });
    assert.equal((await responsePromise).status, status, 'SMS failure must not fail the request');
  }
});

test('both adapters persist Call, Recall, call-next and staff delivery refresh; public endpoints stay private', async (t) => {
  for (const backend of ['server.js', 'netlify/functions/api.mjs']) {
    const entry = path.resolve(__dirname, '..', backend);
    const nativeRequire = createRequire(entry);
    let stored = { ...Q.emptyState(), tickets: [{ id: 'one', name: 'Private Customer', phone, model: 'J5', number: 'J5-001', status: 'waiting', createdAt: Date.now() }] };
    let writes = 0;
    let handler;
    const persist = (value) => { stored = structuredClone(value); writes++; };
    let source = fs.readFileSync(entry, 'utf8');
    let context;
    if (backend === 'server.js') {
      context = vm.createContext({ __dirname: path.dirname(entry), URL, Buffer, console,
        process: { env: { STAFF_PIN: '1234' } },
        require: (id) => id === 'http' ? { createServer: (fn) => { handler = fn; return { listen() {} }; } }
          : id === 'fs' ? { readFileSync: () => JSON.stringify(stored), mkdirSync() {}, writeFileSync: (file, value) => persist(JSON.parse(value)) }
          : nativeRequire(id),
      });
    } else {
      source = source.replace(/^import .*;\r?\n/gm, '')
        .replace('const require = createRequire(import.meta.url);', '')
        .replace('export const config', 'const config')
        .replace('export default async', 'globalThis.handler = async');
      context = vm.createContext({ URL, Response, Blob, Buffer, process: { env: { STAFF_PIN: '1234' } }, require: nativeRequire,
        getStore: () => ({ get: async () => structuredClone(stored), setJSON: async (key, value) => persist(value) }),
      });
    }
    vm.runInContext(source, context);
    async function request(url, method = 'GET', pin = '1234') {
      if (backend !== 'server.js') return context.handler(new Request('https://queue.test' + url, { method, headers: { 'x-staff-pin': pin } }));
      let status;
      let body;
      await handler({ url, method, headers: { 'x-staff-pin': pin } }, {
        writeHead(code) { status = code; }, end(value) { body = value; },
      });
      return new Response(body, { status });
    }
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => Response.json(options.method === 'GET'
      ? { state: 'Delivered' } : { id: `send_${++sends}`, state: 'Sent' }));
    for (const route of ['/api/staff/next/J5', '/api/staff/tickets/one/call']) {
      const response = await request(route, 'POST');
      assert.equal(response.status, 200, backend);
      await new Promise(setImmediate); // Local sends finish and save after responding.
      assert.equal(stored.tickets[0].callSms.state, 'Sent', backend);
      assert.equal(stored.tickets[0].callSms.id, `send_${sends}`);
    }
    // Both adapters must read the same eligible persisted record.
    if (backend === 'server.js') vm.runInContext('state.tickets[0].callSms.checkedAt -= 9000;', context);
    else stored.tickets[0].callSms.checkedAt -= 9000;
    const before = writes;
    assert.equal((await request('/api/staff/tickets', 'GET', 'wrong')).status, 401);
    assert.equal(writes, before);
    const staff = await (await request('/api/staff/tickets')).json();
    assert.equal(staff.tickets[0].callSms.state, 'Delivered');
    assert.equal(stored.tickets[0].callSms.state, 'Delivered');
    assert.equal(writes, before + 1, 'one save for refresh');
    await request('/api/staff/tickets');
    assert.equal(writes, before + 1, 'final states need no save');
    assert.equal('callSms' in (await (await request('/api/state')).json()).tickets[0], false);
    assert.equal('callSms' in (await (await request('/api/tickets/one')).json()).ticket, false);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error(pass); });
    assert.equal((await request('/api/staff/tickets/one/call', 'POST')).status, 200);
    await new Promise(setImmediate);
    assert.equal(stored.tickets[0].callSms.state, 'Failed');
  }
});
