// Which SMS goes out when. All sends are best-effort: a failed text never fails the request.
const { MODELS, today, waitingTickets } = require('./queue');
const { sendSms, smsStatus } = require('./sms');

const BRAND = 'OMODA & JAECOO Test Drive';

function modelOf(ticket) {
  return MODELS.find((m) => m.id === ticket.model) || { name: ticket.model, units: 1, minutes: 0 };
}

function firstWaiting(state, modelId) {
  return waitingTickets(state, modelId)[0] || null;
}

// Snapshot of who is first in line per model; take it before a change, compare after.
function firstWaitingIds(state) {
  return Object.fromEntries(MODELS.map((m) => [m.id, (firstWaiting(state, m.id) || {}).id || null]));
}

// On registration
function welcome(state, ticket, position) {
  const m = modelOf(ticket);
  const ahead = Math.max(position - 1, 0);
  const est = Math.max(0, Math.ceil(ahead / m.units)) * m.minutes;
  const wait = ahead === 0 ? "You're first in line." : `${ahead} ahead of you, est. wait ${est} min.`;
  return sendSms(ticket.phone, `${BRAND}: You're in the ${m.name} queue as ${ticket.number}. ${wait} We'll text you when it's your turn.`);
}

// On call / recall
async function yourTurn(ticket) {
  const record = ticket.callSms = { at: Date.now(), state: 'Pending', checkedAt: Date.now() };
  const name = String(ticket.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const greeting = name ? `Good day, ${name}!` : 'Good day!';
  const result = await sendSms(ticket.phone, `${greeting}\n\nWe would like to inform you that your Queue Number ${ticket.number} is now being called. Kindly proceed to the OMODA JAECOO Booth and approach our staff for assistance.\n\nPlease have your queue number ready and make sure to proceed within 10 minutes to avoid delays and cancelation in the process.\n\nThank you for your patience and cooperation. We look forward to assisting you!`);
  // A later recall owns its own record even if an earlier send finishes last.
  Object.assign(record, { state: result.state, checkedAt: Date.now() },
    result.id ? { id: result.id } : {}, result.error ? { error: result.error } : {});
  return result;
}

// After any change, text whoever newly became first in line (once per ticket).
// Returns true if a ticket was flagged, so the caller knows to save again.
async function notifyNext(state, beforeIds, { skipId } = {}) {
  const sends = [];
  for (const m of MODELS) {
    const first = firstWaiting(state, m.id);
    if (!first || first.id === beforeIds[m.id] || first.id === skipId || first.nextNotifiedAt) continue;
    first.nextNotifiedAt = Date.now();
    sends.push(sendSms(first.phone, `${BRAND}: ${first.number}, you're next for the ${m.name}. Please head back to the OMODA & JAECOO Booth now.`));
  }
  await Promise.allSettled(sends);
  return sends.length > 0;
}

// Persistence is owned by the adapter; return whether a save is needed.
async function refreshCallSms(state, now = Date.now()) {
  if (state.date !== today()) return false;
  const eligible = state.tickets.filter((t) => {
    const sms = t.callSms;
    return sms?.id && ['Pending', 'Processed', 'Sent'].includes(sms.state)
      && Number.isFinite(sms.at) && now >= sms.at && now - sms.at <= 60 * 60 * 1000
      && (!sms.checkedAt || now - sms.checkedAt > 8000);
  }).slice(0, 10);
  await Promise.all(eligible.map(async (t) => {
    const sms = t.callSms;
    // Reserve before awaiting to prevent overlapping local polls checking twice.
    sms.checkedAt = now;
    try {
      const result = await smsStatus(sms.id);
      if (result) {
        sms.state = result.state;
        delete sms.error;
        if (result.error) sms.error = result.error;
      }
    } catch {} // Transient failures retain the previous status.
  }));
  return eligible.length > 0;
}

module.exports = { welcome, yourTurn, notifyNext, firstWaitingIds, refreshCallSms };
