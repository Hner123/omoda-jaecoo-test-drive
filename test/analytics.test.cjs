const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const A = require('../public/analytics-core.js');

const MODELS = [{ id: 'J5', name: 'JAECOO J5 HEV' }, { id: 'J7SHS', name: 'JAECOO J7 SHS' }];
let n = 0;
const t = (over) => ({ id: 'id' + ++n, number: 'J5-' + n, model: 'J5', status: 'done', phone: '0917000000' + (n % 10), name: 'Guest', ...over });
const report = (tickets, over = {}) => ({ date: '2026-11-13', today: '2026-11-13', models: MODELS,
  customerTypes: { walk_in: 'Walk-in', dealer: 'Invited by dealer' }, testDriveResources: { showroom: 'Showroom', event: 'Event' }, tickets, ...over });

test('KPIs count registrations, unique people across phone formats, drives, drove % and no-shows', () => {
  const a = A.aggregate(report([
    t({ phone: '0917 123 4567', status: 'done' }),
    t({ phone: '+639171234567', status: 'driving', model: 'J7SHS' }), // same person, other car, driving today counts as drove
    t({ phone: '09181111111', status: 'noshow' }),
    t({ phone: '09182222222', status: 'waiting' }),
    t({ phone: '09183333333', status: 'cancelled' }),
  ]));
  assert.deepEqual(a.kpis, { registrations: 5, people: 4, drives: 2, drovePct: 40, noshows: 1, inLine: 1 });
  assert.equal(a.isToday, true);
});

test('a past day turns open tickets into no-shows and unfinished drives into drives', () => {
  const a = A.aggregate(report([t({ status: 'waiting' }), t({ status: 'called' }), t({ status: 'driving' })], { today: '2026-11-14' }));
  assert.equal(a.isToday, false);
  assert.equal(a.kpis.noshows, 2);
  assert.equal(a.kpis.drives, 1);
  assert.equal(a.kpis.inLine, 0);
});

test('an empty day never produces NaN or Infinity', () => {
  const a = A.aggregate(report([]));
  assert.deepEqual(a.kpis, { registrations: 0, people: 0, drives: 0, drovePct: 0, noshows: 0, inLine: 0 });
  assert.equal(a.leader, null);
  assert.equal(a.places.other, null);
  assert.ok(!JSON.stringify(a).match(/NaN|Infinity|null,"drovePct"/));
  for (const c of a.cars) assert.equal(c.drovePct, 0);
});

test('per car table splits outcomes and totals add up', () => {
  const a = A.aggregate(report([
    t({ model: 'J5', status: 'done' }), t({ model: 'J5', status: 'noshow' }), t({ model: 'J7SHS', status: 'cancelled' }), t({ model: 'J7SHS', status: 'waiting' }),
  ]));
  assert.deepEqual(a.cars.map((c) => [c.id, c.registered, c.drove, c.noshow, c.cancelled, c.open, c.drovePct]),
    [['J5', 2, 1, 1, 0, 0, 50], ['J7SHS', 2, 0, 0, 1, 1, 0]]);
  assert.deepEqual(a.carTotal, { registered: 4, drove: 1, noshow: 1, cancelled: 1, open: 1, drovePct: 25 });
});

test('dealers are ranked by drives with Not recorded last, and the leader margin is right', () => {
  const a = A.aggregate(report([
    t({ dealer: 'OJ Makati' }), t({ dealer: 'OJ Makati' }), t({ dealer: 'OJ Makati', status: 'noshow' }),
    t({ dealer: 'OJ Shaw' }), t({ dealer: '' }), t({ dealer: '' }), t({ dealer: '' }),
  ]));
  assert.deepEqual(a.dealers.map((d) => [d.name, d.drives, d.registered, d.drovePct]),
    [['OJ Makati', 2, 3, 67], ['OJ Shaw', 1, 1, 100], ['Not recorded', 3, 3, 100]]);
  assert.deepEqual(a.leader, { name: 'OJ Makati', drives: 2, tied: false, by: 1 });
  assert.deepEqual(a.dealers[0].byCar, { J5: 2, J7SHS: 0 });
});

