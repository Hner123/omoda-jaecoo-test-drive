const crypto = require('crypto');

// Queue rules shared by the local Node server (server.js) and the Netlify function (netlify/functions/api.mjs).
// Everything here is plain state-in / state-out; persistence lives in the caller.

// Models offered for test drive. `units` = demo cars available, `minutes` = avg drive length.
const MODELS = [
  { id: 'J5', name: 'JAECOO J5 HEV', brand: 'JAECOO', prefix: 'J5-', tagline: '', image: '/img/j5.png', showcase: '/img/show-j5.png', units: 1, minutes: 20 },
  { id: 'J5EV', name: 'JAECOO J5 BEV', brand: 'JAECOO', prefix: 'J5EV-', tagline: '', image: '/img/j5ev.png', showcase: '/img/show-j5ev.png', units: 1, minutes: 20 },
  { id: 'EJ6', name: 'JAECOO EJ6', brand: 'JAECOO', prefix: 'EJ6-', tagline: '', image: '/img/ej6.png', showcase: '/img/show-ej6.png', units: 1, minutes: 20 },
  { id: 'J7SHS', name: 'JAECOO J7 SHS', brand: 'JAECOO', prefix: 'J7-', tagline: '', image: '/img/j7shs.png', showcase: '/img/show-j7shs.png', units: 1, minutes: 20 },
];

// Location/dealer choices in the client's required order.
const DEALERS = [
  'OJ Libis', 'OJ Commonwealth', 'OJ Quezon Ave.', 'OJ Shaw', 'OJ Greenhills',
  'OJ Alabang', 'OJ Pasig', 'OJ Makati', 'OJ North EDSA', 'OJ Otis',
  'OJ Fairview', 'OJ Manila Bay', 'OJ Paranaque', 'OJ Abad Santos',
];

const ACTIVE = ['waiting', 'called', 'driving'];

// Showroom's local day, regardless of where the code runs (Netlify functions run in UTC).
const TZ = process.env.QUEUE_TZ || 'Asia/Manila';
function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function emptyState() {
  return { date: today(), counters: {}, tickets: [] };
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

function maskPhone(p = '') {
  return p.length > 4 ? p.slice(0, 2) + '•'.repeat(p.length - 4) + p.slice(-2) : p;
}

// SMS provider metadata belongs only in staff responses and storage.
function customerTicket(ticket) {
  const { callSms, ...visible } = ticket;
  return visible;
}

function orderKey(ticket) {
  return ticket.queueAt ?? ticket.createdAt;
}

function waitingTickets(state, model) {
  return state.tickets.filter((t) => t.model === model && t.status === 'waiting')
    .sort((a, b) => orderKey(a) - orderKey(b));
}

function withFleet(models, fleet = {}) {
  return models.map((m) => {
    const units = fleet?.[m.id];
    return { ...m, units: Number.isInteger(units) && units >= 0 && units <= 50 ? units : m.units };
  });
}

function validateFleet(body) {
  if (!body || !MODELS.some((m) => m.id === body.model)) throw httpError(400, 'Unknown model');
  if (!Number.isInteger(body.units) || body.units < 0 || body.units > 50) throw httpError(400, 'units must be an integer from 0 to 50');
  return { model: body.model, units: body.units };
}

function publicState(state, fleet) {
  return {
    date: state.date,
    models: withFleet(MODELS, fleet).map((m) => {
      const waiting = state.tickets.filter((t) => t.model === m.id && t.status === 'waiting');
      return { ...m, waitingCount: waiting.length, estWaitMin: Math.ceil(waiting.length / Math.max(1, m.units)) * m.minutes };
    }),
    // Anyone can read this, so it lists only what the lobby display needs. Never add the ticket id:
    // it is what lets a customer open and cancel their own ticket.
    // Publish array order, not the private ids or internal queue keys.
    tickets: [...state.tickets].sort((a, b) => orderKey(a) - orderKey(b)).map((t) => ({
      number: t.number,
      model: t.model,
      name: t.name.split(' ')[0],
      status: t.status,
      createdAt: t.createdAt,
      calledAt: t.calledAt,
      callCount: t.callCount,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    })),
    customerTypes: CUSTOMER_TYPES,
    testDriveResources: TEST_DRIVE_RESOURCES,
    dealers: DEALERS,
  };
}

function position(state, ticket) {
  if (ticket.status !== 'waiting') return 0;
  return waitingTickets(state, ticket.model).findIndex((t) => t.id === ticket.id) + 1;
}

function reorder(state, model, ids) {
  if (!MODELS.some((m) => m.id === model)) throw httpError(400, 'Unknown model');
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string' || !id.length)) {
    throw httpError(400, 'ids must be an array of up to 500 ticket id strings');
  }
  const current = waitingTickets(state, model);
  const remaining = new Map(current.map((t) => [t.id, t]));
  const ordered = [];
  for (const id of ids) {
    if (!remaining.has(id)) continue;
    ordered.push(remaining.get(id));
    remaining.delete(id); // Duplicate ids cannot duplicate tickets.
  }
  ordered.push(...remaining.values());
  const keys = current.map(orderKey);
  const changed = [];
  let previous = -Infinity;
  ordered.forEach((ticket, i) => {
    const key = Math.max(keys[i], previous + 1);
    if (orderKey(ticket) !== key) {
      ticket.queueAt = key;
      changed.push(ticket);
    }
    previous = key;
  });
  return changed;
}

