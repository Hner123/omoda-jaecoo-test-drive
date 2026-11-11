const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/ticket-image.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const data = {
  number: 'J7-001', firstName: 'Juan', modelName: 'JAECOO J7 SHS',
  createdAt: '2026-11-11T03:15:00Z', carImage: '/img/j7shs.png',
  phone: '09179998888', email: 'private@example.test', license: 'LICENSE-SECRET',
  licenseNumber: 'LICENSE-NUMBER-SECRET', id: 'CANCEL-SECRET',
  url: 'https://queue.test/?t=CANCEL-SECRET',
};

function harness({ images = true, navigator = {}, blob = {}, drawFailure = false, filters = true } = {}) {
  const strings = [], drawings = [], timers = [], downloads = [], revoked = [];
  const ctx = {
    scale() {}, fillRect() {}, save() {}, restore() {},
    measureText: (text) => ({ width: text.length * 10 }),
    fillText: (text) => strings.push(text),
    drawImage: (...args) => { if (drawFailure) throw new Error('Artwork failed'); drawings.push(args); },
  };
  if (filters) ctx.filter = 'none';
  const canvas = { getContext: () => ctx, toBlob: (callback, type) => {
    assert.equal(type, 'image/png'); callback(blob);
  } };
  const context = vm.createContext({
    URL: class extends URL {
      static createObjectURL() { return 'blob:ticket'; }
      static revokeObjectURL(url) { revoked.push(url); }
    },
    location: { origin: 'https://queue.test', href: data.url },
    navigator, File: class { constructor(parts, name, options) { Object.assign(this, { parts, name, ...options }); } },
    Image: class {
      naturalWidth = 1200; naturalHeight = 400;
      set src(value) { this.url = value; if (images) this.onload(); }
    },
    document: {
      createElement: (tag) => tag === 'canvas' ? canvas : {
        click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {},
      },
      body: { append() {} },
    },
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
  });
  vm.runInContext(source, context);
  return { context, canvas, strings, drawings, timers, downloads, revoked };
}

test('index inline scripts parse; save action retains visibility and removes the print feature', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  for (const [, script] of scripts) new vm.Script(script);
  assert.match(html, /id="save-ticket">Save ticket to my phone/);
  assert.match(html, /\$\('#save-ticket'\)\.hidden = !\['waiting', 'called'\]\.includes\(t.status\)/);
  assert.doesNotMatch(html, /id="(?:print|stub|s-num|s-model|s-name|s-phone|s-license|s-date|s-pos)"|window\.print/);
});

test('portrait PNG renderer draws only allowed text even when extra private fields are supplied', async () => {
  const h = harness();
  await h.context.drawTicketImage(data);
  assert.equal(h.canvas.width, 1080);
  assert.equal(h.canvas.height, 1600);
  for (const expected of [data.number, data.firstName, data.modelName, 'Test Drive', 'Queue number']) {
    assert.ok(h.strings.includes(expected), expected);
  }
  const drawn = h.strings.join('\n');
  for (const forbidden of [data.phone, data.email, data.license, data.licenseNumber, data.id, data.url, data.carImage]) {
    assert.ok(!drawn.includes(forbidden), `Must never draw ${forbidden}`);
  }
  assert.doesNotMatch(drawn, /https?:|\?t=|phone|e-mail|license/i);
  assert.equal(h.drawings.length, 2, 'logo and car are drawn');
});

test('canvas without filter support uses the text wordmark and draws only the car artwork', async () => {
  const h = harness({ filters: false });
  await h.context.drawTicketImage(data);
  assert.ok(h.strings.includes('OMODA & JAECOO'));
  assert.equal(h.drawings.length, 1);
  assert.equal(h.drawings[0][0].url, 'https://queue.test/img/j7shs.png');
});

test('slow artwork expires within three seconds and saving still succeeds with a text wordmark', async () => {
  const h = harness({ images: false });
  const pending = h.context.saveTicketImage(data);
  assert.equal(h.timers.length, 2);
  for (const timer of [...h.timers]) {
    assert.equal(timer.delay, 3000); timer.callback();
  }
  await pending;
  assert.ok(h.strings.includes('OMODA & JAECOO'));
  assert.equal(h.downloads.length, 1);
});

test('artwork failures and cross-origin sources do not prevent rendering', async () => {
  const h = harness({ drawFailure: true });
  await h.context.drawTicketImage({ ...data, carImage: 'https://other.test/car.png' });
  assert.ok(h.strings.includes('OMODA & JAECOO'));
  assert.ok(h.strings.includes(data.number));
});

test('supported file sharing uses a PNG file and the requested title', async () => {
  let shared;
  const h = harness({ navigator: {
    canShare: ({ files }) => files[0].type === 'image/png',
    share: async (payload) => { shared = payload; },
  } });
  await h.context.saveTicketImage(data);
  assert.equal(shared.title, 'My test drive ticket');
  assert.equal(shared.files[0].name, 'OMODA-JAECOO-ticket-J7-001.png');
  assert.equal(h.downloads.length, 0);
});

test('share cancellation never starts a download', async () => {
  const h = harness({ navigator: {
    canShare: () => true,
    share: async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); },
  } });
  await h.context.saveTicketImage(data);
  assert.equal(h.downloads.length, 0);
});

test('unsupported sharing and non-cancellation failures download then revoke the URL', async () => {
  for (const navigator of [
    {}, { canShare: () => false },
    { canShare: () => { throw new Error('Unsupported'); } },
    { canShare: () => true, share: async () => { throw new Error('Share failed'); } },
  ]) {
    const h = harness({ navigator });
    await h.context.saveTicketImage(data);
    assert.deepEqual(h.downloads, [{ href: 'blob:ticket', filename: 'OMODA-JAECOO-ticket-J7-001.png' }]);
    h.timers.filter((timer) => !timer.cleared).forEach((timer) => timer.callback());
    assert.deepEqual(h.revoked, ['blob:ticket']);
  }
});

test('button reports export failures and restores its label and enabled state', async () => {
  const h = harness({ blob: null });
  const button = { disabled: false, textContent: 'Save ticket to my phone' };
  const messages = [];
  Object.assign(h.context, { $: () => button, ticketImageData: data, toast: (message) => messages.push(message) });
  const handler = html.slice(html.indexOf("    $('#save-ticket').onclick"), html.indexOf("    $('#leave').onclick"));
  vm.runInContext(handler, h.context);
  const pending = button.onclick();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Preparing…');
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Save ticket to my phone');
  assert.deepEqual(messages, ["Couldn't save the ticket. Please take a screenshot instead."]);
});
