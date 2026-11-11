const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const Q = require('../lib/queue');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
const registration = {
  model: 'J5EV', name: 'Private Customer', gender: 'female', phone: '09170000000', email: 'test@example.test',
  municipality: 'Makati', customerType: 'walk_in', dealer: 'oj makati', salesExecutive: 'Sales Person',
  testDriveResource: 'bank_display', consent: true, licenseNumber: 'TEST-123', licenseExpiry: '2099-12-31',
  licensePhoto: png, licensePhotoBack: png, signature: png,
};

test('signature validation rejects non-PNG, malformed and oversized images', () => {
  const images = Q.registrationImages(registration);
  assert.equal(images.signature.type, 'image/png');
  const huge = Buffer.alloc(300 * 1024);
  Buffer.from(png.split(',')[1], 'base64').copy(huge);
  for (const [signature, status] of [
    [null, 400], ['data:image/jpeg;base64,AAAA', 400], ['data:image/png;base64,AAAA', 400],
    ['data:image/png;base64,!!!!', 400], [`data:image/png;base64,${huge.toString('base64')}`, 413],
  ]) assert.throws(() => Q.registrationImages({ ...registration, signature }), { status });
});

test('real Netlify adapter validates registration and stores/serves all three private documents through Blobs SDK', async (t) => {
  const envNames = ['NETLIFY_BLOBS_CONTEXT', 'STAFF_PIN', 'SMS_PROVIDER'];
  const original = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of envNames) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
    siteID: 'registration-site', token: 'test-only', edgeURL: 'https://blobs.test', uncachedEdgeURL: 'https://blobs.test',
  })).toString('base64');
  process.env.STAFF_PIN = '1234';
  process.env.SMS_PROVIDER = 'none';
  const blobs = new Map();
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'blobs.test', 'no external SMS, vision or other network calls');
    assert.match(url.pathname, /^\/registration-site\/site:(queue|licenses)\//);
    if (options.method === 'put') {
      const bytes = Buffer.from(await new Response(options.body).arrayBuffer());
      blobs.set(url.pathname, { bytes, metadata: options.headers['x-amz-meta-user'] });
      return new Response('');
    }
    const stored = blobs.get(url.pathname);
    return stored ? new Response(stored.bytes, { headers: stored.metadata ? { 'netlify-blobs-metadata': stored.metadata } : {} }) : new Response(null, { status: 404 });
  });
  const { default: handler } = await import(pathToFileURL(path.join(__dirname, '../netlify/functions/api.mjs')).href);
  const request = (route, options = {}) => handler(new Request('https://queue.test' + route, options));
  const post = (body) => request('/api/tickets', { method: 'POST', body: JSON.stringify(body) });
  for (const [field, error] of [
    ['licensePhoto', 'Please add a photo of the front of your license'],
    ['licensePhotoBack', 'Please add a photo of the back of your license'], ['signature', 'Please add your signature'],
  ]) {
    const res = await post({ ...registration, [field]: undefined });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, error);
    assert.equal(blobs.size, 0);
  }
  const landline = await post({ ...registration, phone: '04846488464' });
  assert.equal(landline.status, 400);
  assert.equal((await landline.json()).error, 'Please enter a valid mobile number (e.g. 0917 123 4567)');
  assert.equal(blobs.size, 0);
  const forged = await post({ ...registration, dealer: 'Unlisted branch', guestMatched: true });
  assert.equal(forged.status, 400);
  const res = await post(registration);
  assert.equal(res.status, 201);
  const { ticket } = await res.json();
  assert.equal(ticket.number, 'J5EV-001');
  assert.equal(ticket.dealer, 'OJ Makati');
  assert.equal(ticket.gender, 'female');
  assert.equal(ticket.salesExecutive, 'Sales Person');
  assert.equal(ticket.testDriveResource, 'bank_display');
  assert.ok(ticket.consentAt);
  const expected = Buffer.from(png.split(',')[1], 'base64');
  for (const side of ['front', 'back', 'signature']) {
    const suffix = side === 'front' ? '' : `-${side}`;
    const blob = blobs.get(`/registration-site/site:licenses/${ticket.id}${suffix}`);
    assert.ok(blob);
    assert.deepEqual(blob.bytes, expected);
    assert.equal(JSON.parse(Buffer.from(blob.metadata.slice(4), 'base64')).type, 'image/png');
    const route = `/api/staff/license/${ticket.id}?side=${side}`;
    for (const pin of ['', 'wrong']) assert.equal((await request(route, { headers: { 'x-staff-pin': pin } })).status, 401);
    const doc = await request(route, { headers: { 'x-staff-pin': '1234' } });
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get('content-type'), 'image/png');
    assert.equal(doc.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await doc.arrayBuffer()), expected);
  }
  assert.equal((await request(`/api/staff/license/${ticket.id}?side=../queue`, { headers: { 'x-staff-pin': '1234' } })).status, 400);
  assert.equal((await request(`/api/staff/license/${ticket.id}`, { headers: { 'x-staff-pin': '1234' } })).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.tickets[0].name, 'Private');
  assert.deepEqual(Object.keys(state.tickets[0]).sort(), ['number', 'model', 'name', 'status', 'createdAt'].sort());
  const staff = await (await request('/api/staff/tickets', { headers: { 'x-staff-pin': '1234' } })).json();
  assert.deepEqual(staff.tickets[0], ticket);
  const queue = JSON.parse(blobs.get(`/registration-site/site:queue/${Q.today()}`).bytes);
  assert.equal(queue.tickets[0].hasSignature, true);
  assert.equal(queue.tickets[0].hasLicensePhotoBack, true);
  assert.doesNotMatch(JSON.stringify(queue), /data:image|iVBORw0KGgo/);
});

