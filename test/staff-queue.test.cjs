const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/staff.html'), 'utf8');
const source = html.slice(html.indexOf('    const queueView'), html.indexOf('    // Dealer guest list:'));
function harness() {
  const nodes = new Map();
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
    return nodes.get(selector);
  };
  const tickets = Array.from({ length: 8 }, (_, i) => ({ id: 't' + i, number: 'J7-00' + (i + 1), name: i ? 'Customer ' + i : 'Maria Cruz',
    phone: i ? '09990000000' : '0917 123-4567', status: 'done', finishedAt: i + 1, model: 'J7', createdAt: i + 1 }));
  const context = vm.createContext({ $, state: { date: '2026-11-11', tickets, models: [{ id: 'J7', name: 'JAECOO', image: '', waitingCount: 0, estWaitMin: 0 }] },
    document: { createElement: () => ({ content: {} }) },
    esc: (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    ago: () => '3 min ago', cardDate: (value) => value, genderLabel: () => '', STATUS_LABEL: { done: 'Completed', noshow: 'No-show' },
  });
  vm.runInContext(source, context);
  // Capture the markup passed to the DOM reconciler on every actual render().
  vm.runInContext(`syncQueueDOM = (target, content) => { target.markup = document.template.innerHTML; };`, context);
  context.document.createElement = () => (context.document.template = { content: {} });
  const run = (code) => vm.runInContext(code, context);
  const render = () => { context.render(); return $('#cols').markup; };
  return { context, $, tickets, run, render };
}

test('staff inline script parses', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
  assert.equal(scripts.length, 1);
  scripts.forEach((script) => new vm.Script(script));
  assert.match(html, /<label for="queue-search">Search number, name or phone<\/label>/);
});

test('filter matches number/name case-insensitively and normalizes spaces and dashes in phones', () => {
  const { context, tickets } = harness();
  for (const query of ['j7-001', 'MARIA cru', '09171234567', '0917-123 4567', '123 456']) {
    assert.deepEqual(Array.from(context.filterTickets(tickets, query), (t) => t.id), ['t0'], query);
  }
  assert.equal(context.filterTickets(tickets, '   ').length, 8);
  assert.equal(context.filterTickets(tickets, 'unknown').length, 0);
  assert.equal(context.filterTickets(tickets, '---').length, 0);
});

test('Recent renders latest five, Show all/less state survives renders, search includes older matches', () => {
  const { render, run, context } = harness();
  let markup = render();
  assert.equal((markup.match(/data-ticket=/g) || []).length, 5);
  assert.ok(markup.indexOf('data-ticket="t7"') < markup.indexOf('data-ticket="t3"'));
  assert.doesNotMatch(markup, /data-ticket="t0"/);
  assert.match(markup, /Show all \(8\)/);
  run("queueView.recentAll.add('J7')");
  for (let i = 0; i < 2; i++) {
    markup = render();
    assert.equal((markup.match(/data-ticket=/g) || []).length, 8);
    assert.match(markup, />Show less<\/button>/);
  }
  run("queueView.recentAll.delete('J7'); queueView.search = 'Customer'");
  markup = render();
  assert.equal((markup.match(/data-ticket=/g) || []).length, 7);
  assert.match(markup, /Recent \(7 of 8\)/);
  run("queueView.search = 'Maria'");
  assert.match(render(), /data-ticket="t0"/);
  run("queueView.search = ''");
  assert.equal((render().match(/data-ticket=/g) || []).length, 5);
  assert.equal(context.visibleTickets(context.state.tickets, '', false, false).length, 8);
});

