# Booking Availability Monitor

Watches the Eventbrite booking page for the Royal College of Surgeons of England
**Licence in Dental Surgery (LDS) Part 2 Exam — February 2027** and alerts you by
desktop notification and Telegram when a ticket can *genuinely* be booked.

- **Dashboard:** <https://logeshsharma.github.io/booking-availability-monitor/>
- **Target event:** [LDS Part 2 Exam February 2027](https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810) (Eventbrite ID `2004570995810`)

No backend, no database, no paid hosting. A static GitHub Pages site plus a
Tampermonkey userscript, and nothing else.

---

## How it is put together

Two components, and only one of them monitors anything.

| | Component A — GitHub Pages dashboard | Component B — Tampermonkey userscript |
|---|---|---|
| Runs on | `logeshsharma.github.io` | `eventbrite.co.uk` |
| Purpose | Setup, installation and documentation | **All actual monitoring** |
| Live status | None — it cannot have any | Yes, in the floating panel |
| Controls | None | Start / Stop / interval / credentials |

### Why the dashboard has no live status or Start button

The dashboard and the userscript run in different browser origins. A page served
from `github.io` cannot read Tampermonkey's storage and cannot see the Eventbrite
tab. Bridging them would need a backend, which is explicitly out of scope.

So the dashboard does not pretend. It shows **no** live monitoring numbers and
has **no** Start/Stop buttons — those live in the userscript panel on the
Eventbrite page, which is the only place that can honestly provide them. The one
interactive control on the dashboard is a notification-permission test, which
genuinely runs in your browser on that origin.

---

## How availability is actually detected

A visible "Get tickets" button is **not** proof of availability. The script reads
four signals, three of them from the listing page and one decisive one from
Eventbrite's own checkout inventory.

| Signal | Where it comes from | What it tells us |
|---|---|---|
| `context.salesStatus.salesStatus` | the page's `__NEXT_DATA__` payload | Eventbrite's own verdict — `sold_out`, `on_sale`, `sales_ended`, … |
| `offers[].availability` | schema.org JSON-LD in the page head | independent corroboration — `SoldOut` vs `InStock` |
| `conversion-bar-sold-out-signal` | a DOM marker in the ticket panel | vetoes an "available" reading while present |
| `ticketAvailabilityInfo` + `maximum_quantity_per_order` | the checkout widget's `__SERVER_DATA__` | **the decisive test — can a quantity actually be selected?** |

### The rules that prevent false alarms

- **Available** requires `has_available_tickets === true` **and** at least one
  ticket whose `maximum_quantity_per_order > 0`.
- A ticket row that renders while its per-order maximum is `0` is **sold out**.
  That is exactly the "button exists, booking doesn't" trap — the concrete
  per-ticket data outranks the aggregate flag.
- **Sold out with an open waitlist is still sold out.** Joining a waitlist is not
  booking. (This event *does* have a waitlist, and it was full when this was built.)
- If two signals disagree about whether you can book, the result is **Unknown** —
  never "available".
- If Eventbrite serves a bot check, a queue page, or anything unparseable, the
  result is **Unknown**.

### The states

| State | Meaning | Alerts? |
|---|---|---|
| `AVAILABLE` | Inventory confirms an orderable ticket | ✅ |
| `AVAILABLE_UNCONFIRMED` | Listing suggests an opening, inventory could not confirm | ✅ clearly labelled as unconfirmed |
| `SOLD_OUT` | Confirmed sold out (waitlist included) | ❌ |
| `NOT_YET_ON_SALE` / `SALES_ENDED` / `UNAVAILABLE` | Self-explanatory | ❌ |
| `UNKNOWN` | Blocked, unreadable, or signals conflict | ❌ |

`AVAILABLE_UNCONFIRMED` still alerts on purpose. For a £1,793 exam seat a
clearly-labelled maybe beats a missed opening. It is never presented as a
confirmed result.

---

## Installation

