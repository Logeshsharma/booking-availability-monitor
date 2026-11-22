# Booking Availability Monitor

Checks the Eventbrite page for the RCS England **Licence in Dental Surgery (LDS)
Part 2 Exam — February 2027** every **15 seconds** and alerts you by desktop
notification and Telegram when a ticket can genuinely be booked.

- **Website:** <https://logeshsharma.github.io/booking-availability-monitor/>
- **Target event:** [LDS Part 2 Exam February 2027](https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810) (`2004570995810`)

No backend, no database, no paid hosting.

---

## The two pieces

| | GitHub Pages website | Tampermonkey userscript |
|---|---|---|
| Runs on | `logeshsharma.github.io` | `eventbrite.co.uk` |
| What it does | Embeds the booking page and reloads that frame every 15s | **Actually detects availability and alerts you** |
| Detects availability? | **No** — you watch it | Yes, with desktop + Telegram alerts |

### Why the website cannot detect availability

The website and Eventbrite are different browser origins, and Eventbrite sends
no `Access-Control-Allow-Origin` header. Verified from the deployed site:

| Attempt | Result |
|---|---|
| `fetch()` the booking page | blocked by CORS |
| `XMLHttpRequest` | blocked by CORS |
| `fetch(mode: 'no-cors')` | `type: "opaque"`, body length 0 |
| `<iframe>` it | **loads and renders** |
| Read inside that iframe | `SecurityError: Blocked a frame … from accessing a cross-origin frame` |

Eventbrite sets no `X-Frame-Options` and no CSP `frame-ancestors`, so the page
can be embedded — it just cannot be read. The site therefore shows you the real
booking page and keeps it fresh; it never claims to detect anything. For
automatic detection, use the userscript.

---

## The website

Embeds the booking page and reloads **only that frame** every 15 seconds, while
the page itself stays loaded. Shows last refresh, a countdown to the next one, a
refresh count, and a Pause control.

Implementation notes that matter:

- Each refresh builds a **new `<iframe>` and swaps it in**, rather than
  reassigning `.src`. Assigning `.src` pushes an entry onto the frame's session
  history and hijacks the browser Back button.
- The incoming frame loads hidden and is swapped in 2.5s after its `load` event.
  Eventbrite is a Next.js app whose `load` fires before React paints, so
  swapping immediately showed an unpainted frame.
- The cadence is measured from when each request goes out, not when it returns,
  so 15s stays 15s. A 2s floor stops a slow load causing back-to-back requests.
- The frame URL carries a cache-buster — the page is served via CloudFront with
  `s-maxage=300`, so without it the browser can return a cached copy.
- A failed or timed-out load keeps the previous frame on screen rather than
  blanking it.
- CSS/JS URLs are stamped with content hashes by the deploy workflow. Pages
  serves assets with `max-age=600`, so without this a returning visitor can run
  the previous deploy's JavaScript against the new markup.

**One full page load of Eventbrite every 15 seconds is not free** — roughly 240
loads an hour, each a few hundred KB plus assets. Use Pause when you are not
actively watching.

---

## The panel

Appears bottom-right on the Eventbrite page.

```
● BOOKING MONITOR              ⚙ ▼
  LDS Part 2 Exam — February 2027
  ┌───────────────────────────────┐
  │          SOLD OUT             │
  └───────────────────────────────┘
  Monitoring              RUNNING
  Last refresh           17:06:15
  Last result             SUCCESS
  Next refresh                12s
  Checks            128 ok / 3 failed
  [ Stop ]          [ Check now ]
  [      Download logs           ]
```

**Last refresh** is the time of the last check that actually returned fresh data.
A failed check updates **Last result**, never **Last refresh** — a refresh is
never reported as successful unless real data came back.

The **⚙** toggle holds the interval, Telegram credentials and the two test buttons.

---

## Refresh behaviour and rate limits

Default interval: **15 seconds**, one request per cycle. The checkout-inventory
request fires only when the listing is something other than a plain sold-out, so
a sold-out event stays at exactly one request per cycle.