test('staff CSV and Excel report use new fields, labels and summary groups, including older tickets', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/staff.html'), 'utf8');
  const source = html.slice(html.indexOf('    function driveStatus('), html.indexOf('    async function loadReportDays('));
  const csv = html.slice(html.indexOf('    function registrationCsv('), html.indexOf("    $('#report-csv').onclick"));
  const context = vm.createContext({
    genderLabel: (gender) => gender === 'male' ? 'Male' : gender === 'female' ? 'Female' : '',
    cardDate: (value) => value || '',
    XLSX: { utils: {
      book_new: () => ({}), aoa_to_sheet: (rows) => ({ rows }), encode_range: () => 'A1:Z3',
      book_append_sheet: (book, sheet, name) => { book[name] = sheet; },
    } },
  });
  vm.runInContext(source + csv, context);
  const state = Q.emptyState();
  const ticket = Q.createTicket(state, { ...registration, hasLicensePhoto: true, hasLicensePhotoBack: true, hasSignature: true });
  ticket.callSms = { state: 'Delivered' };
  const data = Q.mergeDay(state.date, [state]);
  data.tickets.push({ name: 'Old Customer', number: 'OLD-001', model: 'old-model', createdAt: ticket.createdAt, status: 'waiting' });
  const book = context.buildReportWorkbook(data);
  const [header, row, old] = book.Registrations.rows;
  const value = (label, values = row) => values[header.indexOf(label)];
  assert.equal(value('Call SMS status'), 'Delivered');
  assert.equal(value('Call SMS status', old), '');
  assert.equal(value('License No.'), 'TEST-123');
  assert.equal(value('License Expiry'), '2099-12-31');
  assert.equal(value('License No.', old), '');
  assert.equal(value('License Expiry', old), '');
  const withoutDetails = { ...ticket, licenseNumber: null, licenseExpiry: null };
  const nullRow = context.registrationRows({ ...data, tickets: [withoutDetails] })[1];
  assert.equal(value('License No.', nullRow), '');
  assert.equal(value('License Expiry', nullRow), '');
  assert.doesNotMatch(context.registrationCsv({ ...data, tickets: [withoutDetails] }), /null|undefined/);
  assert.equal(value('Gender'), 'Female');
  assert.equal(value('Preferred Model'), 'JAECOO J5 BEV');
  assert.equal(value('Location/Dealer'), 'OJ Makati');
  assert.equal(value('Assigned Sales Executive'), 'Sales Person');
  assert.equal(value('Test Drive Resource'), 'Bank Display');
  for (const label of ['Data Privacy Consent', 'Signature on file', 'License Back Photo']) {
    assert.equal(value(label), 'Yes');
    assert.equal(value(label, old), 'No');
  }
  assert.ok(header.every((_, i) => i in row && i in old));
  assert.equal(header.length, row.length);
  assert.equal(header.length, old.length);
  const summary = JSON.stringify(book.Summary.rows);
  assert.match(summary, /By location\/dealer/);
  assert.match(summary, /By test drive resource/);
  assert.match(summary, /Bank Display/);
  const exported = context.registrationCsv(data);
  assert.match(exported, /"Gender"/);
  assert.match(exported, /"Female"/);
  assert.match(exported, /"Bank Display"/);
  assert.doesNotMatch(exported, /Inviting Dealer|bank_display|data:image/);
});

