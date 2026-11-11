const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Q = require('../lib/queue');
const { toE164 } = require('../lib/sms');
const { findGuest } = require('../lib/guests');

const valid = ['09171234567', '0917 123 4567', '0917-123-4567', '+639171234567', '639171234567', '9171234567', '(0917) 123.4567'];
const invalid = ['04846488464', '0281234567', '12345', '091712345', '091712345678', '+14155552671', '',
  'abc09171234567', '0917/123/4567', '++639171234567', '+09171234567', '091712345678901234567'];
const message = 'Please enter a valid mobile number (e.g. 0917 123 4567)';
const registration = {
  model: 'J5', name: 'Customer', gender: 'female', email: 'test@example.test', municipality: 'Makati',
  customerType: 'walk_in', dealer: 'OJ Makati', salesExecutive: 'Sales Person', testDriveResource: 'showroom', consent: true,
};
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const helper = html.slice(html.indexOf('    function isPhMobile('), html.indexOf('    function scanExpiry('));
const submit = html.slice(html.indexOf("    $('#form').addEventListener('submit'"), html.indexOf('    // ---- ticket view'));

test('server and browser accept only the supported Philippine mobile formats', () => {
  const browser = vm.createContext({});
  vm.runInContext(helper, browser);
  for (const [numbers, expected] of [[valid, true], [invalid, false]]) {
    for (const phone of numbers) {
      assert.equal(Q.isPhMobile(phone), expected, phone);
      assert.equal(browser.isPhMobile(phone), expected, phone);
    }
  }
});

test('createTicket rejects invalid raw phones before sanitization and leaves state intact', () => {
  const state = Q.emptyState();
  const before = structuredClone(state);
  for (const phone of invalid) {
    assert.throws(() => Q.createTicket(state, { ...registration, phone }), { status: 400, message }, phone);
    assert.deepEqual(state, before);
  }
});

test('valid phones retain storage, allow repeat registrations, match guests and send as +63', () => {
  const guest = { phone: '9171234567', dealer: 'OJ Makati' };
  for (const phone of valid) {
    const state = Q.emptyState();
    const ticket = Q.createTicket(state, { ...registration, phone });
    assert.equal(ticket.phone, phone.replace(/[^\d+]/g, '').slice(0, 16));
    const secondTicket = Q.createTicket(state, { ...registration, phone });
    assert.notEqual(secondTicket.number, ticket.number);
    assert.equal(secondTicket.phone, ticket.phone);
    assert.equal(state.tickets.length, 2);
    assert.equal(findGuest({ guests: [guest] }, { phone: ticket.phone }), guest);
    assert.equal(toE164(ticket.phone), '+639171234567');
  }
});

test('registration displays the mobile error and makes no API call for invalid phones', async () => {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', addEventListener(event, fn) { this[event] = fn; } });
    return nodes.get(id);
  };
  let validated = 0;
  const context = vm.createContext({ $, validate() { validated++; $('#submit').disabled = false; },
    api() { assert.fail('invalid phones must not reach the API'); } });
  vm.runInContext(helper + submit, context);
  for (const phone of invalid) {
    $('#phone').value = phone;
    await $('#form').submit({ preventDefault() {} });
    assert.equal($('#err').textContent, message);
    assert.equal($('#submit').disabled, false);
  }
  assert.equal(validated, invalid.length);
  assert.match(html, /id="phone"[^>]*inputmode="tel"/);
  assert.match(html, /id="phone"[^>]*placeholder="09XX XXX XXXX"/);
});
