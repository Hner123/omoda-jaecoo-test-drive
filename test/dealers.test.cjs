const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Q = require('../lib/queue');

test('DEALERS contains the 14 exact location/dealer choices in client order', () => {
  assert.deepEqual(Q.DEALERS, [
    'OJ Libis', 'OJ Commonwealth', 'OJ Quezon Ave.', 'OJ Shaw', 'OJ Greenhills',
    'OJ Alabang', 'OJ Pasig', 'OJ Makati', 'OJ North EDSA', 'OJ Otis',
    'OJ Fairview', 'OJ Manila Bay', 'OJ Paranaque', 'OJ Abad Santos',
  ]);
});

test('renamed models retain ids, ticket prefixes and images', () => {
  assert.deepEqual(Q.MODELS.slice(0, 2).map(({ id, name, prefix, image, showcase }) => ({ id, name, prefix, image, showcase })), [
    { id: 'J5', name: 'JAECOO J5 HEV', prefix: 'J5-', image: '/img/j5.png', showcase: '/img/show-j5.png' },
    { id: 'J5EV', name: 'JAECOO J5 BEV', prefix: 'J5EV-', image: '/img/j5ev.png', showcase: '/img/show-j5ev.png' },
  ]);
});

const registration = {
  model: 'J5', name: 'Test Customer', gender: 'female', phone: '09170000000', email: 'test@example.test',
  municipality: 'Makati', customerType: 'dealer', dealer: 'OJ Makati', salesExecutive: 'Sales Person',
  testDriveResource: 'event', consent: true, licenseNumber: 'TEST-123', licenseExpiry: '2099-12-31',
  hasLicensePhoto: true, hasLicensePhotoBack: true, hasSignature: true,
};

test('public state exposes labels but only allowlisted ticket fields', () => {
  const state = Q.emptyState();
  Q.createTicket(state, { ...registration, signature: 'private image', licensePhotoBack: 'private image' });
  const result = Q.publicState(state);
  assert.deepEqual(result.dealers, Q.DEALERS);
  assert.deepEqual(result.customerTypes, Q.CUSTOMER_TYPES);
  assert.deepEqual(result.testDriveResources, { showroom: 'Showroom', mall_display: 'Mall Display', bank_display: 'Bank Display', event: 'Event' });
  assert.equal(result.models.length, Q.MODELS.length);
  assert.equal(result.tickets[0].name, 'Test');
  assert.deepEqual(Object.keys(result.tickets[0]).sort(), ['number', 'model', 'name', 'status', 'createdAt', 'calledAt', 'callCount', 'startedAt', 'finishedAt'].sort());
  const report = Q.mergeDay(state.date, [state]);
  assert.deepEqual(report.testDriveResources, Q.TEST_DRIVE_RESOURCES);
  assert.equal(report.tickets[0].gender, 'female');
  assert.equal(report.tickets[0].hasSignature, true);
  assert.ok(report.tickets[0].consentAt > 0);
});

test('every customer type requires a listed dealer and stores canonical spelling', () => {
  for (const customerType of Object.keys(Q.CUSTOMER_TYPES)) {
    const ticket = Q.createTicket(Q.emptyState(), { ...registration, customerType, dealer: '  oJ mAkAtI  ' });
    assert.equal(ticket.dealer, 'OJ Makati');
    for (const dealer of ['', '   ', 'Unlisted branch', '__other', 'OJ Sta. Rosa']) {
      assert.throws(() => Q.createTicket(Q.emptyState(), { ...registration, customerType, dealer }), { status: 400 });
    }
  }
  for (const dealer of ['Unlisted branch', '  Custom dealer  ', 'x'.repeat(90)]) {
    const ticket = Q.createTicket(Q.emptyState(), { ...registration, dealer, guestMatched: true });
    assert.equal(ticket.dealer, dealer.trim().slice(0, 80));
  }
});