test('a single dealer leads without a made-up margin', () => {
  const a = A.aggregate(report([t({ dealer: 'OJ Makati' }), t({ dealer: '' })]));
  assert.deepEqual(a.leader, { name: 'OJ Makati', drives: 1, tied: false, by: 0 });
});

test('a tie at the top is reported as a tie', () => {
  const a = A.aggregate(report([t({ dealer: 'OJ Shaw' }), t({ dealer: 'OJ Otis' })]));
  assert.equal(a.leader.tied, true);
});

test('sales executive names merge case and spacing variants under the most common spelling', () => {
  const a = A.aggregate(report([
    t({ dealer: 'OJ Makati', salesExecutive: 'Oslo Reyes' }),
    t({ dealer: 'OJ Makati', salesExecutive: ' oslo  reyes ' }),
    t({ dealer: 'OJ Makati', salesExecutive: 'Oslo Reyes', status: 'noshow' }),
    t({ dealer: 'OJ Makati', salesExecutive: 'Julio', model: 'J7SHS' }),
    t({ dealer: 'OJ Makati', salesExecutive: '' }),
  ]));
  const g = a.salesGroups.find((x) => x.dealer === 'OJ Makati');
  assert.deepEqual(g.people.map((p) => [p.name, p.drives, p.registered]), [['Oslo Reyes', 2, 3], ['Julio', 1, 1]]);
  assert.deepEqual(g.people[1].byCar, { J5: 0, J7SHS: 1 });
  assert.equal(g.notRecorded, 1);
});

test('places count each person once, tidy spellings, and roll the tail into other places', () => {
  const a = A.aggregate(report([
    t({ phone: '09170000001', municipality: 'QC' }),
    t({ phone: '09170000001', municipality: 'Makati', model: 'J7SHS' }), // same person: first ticket decides the place
    t({ phone: '09170000002', municipality: 'quezon city ', status: 'noshow' }),
    t({ phone: '09170000003', municipality: 'Paranaque' }),
    t({ phone: '09170000004', municipality: '' }),
  ]), { topPlaces: 2 });
  assert.equal(a.places.count, 3);
  assert.deepEqual(a.places.top.map((p) => [p.name, p.people, p.drove]), [['Quezon City', 2, 1], ['Not given', 1, 1]]);
  assert.deepEqual(a.places.other, { places: 1, people: 1, drove: 1 });
  assert.equal(A.placeOf('Sta. Rosa'), 'Santa Rosa City');
  assert.equal(A.placeOf('City of Manila'), 'Manila');
});

test('form field breakdowns use report labels and show unknown values as Not recorded', () => {
  const a = A.aggregate(report([t({ customerType: 'walk_in', gender: 'male', testDriveResource: 'event' }), t({ customerType: 'old_value', gender: 'female' })]));
  assert.deepEqual(a.fields.customerType.map((x) => [x.label, x.count, x.pct]), [['Walk-in', 1, 50], ['Invited by dealer', 0, 0], ['Not recorded', 1, 50]]);
  assert.deepEqual(a.fields.gender.map((x) => [x.label, x.count]), [['Male', 1], ['Female', 1]]);
  assert.deepEqual(a.fields.resource.map((x) => [x.label, x.count]), [['Showroom', 0], ['Event', 1], ['Not recorded', 1]]);
});

test('analytics output never carries phone numbers or e-mails', () => {
  const a = A.aggregate(report([t({ phone: '09175551234', email: 'secret@example.com', salesExecutive: 'Ana' })]));
  const out = JSON.stringify(a);
  assert.doesNotMatch(out, /5551234|secret@example\.com/);
});

test('analytics page parses, reuses the staff PIN and is routed on every host', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/analytics.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0]);
  assert.match(html, /const PIN_KEY = 'xpq-pin'/);
  assert.match(html, /<script src="\/analytics-core\.js"><\/script>/);
  const staff = fs.readFileSync(path.join(__dirname, '../public/staff.html'), 'utf8');
  assert.match(staff, /sessionStorage\.getItem\('xpq-pin'\)/);
  assert.match(staff, /<a href="\/analytics">Analytics<\/a>/);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/analytics' && r.destination === '/analytics.html'));
  assert.match(fs.readFileSync(path.join(__dirname, '../netlify.toml'), 'utf8'), /from = "\/analytics"\s+to = "\/analytics\.html"/);
});