// Splits a "data:image/jpeg;base64,..." string into bytes + type, or returns null. Used by both servers
// to store the license photo; the photo itself never goes into the queue state.
function decodePhoto(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 4 * 1024 * 1024) throw httpError(413, 'Photo is too large');
  return { type: m[1], bytes };
}

// How the customer came to the event (asked for by the Sales Team).
const CUSTOMER_TYPES = {
  walk_in: 'Walk-in',
  oj_ph: 'Signed up thru OMODA & JAECOO Philippines',
  dealer: 'Invited by dealer / signed up thru dealer',
};

const TEST_DRIVE_RESOURCES = {
  showroom: 'Showroom',
  mall_display: 'Mall Display',
  bank_display: 'Bank Display',
  event: 'Event',
};

// Validate attachments before creating a ticket. Image bytes never enter queue state.
function registrationImages(body) {
  const front = decodePhoto(body.licensePhoto);
  if (!front) throw httpError(400, 'Please add a photo of the front of your license');
  const back = decodePhoto(body.licensePhotoBack);
  if (!back) throw httpError(400, 'Please add a photo of the back of your license');
  if (!/^data:image\/png;base64,/.test(String(body.signature || ''))) throw httpError(400, 'Please add your signature');
  const signature = decodePhoto(body.signature);
  if (!signature || signature.bytes.length < 8 || !signature.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw httpError(400, 'Please add a valid PNG signature');
  }
  if (signature.bytes.length >= 300 * 1024) throw httpError(413, 'Signature must be under 300 KB');
  return { front, back, signature };
}

// Only these three sides can be requested through the staff-only image endpoint.
function licenseSide(value) {
  const side = value === null ? 'front' : value;
  if (!['front', 'back', 'signature'].includes(side)) throw httpError(400, 'Invalid license side');
  return side === 'front' ? '' : `-${side}`;
}

function isPhMobile(raw) {
  const phone = String(raw || '').replace(/[\s.()-]/g, '');
  return /^(?:0|\+?63)?9\d{9}$/.test(phone);
}