test('gender, sales executive, resource and privacy consent are validated', () => {
  for (const [field, values] of [
    ['gender', [undefined, '', 'Male', 'other']],
    ['salesExecutive', [undefined, '', '   ', 'x'.repeat(61)]],
    ['testDriveResource', [undefined, '', 'Mall Display', 'invalid', 'toString']],
    ['consent', [undefined, false, 'true', 1]],
  ]) {
    for (const value of values) {
      const state = Q.emptyState();
      assert.throws(() => Q.createTicket(state, { ...registration, [field]: value }), { status: 400 }, `${field}=${value}`);
      assert.equal(state.tickets.length, 0);
      assert.deepEqual(state.counters, {});
    }
  }
  for (const gender of ['male', 'female']) for (const testDriveResource of Object.keys(Q.TEST_DRIVE_RESOURCES)) {
    const ticket = Q.createTicket(Q.emptyState(), { ...registration, gender, testDriveResource, salesExecutive: '  Sales Person  ' });
    assert.equal(ticket.salesExecutive, 'Sales Person');
    assert.equal(ticket.gender, gender);
    assert.equal(ticket.testDriveResource, testDriveResource);
  }
});

// Exercise the kiosk's actual dealer functions without GUI tools or new dependencies.
function kiosk() {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const source = html.slice(html.indexOf('    function renderDealers()'), html.indexOf('    async function checkInvite()'));
  const nodes = new Map();
  function node() {
    return { value: '', disabled: false, hidden: false, required: false, dataset: {},
      handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } };
  }
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const select = $('#dealer');
  select.temporary = [];
  select.querySelectorAll = () => select.temporary.slice();
  select.append = (option) => {
    select.temporary.push(option);
    option.remove = () => select.temporary.splice(select.temporary.indexOf(option), 1);
  };
  const context = vm.createContext({ $, document: { createElement: node }, validate() {},
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    dealers: Q.DEALERS, dealerSignature: null,
  });
  vm.runInContext(source, context);
  context.renderDealers();
  return { $, select, context };
}

test('kiosk renders a flat list without Other, always requires dealer, and retains selection across polls', () => {
  const { $, select, context } = kiosk();
  assert.doesNotMatch(select.innerHTML, /optgroup|Other dealer|__other/);
  assert.ok(select.innerHTML.indexOf('Select dealership') < select.innerHTML.indexOf('OJ Libis'));
  assert.ok(select.innerHTML.indexOf('OJ Paranaque') < select.innerHTML.indexOf('OJ Abad Santos'));
  select.value = 'OJ Makati';
  context.renderDealers();
  assert.equal(context.dealerValue(), 'OJ Makati');
  $('#customer-type').value = 'walk_in';
  $('#customer-type').handlers.change();
  assert.equal(select.value, 'OJ Makati');
  context.clearDealer();
  assert.equal(select.required, true);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<div id="dealer-wrap">/);
  assert.match(html, /<select id="dealer" required>/);
  assert.doesNotMatch(html, /dealer-other/);
});

test('guest lookup locks canonical or temporary dealer values, and unlocking clears them', () => {
  const { $, select, context } = kiosk();
  context.setInvite('  oj makati  ');
  assert.equal(select.value, 'OJ Makati');
  assert.equal(select.disabled, true);
  assert.equal($('#customer-type').disabled, true);
  assert.equal($('#customer-type').value, 'dealer');
  assert.equal(select.temporary.length, 0);
  assert.equal(context.dealerValue(), 'OJ Makati');
  const unlisted = 'Guest <branch> & dealer';
  context.setInvite(unlisted);
  assert.equal(select.temporary.length, 1);
  assert.equal(select.temporary[0].textContent, unlisted);
  assert.equal(context.dealerValue(), unlisted);
  context.renderDealers();
  assert.equal(context.dealerValue(), unlisted);
  context.setInvite(null);
  assert.equal(select.temporary.length, 0);
  assert.equal(select.disabled, false);
  assert.equal(select.value, '');
  assert.equal(select.required, true);
  assert.equal($('#customer-type').disabled, false);
  assert.equal($('#dealer-wrap').hidden, false);
});
