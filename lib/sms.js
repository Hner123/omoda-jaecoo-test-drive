// SMS sending. Provider is picked from env:
//   SMSGATE_USERNAME + SMSGATE_PASSWORD -> SMSGate Cloud (takes priority)
//   TRACCAR_KEY    → Traccar SMS Gateway app in Cloud mode (https://www.traccar.org/sms/)
//   SEMAPHORE_KEY  → Semaphore (PH), optional SEMAPHORE_SENDER (default "SEMAPHORE")
//   none configured -> messages are skipped (app keeps working without SMS)
// Set SMS_PROVIDER=none to force-disable even if a key is present.

const { maskPhone } = require('./queue');
const TIMEOUT_MS = 6000;

function provider() {
  if (process.env.SMS_PROVIDER === 'none') return 'none';
  if (process.env.SMS_PROVIDER) return process.env.SMS_PROVIDER;
  if (process.env.SMSGATE_USERNAME && process.env.SMSGATE_PASSWORD) return 'smsgate';
  if (process.env.TRACCAR_KEY) return 'traccar';
  if (process.env.SEMAPHORE_KEY) return 'semaphore';
  return 'none';
}

// PH-centric E.164: 09171234567 → +639171234567, 639171234567 → +639171234567, +63… kept
function toE164(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('00')) return '+' + p.slice(2);
  if (p.startsWith('0')) return '+63' + p.slice(1);
  if (p.startsWith('63')) return '+' + p;
  return '+' + p;
}

async function post(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

async function sendSms(phone, message) {
  const to = toE164(phone);
  const masked = maskPhone(to);
  const which = provider();
  try {
    let r;
    if (which === 'smsgate') {
      const user = process.env.SMSGATE_USERNAME;
      const pass = process.env.SMSGATE_PASSWORD;
      if (!user || !pass) {
        console.log(`[sms:smsgate] ${masked} -> FAILED missing credentials`);
        return { provider: which, ok: false, state: 'Failed', error: 'missing_credentials' };
      }
      const body = { textMessage: { text: message }, phoneNumbers: [to], withDeliveryReport: true };
      const sim = (process.env.SMSGATE_SIM || '').trim();
      if (/^[1-3]$/.test(sim)) body.simNumber = Number(sim);
      else if (sim) console.log('[sms:smsgate] ignoring invalid SMSGATE_SIM');
      r = await post(
        process.env.SMSGATE_URL || 'https://api.sms-gate.app/3rdparty/v1/messages',
        { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') },
        JSON.stringify(body),
      );
    } else if (which === 'traccar') {
      r = await post(
        'https://www.traccar.org/sms/',
        { 'Content-Type': 'application/json', Authorization: process.env.TRACCAR_KEY },
        JSON.stringify({ to, message }),
      );
      // Traccar replies 200 even on failure; the verdict is in the body:
      // {"successCount":1,"failureCount":0,...} or {"successCount":0,"failureCount":1,"responses":[{"error":{...}}]}
      try {
        const j = JSON.parse(r.body);
        if (typeof j.failureCount === 'number') {
          r.ok = j.failureCount === 0 && j.successCount > 0;
          if (!r.ok) r.body = (j.responses && j.responses[0] && j.responses[0].error && j.responses[0].error.message) || r.body;
        }
      } catch {}
    } else if (which === 'semaphore') {
      r = await post(
        'https://api.semaphore.co/api/v4/messages',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ apikey: process.env.SEMAPHORE_KEY, number: to, message, sendername: process.env.SEMAPHORE_SENDER || 'SEMAPHORE' }),
      );
    } else {
      console.log(`[sms:skipped] ${masked}`);
      return { provider: which, ok: false, state: 'Skipped' };
    }
    // Never log response bodies or exception messages: providers may echo secrets or customer data.
    console.log(`[sms:${which}] ${masked} -> ${r.ok ? 'sent (queued)' : 'FAILED ' + r.status + ' provider rejected message'}`);
    if (!r.ok) return { provider: which, ok: false, state: 'Failed', error: `http_${r.status}` };
    if (which !== 'smsgate') return { provider: which, ok: true, state: 'Sent' };
    let data;
    try { data = JSON.parse(r.body); } catch {}
    const result = normalizeStatus(data?.state || data?.recipients?.[0]?.state ? data : { state: 'Pending' });
    return { provider: which, ok: result.state !== 'Failed', ...result,
      ...(validId(data?.id) ? { id: data.id } : {}) };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout' : 'request failed';
    console.log(`[sms:${which}] ${masked} -> ERROR ${reason}`);
    return { provider: which, ok: false, state: 'Failed', error: reason === 'timeout' ? 'timeout' : 'request_failed' };
  }
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function normalizeStatus(data) {
  const recipient = Array.isArray(data?.recipients) ? data.recipients[0] : null;
  const raw = typeof recipient?.state === 'string' ? recipient.state : data?.state;
  const state = ['Pending', 'Processed', 'Sent', 'Delivered', 'Failed'].includes(raw) ? raw : 'Failed';
  const error = typeof recipient?.error === 'string'
    ? recipient.error.replace(/[^A-Za-z0-9 .,:_-]/g, '').slice(0, 80).trim() : '';
  return { state, ...(state !== raw ? { error: 'cancelled' } : error ? { error } : {}) };
}

async function smsStatus(id) {
  if (provider() !== 'smsgate' || !validId(id)) return null;
  const user = process.env.SMSGATE_USERNAME;
  const pass = process.env.SMSGATE_PASSWORD;
  if (!user || !pass) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const url = (process.env.SMSGATE_URL || 'https://api.sms-gate.app/3rdparty/v1/messages').replace(/\/$/, '');
    const res = await fetch(`${url}/${encodeURIComponent(id)}`, {
      method: 'GET', headers: { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }, signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return normalizeStatus(await res.json());
  } catch { return null; }
  finally { clearTimeout(timer); }
}

module.exports = { sendSms, smsStatus, toE164, provider };
