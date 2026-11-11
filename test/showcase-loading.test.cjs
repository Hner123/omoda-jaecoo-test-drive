const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = html.slice(html.indexOf('    function loadStageImage('), html.indexOf("    $('#models').addEventListener('click'"));

function harness(cached = new Set()) {
  const timers = [];
  const preloads = [];
  function image() {
    const events = {};
    const classes = new Set();
    return {
      complete: false, naturalWidth: 0, classes, assignments: [],
      classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      addEventListener: (name, callback) => { events[name] = callback; },
      emit(name) { events[name](); },
      set src(value) {
        this.assignments.push(value);
        this.complete = cached.has(value);
        this.naturalWidth = this.complete ? 1582 : 0;
      },
    };
  }
  const node = () => ({ dataset: {}, textContent: '', setAttribute() {}, querySelectorAll: () => [] });
  const nodes = Object.fromEntries(['models', 'model-stage', 'model-waiting', 'model-wait', 'model-select', 'model-selection'].map((id) => ['#' + id, node()]));
  const stage = nodes['#model-stage'];
  let renders = 0;
  Object.defineProperty(stage, 'innerHTML', { set(value) {
    renders++;
    stage.markup = value;
    stage.img = image();
    stage.loader = { hidden: false };
  } });
  stage.querySelector = (selector) => selector === 'img' ? stage.img : stage.loader;
  const context = vm.createContext({
    models: ['A', 'B', 'C', 'D'].map((id) => ({ id, name: 'Brand ' + id, brand: 'Brand', showcase: `/show-${id}.png`, image: `/${id}.png`, waitingCount: 0 })),
    previewed: null, selected: null, showcasePreloads: [], showcasePreloadsStarted: false,
    $: (selector) => nodes[selector], esc: (value) => value, validate() {},
    setTimeout: (callback) => timers.push(callback),
    Image: function () { const img = image(); preloads.push(img); return img; },
  });
  vm.runInContext(source, context);
  return { context, stage, timers, preloads, renders: () => renders, render: () => context.renderModels() };
}

test('uncached showcase stays loading until load, with an accessible nonblocking status', () => {
  const h = harness();
  h.render();
  assert.equal(h.stage.loader.hidden, false);
  assert.equal(h.stage.img.classes.has('is-loaded'), false);
  assert.match(h.stage.markup, /role="status" aria-live="polite"/);
  assert.doesNotMatch(h.stage.markup, /disabled/);
  h.stage.img.naturalWidth = 1582;
  h.stage.img.emit('load');
  assert.equal(h.stage.loader.hidden, true);
  assert.equal(h.stage.img.classes.has('is-loaded'), true);
});

test('cached images finish immediately without waiting for a load event', () => {
  const h = harness(new Set(['/show-A.png']));
  h.render();
  assert.equal(h.stage.loader.hidden, true);
  assert.equal(h.stage.img.classes.has('is-loaded'), true);
});

test('showcase failure tries the fallback once and stops loading if both fail', () => {
  const h = harness();
  h.render();
  h.stage.img.emit('error');
  assert.deepEqual(h.stage.img.assignments, ['/show-A.png', '/A.png']);
  assert.equal(h.stage.loader.hidden, false);
  h.stage.img.emit('error');
  assert.equal(h.stage.loader.hidden, true);
  assert.equal(h.stage.img.classes.has('is-loaded'), false);
  assert.equal(h.stage.img.assignments.length, 2);
});

test('cached fallback succeeds and a direct fallback is not retried', () => {
  const h = harness(new Set(['/A.png']));
  h.render();
  h.stage.img.emit('error');
  assert.equal(h.stage.loader.hidden, true);
  assert.equal(h.stage.img.classes.has('is-loaded'), true);
  h.context.models[1].showcase = null;
  h.context.previewed = 'B';
  h.render();
  h.stage.img.emit('error');
  assert.equal(h.stage.loader.hidden, true);
  assert.deepEqual(h.stage.img.assignments, ['/B.png']);
});

test('rapid switching ignores detached images, including switching back to the same model', () => {
  const h = harness();
  h.render();
  const previous = h.stage.img;
  for (const id of ['B', 'A']) { h.context.previewed = id; h.render(); }
  previous.naturalWidth = 1582;
  previous.emit('load');
  previous.emit('error');
  assert.equal(h.stage.loader.hidden, false);
  assert.equal(h.stage.img.classes.has('is-loaded'), false);
  assert.deepEqual(previous.assignments, ['/show-A.png']);
});

test('polling and selection preserve the image; all four showcases preload once after render', () => {
  const h = harness();
  h.render();
  const img = h.stage.img;
  const loader = h.stage.loader;
  h.context.models[0].waitingCount = 3;
  h.context.selected = 'A';
  h.render();
  assert.equal(h.renders(), 1);
  assert.equal(h.stage.img, img);
  assert.equal(h.stage.loader, loader);
  assert.equal(h.timers.length, 1);
  assert.equal(h.preloads.length, 0);
  h.timers[0]();
  assert.deepEqual(h.preloads.map((image) => image.assignments[0]), ['/show-A.png', '/show-B.png', '/show-C.png', '/show-D.png']);
  h.render();
  assert.equal(h.timers.length, 1);
});
