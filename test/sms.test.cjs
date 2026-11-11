const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sendSms, provider } = require('../lib/sms');
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
        assert.deepEqual(JSON.parse(options.body), { textMessage: { text: 'Ticket J5-001' }, phoneNumbers: [phone] });
        assert.ok(options.signal instanceof AbortSignal);
        return new Response(status === 204 ? null : '{"id":"mock-id","state":"Pending"}', { status });
      });
      const result = await sendSms('09171234567', 'Ticket J5-001');
      assert.equal(called, true);
      assert.equal(result.ok, true);
      assert.equal(result.status, status);
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
      const expected = { textMessage: { text: 'Ticket J5-001' }, phoneNumbers: [phone] };
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
  assert.deepEqual(await sendSms(phone, sensitive), { ok: false, error: 'request failed' });
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
  assert.deepEqual(await sendSms(phone, 'Ticket J5-001'), { ok: false, error: 'timeout' });
  assert.match(logs[0], /ERROR timeout/);
  assertPrivateLogs();
});

test('explicit SMSGate without credentials fails safely; none skips without message text', async () => {
  process.env.SMS_PROVIDER = 'smsgate';
  delete process.env.SMSGATE_PASSWORD;
  assert.deepEqual(await sendSms(phone, 'Private Customer'), { ok: false, error: 'missing credentials' });
  process.env.SMS_PROVIDER = 'none';
  assert.deepEqual(await sendSms(phone, 'Private Customer'), { skipped: true });
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