test('signature pad requires strokes, supports touch pointers, retains ink on resize and clears', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const source = html.slice(html.indexOf('    // Keep normalized strokes'), html.indexOf('    function clearRegistration()'));
  const calls = [];
  const handlers = {};
  const ctx = { fillRect: (...args) => calls.push(['white', ...args]), scale: (...args) => calls.push(['scale', ...args]),
    beginPath() {}, moveTo() {}, lineTo: (...args) => calls.push(['line', ...args]), stroke() {} };
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 320, height: 180, left: 0, top: 0 }),
    addEventListener: (name, handler) => { handlers[name] = handler; }, setPointerCapture() {} };
  const clear = {};
  let validations = 0;
  const context = vm.createContext({
    $: (id) => id === '#signature' ? canvas : clear, window: { devicePixelRatio: 2 },
    document: { createElement: () => ({ getContext: () => ctx, toDataURL: () => png }) },
    ResizeObserver: class { observe() {} }, validate: () => { validations++; },
  });
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('signatureHasInk', context), false);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 360);
  const event = (x, y) => ({ pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {} });
  handlers.pointerdown(event(10, 10));
  assert.equal(vm.runInContext('signatureHasInk', context), false, 'a tap alone is not a stroke');
  handlers.pointermove(event(60, 40));
  handlers.pointerup(event(60, 40));
  assert.equal(vm.runInContext('signatureHasInk', context), true);
  assert.equal(context.signatureData(), png);
  context.resizeSignature();
  assert.equal(vm.runInContext('signatureHasInk', context), true);
  assert.ok(calls.some(([type]) => type === 'line'));
  assert.ok(calls.some(([type]) => type === 'white'));
  clear.onclick();
  assert.equal(vm.runInContext('signatureHasInk', context), false);
  assert.equal(vm.runInContext('signatureStrokes.length', context), 0);
  assert.ok(validations >= 2);
});

