// Pure number crunching for the Analytics page. No DOM here, so it can be unit tested.
// Input: the staff daily report ({ date, today, models, customerTypes, testDriveResources, tickets }).
(function (root) {
  const NOT_RECORDED = 'Not recorded';

  // What happened to one registration. An open ticket on a past day counts as a no-show, like the Excel report.
  function outcome(t, isToday) {
    if (t.status === 'done' || (t.status === 'driving' && !isToday)) return 'drove';
    if (t.status === 'driving') return 'driving';
    if (t.status === 'cancelled') return 'cancelled';
    if (t.status === 'noshow' || !isToday) return 'noshow';
    return 'open'; // still waiting or being called today
  }
  const drove = (o) => o === 'drove' || o === 'driving';

  function pct(a, b) {
    return b ? Math.round((a / b) * 100) : 0;
  }

  const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const personKey = (t) => String(t.phone || '').replace(/\D/g, '').replace(/^(?:63|0)?(?=9\d{9}$)/, '') || 'ticket:' + (t.id || t.number);

  // Sales executive names are typed by guests: merge case/spacing variants and show the most common spelling.
  function salesNames(tickets) {
    const spellings = new Map(); // lower-case key -> Map(spelling -> count)
    for (const t of tickets) {
      const raw = tidy(t.salesExecutive);
      if (!raw) continue;
      const key = raw.toLowerCase();
      if (!spellings.has(key)) spellings.set(key, new Map());
      const m = spellings.get(key);
      m.set(raw, (m.get(raw) || 0) + 1);
    }
    const display = new Map();
    for (const [key, m] of spellings) {
      display.set(key, [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
    }
    return (t) => {
      const raw = tidy(t.salesExecutive);
      return raw ? display.get(raw.toLowerCase()) : '';
    };
  }

  // "QC", "quezon city" and "Quezon City " are the same place.
  const CITY = new Set(['Quezon', 'Pasig', 'Makati', 'Taguig', 'Mandaluyong', 'Pasay', 'Parañaque', 'Las Piñas', 'Muntinlupa', 'Marikina', 'Caloocan', 'Valenzuela', 'Malabon', 'Navotas', 'San Juan', 'Manila', 'Antipolo', 'Bacoor', 'Imus', 'Dasmariñas', 'Calamba', 'Santa Rosa', 'Biñan', 'San Pedro', 'Cabuyao', 'Tagaytay', 'Angeles', 'Lipa', 'Baguio', 'Cebu', 'Davao', 'Iloilo', 'Bacolod']);
  function placeOf(raw) {
    let x = String(raw || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!x) return '';
    x = x.replace(/^city of /, '').replace(/ city$/, '').replace(/^(metro manila|ncr) /, '');
    if (/^q ?c$/.test(x)) x = 'quezon';
    if (x === 'paranaque') x = 'parañaque';
    if (x === 'las pinas') x = 'las piñas';
    if (x === 'sta rosa') x = 'santa rosa';
    const name = x.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return CITY.has(name) && name !== 'Manila' ? name + ' City' : name;
  }

  function countBy(list, key) {
    const out = {};
    for (const x of list) {
      const k = key(x);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  function aggregate(report, { topPlaces = 12 } = {}) {
    const isToday = report.date === report.today;
    const models = report.models || [];
    const tickets = report.tickets || [];
    const salesOf = salesNames(tickets);
    const rows = tickets.map((t) => ({
      t,
      o: outcome(t, isToday),
      dealer: tidy(t.dealer) || NOT_RECORDED,
      sales: salesOf(t),
    }));
    const drives = rows.filter((r) => drove(r.o));
    const regCount = rows.length;

    const kpis = {
      registrations: regCount,
      people: new Set(tickets.map(personKey)).size,
      drives: drives.length,
      drovePct: pct(drives.length, regCount),
      noshows: rows.filter((r) => r.o === 'noshow').length,
      inLine: rows.filter((r) => r.o === 'open').length,
    };

    // ---- per car ----
    const cars = models.map((m) => {
      const all = rows.filter((r) => r.t.model === m.id);
      const o = countBy(all, (r) => (drove(r.o) ? 'drove' : r.o));
      return { id: m.id, name: m.name, registered: all.length, drove: o.drove || 0, noshow: o.noshow || 0,
        cancelled: o.cancelled || 0, open: o.open || 0, drovePct: pct(o.drove || 0, all.length) };
    });
    const tot = countBy(rows, (r) => (drove(r.o) ? 'drove' : r.o));
    const carTotal = { registered: regCount, drove: tot.drove || 0, noshow: tot.noshow || 0, cancelled: tot.cancelled || 0,
      open: tot.open || 0, drovePct: pct(tot.drove || 0, regCount) };

    // ---- per dealer ----
    const dealerNames = [...new Set(rows.map((r) => r.dealer))];
    const dealers = dealerNames.map((name) => {
      const mine = rows.filter((r) => r.dealer === name);
      const d = mine.filter((r) => drove(r.o));
      const byCar = {};
      for (const m of models) byCar[m.id] = d.filter((r) => r.t.model === m.id).length;
      return { name, registered: mine.length, drives: d.length, drovePct: pct(d.length, mine.length), byCar };
    }).sort((a, b) => (a.name === NOT_RECORDED) - (b.name === NOT_RECORDED) || b.drives - a.drives || b.registered - a.registered || a.name.localeCompare(b.name));
    const ranked = dealers.filter((x) => x.name !== NOT_RECORDED);
    let leader = null;
    if (ranked.length && ranked[0].drives > 0) {
      const tied = ranked.filter((x) => x.drives === ranked[0].drives);
      // "leads by N" only makes sense against another dealer that registered someone
      leader = { name: ranked[0].name, drives: ranked[0].drives, tied: tied.length > 1, by: tied.length > 1 || !ranked[1] ? 0 : ranked[0].drives - ranked[1].drives };
    }

    // ---- sales executives, grouped by dealer ----
    const salesGroups = dealers.map((dl) => {
      const mine = rows.filter((r) => r.dealer === dl.name);
      const named = mine.filter((r) => r.sales);
      const names = [...new Set(named.map((r) => r.sales))];
      const people = names.map((n) => {
        const reg = named.filter((r) => r.sales === n);
        const d = reg.filter((r) => drove(r.o));
        const byCar = {};
        for (const m of models) byCar[m.id] = d.filter((r) => r.t.model === m.id).length;
        return { name: n, drives: d.length, registered: reg.length, byCar };
      }).sort((a, b) => b.drives - a.drives || b.registered - a.registered || a.name.localeCompare(b.name));
      const notRecorded = mine.filter((r) => !r.sales && drove(r.o)).length;
      return { dealer: dl.name, people, notRecorded };
    }).filter((g) => g.people.length || g.notRecorded);

    // ---- where guests come from: one count per person (first ticket decides the place) ----
    const byPerson = new Map();
    for (const r of rows) {
      const k = personKey(r.t);
      if (!byPerson.has(k)) byPerson.set(k, { place: placeOf(r.t.municipality) || 'Not given', drove: false });
    }
    for (const r of rows) if (drove(r.o)) byPerson.get(personKey(r.t)).drove = true;
    const placeMap = {};
    for (const p of byPerson.values()) {
      const x = (placeMap[p.place] = placeMap[p.place] || { name: p.place, people: 0, drove: 0 });
      x.people++;
      if (p.drove) x.drove++;
    }
    const placeList = Object.values(placeMap).sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
    const restList = placeList.slice(topPlaces);
    const places = {
      count: placeList.length,
      top: placeList.slice(0, topPlaces),
      other: restList.length ? { places: restList.length, people: restList.reduce((s, x) => s + x.people, 0), drove: restList.reduce((s, x) => s + x.drove, 0) } : null,
    };

    // ---- form fields: customer type, test drive resource, gender (per registration) ----
    const breakdown = (labels, key) => {
      const c = countBy(rows, (r) => key(r.t) || '');
      const list = Object.keys(labels).map((k) => ({ key: k, label: labels[k], count: c[k] || 0, pct: pct(c[k] || 0, regCount) }));
      const extra = Object.keys(c).filter((k) => !(k in labels));
      const unknown = extra.reduce((s, k) => s + c[k], 0);
      if (unknown) list.push({ key: '', label: NOT_RECORDED, count: unknown, pct: pct(unknown, regCount) });
      return list;
    };
    const fields = {
      customerType: breakdown(report.customerTypes || {}, (t) => t.customerType),
      resource: breakdown(report.testDriveResources || {}, (t) => t.testDriveResource),
      gender: breakdown({ male: 'Male', female: 'Female' }, (t) => t.gender),
    };

    return { date: report.date, isToday, models: models.map((m) => ({ id: m.id, name: m.name })), kpis, cars, carTotal, dealers, leader, salesGroups, places, fields };
  }

  const api = { aggregate, outcome, placeOf, personKey, salesNames, pct, NOT_RECORDED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analytics = api;
})(typeof window !== 'undefined' ? window : globalThis);