test('details, section collapse and search persist across new polled ticket objects; Escape clears', () => {
  const { context, $, render, run } = harness();
  context.state.tickets[0].status = 'waiting';
  run("queueView.expanded.add('t0'); queueView.collapsed.add('J7:recent')");
  const input = $('#queue-search');
  input.value = 'Maria';
  input.handlers.input({ target: input });
  for (let i = 0; i < 2; i++) {
    context.state.tickets = context.state.tickets.map((t) => ({ ...t }));
    const markup = render();
    assert.match(markup, /data-details="t0"[^>]*aria-expanded="true"/);
    assert.match(markup, /id="ticket-details-t0">/);
    assert.match(markup, /data-section="J7:recent"[^>]*aria-expanded="false"/);
    assert.match(markup, /Waiting \(1 of 1\)/);
    assert.match(markup, /No matches/);
    assert.equal(input.value, 'Maria');
  }
  let prevented = false;
  input.handlers.keydown({ key: 'Escape', target: input, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(input.value, '');
  assert.equal(run('queueView.search'), '');
  assert.match(render(), /data-details="t0"[^>]*aria-expanded="true"/);
});

test('waiting positions keep original queue order under search and row controls name the ticket', () => {
  const { context, render, run } = harness();
  context.state.tickets.forEach((t) => { t.status = 'waiting'; });
  run("queueView.search = 'Customer 3'");
  const markup = render();
  assert.match(markup, /Waiting \(1 of 8\)/);
  assert.match(markup, /aria-label="Position 4">4\./);
  for (const label of ['Call', 'Remove', 'Details']) assert.ok(markup.includes(`aria-label="${label} J7-004"`));
});

test('moveId moves up/down, preserves input and ignores moves past either end or unknown ids', () => {
  const { context } = harness();
  const original = ['a', 'b', 'c'];
  for (const [id, offset, expected] of [
    ['b', -1, ['b', 'a', 'c']], ['b', 1, ['a', 'c', 'b']],
    ['a', -1, original], ['c', 1, original], ['missing', 1, original],
  ]) assert.deepEqual(Array.from(context.moveId(original, id, offset)), expected);
  assert.deepEqual(original, ['a', 'b', 'c']);
});

test('waiting controls use queueAt, disable endpoints, hide under search and preserve details', () => {
  const { context, render, run } = harness();
  context.state.tickets.forEach((t) => { t.status = 'waiting'; });
  context.state.tickets[7].queueAt = 0;
  run("queueView.expanded.add('t7')");
  let markup = render();
  assert.ok(markup.indexOf('data-ticket="t7"') < markup.indexOf('data-ticket="t0"'));
  assert.match(markup, /data-waiting-model="J7"/);
  assert.match(markup, /aria-label="Drag to reorder J7-008"/);
  assert.match(markup, /aria-label="Move J7-008 up" disabled/);
  assert.match(markup, /aria-label="Move J7-007 down" disabled/);
  assert.match(markup, /data-details="t7"[^>]*aria-expanded="true"/);
  run("queueView.search = 'Customer'");
  markup = render();
  assert.match(markup, /Clear search to reorder/);
  assert.doesNotMatch(markup, /data-handle=|data-move=/);
});

test('moveWaiting optimistically updates positions, posts full ids, keeps handle focus and rolls back errors', async () => {
  for (const fails of [false, true]) {
    const { context, $, render, run } = harness();
    context.state.tickets.forEach((t) => { t.status = 'waiting'; });
    const requests = [], focused = [], errors = [];
    let refreshed = 0, finish;
    context.pin = '1234';
    context.toast = (message) => errors.push(message);
    context.load = async () => { refreshed++; };
    $('#cols').querySelectorAll = () => context.state.tickets.map((t) => ({ dataset: { handle: t.id }, focus: () => focused.push(t.id) }));
    context.api = (route, options) => {
      requests.push({ route, options });
      return new Promise((resolve, reject) => { finish = () => fails ? reject(new Error('Save failed')) : resolve({ ok: true }); });
    };
    const pending = context.moveWaiting('t1', -1);
    assert.equal(run('reorderView.saving'), true);
    const markup = render();
    assert.ok(markup.indexOf('data-ticket="t1"') < markup.indexOf('data-ticket="t0"'));
    assert.match(markup, /aria-label="Position 1">1\./);
    assert.deepEqual(focused, ['t1']);
    assert.equal(requests[0].route, '/api/staff/reorder');
    assert.equal(requests[0].options.pin, '1234');
    assert.deepEqual(Array.from(requests[0].options.body.ids), ['t1', 't0', 't2', 't3', 't4', 't5', 't6', 't7']);
    assert.equal(requests[0].options.body.model, 'J7');
    await context.moveWaiting('t2', -1);
    assert.equal(requests.length, 1, 'block overlapping moves');
    finish();
    await pending;
    assert.equal(refreshed, 1);
    assert.equal(run('reorderView.saving'), false);
    assert.deepEqual(errors, fails ? ['Save failed'] : []);
    if (fails) assert.ok(render().indexOf('data-ticket="t0"') < render().indexOf('data-ticket="t1"'));
    assert.deepEqual(context.state.tickets.map((t) => t.createdAt), [1, 2, 3, 4, 5, 6, 7, 8]);
  }
});

test('polling skips active drags/saves and discards a poll already in flight when drag starts', async () => {
  const { context, run } = harness();
  const loadSource = html.slice(html.indexOf('    async function load()'), html.indexOf('    const genderLabel'));
  vm.runInContext(loadSource, context);
  context.pin = '1234';
  let requests = 0, finish;
  context.api = () => { requests++; return new Promise((resolve) => { finish = resolve; }); };
  const original = context.state;
  const pending = context.load();
  run("reorderView.drag = { id: 't0' }; ++reorderView.version");
  await context.load();
  context.render(); // Must leave the DOM alone during the drag.
  assert.equal(requests, 1);
  finish({ tickets: [] });
  await pending;
  assert.equal(context.state, original);
  run('reorderView.drag = null; reorderView.saving = true');
  await context.load();
  assert.equal(requests, 1);
});

test('dragging is handle-only, rejects other models, marks the drop edge and submits the full reordered list', () => {
  const { context, $, render, run } = harness();
  context.state.tickets.slice(0, 3).forEach((t) => { t.status = 'waiting'; });
  const cols = $('#cols');
  const list = { dataset: { waitingModel: 'J7' }, querySelectorAll: () => rows };
  const rows = ['t0', 't1', 't2'].map((id) => {
    const classes = new Set();
    return { dataset: { ticket: id }, classes,
      classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)) },
      getBoundingClientRect: () => ({ top: 0, height: 40 }),
      closest: (selector) => selector === '[data-waiting-model]' ? list : selector === '[data-ticket]' ? rows.find((row) => row.dataset.ticket === id) : null,
    };
  });
  list.lastElementChild = rows[2];
  cols.querySelectorAll = (selector) => selector === '[data-handle]' ? [] : rows.filter((row) => row.classes.size);
  cols.contains = () => false;
  const handle = { dataset: { handle: 't0' }, closest: () => list };
  const startedOn = { closest: (selector) => selector === '[data-handle]' ? handle : null };
  const transfer = { setData(type, value) { this.data = [type, value]; } };
  let prevented = false;
  const event = (target, clientY = 30) => ({ target, clientY, dataTransfer: transfer, preventDefault() { prevented = true; } });
  cols.handlers.dragstart(event(rows[0]));
  assert.equal(prevented, true, 'dragging a row body cannot start reorder');
  prevented = false;
  cols.handlers.dragstart(event(startedOn));
  assert.deepEqual(transfer.data, ['text/plain', 't0']);
  assert.equal(run('reorderView.drag.model'), 'J7');
  const otherModel = { closest: () => ({ dataset: { waitingModel: 'J5' } }) };
  cols.handlers.dragover(event(otherModel));
  assert.equal(prevented, false);
  cols.handlers.drop(event(otherModel));
  assert.equal(prevented, false);
  cols.handlers.dragover(event(rows[2]));
  assert.equal(prevented, true);
  assert.ok(rows[2].classes.has('drop-after'));
  cols.handlers.dragover(event(rows[1], 5));
  assert.ok(rows[1].classes.has('drop-before'));
  assert.equal(rows[2].classes.size, 0);
  const calls = [];
  context.saveOrder = (model, ids, focus) => calls.push([model, Array.from(ids), focus]);
  cols.handlers.drop(event(rows[2]));
  assert.deepEqual(calls, [['J7', ['t1', 't2', 't0'], 't0']]);
  assert.equal(run('reorderView.drag'), null);
  assert.ok(rows.every((row) => row.classes.size === 0));
  cols.handlers.dragend();
  assert.equal(calls.length, 1, 'dragend after a drop cannot repeat or cancel the save');
  render();
});