test('kiosk validation requires each added field and successful-registration reset clears private inputs', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: false, addEventListener() {},
      removeAttribute: (attribute) => { delete $(id)[attribute]; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ $, selected: 'J5', licensePhoto: png, licensePhotoBack: png, signatureHasInk: true,
    registrationVersion: 0, lookupSeq: 0, lookupTimer: 123, clearTimeout() {},
    licenseNumber: null, licenseExpiry: null, todayLocal: () => '2026-11-10', cardDate: (value) => value,
    dealerValue: () => $('#dealer').value,
    setInvite: () => {}, clearDealer: () => { $('#dealer').value = ''; },
  });
  context.clearSignature = () => { context.signatureHasInk = false; };
  const source = html.slice(html.indexOf('    function validate()'), html.indexOf('    // ---- license scan'));
  const reset = html.slice(html.indexOf('    function clearRegistration()'), html.indexOf('    // ---- waiver modal'));
  vm.runInContext(source + reset, context);
  for (const [id, value] of Object.entries({ name: 'Customer', gender: 'male', phone: '09171234567', email: 'test@example.test',
    municipality: 'Makati', 'customer-type': 'walk_in', dealer: 'OJ Makati', 'sales-executive': 'Sales Person',
    'test-drive-resource': 'event' })) $('#' + id).value = value;
  $('#license').checked = $('#consent').checked = true;
  context.validate();
  assert.equal($('#submit').disabled, false);
  for (const [id, message] of [['gender', 'select your gender'], ['dealer', 'select a location/dealer'],
    ['sales-executive', 'enter your assigned sales executive'], ['test-drive-resource', 'select a test drive resource']]) {
    const saved = $('#' + id).value;
    $('#' + id).value = '';
    context.validate();
    assert.equal($('#submit').disabled, true);
    assert.ok($('#missing').textContent.includes(message));
    $('#' + id).value = saved;
  }
  for (const [field, message] of [['licensePhoto', 'front of your license'], ['licensePhotoBack', 'back of your license'], ['signatureHasInk', 'draw your signature']]) {
    const saved = context[field];
    context[field] = null;
    context.validate();
    assert.equal($('#submit').disabled, true);
    assert.ok($('#missing').textContent.includes(message));
    context[field] = saved;
  }
  context.licenseExpiry = '2026-11-09';
  context.validate();
  assert.equal($('#submit').disabled, true);
  assert.match($('#license-warn').textContent, /This license expired on 2026-11-09/);
  context.licenseExpiry = '2026-11-10';
  context.validate();
  assert.equal($('#submit').disabled, false, 'expiry today is allowed');
  context.licenseNumber = 'TEST123';
  $('#consent').checked = false;
  context.validate();
  assert.ok($('#missing').textContent.includes('agree to the data privacy consent'));
  $('#form').reset = () => { for (const node of nodes.values()) { node.value = ''; node.checked = false; } };
  $('#license-img').src = $('#back-img').src = png;
  context.clearRegistration();
  assert.equal(context.selected, null);
  assert.equal(context.licensePhoto, null);
  assert.equal(context.licensePhotoBack, null);
  assert.equal(context.licenseNumber, null);
  assert.equal(context.licenseExpiry, null);
  assert.equal(context.signatureHasInk, false);
  for (const id of ['gender', 'sales-executive', 'test-drive-resource']) assert.equal($('#' + id).value, '');
  assert.equal($('#consent').checked, false);
  assert.equal($('#license').checked, false);
  assert.equal($('#license-preview').hidden, true);
  assert.equal($('#back-preview').hidden, true);
  assert.equal($('#license-img').src, undefined);
  assert.equal($('#back-img').src, undefined);
  assert.equal(context.registrationVersion, 1);
  assert.equal(context.lookupSeq, 1);
  assert.match(html, /I agree that Omoda and Jaecoo Motor Philippines Inc\., its dealers, may use my information to arrange the display and test drive and to contact me about Omoda and Jaecoo products, in line with the Data Privacy Act of 2012\./);
});


test('optional scan metadata is sanitised and stored; expired dates remain rejected', () => {
  for (const patch of [
    { licenseNumber: undefined, licenseExpiry: undefined },
    { licenseNumber: null, licenseExpiry: null },
    { licenseNumber: ' !@ ', licenseExpiry: 'unreadable' },
  ]) {
    const ticket = Q.createTicket(Q.emptyState(), { ...registration, ...patch });
    assert.equal(ticket.licenseNumber, null);
    assert.equal(ticket.licenseExpiry, null);
  }
  const ticket = Q.createTicket(Q.emptyState(), { ...registration, licenseNumber: ' test-123! ' });
  assert.equal(ticket.licenseNumber, 'TEST-123');
  assert.equal(ticket.licenseExpiry, '2099-12-31');
  assert.equal(Q.createTicket(Q.emptyState(), { ...registration, licenseExpiry: Q.today() }).licenseExpiry, Q.today());
  assert.throws(() => Q.createTicket(Q.emptyState(), { ...registration, licenseNumber: null, licenseExpiry: '2000-01-01' }),
    { status: 400, message: 'This license expired on 2000/01/01. A valid license is required to test drive.' });
});

