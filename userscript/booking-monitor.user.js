// ==UserScript==
// @name         Eventbrite Booking Monitor — LDS Part 2 Exam (Feb 2027)
// @namespace    https://logeshsharma.github.io/booking-availability-monitor/
// @version      2.0.0
// @description  Minimal 15-second availability monitor for the RCS England "Licence in Dental Surgery Part 2 Exam February 2027" Eventbrite page. Alerts by desktop notification and Telegram only when a ticket can genuinely be booked. Never auto-buys, never touches CAPTCHA or the waiting room.
// @author       booking-availability-monitor
// @homepageURL  https://logeshsharma.github.io/booking-availability-monitor/
// @supportURL   https://github.com/Logeshsharma/booking-availability-monitor/issues
// @match        https://www.eventbrite.co.uk/e/*2004570995810*
// @match        https://www.eventbrite.com/e/*2004570995810*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      eventbrite.co.uk
// @connect      eventbrite.com
// @connect      api.telegram.org
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* eslint-env browser, greasemonkey */
(function () {
    'use strict';

    // =====================================================================
    // 1. CONFIGURATION
    // =====================================================================

    const EVENT_ID = '2004570995810';
    const EVENT_URL =
        'https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-' +
        EVENT_ID;
    const EVENT_NAME = 'LDS Part 2 Exam — February 2027';
    const EVENT_NAME_FULL = 'Licence in Dental Surgery Part 2 Exam February 2027';

    const CHECKOUT_URL =
        'https://www.eventbrite.co.uk/checkout-external?eid=' +
        EVENT_ID +
        '&parent=' +
        encodeURIComponent(EVENT_URL);

    const DEFAULTS = {
        intervalSeconds: 15,
        minIntervalSeconds: 10,
        maxIntervalSeconds: 3600,
        heartbeatMs: 1000,          // drives the countdown and the deadline check
        requestTimeoutMs: 12000,    // must comfortably fit inside one 15s cycle
        lockTtlMs: 45000,
        notifyCooldownMs: 10 * 60 * 1000,
        maxLogEntries: 1500,
        // Back-off applied after consecutive failures, so a rate limit or an
        // outage is never answered with the same 15s hammering.
        backoffStartMs: 30 * 1000,
        backoffFactor: 2,
        backoffMaxMs: 15 * 60 * 1000,
        rateLimitStartMs: 2 * 60 * 1000
    };

    const K = {
        config: 'ebm.' + EVENT_ID + '.config',
        status: 'ebm.' + EVENT_ID + '.status',
        lock: 'ebm.' + EVENT_ID + '.lock',
        log: 'ebm.' + EVENT_ID + '.log'
    };

    // =====================================================================
    // 2. DETECTION CORE  (pure functions — unit-tested in tests/detection.test.js)
    // =====================================================================

    const STATES = {
        AVAILABLE: 'AVAILABLE',
        AVAILABLE_UNCONFIRMED: 'AVAILABLE_UNCONFIRMED',
        SOLD_OUT: 'SOLD_OUT',
        NOT_YET_ON_SALE: 'NOT_YET_ON_SALE',
        SALES_ENDED: 'SALES_ENDED',
        UNAVAILABLE: 'UNAVAILABLE',
        UNKNOWN: 'UNKNOWN'
    };

    // States that are worth waking a human up for.
    const ALERT_STATES = [STATES.AVAILABLE, STATES.AVAILABLE_UNCONFIRMED];

    /**
     * Extract the Next.js hydration payload from an Eventbrite listing page.
     * Returns null when the script tag is absent or unparseable (page changed,
     * we were served a bot-check page, etc.) — callers must treat null as UNKNOWN.
     */
    function parseNextData(html) {
        if (typeof html !== 'string' || !html) return null;
        const m = html.match(
            /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
        );
        if (!m) return null;
        try {
            return JSON.parse(m[1]);
        } catch (e) {
            return null;
        }
    }

    /** Extract window.__SERVER_DATA__ from the checkout widget HTML. */
    function parseServerData(html) {
        if (typeof html !== 'string' || !html) return null;
        const m = html.match(
            /window\.__SERVER_DATA__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/
        );
        if (!m) return null;
        try {
            return JSON.parse(m[1]);
        } catch (e) {
            return null;
        }
    }

    /** All JSON-LD blobs in a page, as parsed objects. */
    function parseJsonLd(html) {
        if (typeof html !== 'string' || !html) return [];
        const out = [];
        const re =
            /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            try {
                out.push(JSON.parse(m[1]));
            } catch (e) {
                /* ignore malformed blocks */
            }
        }
        return out;
    }

    /**
     * Map Eventbrite's own sales_status string onto our state vocabulary.
     * Unrecognised values deliberately fall through to UNKNOWN rather than
     * being optimistically treated as "available".
     */
    function classifySalesStatus(raw) {
        if (typeof raw !== 'string' || !raw) return STATES.UNKNOWN;
        switch (raw.toLowerCase()) {
            case 'on_sale':
            case 'available':
                return STATES.AVAILABLE_UNCONFIRMED; // needs checkout confirmation
            case 'sold_out':
                return STATES.SOLD_OUT;
            case 'sales_ended':
            case 'ended':
                return STATES.SALES_ENDED;
            case 'not_yet_on_sale':
            case 'not_yet_started':
            case 'start_sales':
                return STATES.NOT_YET_ON_SALE;
            case 'unavailable':
                return STATES.UNAVAILABLE;
            default:
                return STATES.UNKNOWN;
        }
    }

    /** schema.org availability → our vocabulary. */
    function classifyOfferAvailability(raw) {
        if (typeof raw !== 'string' || !raw) return STATES.UNKNOWN;
        const v = raw.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase();
        if (v === 'instock' || v === 'limitedavailability' || v === 'presale') {
            return STATES.AVAILABLE_UNCONFIRMED;
        }
        if (v === 'soldout') return STATES.SOLD_OUT;
        if (v === 'outofstock') return STATES.SOLD_OUT;
        return STATES.UNKNOWN;
    }

    /**
     * Read the three independent listing-page signals.
     *   1. __NEXT_DATA__ context.salesStatus.salesStatus   (authoritative-ish)
     *   2. JSON-LD / offersSchema availability             (corroborating)
     *   3. the conversion-bar sold-out DOM marker          (corroborating)
     */
    function detectFromListingHtml(html) {
        const signals = {
            salesStatus: null,
            salesMessage: null,
            offerAvailability: null,
            domSoldOutMarker: null,
            waitlistFull: null,
            waitlistEnabled: null,
            saleStart: null,
            saleEnd: null
        };

        const next = parseNextData(html);
        if (next) {
            const ctx =
                (next.props && next.props.pageProps && next.props.pageProps.context) ||
                {};
            if (ctx.salesStatus && typeof ctx.salesStatus.salesStatus === 'string') {
                signals.salesStatus = ctx.salesStatus.salesStatus;
                signals.salesMessage = ctx.salesStatus.message || null;
            }
            const offers =
                (ctx.seo && Array.isArray(ctx.seo.offersSchema) && ctx.seo.offersSchema) ||
                null;
            if (offers && offers.length && typeof offers[0].availability === 'string') {
                signals.offerAvailability = offers[0].availability;
                signals.saleEnd = offers[0].availabilityEnds || null;
                signals.saleStart = offers[0].availabilityStarts || null;
            }
        }

        // Fall back to raw JSON-LD if the Next payload moved or changed shape.
        if (signals.offerAvailability === null) {
            const blobs = parseJsonLd(html);
            for (const b of blobs) {
                const offers = b && b.offers;
                const arr = Array.isArray(offers) ? offers : offers ? [offers] : [];
                for (const o of arr) {
                    if (o && typeof o.availability === 'string') {
                        signals.offerAvailability = o.availability;
                        signals.saleEnd = o.availabilityEnds || signals.saleEnd;
                        break;
                    }
                }
                if (signals.offerAvailability) break;
            }
        }

        if (typeof html === 'string' && html) {
            signals.domSoldOutMarker = /conversion-bar-sold-out-signal/i.test(html);
        }

        const fromSales = classifySalesStatus(signals.salesStatus);
        const fromOffer = classifyOfferAvailability(signals.offerAvailability);

        let state;
        let confidence;

        if (fromSales === STATES.UNKNOWN && fromOffer === STATES.UNKNOWN) {
            // We learned nothing at all — page structure changed or we were blocked.
            state = STATES.UNKNOWN;
            confidence = 'none';
        } else if (fromSales === STATES.UNKNOWN) {
            state = fromOffer;
            confidence = 'low';
        } else if (fromOffer === STATES.UNKNOWN) {
            state = fromSales;
            confidence = 'low';
        } else if (fromSales === fromOffer) {
            state = fromSales;
            confidence = 'high';
        } else if (
            (ALERT_STATES.indexOf(fromSales) !== -1) !==
            (ALERT_STATES.indexOf(fromOffer) !== -1)
        ) {
            // The two sources disagree about whether you can book at all.
            // Never resolve that in favour of "available" — this is exactly
            // how false positives happen.
            state = STATES.UNKNOWN;
            confidence = 'conflict';
        } else {
            // Both agree you cannot book; they just disagree on the flavour
            // (e.g. salesStatus "not_yet_on_sale" vs JSON-LD "SoldOut").
            // Eventbrite's own salesStatus is the more specific of the two.
            state = fromSales;
            confidence = 'high';
        }

        // A sold-out DOM marker contradicting an "available" reading is also a conflict.
        if (signals.domSoldOutMarker === true && ALERT_STATES.indexOf(state) !== -1) {
            state = STATES.UNKNOWN;
            confidence = 'conflict';
        }

        return { source: 'listing', state, confidence, signals };
    }

    /**
     * The real "can a ticket actually be selected?" test.
     * Uses the checkout widget's own inventory numbers rather than the
     * presence of a button.
     */
    function detectFromCheckoutHtml(html) {
        const sd = parseServerData(html);
        if (!sd) {
            return {
                source: 'checkout',
                state: STATES.UNKNOWN,
                confidence: 'none',
                selectable: false,
                signals: { reason: 'no __SERVER_DATA__ in checkout response' }
            };
        }
        return detectFromCheckoutData(sd);
    }

    function detectFromCheckoutData(sd) {
        const info = (sd && sd.ticketAvailabilityInfo) || {};
        const tickets = Array.isArray(sd && sd.tickets) ? sd.tickets : [];
        const waitingRoom = (sd && sd.waitingRoom) || {};

        const selectableTickets = tickets.filter(function (t) {
            if (!t) return false;
            const onSale =
                typeof t.on_sale_status === 'string' &&
                t.on_sale_status.toUpperCase() === 'AVAILABLE';
            // maximum_quantity_per_order === 0 means the quantity picker is dead,
            // even if the row renders. This is the single most reliable tell.
            const canPickQuantity =
                typeof t.maximum_quantity_per_order === 'number' &&
                t.maximum_quantity_per_order > 0;
            const notSoldOut = !(t.onsale_status && t.onsale_status.sold_out_with_waitlist);
            return onSale && canPickQuantity && notSoldOut;
        });

        const signals = {
            hasAvailableTickets:
                typeof info.has_available_tickets === 'boolean'
                    ? info.has_available_tickets
                    : null,
            isSoldOut: typeof info.is_sold_out === 'boolean' ? info.is_sold_out : null,
            remainingCapacity:
                typeof info.remaining_capacity === 'number' ? info.remaining_capacity : null,
            waitlistEnabled:
                typeof info.waitlist_enabled === 'boolean' ? info.waitlist_enabled : null,
            ticketCount: tickets.length,
            selectableCount: selectableTickets.length,
            selectableNames: selectableTickets.map(function (t) {
                return t.name;
            }),
            waitingRoomLive: waitingRoom.is_live === true,
            ticketStatuses: tickets.map(function (t) {
                return {
                    name: t && t.name,
                    on_sale_status: t && t.on_sale_status,
                    maxPerOrder: t && t.maximum_quantity_per_order
                };
            })
        };

        // Genuine availability: inventory says yes AND at least one ticket is
        // actually orderable.
        if (signals.hasAvailableTickets === true && selectableTickets.length > 0) {
            return {
                source: 'checkout',
                state: STATES.AVAILABLE,
                confidence: 'high',
                selectable: true,
                signals
            };
        }

        // Explicitly sold out.
        if (signals.isSoldOut === true || signals.hasAvailableTickets === false) {
            return {
                source: 'checkout',
                state: STATES.SOLD_OUT,
                confidence: 'high',
                selectable: false,
                signals
            };
        }

        // Inventory flags missing but tickets present and orderable — weaker yes.
        if (signals.hasAvailableTickets === null && selectableTickets.length > 0) {
            return {
                source: 'checkout',
                state: STATES.AVAILABLE_UNCONFIRMED,
                confidence: 'low',
                selectable: true,
                signals
            };
        }

        // The aggregate flag claims tickets exist, but every ticket row we can
        // see is unorderable. The concrete per-ticket data is the decisive
        // evidence here — this is the "button renders, booking doesn't" case.
        if (tickets.length > 0 && selectableTickets.length === 0) {
            return {
                source: 'checkout',
                state: STATES.SOLD_OUT,
                confidence: 'high',
                selectable: false,
                signals
            };
        }

        return {
            source: 'checkout',
            state: STATES.UNKNOWN,
            confidence: 'none',
            selectable: false,
            signals
        };
    }

    /**
     * Merge the cheap listing read with the (optional) authoritative checkout read.
     * The checkout result wins when it is confident, because it reflects real
     * inventory rather than page furniture.
     */
    function combineSignals(listing, checkout) {
        const l = listing || { state: STATES.UNKNOWN, confidence: 'none', signals: {} };

        if (!checkout) {
            return {
                state: l.state,
                confidence: l.confidence,
                verified: false,
                listing: l,
                checkout: null
            };
        }

        if (checkout.state === STATES.AVAILABLE && checkout.selectable) {
            return {
                state: STATES.AVAILABLE,
                confidence: 'high',
                verified: true,
                listing: l,
                checkout: checkout
            };
        }

        if (checkout.state === STATES.SOLD_OUT) {
            return {
                state: STATES.SOLD_OUT,
                confidence: 'high',
                verified: true,
                listing: l,
                checkout: checkout
            };
        }

        if (checkout.state === STATES.AVAILABLE_UNCONFIRMED) {
            return {
                state: STATES.AVAILABLE_UNCONFIRMED,
                confidence: 'low',
                verified: false,
                listing: l,
                checkout: checkout
            };
        }

        // Checkout was unreadable. If the listing claimed availability we surface
        // that as *unconfirmed* rather than silently downgrading to UNKNOWN —
        // a missed opening is worse than a clearly-labelled maybe.
        if (ALERT_STATES.indexOf(l.state) !== -1) {
            return {
                state: STATES.AVAILABLE_UNCONFIRMED,
                confidence: 'low',
                verified: false,
                listing: l,
                checkout: checkout
            };
        }

        return {
            state: l.state,
            confidence: l.confidence,
            verified: false,
            listing: l,
            checkout: checkout
        };
    }

    /**
     * Duplicate-notification guard.
     * Fires only on a genuine transition INTO an alert state (plus the very
     * first observation, so a user installing the script while tickets are
     * already live is not left in the dark).
     */
    function shouldNotify(prev, next, now, cooldownMs) {
        now = typeof now === 'number' ? now : Date.now();
        cooldownMs = typeof cooldownMs === 'number' ? cooldownMs : DEFAULTS.notifyCooldownMs;

        if (!next || ALERT_STATES.indexOf(next.state) === -1) {
            return { notify: false, reason: 'state-not-alertable' };
        }
        if (!prev || !prev.state) {
            return { notify: true, reason: 'initial-observation' };
        }
        if (ALERT_STATES.indexOf(prev.state) !== -1) {
            return { notify: false, reason: 'already-alerted-for-this-run' };
        }

        // Coming out of a CONFIRMED unavailable state (sold out, sales ended,
        // not yet on sale) is always a real event, so it always alerts — even
        // moments after a previous alert. Only a transition out of UNKNOWN is
        // damped by the cooldown, because UNKNOWN means we briefly lost sight
        // of the page and the "change" may be an artefact of that blind spot.
        const cameFromConfirmedState = prev.state !== STATES.UNKNOWN;
        if (
            !cameFromConfirmedState &&
            prev.lastNotifiedState === next.state &&
            typeof prev.lastNotifiedAt === 'number' &&
            now - prev.lastNotifiedAt < cooldownMs
        ) {
            return { notify: false, reason: 'within-cooldown' };
        }
        return { notify: true, reason: 'transition:' + prev.state + '->' + next.state };
    }

    function describeState(state) {
        switch (state) {
            case STATES.AVAILABLE:
                return 'Available';
            case STATES.AVAILABLE_UNCONFIRMED:
                return 'Possibly available (unconfirmed)';
            case STATES.SOLD_OUT:
                return 'Sold out';
            case STATES.NOT_YET_ON_SALE:
                return 'Not yet on sale';
            case STATES.SALES_ENDED:
                return 'Sales ended';
            case STATES.UNAVAILABLE:
                return 'Unavailable';
            default:
                return 'Unknown';
        }
    }

    // =====================================================================
    // 2b. SCHEDULING + LOG HELPERS (pure, unit-tested)
    // =====================================================================

    function clampIntervalSeconds(v) {
        const n = Number(v);
        if (!isFinite(n) || n <= 0) return DEFAULTS.intervalSeconds;
        return Math.min(
            DEFAULTS.maxIntervalSeconds,
            Math.max(DEFAULTS.minIntervalSeconds, Math.round(n))
        );
    }

    /**
     * How long to wait before the next attempt.
     * No failures ⇒ the configured interval. Otherwise exponential back-off,
     * starting higher when the server actually told us to slow down.
     */
    function backoffDelayMs(consecutiveFailures, httpStatus, intervalMs, opts) {
        const o = opts || DEFAULTS;
        const fails = Number(consecutiveFailures) || 0;
        if (fails <= 0) return intervalMs;
        const rateLimited = httpStatus === 429 || httpStatus === 403;
        const start = rateLimited ? o.rateLimitStartMs : o.backoffStartMs;
        const delay = start * Math.pow(o.backoffFactor, fails - 1);
        return Math.min(o.backoffMaxMs, Math.max(intervalMs, delay));
    }

    /** Short, human-readable reason for a failed fetch. */
    function describeHttpError(status, fallback) {
        // The HTTP status is rendered separately by formatLogLine and by the
        // panel, so it is deliberately not repeated inside the message.
        if (status === 429) return 'Rate limited by Eventbrite';
        if (status === 403) return 'Blocked by Eventbrite';
        if (status === 404) return 'Page not found';
        if (typeof status === 'number' && status >= 500) return 'Eventbrite server error';
        if (typeof status === 'number' && status > 0) return 'HTTP ' + status;
        return fallback || 'Request failed';
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function clockTime(ts) {
        const d = new Date(ts);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    /** `[16:30:00] SUCCESS - SOLD OUT` / `[16:30:30] ERROR - Request timeout` */
    function formatLogLine(entry) {
        if (!entry) return '';
        const time = clockTime(entry.at);
        if (entry.ok) {
            return '[' + time + '] SUCCESS - ' + logStateLabel(entry.state);
        }
        const http =
            typeof entry.http === 'number' && entry.http > 0 ? ' (HTTP ' + entry.http + ')' : '';
        return '[' + time + '] ERROR' + http + ' - ' + (entry.error || 'Unknown error');
    }

    function logStateLabel(state) {
        switch (state) {
            case STATES.AVAILABLE:
                return 'AVAILABLE';
            case STATES.AVAILABLE_UNCONFIRMED:
                return 'AVAILABLE (UNCONFIRMED)';
            case STATES.SOLD_OUT:
                return 'SOLD OUT';
            case STATES.NOT_YET_ON_SALE:
                return 'NOT YET ON SALE';
            case STATES.SALES_ENDED:
                return 'SALES ENDED';
            case STATES.UNAVAILABLE:
                return 'UNAVAILABLE';
            default:
                return 'UNKNOWN';
        }
    }

    /** The three-value status the minimal panel shows. */
    function panelStatusLabel(state) {
        if (state === STATES.AVAILABLE) return 'AVAILABLE';
        if (state === STATES.AVAILABLE_UNCONFIRMED) return 'AVAILABLE?';
        if (state === STATES.SOLD_OUT) return 'SOLD OUT';
        return 'UNKNOWN';
    }

    // =====================================================================
    // Node export hook — lets tests require this file without booting the UI.
    // =====================================================================
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            STATES: STATES,
            ALERT_STATES: ALERT_STATES,
            parseNextData: parseNextData,
            parseServerData: parseServerData,
            parseJsonLd: parseJsonLd,
            classifySalesStatus: classifySalesStatus,
            classifyOfferAvailability: classifyOfferAvailability,
            detectFromListingHtml: detectFromListingHtml,
            detectFromCheckoutHtml: detectFromCheckoutHtml,
            detectFromCheckoutData: detectFromCheckoutData,
            combineSignals: combineSignals,
            shouldNotify: shouldNotify,
            describeState: describeState,
            clampIntervalSeconds: clampIntervalSeconds,
            backoffDelayMs: backoffDelayMs,
            describeHttpError: describeHttpError,
            formatLogLine: formatLogLine,
            logStateLabel: logStateLabel,
            panelStatusLabel: panelStatusLabel,
            clockTime: clockTime,
            DEFAULTS: DEFAULTS
        };
        return;
    }

    // =====================================================================
    // 3. STORAGE
    // =====================================================================

    function gmGet(key, fallback) {
        try {
            const raw = GM_getValue(key, null);
            if (raw === null || raw === undefined) return fallback;
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            return fallback;
        }
    }

    function gmSet(key, value) {
        try {
            GM_setValue(key, JSON.stringify(value));
        } catch (e) {
            console.error('[EBM] storage write failed', e);
        }
    }

    function loadConfig() {
        const c = gmGet(K.config, {});
        // Migrate v1 configs, which stored the interval in minutes.
        let seconds = c.intervalSeconds;
        if (seconds === undefined && typeof c.intervalMinutes === 'number') {
            seconds = c.intervalMinutes * 60;
        }
        return {
            intervalSeconds: clampIntervalSeconds(seconds),
            monitoring: c.monitoring === true,
            telegramToken: typeof c.telegramToken === 'string' ? c.telegramToken : '',
            telegramChatId: typeof c.telegramChatId === 'string' ? c.telegramChatId : '',
            browserNotifications: c.browserNotifications !== false,
            sound: c.sound !== false,
            deepVerify: c.deepVerify !== false
        };
    }

    function saveConfig(patch) {
        const merged = Object.assign(loadConfig(), patch || {});
        merged.intervalSeconds = clampIntervalSeconds(merged.intervalSeconds);
        delete merged.intervalMinutes;
        gmSet(K.config, merged);
        return merged;
    }

    function loadStatus() {
        return gmGet(K.status, {
            state: null,
            verified: false,
            lastSuccessAt: null,
            lastAttemptAt: null,
            nextCheckAt: null,
            lastOk: null,
            lastError: null,
            lastHttp: null,
            successCount: 0,
            failureCount: 0,
            consecutiveFailures: 0,
            lastNotifiedState: null,
            lastNotifiedAt: null
        });
    }

    function saveStatus(patch) {
        const merged = Object.assign(loadStatus(), patch || {});
        gmSet(K.status, merged);
        return merged;
    }

    // ---------------------------------------------------------------- log

    function loadLog() {
        const l = gmGet(K.log, []);
        return Array.isArray(l) ? l : [];
    }

    function appendLog(entry) {
        const log = loadLog();
        log.push(entry);
        // Keep the newest N entries so storage cannot grow without bound.
        const trimmed =
            log.length > DEFAULTS.maxLogEntries
                ? log.slice(log.length - DEFAULTS.maxLogEntries)
                : log;
        gmSet(K.log, trimmed);
        return trimmed;
    }

    function buildLogText() {
        const log = loadLog();
        const st = loadStatus();
        const header = [
            'Booking Availability Monitor — check log',
            'Event : ' + EVENT_NAME_FULL,
            'URL   : ' + EVENT_URL,
            'Export: ' + new Date().toString(),
            'Totals: ' + (st.successCount || 0) + ' successful, ' + (st.failureCount || 0) + ' failed',
            'Entries: ' + log.length + ' (most recent ' + DEFAULTS.maxLogEntries + ' kept)',
            ''.padEnd(60, '-'),
            ''
        ].join('\n');
        return header + log.map(formatLogLine).join('\n') + '\n';
    }

    function downloadLog() {
        try {
            const blob = new Blob([buildLogText()], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const d = new Date();
            const stamp =
                d.getFullYear() +
                pad2(d.getMonth() + 1) +
                pad2(d.getDate()) +
                '-' +
                pad2(d.getHours()) +
                pad2(d.getMinutes()) +
                pad2(d.getSeconds());
            const a = document.createElement('a');
            a.href = url;
            a.download = 'booking-monitor-log-' + stamp + '.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 2000);
            return true;
        } catch (e) {
            console.error('[EBM] log download failed', e);
            return false;
        }
    }

    // =====================================================================
    // 4. NETWORK
    // =====================================================================

    /** Resolves {status, text}; rejects with an Error carrying .status. */
    function httpGet(url) {
        return new Promise(function (resolve, reject) {
            let settled = false;
            const fail = function (msg, status) {
                if (settled) return;
                settled = true;
                const err = new Error(msg);
                err.status = status || 0;
                reject(err);
            };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: DEFAULTS.requestTimeoutMs,
                    headers: { Accept: 'text/html,application/xhtml+xml' },
                    onload: function (res) {
                        if (settled) return;
                        if (res.status >= 200 && res.status < 300) {
                            settled = true;
                            resolve({ status: res.status, text: res.responseText || '' });
                        } else {
                            fail(describeHttpError(res.status), res.status);
                        }
                    },
                    onerror: function () {
                        fail('Network error', 0);
                    },
                    ontimeout: function () {
                        fail('Request timeout', 0);
                    },
                    onabort: function () {
                        fail('Request aborted', 0);
                    }
                });
            } catch (e) {
                fail(e.message || 'Request failed', 0);
            }
        });
    }

    function sendTelegram(token, chatId, text) {
        return new Promise(function (resolve, reject) {
            if (!token || !chatId) {
                reject(new Error('Telegram bot token and chat ID are both required'));
                return;
            }
            let settled = false;
            const done = function (fn, arg) {
                if (settled) return;
                settled = true;
                fn(arg);
            };
            try {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://api.telegram.org/bot' + token + '/sendMessage',
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({
                        chat_id: chatId,
                        text: text,
                        parse_mode: 'HTML',
                        disable_web_page_preview: false
                    }),
                    timeout: DEFAULTS.requestTimeoutMs,
                    onload: function (res) {
                        let parsed = null;
                        try {
                            parsed = JSON.parse(res.responseText);
                        } catch (e) {
                            /* non-JSON body */
                        }
                        if (res.status >= 200 && res.status < 300 && parsed && parsed.ok) {
                            done(resolve, parsed);
                        } else {
                            done(
                                reject,
                                new Error(
                                    'Telegram API: ' +
                                        ((parsed && parsed.description) ||
                                            'HTTP ' + res.status)
                                )
                            );
                        }
                    },
                    onerror: function () {
                        done(reject, new Error('Telegram request failed'));
                    },
                    ontimeout: function () {
                        done(reject, new Error('Telegram request timed out'));
                    }
                });
            } catch (e) {
                done(reject, e);
            }
        });
    }

    // =====================================================================
    // 5. NOTIFICATIONS  (unchanged behaviour from v1)
    // =====================================================================

    function playAlertSound() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            [880, 1174.66, 1318.51].forEach(function (freq, i) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const start = ctx.currentTime + i * 0.22;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.35, start + 0.03);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(start);
                osc.stop(start + 0.22);
            });
            setTimeout(function () {
                try { ctx.close(); } catch (e) { /* noop */ }
            }, 1500);
        } catch (e) {
            console.warn('[EBM] alert sound failed', e);
        }
    }

    function showDesktopNotification(title, body) {
        if (!loadConfig().browserNotifications) return;
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({
                    title: title,
                    text: body,
                    timeout: 0,
                    onclick: function () {
                        try { window.focus(); } catch (e) { /* noop */ }
                        window.open(EVENT_URL, '_blank');
                    }
                });
                return;
            }
        } catch (e) {
            console.warn('[EBM] GM_notification failed', e);
        }
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                const n = new Notification(title, { body: body, requireInteraction: true });
                n.onclick = function () {
                    window.focus();
                    window.open(EVENT_URL, '_blank');
                };
            }
        } catch (e) {
            console.warn('[EBM] Notification API failed', e);
        }
    }

    function requestNotificationPermission() {
        try {
            if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
            if (Notification.permission === 'granted') return Promise.resolve('granted');
            return Notification.requestPermission();
        } catch (e) {
            return Promise.resolve('error');
        }
    }

    function escapeHtml(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeAttr(s) {
        return escapeHtml(s).replace(/"/g, '&quot;');
    }

    async function dispatchNotifications(result) {
        const cfg = loadConfig();
        const confirmed = result.state === STATES.AVAILABLE;
        const title = confirmed
            ? 'TICKETS AVAILABLE — LDS Part 2 Feb 2027'
            : 'Possible availability — LDS Part 2 Feb 2027';
        const verified = result.verified
            ? 'Verified against Eventbrite ticket inventory.'
            : 'NOT verified — check the page yourself.';

        showDesktopNotification(title, verified + '\n' + EVENT_URL);
        if (cfg.sound) playAlertSound();

        let telegram = 'skipped (not configured)';
        if (cfg.telegramToken && cfg.telegramChatId) {
            try {
                await sendTelegram(
                    cfg.telegramToken,
                    cfg.telegramChatId,
                    (confirmed ? '🎟️ <b>TICKETS AVAILABLE</b>' : '⚠️ <b>POSSIBLY AVAILABLE</b>') +
                        '\n\n' +
                        escapeHtml(EVENT_NAME_FULL) +
                        '\n' +
                        (result.verified ? '✅ ' : '❓ ') +
                        verified +
                        '\n\n<a href="' + EVENT_URL + '">Open the booking page</a>'
                );
                telegram = 'sent';
            } catch (e) {
                telegram = 'failed: ' + e.message;
                console.error('[EBM] Telegram failed', e);
            }
        }

        saveStatus({ lastNotifiedState: result.state, lastNotifiedAt: Date.now() });
        return telegram;
    }

    // =====================================================================
    // 6. CHECK CYCLE
    // =====================================================================

    const TAB_ID = Math.random().toString(36).slice(2) + '-' + Date.now();
    let inFlight = false;
    let heartbeatTimer = null;

    function acquireLock() {
        const lock = gmGet(K.lock, null);
        const now = Date.now();
        if (lock && lock.owner !== TAB_ID && now - lock.at < DEFAULTS.lockTtlMs) return false;
        gmSet(K.lock, { owner: TAB_ID, at: now });
        return true;
    }

    function releaseLock() {
        const lock = gmGet(K.lock, null);
        if (lock && lock.owner === TAB_ID) gmSet(K.lock, null);
    }

    async function runCheck(manual) {
        if (inFlight) return { skipped: 'already-running' };
        if (!manual && !acquireLock()) return { skipped: 'another-tab-holds-lock' };

        inFlight = true;
        refreshDynamic();

        const cfg = loadConfig();
        const prev = loadStatus();
        const now = Date.now();

        let ok = false;
        let httpStatus = null;
        let errorMsg = null;
        let result = null;

        try {
            // ---- listing read (one request per cycle in the steady state) ----
            const res = await httpGet(EVENT_URL + '?_ebm=' + now);
            httpStatus = res.status;
            const listing = detectFromListingHtml(res.text);

            if (listing.confidence === 'none') {
                // 200 OK, but nothing readable in it — a bot check, a queue page
                // or a layout change. That is NOT fresh data, so it is a failure.
                errorMsg = 'Could not read availability (page blocked or changed)';
                result = { state: STATES.UNKNOWN, confidence: 'none', verified: false,
                           listing: listing, checkout: null };
            } else {
                // ---- inventory verification, only when it might matter --------
                let checkout = null;
                if (cfg.deepVerify && ALERT_STATES.indexOf(listing.state) !== -1) {
                    try {
                        const cres = await httpGet(CHECKOUT_URL);
                        checkout = detectFromCheckoutHtml(cres.text);
                    } catch (e) {
                        checkout = {
                            source: 'checkout', state: STATES.UNKNOWN, confidence: 'none',
                            selectable: false,
                            signals: { reason: 'checkout fetch failed: ' + e.message }
                        };
                    }
                }
                result = combineSignals(listing, checkout);
                ok = true;
            }
        } catch (e) {
            httpStatus = e.status || null;
            errorMsg = e.message || 'Request failed';
            result = { state: prev.state || STATES.UNKNOWN, confidence: 'none',
                       verified: false, listing: null, checkout: null };
        }

        const finishedAt = Date.now();
        const consecutiveFailures = ok ? 0 : (prev.consecutiveFailures || 0) + 1;
        const intervalMs = cfg.intervalSeconds * 1000;
        const delay = backoffDelayMs(consecutiveFailures, httpStatus, intervalMs);

        appendLog({
            at: finishedAt,
            ok: ok,
            http: httpStatus,
            state: ok ? result.state : null,
            error: ok ? null : errorMsg
        });

        // Availability only ever changes on a successful read, so a failed cycle
        // must never move the recorded state or fire an alert.
        const decision = ok
            ? shouldNotify(prev, result, finishedAt, DEFAULTS.notifyCooldownMs)
            : { notify: false, reason: 'check-failed' };

        saveStatus({
            state: ok ? result.state : prev.state,
            verified: ok ? result.verified : prev.verified,
            lastAttemptAt: finishedAt,
            lastSuccessAt: ok ? finishedAt : prev.lastSuccessAt,
            lastOk: ok,
            lastError: ok ? null : errorMsg,
            lastHttp: httpStatus,
            successCount: (prev.successCount || 0) + (ok ? 1 : 0),
            failureCount: (prev.failureCount || 0) + (ok ? 0 : 1),
            consecutiveFailures: consecutiveFailures,
            nextCheckAt: loadConfig().monitoring ? finishedAt + delay : null
        });

        if (decision.notify) await dispatchNotifications(result);

        inFlight = false;
        releaseLock();
        render();

        return { ok: ok, state: result.state, error: errorMsg, http: httpStatus,
                 notified: decision.notify, backoffMs: delay };
    }

    /**
     * Wall-clock heartbeat rather than one long timer: background tabs throttle
     * timers and a sleeping machine freezes them, so we compare now() against a
     * persisted deadline instead of trusting setTimeout to fire on schedule.
     */
    function heartbeat() {
        const cfg = loadConfig();
        if (!cfg.monitoring) {
            refreshDynamic();
            return;
        }
        const st = loadStatus();
        const now = Date.now();
        if (!st.nextCheckAt) {
            saveStatus({ nextCheckAt: now });
            return;
        }
        if (now >= st.nextCheckAt && !inFlight) {
            runCheck(false);
        } else {
            refreshDynamic();
        }
    }

    function startMonitoring() {
        saveConfig({ monitoring: true });
        saveStatus({ nextCheckAt: Date.now(), consecutiveFailures: 0 });
        render();
        heartbeat();
    }

    function stopMonitoring() {
        saveConfig({ monitoring: false });
        saveStatus({ nextCheckAt: null });
        releaseLock();
        render();
    }

    // =====================================================================
    // 7. MINIMAL PANEL
    // =====================================================================

    let shadow = null;
    let host = null;

    const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { position: fixed; right: 16px; bottom: 16px; width: 268px; z-index: 2147483647;
  background: #fff; color: #19202c; border: 1px solid #d9dee8; border-radius: 12px;
  box-shadow: 0 10px 30px rgba(16,24,40,.18); font-size: 13px; overflow: hidden; }
.wrap.collapsed .body { display: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
  background: #f7f9fc; border-bottom: 1px solid #e6ebf3; }
.head h1 { font-size: 11px; font-weight: 700; margin: 0; flex: 1; letter-spacing: .05em;
  text-transform: uppercase; color: #5b6677; cursor: pointer; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa4b8; flex: none; }
.dot.on { background: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,.18); }
.icon { border: 0; background: none; cursor: pointer; font-size: 12px; color: #8a94a8; padding: 2px 3px; }
.icon:hover { color: #19202c; }
.body { padding: 11px; }
.evt { font-size: 12px; font-weight: 600; color: #5b6677; margin-bottom: 9px; line-height: 1.35; }
.status { text-align: center; font-size: 19px; font-weight: 800; letter-spacing: .02em;
  padding: 11px 8px; border-radius: 9px; margin-bottom: 10px; }
.status.sold { background: #fee2e2; color: #7f1d1d; }
.status.avail { background: #dcfce7; color: #14532d; }
.status.maybe { background: #fef3c7; color: #78350f; }
.status.unknown { background: #e9edf3; color: #42506a; }
.row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; }
.k { color: #6b7488; }
.v { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.v.ok { color: #16a34a; }
.v.bad { color: #dc2626; }
.err { margin-top: 7px; padding: 6px 8px; background: #fef2f2; border: 1px solid #fecaca;
  color: #7f1d1d; border-radius: 6px; font-size: 11px; word-break: break-word; }
.btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 11px; }
button.b { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 8px; border-radius: 7px;
  border: 1px solid #d9dee8; background: #fff; color: #19202c; cursor: pointer; }
button.b:hover { background: #f3f6fb; }
button.b.go { background: #16a34a; border-color: #16a34a; color: #fff; }
button.b.go:hover { background: #15803d; }
button.b.stop { background: #dc2626; border-color: #dc2626; color: #fff; }
button.b.stop:hover { background: #b91c1c; }
button.b:disabled { opacity: .55; cursor: not-allowed; }
.wide { grid-column: 1 / -1; }
.settings { margin-top: 11px; padding-top: 10px; border-top: 1px solid #e6ebf3; }
.settings[hidden] { display: none; }
label { display: block; font-size: 10.5px; color: #6b7488; margin: 7px 0 2px; }
input { width: 100%; padding: 5px 7px; border: 1px solid #d9dee8; border-radius: 6px;
  font-size: 12px; background: #fff; color: #19202c; }
.note { font-size: 10px; color: #8a94a8; margin-top: 8px; line-height: 1.45; }
.toast { margin-top: 8px; font-size: 11px; padding: 5px 8px; border-radius: 6px; }
.toast.ok { background: #dcfce7; color: #14532d; }
.toast.bad { background: #fee2e2; color: #7f1d1d; }
@media (prefers-color-scheme: dark) {
  .wrap { background: #161c26; color: #e8ecf4; border-color: #2a3342; }
  .head { background: #1c2430; border-bottom-color: #2a3342; }
  .head h1 { color: #a3aec0; }
  .evt { color: #a3aec0; }
  .k { color: #9aa4b8; }
  .status.sold { background: #2e1416; color: #fca5a5; }
  .status.avail { background: #0f2e1c; color: #86efac; }
  .status.maybe { background: #2e2410; color: #fcd34d; }
  .status.unknown { background: #212a38; color: #b6c1d4; }
  button.b { background: #222935; border-color: #343d4d; color: #e8ecf4; }
  button.b:hover { background: #2a3240; }
  input { background: #1c2430; border-color: #343d4d; color: #e8ecf4; }
  .settings { border-top-color: #2a3342; }
}
`;

    function buildPanel() {
        host = document.createElement('div');
        host.id = 'ebm-monitor-host';
        shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = PANEL_CSS;
        shadow.appendChild(style);
        const wrap = document.createElement('div');
        wrap.className = 'wrap';
        shadow.appendChild(wrap);
        document.body.appendChild(host);
        render();
    }

    let toastMsg = null;
    let toastOk = true;
    let settingsOpen = false;

    function toast(msg, ok) {
        toastMsg = msg;
        toastOk = ok !== false;
        render();
        setTimeout(function () {
            toastMsg = null;
            render();
        }, 5000);
    }

    /** Full rebuild — only on structural changes, never on the 1s tick. */
    function render() {
        if (!shadow) return;
        const wrap = shadow.querySelector('.wrap');
        if (!wrap) return;
        const cfg = loadConfig();
        const collapsed = wrap.classList.contains('collapsed');

        wrap.innerHTML =
            '<div class="head">' +
              '<span class="dot" id="dot"></span>' +
              '<h1 data-act="collapse">Booking Monitor</h1>' +
              '<button class="icon" data-act="settings" title="Settings">&#9881;</button>' +
              '<button class="icon" data-act="collapse" title="Collapse">' + (collapsed ? '&#9650;' : '&#9660;') + '</button>' +
            '</div>' +
            '<div class="body">' +
              '<div class="evt">' + escapeHtml(EVENT_NAME) + '</div>' +
              '<div class="status unknown" id="status">UNKNOWN</div>' +
              '<div class="row"><span class="k">Monitoring</span><span class="v" id="mon">—</span></div>' +
              '<div class="row"><span class="k">Last refresh</span><span class="v" id="last">—</span></div>' +
              '<div class="row"><span class="k">Last result</span><span class="v" id="res">—</span></div>' +
              '<div class="row"><span class="k">Next refresh</span><span class="v" id="next">—</span></div>' +
              '<div class="row"><span class="k">Checks</span><span class="v" id="counts">—</span></div>' +
              '<div id="errbox"></div>' +
              '<div class="btns">' +
                '<button class="b" id="toggle" data-act="toggle">Start</button>' +
                '<button class="b" data-act="check">Check now</button>' +
                '<button class="b wide" data-act="logs">Download logs</button>' +
              '</div>' +
              '<div class="settings" id="settings"' + (settingsOpen ? '' : ' hidden') + '>' +
                '<label>Refresh interval (seconds, min ' + DEFAULTS.minIntervalSeconds + ')</label>' +
                '<input type="number" data-f="interval" min="' + DEFAULTS.minIntervalSeconds + '" max="' + DEFAULTS.maxIntervalSeconds + '" value="' + cfg.intervalSeconds + '">' +
                '<label>Telegram bot token</label>' +
                '<input type="password" data-f="token" placeholder="123456:ABC-DEF…" value="' + escapeAttr(cfg.telegramToken) + '">' +
                '<label>Telegram chat ID</label>' +
                '<input type="text" data-f="chat" placeholder="123456789" value="' + escapeAttr(cfg.telegramChatId) + '">' +
                '<div class="btns">' +
                  '<button class="b" data-act="save">Save</button>' +
                  '<button class="b" data-act="test-telegram">Test Telegram</button>' +
                  '<button class="b wide" data-act="test-browser">Test desktop notification</button>' +
                '</div>' +
                '<div class="note">Credentials stay in Tampermonkey storage on this computer. Treat the bot token like a password.</div>' +
              '</div>' +
              (toastMsg ? '<div class="toast ' + (toastOk ? 'ok' : 'bad') + '">' + escapeHtml(toastMsg) + '</div>' : '') +
            '</div>';

        if (collapsed) wrap.classList.add('collapsed');
        wireEvents(wrap);
        refreshDynamic();
    }

    /** Cheap per-second update — touches text only, so inputs keep focus. */
    function refreshDynamic() {
        if (!shadow) return;
        const q = function (id) { return shadow.getElementById(id); };
        const cfg = loadConfig();
        const st = loadStatus();
        const now = Date.now();

        const dot = q('dot');
        if (dot) dot.className = 'dot' + (cfg.monitoring ? ' on' : '');

        const statusEl = q('status');
        if (statusEl) {
            const label = panelStatusLabel(st.state);
            statusEl.textContent = label;
            statusEl.className =
                'status ' +
                (st.state === STATES.AVAILABLE ? 'avail'
                    : st.state === STATES.AVAILABLE_UNCONFIRMED ? 'maybe'
                    : st.state === STATES.SOLD_OUT ? 'sold' : 'unknown');
        }

        const mon = q('mon');
        if (mon) mon.textContent = cfg.monitoring ? (inFlight ? 'CHECKING…' : 'RUNNING') : 'STOPPED';

        const last = q('last');
        if (last) last.textContent = st.lastSuccessAt ? clockTime(st.lastSuccessAt) : '—';

        const res = q('res');
        if (res) {
            if (st.lastOk === true) {
                res.textContent = 'SUCCESS';
                res.className = 'v ok';
            } else if (st.lastOk === false) {
                res.textContent = 'FAILED';
                res.className = 'v bad';
            } else {
                res.textContent = '—';
                res.className = 'v';
            }
        }

        const next = q('next');
        if (next) {
            if (!cfg.monitoring || !st.nextCheckAt) {
                next.textContent = '—';
            } else if (inFlight) {
                next.textContent = 'checking…';
            } else {
                const secs = Math.max(0, Math.ceil((st.nextCheckAt - now) / 1000));
                next.textContent = secs + 's';
            }
        }

        const counts = q('counts');
        if (counts) {
            counts.innerHTML =
                '<span class="ok">' + (st.successCount || 0) + ' ok</span> / ' +
                '<span class="bad">' + (st.failureCount || 0) + ' failed</span>';
        }

        const errbox = q('errbox');
        if (errbox) {
            const backingOff = (st.consecutiveFailures || 0) > 0;
            errbox.innerHTML =
                st.lastOk === false && st.lastError
                    ? '<div class="err">' +
                      (st.lastHttp ? 'HTTP ' + st.lastHttp + ' — ' : '') +
                      escapeHtml(st.lastError) +
                      (backingOff
                          ? ' — backing off, ' + st.consecutiveFailures + ' consecutive failure' +
                            (st.consecutiveFailures === 1 ? '' : 's')
                          : '') +
                      '</div>'
                    : '';
        }

        const toggle = q('toggle');
        if (toggle) {
            toggle.textContent = cfg.monitoring ? 'Stop' : 'Start';
            toggle.className = 'b ' + (cfg.monitoring ? 'stop' : 'go');
        }
    }

    function wireEvents(wrap) {
        wrap.querySelectorAll('[data-act]').forEach(function (el) {
            el.addEventListener('click', async function (ev) {
                ev.stopPropagation();
                const act = el.getAttribute('data-act');

                if (act === 'collapse') {
                    wrap.classList.toggle('collapsed');
                    render();
                } else if (act === 'settings') {
                    settingsOpen = !settingsOpen;
                    render();
                } else if (act === 'toggle') {
                    if (loadConfig().monitoring) {
                        stopMonitoring();
                    } else {
                        const perm = await requestNotificationPermission();
                        if (perm !== 'granted' && perm !== 'unsupported') {
                            toast('Desktop notifications blocked — Telegram still works.', false);
                        }
                        startMonitoring();
                    }
                } else if (act === 'check') {
                    const r = await runCheck(true);
                    if (r && r.skipped) toast('Skipped: ' + r.skipped, false);
                } else if (act === 'logs') {
                    const n = loadLog().length;
                    if (!n) {
                        toast('No log entries yet.', false);
                    } else {
                        toast(downloadLog() ? 'Downloaded ' + n + ' entries.' : 'Download failed.', true);
                    }
                } else if (act === 'save') {
                    const g = function (f) { return wrap.querySelector('[data-f="' + f + '"]'); };
                    const before = loadConfig().intervalSeconds;
                    const cfg = saveConfig({
                        intervalSeconds: g('interval') ? g('interval').value : before,
                        telegramToken: g('token') ? g('token').value.trim() : '',
                        telegramChatId: g('chat') ? g('chat').value.trim() : ''
                    });
                    if (cfg.monitoring && cfg.intervalSeconds !== before) {
                        saveStatus({ nextCheckAt: Date.now() + cfg.intervalSeconds * 1000 });
                    }
                    toast('Saved — every ' + cfg.intervalSeconds + 's.', true);
                } else if (act === 'test-browser') {
                    const perm = await requestNotificationPermission();
                    showDesktopNotification('Test — Booking Monitor', 'Test notification.\n' + EVENT_URL);
                    if (loadConfig().sound) playAlertSound();
                    toast(perm === 'granted' || perm === 'unsupported'
                        ? 'Test notification sent.' : 'Permission is "' + perm + '".',
                        perm === 'granted' || perm === 'unsupported');
                } else if (act === 'test-telegram') {
                    const cfg = loadConfig();
                    if (!cfg.telegramToken || !cfg.telegramChatId) {
                        toast('Enter a token and chat ID, then Save.', false);
                        return;
                    }
                    try {
                        await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
                            '✅ <b>Booking Monitor test</b>\n' + escapeHtml(EVENT_NAME_FULL));
                        toast('Telegram test sent.', true);
                    } catch (e) {
                        toast(e.message, false);
                    }
                }
            });
        });
    }

    // =====================================================================
    // 8. BOOT
    // =====================================================================

    function boot() {
        if (window.top !== window.self) return;
        if (document.getElementById('ebm-monitor-host')) return;

        buildPanel();
        heartbeat();
        heartbeatTimer = setInterval(heartbeat, DEFAULTS.heartbeatMs);

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) heartbeat();
        });
        window.addEventListener('focus', heartbeat);
        window.addEventListener('online', heartbeat);
        window.addEventListener('beforeunload', function () {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            releaseLock();
        });

        console.info('[EBM] v2 loaded — interval ' + loadConfig().intervalSeconds + 's');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
