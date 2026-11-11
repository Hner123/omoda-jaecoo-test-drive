const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('port 3100 local HTTP smoke: complete registration, private documents, announcements and privacy', async () => {
  // server.js resolves data relative to __dirname. Isolate it from the live port-3000 data.
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-announce-server-'));
  let child;
  try {
    fs.copyFileSync(path.join(root, 'server.js'), path.join(temp, 'server.js'));
    fs.cpSync(path.join(root, 'lib'), path.join(temp, 'lib'), { recursive: true });
    const env = { ...process.env, PORT: '3100', STAFF_PIN: '1234', SMS_PROVIDER: 'none' };
    delete env.ELEVENLABS_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.TTS_PROVIDER;
    child = spawn(process.execPath, ['server.js'], { cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
      child.stdout.on('data', (data) => {
        output += data;
        if (output.includes('Lobby display')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (data) => { output += data; });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)); });
    });
    async function request(url, options) {
      return fetch(`http://localhost:3100${url}`, { ...options, signal: AbortSignal.timeout(5000) });
    }
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
    const registration = {
      model: 'J5', name: 'Dealer Guest', gender: 'male', phone: '09170000003', email: 'dealer@example.test',
      municipality: 'Makati', customerType: 'dealer', dealer: 'OJ Makati', salesExecutive: '  Sales Person  ', testDriveResource: 'mall_display',
      consent: true, licenseNumber: 'TEST-456', licenseExpiry: '2099-12-31', licensePhoto: png, licensePhotoBack: png, signature: png,
    };
    async function post(body) {
      return request('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    async function register(model, phone) {
      const response = await post({ ...registration, model, phone, name: 'Juan PrivateSurname', customerType: 'walk_in' });
      assert.equal(response.status, 201);
      return (await response.json()).ticket;
    }
    const publicState = await (await request('/api/state')).json();
    assert.deepEqual(publicState.dealers, require('../lib/queue').DEALERS);
    assert.equal(publicState.dealers.length, 14);
    assert.deepEqual(publicState.testDriveResources, require('../lib/queue').TEST_DRIVE_RESOURCES);
    console.log(`GET /api/state -> 200; ${publicState.dealers.length} dealerships`);
    for (const [patch, error] of [
      [{ licensePhoto: undefined }, 'Please add a photo of the front of your license'],
      [{ licensePhotoBack: undefined }, 'Please add a photo of the back of your license'],
      [{ signature: undefined }, 'Please add your signature'],
      [{ signature: 'data:image/jpeg;base64,AAAA' }, 'Please add your signature'],
      [{ signature: 'data:image/png;base64,AAAA' }, 'Please add a valid PNG signature'],
      [{ dealer: '' }, 'Please select a location/dealer'],
      [{ dealer: 'Unlisted', guestMatched: true }, 'Please select a listed location/dealer'],
      [{ consent: false }, 'Please agree to the data privacy consent'],
      [{ licenseNumber: undefined, licenseExpiry: '2000-01-01' }, 'This license expired on 2000/01/01. A valid license is required to test drive.'],
    ]) {
      const response = await post({ ...registration, ...patch });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, error);
      console.log(`POST /api/tickets -> 400 ${error}`);
    }
    const optional = await post({ ...registration, phone: '09170000005', licenseNumber: undefined, licenseExpiry: undefined });
    assert.equal(optional.status, 201);
    const optionalTicket = (await optional.json()).ticket;
    assert.equal(optionalTicket.licenseNumber, null);
    assert.equal(optionalTicket.licenseExpiry, null);
    assert.equal(optionalTicket.hasLicensePhoto, true);
    assert.equal(optionalTicket.hasLicensePhotoBack, true);
    assert.equal(optionalTicket.hasSignature, true);
    const storedOptional = JSON.parse(fs.readFileSync(path.join(temp, 'data/queue.json'), 'utf8')).tickets.find((t) => t.id === optionalTicket.id);
    assert.equal(storedOptional.licenseNumber, null);
    assert.equal(storedOptional.licenseExpiry, null);
    console.log('POST /api/tickets without license number/expiry, with front/back/signature -> 201 (stored null)');
    const full = await post({ ...registration, dealer: '  OJ MAKATI  ' });
    assert.equal(full.status, 201);
    const fullTicket = (await full.json()).ticket;
    assert.equal(fullTicket.licenseNumber, 'TEST-456');
    assert.equal(fullTicket.licenseExpiry, '2099-12-31');
    assert.equal(fullTicket.dealer, 'OJ Makati');
    assert.equal(fullTicket.gender, 'male');
    assert.equal(fullTicket.salesExecutive, 'Sales Person');
    assert.equal(fullTicket.testDriveResource, 'mall_display');
    assert.ok(fullTicket.consentAt);
    assert.equal(fullTicket.hasLicensePhoto, true);
    assert.equal(fullTicket.hasLicensePhotoBack, true);
    assert.equal(fullTicket.hasSignature, true);
    console.log('POST /api/tickets full registration -> 201');
    const expectedBytes = Buffer.from(png.split(',')[1], 'base64');
    for (const side of ['front', 'back', 'signature']) {
      for (const pin of [undefined, 'wrong']) {
        const res = await request(`/api/staff/license/${fullTicket.id}?side=${side}`, { headers: pin ? { 'x-staff-pin': pin } : {} });
        assert.equal(res.status, 401);
        await res.arrayBuffer();
      }
      const res = await request(`/api/staff/license/${fullTicket.id}?side=${side}`, { headers: { 'x-staff-pin': '1234' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), expectedBytes);
      const suffix = side === 'front' ? '' : `-${side}`;
      assert.deepEqual(fs.readFileSync(path.join(temp, 'data/licenses', `${fullTicket.id}${suffix}.png`)), expectedBytes);
      console.log(`GET staff document side=${side} -> 200 with PIN; 401 without/wrong PIN`);
    }
    const legacyFront = await request(`/api/staff/license/${fullTicket.id}`, { headers: { 'x-staff-pin': '1234' } });
    assert.equal(legacyFront.status, 200);
    assert.deepEqual(Buffer.from(await legacyFront.arrayBuffer()), expectedBytes);
    for (const side of ['', 'BACK', '../queue', 'signature.png']) {
      const res = await request(`/api/staff/license/${fullTicket.id}?side=${encodeURIComponent(side)}`, { headers: { 'x-staff-pin': '1234' } });
      assert.equal(res.status, 400);
      await res.arrayBuffer();
    }
    const upload = await request('/api/staff/guests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-staff-pin': '1234' },
      body: JSON.stringify({ csv: 'Name,Mobile,E-mail,Dealer\nGuest,09170000004,guest@example.test,Unlisted Guest Branch\n' }) });
    assert.equal(upload.status, 200);
    await upload.arrayBuffer();
    const guest = await post({ ...registration, phone: '09170000004', email: 'guest@example.test', customerType: 'walk_in', dealer: 'forged value' });
    assert.equal(guest.status, 201);
    const guestTicket = (await guest.json()).ticket;
    assert.equal(guestTicket.guestMatched, true);
    assert.equal(guestTicket.customerType, 'dealer');
    assert.equal(guestTicket.dealer, 'Unlisted Guest Branch');
    const staff = await request('/api/staff/tickets', { headers: { 'x-staff-pin': '1234' } });
    const staffTicket = (await staff.json()).tickets.find((t) => t.id === fullTicket.id);
    assert.deepEqual(staffTicket, fullTicket);
    const date = require('../lib/queue').today();
    const report = await (await request(`/api/staff/report/${date}`, { headers: { 'x-staff-pin': '1234' } })).json();
    assert.equal(report.tickets.find((t) => t.id === fullTicket.id).salesExecutive, 'Sales Person');
    assert.equal(report.testDriveResources.mall_display, 'Mall Display');
    const calledTicket = await register('J5EV', '09170000001');
    const waitingTicket = await register('J5EV', '09170000002');
    const call = await request('/api/staff/next/J5EV', { method: 'POST', headers: { 'x-staff-pin': '1234' } });
    assert.equal(call.status, 200);
    await call.arrayBuffer();
    const start = performance.now();
    const disabled = await request(`/api/announce?number=${calledTicket.number}&text=NEVER-SPEAK-THIS`);
    assert.equal(disabled.status, 503);
    assert.deepEqual(await disabled.json(), { error: 'Voice not configured' });
    assert.ok(performance.now() - start < 1000, 'missing key should respond without an external request');
    for (const [number, status, error] of [
      [waitingTicket.number, 404, 'Called ticket not found'],
      ['J5EV-999', 404, 'Called ticket not found'],
      ['malformed', 400, 'Invalid ticket number'],
    ]) {
      const response = await request(`/api/announce?number=${number}`);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
      console.log(`GET /api/announce?number=${number} -> ${status} ${error}`);
    }
    console.log(`GET /api/announce?number=${calledTicket.number} -> 503 Voice not configured (under 1 s)`);
    const state = await (await request('/api/state')).json();
    for (const ticket of state.tickets) {
      assert.equal(ticket.name, ticket.model === 'J5' ? 'Dealer' : 'Juan');
      for (const field of ['id', 'phone', 'email', 'licenseNumber', 'licenseExpiry', 'hasLicensePhoto', 'gender', 'dealer', 'salesExecutive', 'testDriveResource', 'consentAt', 'signature', 'licensePhoto', 'licensePhotoBack', 'hasSignature', 'hasLicensePhotoBack']) assert.ok(!(field in ticket));
    }
    assert.ok(fs.existsSync(path.join(temp, 'data/queue.json')));
    assert.doesNotMatch(output, /data:image|iVBORw0KGgo/);
    assert.doesNotMatch(fs.readFileSync(path.join(temp, 'data/queue.json'), 'utf8'), /data:image|iVBORw0KGgo/);
  } finally {
    if (child && child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    // Verify the recursive deletion stays inside the exact temporary test workspace.
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('queue-announce-server-'));
    fs.rmSync(temp, { recursive: true, force: true });
    assert.equal(fs.existsSync(temp), false);
    console.log('Port 3100 server stopped; isolated data removed; port 3000 untouched.');
  }
});