function createTicket(state, { model, name, gender, phone, email, municipality, customerType, dealer, guestMatched, salesExecutive, testDriveResource, consent, licenseNumber, licenseExpiry, hasLicensePhoto, hasLicensePhotoBack, hasSignature }) {
  const m = MODELS.find((x) => x.id === model);
  if (!m) throw httpError(400, 'Unknown model');
  name = String(name || '').trim().slice(0, 60);
  const validPhone = isPhMobile(phone);
  phone = String(phone || '').replace(/[^\d+]/g, '').slice(0, 16);
  email = String(email || '').trim().toLowerCase().slice(0, 120);
  municipality = String(municipality || '').trim().slice(0, 80);
  dealer = String(dealer || '').trim().slice(0, 80);
  salesExecutive = String(salesExecutive || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'A valid e-mail address is required');
  if (!municipality) throw httpError(400, 'Municipality of residence is required');
  if (!Object.hasOwn(CUSTOMER_TYPES, customerType)) throw httpError(400, 'Customer type is required');
  if (!dealer) throw httpError(400, 'Please select a location/dealer');
  const listedDealer = DEALERS.find((d) => d.toLowerCase() === dealer.toLowerCase());
  if (!guestMatched && !listedDealer) throw httpError(400, 'Please select a listed location/dealer');
  dealer = guestMatched ? dealer : listedDealer;
  if (!['male', 'female'].includes(gender)) throw httpError(400, 'Please select Male or Female');
  if (!salesExecutive || salesExecutive.length > 60) throw httpError(400, 'Assigned Sales Executive is required (60 characters maximum)');
  if (!Object.hasOwn(TEST_DRIVE_RESOURCES, testDriveResource)) throw httpError(400, 'Please select a test drive resource');
  if (consent !== true) throw httpError(400, 'Please agree to the data privacy consent');
  if (!name) throw httpError(400, 'Name is required');
  if (!validPhone) throw httpError(400, 'Please enter a valid mobile number (e.g. 0917 123 4567)');
  // Optional license details come from the scan; attachments are stored separately.
  licenseNumber = String(licenseNumber || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20) || null;
  licenseExpiry = /^\d{4}-\d{2}-\d{2}$/.test(licenseExpiry || '') ? licenseExpiry : null;
  if (licenseExpiry && licenseExpiry < today()) throw httpError(400, `This license expired on ${licenseExpiry.replace(/-/g, '/')}. A valid license is required to test drive.`);

  state.counters[model] = (state.counters[model] || 0) + 1;
  const createdAt = Date.now();
  const ticket = {
    id: crypto.randomBytes(16).toString('hex'),
    number: `${m.prefix}${String(state.counters[model]).padStart(3, '0')}`,
    model,
    name,
    gender,
    phone,
    email,
    municipality,
    customerType,
    dealer: dealer || null,
    guestMatched: !!guestMatched,
    salesExecutive,
    testDriveResource,
    consentAt: Date.now(),
    licenseNumber,
    licenseExpiry,
    hasLicensePhoto: !!hasLicensePhoto,
    hasLicensePhotoBack: !!hasLicensePhotoBack,
    hasSignature: !!hasSignature,
    status: 'waiting',
    createdAt,
    queueAt: createdAt,
  };
  state.tickets.push(ticket);
  return ticket;
}

const TRANSITIONS = {
  call: { from: ['waiting', 'called'], to: 'called', stamp: 'calledAt' },
  start: { from: ['called'], to: 'driving', stamp: 'startedAt' },
  finish: { from: ['driving'], to: 'done', stamp: 'finishedAt' },
  noshow: { from: ['waiting', 'called'], to: 'noshow', stamp: 'finishedAt' },
  requeue: { from: ['called', 'noshow'], to: 'waiting', stamp: null },
  cancel: { from: ['waiting', 'called'], to: 'cancelled', stamp: 'finishedAt' },
};

function act(state, id, action) {
  const t = state.tickets.find((x) => x.id === id);
  if (!t) throw httpError(404, 'Ticket not found');
  const tr = TRANSITIONS[action];
  if (!tr) throw httpError(400, 'Unknown action');
  if (!tr.from.includes(t.status)) throw httpError(409, `Cannot ${action} a ticket that is ${t.status}`);
  t.status = tr.to;
  if (action === 'call') t.callCount = (t.callCount || 0) + 1;
  if (tr.stamp) t[tr.stamp] = Date.now();
  if (action === 'requeue') {
    // Reordering can offset colliding millisecond keys slightly into the future.
    t.queueAt = Math.max(Date.now(), ...waitingTickets(state, t.model).filter((x) => x !== t).map((x) => orderKey(x) + 1));
  }
  return t;
}

function callNext(state, model) {
  const next = waitingTickets(state, model)[0];
  if (!next) throw httpError(404, 'No one waiting for this model');
  return act(state, next.id, 'call');
}

// A day can be stored in several pieces when staff reset the queue mid-day; the report wants all of them.
function mergeDay(date, states, fleet) {
  const tickets = states.flatMap((s) => s.tickets || []).sort((a, b) => a.createdAt - b.createdAt);
  return { date, today: today(), models: withFleet(MODELS, fleet), customerTypes: CUSTOMER_TYPES, testDriveResources: TEST_DRIVE_RESOURCES, tickets };
}

module.exports = { withFleet, validateFleet, mergeDay, MODELS, DEALERS, ACTIVE, CUSTOMER_TYPES, TEST_DRIVE_RESOURCES, today, emptyState, httpError, maskPhone, publicState, customerTicket, orderKey, waitingTickets, reorder, position, isPhMobile, createTicket, act, callNext, decodePhoto, registrationImages, licenseSide };
