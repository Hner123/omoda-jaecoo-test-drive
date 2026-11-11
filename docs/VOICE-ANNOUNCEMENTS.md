# Voice announcements (Call / Recall)

How the lobby display speaks the queue number and customer name when staff press **Call** or **Recall**, and how the OpenAI voice is connected.

## 1. The big picture

```
Staff console            Server (Netlify function / server.js)             Lobby display (/display)
-------------            -------------------------------------             ------------------------
Call / Recall  --POST--> ticket.status = 'called'
                         ticket.calledAt = now
                         ticket.callCount += 1
                                                     <--GET /api/state (every 3 s)--  sees calledAt changed
                                                                                      -> chime
                                                     <--GET /api/announce?number=--   asks for the voice
                         builds the sentence from the
                         ticket (never from the request)
                         -> OpenAI TTS -> MP3 (cached)
                                                     --audio/mpeg-->                 plays it twice
                                                                                      (falls back to the
                                                                                       browser voice)
```

The display never sends any text to the server. It only sends the ticket number, and the server only speaks for a ticket that is **called today**. This prevents the endpoint from being used to generate arbitrary speech or to burn API credits.

## 2. Connecting the OpenAI voice

### Setup (done once, in Netlify)

1. Create an API key at platform.openai.com > API keys, on an account with credits.
2. In Netlify go to **Project configuration > Environment variables** and add `OPENAI_API_KEY`. Tick **Contains secret values** so the key is hidden in the UI and logs.
3. Redeploy. Functions only pick up new environment variables on the next deploy.

The key is never put in the code, the repository, or chat.

### Optional settings

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Turns the AI voice on (secret). |
| `TTS_PROVIDER` | auto | `openai` or `elevenlabs`. If unset: OpenAI when its key exists, otherwise ElevenLabs. |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Speech model. |
| `OPENAI_TTS_VOICE` | `alloy` | Voice name. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Only needed for a proxy or compatible gateway. |
| `ELEVENLABS_API_KEY` / `_VOICE_ID` / `_MODEL` | none | Alternative provider. The free ElevenLabs plan blocks cloud servers (`detected_unusual_activity`), so it needs a paid plan. |

### The request we send (lib/announce.js, `synthesizeOpenAI`)

```
POST {OPENAI_BASE_URL}/audio/speech
Authorization: Bearer <OPENAI_API_KEY>
Content-Type: application/json
Accept: audio/mpeg

{
  "model": "gpt-4o-mini-tts",
  "voice": "alloy",
  "input": "<the announcement sentence>",
  "response_format": "mp3",
  "instructions": "Speak like a clear, friendly event announcer in a Philippine car showroom. Moderate pace. Read queue numbers slowly and clearly, letter by letter and digit by digit. Pronounce 'Jaecoo' as 'JAY-koo'. Pronounce Filipino names naturally."
}
```

- `instructions` is only sent for `gpt-*` models. Older models such as `tts-1` don't support it.
- The request is aborted after **8 seconds**.
- The response is the MP3 bytes. An empty response counts as a failure.

### Errors and logging

On a failure the server answers `503 {"error":"Voice unavailable"}`, and the display falls back to the browser voice.

The log gets one safe line, for example:

```
Announcement voice unavailable (openai): 401 authentication rejected (invalid_api_key)
```

Only the HTTP status and a validated error code are kept: `invalid_api_key`, `insufficient_quota` and `model_not_found`. The provider's error message, the spoken text, the customer name and the key are never logged.

## 3. The call / recall wording

The client's wording is used, and it's built in two places that must stay identical: `lib/announce.js` `announcementText()` on the server, and `public/common.js` `callAnnouncementText()` in the browser fallback. `test/announce.test.cjs` checks that both produce the same text.

| When | Sentence |
|---|---|
| First call (`callCount` 1) | Queue Number **J 5 E V, zero zero one**, **Mark Yuri Patawaran**. Please proceed to the Omoda Jaecoo Booth for your test drive. |
| Recall (`callCount` 2+) | Now serving Queue Number **J 5 E V, zero zero one**, **Mark Yuri Patawaran**. Please proceed to the Omoda Jaecoo Booth. Thank you! |

How each part of the sentence is built:

- **Queue number:** the prefix letters and digits are spaced out, and each digit of the number is read as a word: `J5EV-001` becomes "J 5 E V, zero zero one". A malformed number is spelled out character by character.
- **Name:** the AI voice uses the customer's **full name**. The browser fallback only has the first name, because the public display never receives the full name. HTML is stripped, only letters, spaces, `' - .` are kept, and the name is capped at 60 characters. With no name, the comma is dropped.
- **Brand:** the brand is written as "Omoda Jaecoo" in mixed case, so voices don't spell it out letter by letter.

### How Call vs Recall is detected

In `lib/queue.js`, the staff **Call** and **Recall** buttons both run the `call` action:

```js
if (action === 'call') t.callCount = (t.callCount || 0) + 1;
```

Each press also sets a new `calledAt`. `callCount` is part of the public state, because it isn't sensitive. Count 1 gives the first-call wording, and 2 or more gives the "Now serving..." wording.

## 4. Caching (one paid generation per call)

- **Cache key:** `openai/<date>/<ticket number>/<calledAt>`.
- **Same press:** every play on the same press reuses the same MP3. That covers the second play, other display screens and page reloads.
- **Recall:** a new `calledAt` means a new key, so a recall gets fresh audio with the recall wording.
- **Storage:** Netlify keeps the cache in the Blobs store `announcements`; the local server keeps up to 50 entries in memory.
- **Simultaneous requests:** these share one in-flight generation instead of paying twice.
- **Failures:** failures are not cached, and a failed cache write still returns the audio.
- **Cost:** roughly 100-150 characters per generation, so it's very cheap per call.

Measured on the live site:
- First call: about 5.0 s.
- Recall: about 2.7 s.
- Replaying a cached announcement: instant.

## 5. The lobby display (public/display.html)

1. **Enable call sound:** browsers block audio until someone clicks. Staff click **Enable call sound** in the header once; it plays a chime and unlocks speech and HTML audio. The button then becomes **Test announcement**.
2. **Detecting a call:** `live()` in `public/common.js` polls `/api/state` every 3 s. When a ticket's `calledAt` changes, it fires `onCall({ number, model, name, callCount })`.
3. **Announcement queue:** announcements play one at a time and never overlap. At most 5 wait their turn. While the tab is hidden they are held, then played in order when it's visible again.
4. **Each announcement:**
   - **Chime:** plays first, followed by a 0.9 s pause.
   - **AI voice:** `GET /api/announce?number=...`, with a **10 s** timeout, because uncached generation takes about 4-5 s. On 200 the MP3 plays **twice** with a 1 s gap, and a watchdog stops a stuck player from blocking the queue.
   - **Fallback:** if the request fails, times out or can't play, the browser's `speechSynthesis` reads the same sentence twice. It prefers an `en-PH` voice, then natural English voices.
   - **Voice not configured:** if the server answers this, the display skips the AI request for 5 minutes and uses the browser voice.
5. **Test announcement:** this always uses the browser voice with a sample ticket, because there's no real called ticket to synthesise.

## 6. The endpoint: `GET /api/announce?number=J5EV-001`

| Response | When |
|---|---|
| `200 audio/mpeg` | Ticket is called today and the voice worked (`Cache-Control: private, max-age=300`). |
| `400 Invalid ticket number` | Number doesn't match `^[A-Z0-9]{1,6}-\d{3,4}$`. |
| `404 Called ticket not found` | Unknown, waiting, done or another day's ticket. |
| `503 Voice not configured` | No key for the selected provider. |
| `503 Voice unavailable` | Provider error, timeout or storage failure. |

The same handler (`createAnnouncer` in `lib/announce.js`) is used by both `netlify/functions/api.mjs` (Blobs cache) and `server.js` (memory cache).

## 7. Files

| File | Role |
|---|---|
| `lib/announce.js` | Sentence builder, OpenAI and ElevenLabs clients, provider selection, cache and endpoint handler. |
| `lib/queue.js` | `callCount` on Call/Recall; `callCount` in the public state. |
| `netlify/functions/api.mjs` | `/api/announce` route on Netlify, Blobs `announcements` cache. |
| `server.js` | `/api/announce` route for local runs. |
| `public/common.js` | `live()` call detection; `callAnnouncementText()` browser copy of the sentence. |
| `public/display.html` | Sound button, announcement queue, AI audio playback, browser-voice fallback. |
| `test/announce.test.cjs` and related tests | Wording parity, OpenAI request format, safe error logging, caching, display queue behaviour. |

## 8. Troubleshooting

- **Only the robotic browser voice plays:**
  - Check that `OPENAI_API_KEY` is set in Netlify and that you redeployed after adding it.
  - Look in the function logs for an `Announcement voice unavailable (openai): ...` line.
- **No sound at all:** click **Enable call sound** on the display; this is needed after every page load. Also check that the browser tab isn't muted, and in Brave allow sound for the site.
- **`insufficient_quota`:** add credits to the OpenAI account.
- **`model_not_found`:** set `OPENAI_TTS_MODEL` to a model the account can use.