test('keyboard handle arrows use the same moves; cancelling a drag clears indicators and refreshes', () => {
  const { context, $, run } = harness();
  const cols = $('#cols');
  const moves = [];
  let prevented = 0, refreshed = 0;
  context.moveWaiting = (id, offset) => moves.push([id, offset]);
  context.load = () => { refreshed++; };
  cols.querySelectorAll = () => [];
  const event = (key) => ({ key, target: { closest: () => ({ dataset: { handle: 't0' } }) }, preventDefault() { prevented++; } });
  cols.handlers.keydown(event('ArrowUp'));
  cols.handlers.keydown(event('ArrowDown'));
  cols.handlers.keydown(event('ArrowLeft'));
  assert.deepEqual(moves, [['t0', -1], ['t0', 1]]);
  assert.equal(prevented, 2);
  run("reorderView.drag = { id: 't0' }");
  cols.handlers.keydown(event('Escape'));
  assert.equal(run('reorderView.drag'), null);
  assert.equal(refreshed, 1);
  assert.equal(prevented, 3);
});

test('delegated details/section/recent buttons toggle view state without calling ticket APIs', async () => {
  const { context, $, render, run } = harness();
  const clickSource = html.slice(html.indexOf("    $('#cols').addEventListener('click'"), html.indexOf("    $('#reset').onclick"));
  vm.runInContext(clickSource, context);
  const click = (dataset) => $('#cols').handlers.click({ target: { closest: () => ({ dataset }) } });
  await click({ details: 't7' });
  assert.match(render(), /data-details="t7"[^>]*aria-expanded="true"/);
  await click({ details: 't7' });
  assert.equal(run("queueView.expanded.has('t7')"), false);
  await click({ section: 'J7:recent' });
  assert.match(render(), /data-section="J7:recent"[^>]*aria-expanded="false"/);
  await click({ section: 'J7:recent' });
  assert.equal(run("queueView.collapsed.has('J7:recent')"), false);
  await click({ recent: 'J7' });
  assert.equal((render().match(/data-ticket=/g) || []).length, 8);
  await click({ recent: 'J7' });
  assert.equal((render().match(/data-ticket=/g) || []).length, 5);
});

