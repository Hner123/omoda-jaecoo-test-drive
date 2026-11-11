# OMODA & JAECOO Test Drive Queue

Walk-in test drive queueing for the showroom. Runs two ways from the same code:

- **Netlify (public URL)** — static pages + a Netlify Function, queue stored in Netlify Blobs.
- **Local (showroom PC)** — `node server.js`, queue stored in `data/queue.json`. No install needed.

| Screen | Path | Who uses it |
|---|---|---|
| Kiosk / customer ticket | `/` | Customers pick from four JAECOO models, complete the registration form, get a number (e.g. `J5EV-001`); page updates itself, ticket is printable |
| Staff console | `/staff` | Call next, start drive, finish, no-show, re-queue, remove (PIN protected) |
| Lobby display | `/display` | TV screen: now calling, up next, chime on each call; light/dark toggle |

## Deploy on Vercel (frontend) + self-hosted backend

Import this repository into Vercel with the repository root as the project root. `vercel.json` serves `public/` as a static frontend, skips installation and building, and proxies same-origin `/api/*` requests to `https://drive.heineraboka.site/api/*`. It also rewrites `/staff`, `/display` and `/qr` to their HTML pages, sets `no-cache` on HTML/JS/CSS and HTML routes, and adds basic security headers. No Vercel serverless functions are used; `.vercelignore` includes only `public/` and `vercel.json` in the deployment.

Run `node server.js` on the backend server behind that HTTPS URL. SMS, voice generation, staff PIN validation, credentials and all persistent data live on the backend server; configure their environment variables there. The frontend continues using `/api/...`, including announcement audio, registration JSON bodies and the `x-staff-pin` header.

The backend URL is set in the `/api/:path*` rewrite's `destination` in `vercel.json`. To change servers, replace `https://drive.heineraboka.site` there, keep `/api/:path*`, and redeploy the frontend. Keep the backend reachable over HTTPS. `netlify.toml` remains available for Netlify deployments.

## Deploy to Netlify

One-time:

```bash
npm install
```

```bash
npx netlify login
```

```bash
npx netlify init
```
(choose **Create & configure a new site**; accept the defaults — `netlify.toml` already has the build settings)

Then, every deploy:

```bash
npm run deploy
```

After the first deploy, set the staff PIN in the Netlify dashboard: **Site configuration → Environment variables → Add** `STAFF_PIN` (default is `1234` if unset), then redeploy.

Optional env vars: `QUEUE_TZ` (default `Asia/Manila`, controls when the daily numbering resets).

### Lobby call voice (OpenAI or ElevenLabs)

The lobby display chimes, then plays each call twice with a one-second gap. Click **Enable call sound** once on each display to allow playback; **Test announcement** uses browser speech because it has no called ticket.

The first call (`callCount` missing, 0 or 1) says: "Queue Number [QUEUE NUMBER], [CUSTOMER NAME]. Please proceed to the Omoda Jaecoo Booth for your test drive."

Any later call of the same ticket (`callCount > 1`), including Recall or a call after requeue, says: "Now serving Queue Number [QUEUE NUMBER], [CUSTOMER NAME]. Please proceed to the Omoda Jaecoo Booth. Thank you!" Each call increments the count, which is included in public state.

Queue pronunciation comes from the printed ticket number: `J5EV-001` becomes "J 5 E V, zero zero one" and `J7-012` becomes "J 7, zero one two". Malformed numbers fall back to spaced raw characters. **Test announcement** uses a first-call sample with the first model's ID and "Juan Dela Cruz". Both call wordings are spoken twice.

Set these environment variables on the local server or in Netlify **Site configuration → Environment variables** (available to Functions), then restart the local server or redeploy Netlify:

| Variable | Purpose | Default |
|---|---|---|
| `TTS_PROVIDER` | `openai` or `elevenlabs`; explicit selection requires that provider's key | OpenAI when its key is set, else ElevenLabs when its key is set, else browser voice |
| `OPENAI_API_KEY` | Secret API key, server only; never put it in public files | Unset |
| `OPENAI_TTS_MODEL` | OpenAI speech model | `gpt-4o-mini-tts` |
| `OPENAI_TTS_VOICE` | OpenAI voice | `alloy` |
| `OPENAI_BASE_URL` | OpenAI API base URL (trailing slashes stripped) | `https://api.openai.com/v1` |
| `ELEVENLABS_API_KEY` | Secret API key, server only; never put it in public files | Unset |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID | `21m00Tcm4TlvDq8ikWAM` |
| `ELEVENLABS_MODEL` | Speech model | `eleven_flash_v2_5` |