test('staff rows show independent scan values, expired pills and documents with no null placeholders', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/staff.html'), 'utf8');
  const source = html.slice(html.indexOf('    function row('), html.indexOf('    function section('));
  const context = vm.createContext({ queueView: { expanded: new Set() }, state: { date: '2026-11-10' }, ago: () => 'now',
    esc: (value) => String(value), cardDate: (value) => value, genderLabel: () => '' });
  vm.runInContext(source, context);
  const base = { id: 'test', number: 'J5-001', name: 'Customer', phone: '09170000000', status: 'waiting', hasLicensePhoto: true };
  for (const details of [{}, { licenseNumber: null, licenseExpiry: null }, { licenseNumber: 'TEST-123', licenseExpiry: null }]) {
    const row = context.row({ ...base, ...details }, []);
    assert.match(row, /View license/);
    assert.doesNotMatch(row, /Lic\. (null|undefined)|exp (null|undefined)|pill expired/);
    if (details.licenseNumber) assert.match(row, /Lic\. TEST-123/);
    else assert.doesNotMatch(row, /Lic\./);
    assert.doesNotMatch(row, /exp /);
  }
  const expired = context.row({ ...base, licenseNumber: null, licenseExpiry: '2000-01-01' }, []);
  assert.match(expired, /exp 2000-01-01/);
  assert.match(expired, /pill expired/);
  assert.doesNotMatch(expired, /Lic\./);
  for (const [smsState, label] of Object.entries({ Pending: 'SMS sending…', Processed: 'SMS sending…', Sent: 'SMS sent', Delivered: 'SMS delivered ✓', Failed: 'SMS failed', Skipped: 'SMS off' })) {
    for (const status of ['called', 'driving', 'done']) {
      context.STATUS_LABEL = { done: 'Done' };
      const row = context.row({ ...base, status, callSms: { state: smsState, error: 'sim_unavailable' } }, []);
      assert.ok(row.includes(label));
      if (smsState === 'Failed') assert.match(row, /title="sim_unavailable"/);
    }
  }
  assert.doesNotMatch(context.row(base, []), /SMS /);
});

test('kiosk scan retains optional metadata, clears stale values on unreadable retakes and posts stored details', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /license-no|license-exp|expiryIso|please type it below/);
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: true, classList: { add() {}, remove() {} },
      handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } });
    return nodes.get(id);
  };
  let scanResult;
  let posted;
  const context = vm.createContext({ $, licenseNumber: null, licenseExpiry: null, validate() {},
    downsize: async () => {
      assert.equal($('#license-status').textContent, 'Saving photo…');
      assert.equal($('#license-status').className, 'license-status');
      return png;
    }, selected: 'J5', dealerValue: () => 'OJ Makati',
    signatureHasInk: true, signatureData: () => png, clearRegistration() {}, showTicket() {},
    api: async (route, options) => {
      if (route === '/api/tickets') { posted = options.body; return { ticket: { id: 'test' } }; }
      assert.equal($('#license-status').textContent, 'Front photo saved for this registration.');
      assert.equal($('#license-status').className, 'license-status ok');
      if (scanResult instanceof Error) throw scanResult;
      return scanResult;
    },
  });
  const helper = html.slice(html.indexOf('    function isPhMobile('), html.indexOf('    function validate()'));
  const scan = html.slice(html.indexOf('    let licensePhotoBack'), html.indexOf("    $('#back-btn').onclick"));
  const submit = html.slice(html.indexOf("    $('#form').addEventListener('submit'"), html.indexOf('    // ---- ticket view'));
  vm.runInContext(helper + scan + submit, context);
  $('#phone').value = '09171234567';
  const event = () => ({ target: { files: [{}], value: 'photo' } });
  for (const result of [
    { licenseNumber: 'TEST-123', expiry: '2099-12-31', confidence: 'high' },
    {}, new Error('Scan unavailable'), { expiry: 'invalid' }, { expiry: '2000-01-01' },
  ]) {
    scanResult = result;
    await $('#license-photo').handlers.change(event());
    assert.equal(context.licenseNumber, result.licenseNumber || null);
    assert.equal(context.licenseExpiry, result.expiry === 'invalid' ? null : result.expiry || null);
    assert.equal(vm.runInContext('licensePhoto', context), png);
    await $('#form').handlers.submit({ preventDefault() {} });
    assert.equal(posted.licenseNumber, context.licenseNumber);
    assert.equal(posted.licenseExpiry, context.licenseExpiry);
    assert.equal(posted.licensePhoto, png);
    assert.equal($('#license-status').textContent, 'Front photo saved for this registration.');
    assert.equal($('#license-status').className, 'license-status ok');
  }
  context.downsize = async () => { throw new Error('Could not read that image'); };
  const failedPhoto = event();
  await $('#license-photo').handlers.change(failedPhoto);
  assert.equal($('#license-status').textContent, "Couldn't use that photo. Please try again.");
  assert.equal($('#license-status').className, 'license-status warn');
  assert.equal(failedPhoto.target.value, '');
  assert.equal(context.licenseNumber, null);
  assert.equal(context.licenseExpiry, null);
  assert.equal(context.scanExpiry('2099-02-30'), null);
});