test('DOM reconciliation keeps row/control identity, updates attributes and removes stale rows', () => {
  // Minimal DOM contract exercises the actual reconciler without a browser dependency.
  class Element {
    constructor(name, attrs = {}, children = []) {
      this.nodeType = 1; this.nodeName = name; this.attrs = { ...attrs }; this.childNodes = []; this.parent = null;
      children.forEach((child) => this.insertBefore(child, null));
    }
    get dataset() { return { key: this.attrs['data-key'] }; }
    get children() { return this.childNodes; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { return this.parent?.childNodes[this.parent.childNodes.indexOf(this) + 1] || null; }
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    getAttribute(name) { return this.attrs[name]; }
    setAttribute(name, value) { this.attrs[name] = value; }
    removeAttribute(name) { delete this.attrs[name]; }
    cloneNode() { return new Element(this.nodeName, this.attrs, this.childNodes.map((child) => child.cloneNode(true))); }
    insertBefore(child, before) {
      child.remove();
      this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, child);
      child.parent = this;
    }
    remove() {
      if (this.parent) this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
      this.parent = null;
    }
  }
  const button = (expanded) => new Element('BUTTON', { 'aria-expanded': String(expanded) });
  const row = (key, expanded = false) => new Element('LI', { 'data-key': key }, [button(expanded)]);
  const first = row('a');
  const second = row('b');
  const target = new Element('UL', {}, [first, second]);
  const control = second.firstChild;
  const context = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('    function syncQueueDOM('), html.indexOf('    function render()')), context);
  context.syncQueueDOM(target, new Element('UL', {}, [row('a'), row('b', true)]));
  assert.equal(target.childNodes[1], second);
  assert.equal(second.firstChild, control);
  assert.equal(control.getAttribute('aria-expanded'), 'true');
  context.syncQueueDOM(target, new Element('UL', {}, [row('c'), row('b', true)]));
  assert.deepEqual(target.children.map((el) => el.dataset.key), ['c', 'b']);
  assert.equal(target.children[1], second);
  context.syncQueueDOM(target, new Element('UL', {}, [row('b', true), row('c')]));
  assert.deepEqual(target.children.map((el) => el.dataset.key), ['b', 'c']);
  assert.equal(target.children[0].firstChild, control);
  context.syncQueueDOM(target, new Element('UL'));
  assert.equal(target.children.length, 0);
});