15s polling is deliberately aggressive, so failures back off instead of retrying
at the same rate:

| Consecutive failures | Generic error | Rate limited (429/403) |
|---|---|---|
| 0 | 15s | 15s |
| 1 | 30s | 2 min |
| 2 | 1 min | 4 min |
| 3 | 2 min | 8 min |
| … | capped at 15 min | capped at 15 min |

A success resets it to 15s immediately. The panel shows the error and the
consecutive-failure count. The interval is configurable with a 10-second floor.

---

## Logging

Every check appends one line, kept in Tampermonkey storage (most recent 1,500
entries) and surviving page refreshes. **Download logs** saves a `.txt`:

```
[17:05:52] SUCCESS - SOLD OUT
[17:05:53] ERROR (HTTP 429) - Rate limited by Eventbrite
[17:05:56] ERROR (HTTP 503) - Eventbrite server error
[17:05:57] ERROR - Request timeout
[17:05:59] SUCCESS - SOLD OUT
[17:06:00] SUCCESS - AVAILABLE
```

Each entry records timestamp, success/failure, HTTP status where available,
booking status, and the error message.

---

## How availability is decided

A visible button is not availability. Four signals are read:

| Signal | Source | Meaning |
|---|---|---|
| `salesStatus.salesStatus` | page `__NEXT_DATA__` | Eventbrite's own verdict |
| `offers[].availability` | schema.org JSON-LD | corroboration |
| `conversion-bar-sold-out-signal` | DOM marker | vetoes an "available" reading |
| `ticketAvailabilityInfo` + `maximum_quantity_per_order` | checkout widget | **decisive — can a quantity be selected?** |

- **AVAILABLE** needs confirmed inventory *and* an orderable ticket.
- A ticket row with a per-order maximum of `0` is **sold out**, not available.
- Sold out with an open waitlist is still **sold out**.
- Conflicting, blocked or unreadable signals ⇒ **UNKNOWN**, never a false positive.
- An HTTP 200 that cannot be parsed counts as a **failed** check, not a success.

Alerts fire once per genuine transition into availability. A failed check never
changes the recorded status and never alerts.

---

## Install

1. Install [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open <https://logeshsharma.github.io/booking-availability-monitor/userscript/booking-monitor.user.js> and confirm.
3. Open the booking page, press **Start**, leave the tab open.

### Telegram

Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token. Send
your bot a message, then open `api.telegram.org/bot<TOKEN>/getUpdates` and copy
`chat.id`. Paste both into the panel's **⚙** settings.

**Never put the token on the GitHub Pages site** — it is public and has no field
for it. Credentials live only in Tampermonkey storage on your machine; treat the
token like a password and `/revoke` it in BotFather if it leaks.

---

## Limits

Runs only while the browser is open and the machine is awake. Background tabs are
throttled, so the script compares wall-clock time against a stored deadline rather
than trusting a timer. It never buys tickets and never touches CAPTCHA, logins or
the Eventbrite waiting room.

---

## Project structure

```
├── index.html                      # minimal install page
├── css/styles.css
├── js/dashboard.js
├── userscript/booking-monitor.user.js
├── tests/
│   ├── detection.test.js           # 75 unit tests, zero dependencies
│   ├── fixtures/                   # HTML mirroring real Eventbrite responses
│   └── manual/panel-harness.html   # drives the real panel with stubbed GM_* APIs
└── .github/workflows/deploy.yml
```

## Tests

```bash
node --test tests/*.test.js
```

For the interactive parts, serve the repo and open
`tests/manual/panel-harness.html`. It loads the real userscript with stubbed
`GM_*` APIs and can simulate sold-out, available, not-selectable, waitlist,
conflicting, blocked, not-yet-on-sale, network error, HTTP 429, HTTP 503 and
timeout, plus Telegram success / 401 / timeout.

```bash
python3 -m http.server 8777
# http://localhost:8777/tests/manual/panel-harness.html
```

Not affiliated with Eventbrite or the Royal College of Surgeons of England.