1. Install **Tampermonkey** — [Chrome/Edge](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo), [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/), [Safari](https://apps.apple.com/app/tampermonkey/id1482490089).
2. Install the userscript — open
   <https://logeshsharma.github.io/booking-availability-monitor/userscript/booking-monitor.user.js>
   and confirm Tampermonkey's install screen.
3. Open the [booking page](https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810).
   A **Booking Monitor** panel appears bottom-right.
4. Set your interval (30 min default), add Telegram details if you want them, press **Save settings**.
5. Press **Start** and allow notifications when asked. Leave the tab open.

> The tab must stay open. This is a browser script: it only runs while the
> browser is running and the machine is awake.

---

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts.
   You get a token like `123456789:AAE…`.
2. Open a chat with your new bot and **send it any message** — a bot cannot
   message you first.
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and find
   `"chat":{"id":123456789}`. That number is your chat ID.
4. Paste both into the **userscript panel** (not the website), press **Save
   settings**, then **Test Telegram**.

### Credential safety

- **Never put your bot token on the GitHub Pages site.** It is a public page and
  there is deliberately no token field on it.
- Credentials live only in Tampermonkey storage on your own computer. They are
  never committed to this repository and are sent nowhere except `api.telegram.org`.
- Anyone with access to your browser profile can read them. Treat the token like
  a password; `/revoke` it in BotFather if it leaks.
- A leaked bot token lets someone post as your bot. It does not grant access to
  your Telegram account.

---

## Reliability, honestly

**It does:** check on your interval · persist all state across refreshes and
restarts · catch up immediately after sleep or throttling · alert once per genuine
transition · verify real inventory · report how late a check ran · keep one check
in flight at a time across tabs · say **Unknown** rather than guess.

**It does not:** buy tickets · touch CAPTCHA, logins or the Eventbrite queue · run
with the browser closed · guarantee exact 30-minute timing · show live status on
GitHub Pages.

### On timing

Browsers throttle timers in background tabs and freeze them when the machine
sleeps, so a check scheduled 30 minutes out can land late. Rather than trusting a
single long timer, the script stores a **deadline** and re-checks whether it is
overdue every 15 seconds, on tab focus, on visibility change and on reconnect — so
it catches up fast. It cannot run while the browser is closed, and the panel
reports how late the last check actually was instead of pretending otherwise.

### Request volume

One request per cycle in the steady state. The checkout-inventory request fires
only when the cheap listing read is something other than a plain sold-out, so a
sold-out event costs exactly one request per interval. The interval is clamped to
a minimum of 5 minutes.

---

## Project structure

```
booking-availability-monitor/
├── index.html                      # dashboard
├── css/styles.css
├── js/dashboard.js
├── userscript/
│   └── booking-monitor.user.js     # the monitor (detection core + UI + alerts)
├── tests/
│   ├── detection.test.js           # 55 unit tests, zero dependencies
│   ├── fixtures/                   # HTML fixtures mirroring real responses
│   └── manual/panel-harness.html   # drives the real panel with stubbed GM_* APIs
├── .github/workflows/deploy.yml    # Pages deployment
├── .gitignore
└── README.md
```

The detection core is written as pure functions and exported via a
`module.exports` guard at the end of the userscript, so Node can require the file
for testing without executing any browser or Tampermonkey code.

---

## Tests

```bash
node --test tests/*.test.js
```

No dependencies and no network access — Node's built-in test runner against HTML
fixtures copied from real Eventbrite responses.

For the interactive parts, serve the repo and open
`tests/manual/panel-harness.html`. It loads the **real** userscript with stubbed
`GM_*` APIs and lets you switch the simulated Eventbrite response between
sold-out, available, not-selectable, waitlist, conflicting, blocked, not-yet-on-sale
and network-failure, plus Telegram success / 401 / timeout.

```bash
python3 -m http.server 8777
# then open http://localhost:8777/tests/manual/panel-harness.html
```

---

## Deployment

`.github/workflows/deploy.yml` publishes the repository root to GitHub Pages on
every push to `main`, using `actions/configure-pages@v5` with `enablement: true`
so Pages is switched on automatically.

---

## Scope and ethics

Read-only monitoring of a public page. It never automates a purchase, never fills
a booking form, and never touches CAPTCHA, authentication or Eventbrite's waiting
room. Not affiliated with Eventbrite or the Royal College of Surgeons of England.
