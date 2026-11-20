# Booking Availability Monitor

Checks the Eventbrite page for the RCS England **Licence in Dental Surgery (LDS)
Part 2 Exam — February 2027** every **15 seconds** and alerts you by desktop
notification and Telegram when a ticket can genuinely be booked.

- **Install page:** <https://logeshsharma.github.io/booking-availability-monitor/>
- **Target event:** [LDS Part 2 Exam February 2027](https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810) (`2004570995810`)

No backend, no database, no paid hosting.

---

## The two pieces

| | GitHub Pages | Tampermonkey userscript |
|---|---|---|
| Runs on | `logeshsharma.github.io` | `eventbrite.co.uk` |
| Purpose | Install instructions only | **All monitoring + the live panel** |

They are different browser origins, so the install page cannot read the
userscript's storage. It therefore shows **no** live data rather than faking any.

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