`GET /api/announce?number=J5EV-001` accepts only a ticket called today. The server builds the text from the ticket number, full sanitised customer name and call count; other private ticket fields and arbitrary request text are never sent to the selected provider. The browser fallback uses the name available to it (the public display receives only the first name). Names have HTML tags and unsupported characters removed, whitespace collapsed, and a 60-character cap; an empty name and its comma are omitted. OpenAI uses `/audio/speech` with MP3 output; ElevenLabs uses `mp3_44100_64`. Both use an eight-second server timeout. The key stays on the server and provider error bodies are never logged.

ElevenLabs free plans are blocked from cloud servers such as Netlify; use a paid ElevenLabs plan for cloud hosting. OpenAI speech generation is billed to your OpenAI API account.

Audio is cached by provider, date, ticket number and `calledAt`: normally one generation per call or recall (text length varies). Both repetitions and multiple displays reuse that audio. Local caching keeps the latest 50 generations in memory (cleared on restart); Netlify stores MP3 bytes in the `announcements` Blobs store. Netlify deduplication across separate function instances is best effort, so simultaneous cache misses can spend credits more than once. Cache eviction, deletion or generation failures can also cause a later retry to spend credits again. Old Netlify announcement blobs remain until removed from the Blobs UI; follow your retention policy for full-name audio.

If the selected provider's key is absent (or `TTS_PROVIDER` is invalid), generation fails, fetching exceeds five seconds, or playback fails/stalls, the display automatically uses its existing browser speech twice. An absent key suppresses voice fetches for five minutes before retrying. A slow first generation may finish and populate the cache after the display has already fallen back. No sound plays before the enable click.

Announcement checks (no real key or external voice requests needed): `node --test "test/*.cjs"`. The HTTP smoke test uses port 3100 in an isolated temporary copy, stops that server and removes its test data; existing local data and port 3000 are untouched.

### SMS alerts

Customers get a text when they register, when they become first in line, and when staff Call or Recall their number. Set these in Netlify's environment variables (available to Functions), then redeploy:

| Provider | Variables | Notes |
|---|---|---|
| SMSGate (Android phone, Cloud mode) | `SMSGATE_USERNAME`, `SMSGATE_PASSWORD`, optional `SMSGATE_URL` | Free; uses the Android phone's SIM. Turn on *Cloud server* in the app and copy its username/password. The phone must stay online with the app running |
| Traccar SMS Gateway (Android phone, Cloud mode) | `TRACCAR_KEY` | Free; uses the phone's SIM. Enable *Cloud service* in the app and copy its key |
| Semaphore (PH) | `SEMAPHORE_KEY`, optional `SEMAPHORE_SENDER` | ~₱0.50/SMS, needs account approval |

With `SMS_PROVIDER` unset, SMSGate takes priority when both credentials are set, followed by Traccar, then Semaphore. With no configured provider, the app runs normally and SMS is skipped. `SMS_PROVIDER=smsgate` explicitly selects SMSGate; `SMS_PROVIDER=none` force-disables SMS.

To set up SMSGate:

1. Install [SMS Gateway for Android](https://sms-gate.app) on the Android phone with the SIM you want to send from. Allow SMS permissions, turn on **Cloud server**, then tap **Start Service**. Complete the app's registration if prompted ([Cloud server setup](https://docs.sms-gate.app/getting-started/public-cloud-server/)).
2. Copy the Cloud server username and password into Netlify's `SMSGATE_USERNAME` and `SMSGATE_PASSWORD` environment variables. Keep them server-side and secret.
3. Leave `SMSGATE_URL` unset for the public cloud endpoint (`https://api.sms-gate.app/3rdparty/v1/messages`). For a private server, set it to that server's full messages endpoint URL.
4. Optionally set `SMSGATE_SIM` to an integer from `1` to `3` (for example, `2` to always send from SIM 2). Leave it unset or empty to use the phone's default SIM. Surrounding whitespace is trimmed; invalid values are ignored and logged without including the value.
5. Redeploy Netlify. Keep the phone online with the app running. Register a ticket and use Call / Recall to check delivery after deployment.

SMS sends have a six-second timeout and failures do not fail queue requests. SMSGate 2xx responses mean queued, not confirmed handset delivery. Logs mask phone numbers and omit message text, provider response bodies and credentials.

### Registration fields and reporting

Registrations record the date automatically (`createdAt`). Required fields are name, gender (Male/Female), email, mobile number, municipality/city, customer type, Location/Dealer, Assigned Sales Executive (up to 60 characters), preferred model (selected in the showcase), test drive resource (Showroom, Mall Display, Bank Display or Event), front and back license photos, drawn signature, the data privacy consent checkbox and the existing waiver checkbox. Gender is stored as `male`/`female`; resources as `showroom`/`mall_display`/`bank_display`/`event`. The server records `consentAt` for accepted privacy consent.

Staff can view the new details and all three registration documents. Daily reports offer CSV registrations and an Excel workbook with the same columns and a summary, including groups by location/dealer and test drive resource. Reports export model/resource display labels, privacy consent and signature/back-photo availability. Historical registrations without those fields remain readable and show missing values or No.

### Driver's license scan

Both license photos and a drawn signature are required. Customers scan the front of their license; only the front photo is sent to the GDS AI Gateway (vision model) which returns the name, license number and expiry, and fills the name if it is blank. License number and expiry are optional scan metadata stored with the registration; customers do not see or type those fields. Detected expired licenses are rejected at registration and flagged on the staff console.

Both photos are downsized in the browser to JPEGs below 500 KB each. Signatures are white-background PNGs below 300 KB (decoded bytes). The combined data URLs fit comfortably below the local 6 MB request cap and Netlify's function payload limit. If scanning is unavailable, the front photo is still attached and registration can proceed without a license number or expiry; staff verify the saved photos.

Locally the files are `data/licenses/<ticketId>.<ext>`, `<ticketId>-back.<ext>` and `<ticketId>-signature.png`. Netlify stores them in the `licenses` Blobs store at `<ticketId>`, `<ticketId>-back` and `<ticketId>-signature`. The PIN-protected staff viewer requests `/api/staff/license/<ticketId>?side=front|back|signature` (omitting `side` keeps the existing front-photo behavior). Ticket state contains only attachment flags, not image data. Public state exposes neither personal registration fields nor attachment flags; customer names remain first word only. There is no automatic deletion: remove all three files or blobs as your retention policy requires.

Env vars: `GDS_API_KEY` (required — the `gds_live_…` virtual key), optional `GDS_BASE_URL` (default `https://ai-gateway.heineraboka.site/v1`) and `LICENSE_MODEL` (default `gpt-6.1-sol`). Without a key the scan button reports that scanning isn't set up; customers can still register with the required photos and signature, without entering license details.

### Dealer guest list

Location/Dealer is always required and uses the 14 choices in `DEALERS` in `lib/queue.js`, in the client's exact order. There is no Other option. The server canonicalizes listed names case-insensitively; only a server-verified guest-list match may supply an unlisted dealer (trimmed and capped at 80 characters). The matched dealer and customer type stay locked on the kiosk.

Staff upload who each dealer invited from the staff console (**Upload list**, `.csv` or `.xlsx`; **Download template** gives the columns: Name, Mobile, E-mail, Dealer). Uploads add to the list, and a repeated mobile number or e-mail replaces its entry. The list is kept across days until cleared.

When a customer registers with a mobile number or e-mail on the list, the form fills in and locks "Invited by dealer" and the dealer name, and the server applies the same match when the ticket is created. Names are not matched. `/api/guest-lookup` is public so the form can react as they type, and returns the dealer name only.

### QR poster

`/qr` renders a printable "Scan to join the queue" poster whose code points at the site's own registration page. Print it or download the PNG from that page. It's also linked from the staff console.

### Test the Netlify version locally

```bash
npm run dev
```
Opens on `http://localhost:8888` with a local copy of the Blobs store.

## Run locally without Netlify

```bash
node server.js
```
Serves on port 3000. `PORT` and `STAFF_PIN` can be set as env vars, e.g. `$env:STAFF_PIN="9876"; node server.js`.

## Changing models / wait times

The `MODELS` list at the top of `lib/queue.js` holds the models, demo-car count (`units`) and average drive length (`minutes`). Est. wait = people waiting ÷ units × minutes. Car images are in `public/img/` (side-profile renders from omodajaecoo.com/ph model menu).

## Data

Numbering restarts each day (showroom time). On Netlify each day is a separate key in the `queue` blob store; locally each past day is kept as `data/queue-YYYY-MM-DD.json`. Live updates are by polling every 3 s (`POLL_MS` in `public/common.js`).

## OMODA & JAECOO model lineup

| Model | ID | Ticket prefix | Units | Minutes |
|---|---|---|---|---|
| JAECOO J5 HEV | `J5` | `J5-` | 1 | 20 |
| JAECOO J5 BEV | `J5EV` | `J5EV-` | 1 | 20 |
| JAECOO EJ6 | `EJ6` | `EJ6-` | 1 | 20 |
| JAECOO J7 SHS | `J7SHS` | `J7-` | 1 | 20 |

Customer source `oj_ph` is labelled "Signed up thru OMODA & JAECOO Philippines". Existing tickets retain their stored values; unknown model and customer source IDs display as recorded.

The local model renders and wordmark are from https://www.omodajaecoo.com/ph/. The interface uses system fonts. The white wordmark is filtered dark on light and printed surfaces. SMS credentials and sender configuration are unchanged; an approved branded Semaphore sender can be set with `SEMAPHORE_SENDER`.
