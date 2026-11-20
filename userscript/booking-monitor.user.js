// ==UserScript==
// @name         Eventbrite Booking Monitor — LDS Part 2 Exam (Feb 2027)
// @namespace    https://logeshsharma.github.io/booking-availability-monitor/
// @version      1.0.0
// @description  Watches the RCS England "Licence in Dental Surgery Part 2 Exam February 2027" Eventbrite page and alerts (desktop + Telegram) only when tickets can genuinely be selected. Never auto-buys, never touches CAPTCHA or the waiting room.
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
    const EVENT_NAME = 'Licence in Dental Surgery Part 2 Exam February 2027';

    const CHECKOUT_URL =
        'https://www.eventbrite.co.uk/checkout-external?eid=' +
        EVENT_ID +
        '&parent=' +
        encodeURIComponent(EVENT_URL);

    const DEFAULTS = {
        intervalMinutes: 30,
        minIntervalMinutes: 5,   // politeness floor — do not hammer Eventbrite
        maxIntervalMinutes: 720,
        heartbeatMs: 15000,      // how often we *consider* checking (cheap, local)
        requestTimeoutMs: 25000,
        lockTtlMs: 120000,       // cross-tab lock lifetime
        notifyCooldownMs: 10 * 60 * 1000,
        staleFactor: 2.5,        // overdue by this × interval ⇒ warn the user
        lateFactor: 0.5          // a check landing this × interval late is 'late'
    };

    const K = {
        config: 'ebm.' + EVENT_ID + '.config',
        status: 'ebm.' + EVENT_ID + '.status',
        lock: 'ebm.' + EVENT_ID + '.lock',
        notified: 'ebm.' + EVENT_ID + '.notified',
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
    // Node export hook — lets tests/detection.test.js require this file
    // without booting any browser/Tampermonkey code.
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
            clampInterval: clampInterval,
            DEFAULTS: DEFAULTS
        };
        return; // never boot the UI under Node
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
        return {
            intervalMinutes: clampInterval(c.intervalMinutes),
            monitoring: c.monitoring === true,
            telegramToken: typeof c.telegramToken === 'string' ? c.telegramToken : '',
            telegramChatId: typeof c.telegramChatId === 'string' ? c.telegramChatId : '',
            browserNotifications: c.browserNotifications !== false,
            sound: c.sound !== false,
            deepVerify: c.deepVerify !== false,
            reloadOnCheck: c.reloadOnCheck === true
        };
    }

    function saveConfig(patch) {
        const merged = Object.assign(loadConfig(), patch || {});
        merged.intervalMinutes = clampInterval(merged.intervalMinutes);
        gmSet(K.config, merged);
        return merged;
    }

    function clampInterval(v) {
        const n = Number(v);
        if (!isFinite(n) || n <= 0) return DEFAULTS.intervalMinutes;
        return Math.min(
            DEFAULTS.maxIntervalMinutes,
            Math.max(DEFAULTS.minIntervalMinutes, Math.round(n))
        );
    }

    function loadStatus() {
        return gmGet(K.status, {
            state: null,
            confidence: null,
            verified: false,
            lastCheckedAt: null,
            nextCheckAt: null,
            lastError: null,
            lastNotifiedState: null,
            lastNotifiedAt: null,
            checkCount: 0,
            lastOverdueMs: 0,
            detail: null
        });
    }

    function saveStatus(patch) {
        const merged = Object.assign(loadStatus(), patch || {});
        gmSet(K.status, merged);
        return merged;
    }

    function pushLog(entry) {
        const log = gmGet(K.log, []);
        log.unshift(Object.assign({ at: Date.now() }, entry));
        gmSet(K.log, log.slice(0, 40));
    }

    // =====================================================================
    // 4. NETWORK
    // =====================================================================

    function httpGet(url) {
        return new Promise(function (resolve, reject) {
            let settled = false;
            const done = function (fn, arg) {
                if (settled) return;
                settled = true;
                fn(arg);
            };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: DEFAULTS.requestTimeoutMs,
                    headers: { Accept: 'text/html,application/xhtml+xml' },
                    onload: function (res) {
                        if (res.status >= 200 && res.status < 300) {
                            done(resolve, res.responseText || '');
                        } else {
                            done(reject, new Error('HTTP ' + res.status));
                        }
                    },
                    onerror: function () {
                        done(reject, new Error('network error'));
                    },
                    ontimeout: function () {
                        done(reject, new Error('timeout after ' + DEFAULTS.requestTimeoutMs + 'ms'));
                    },
                    onabort: function () {
                        done(reject, new Error('aborted'));
                    }
                });
            } catch (e) {
                done(reject, e);
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
            const body = JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: false
            });
            try {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: 'https://api.telegram.org/bot' + token + '/sendMessage',
                    headers: { 'Content-Type': 'application/json' },
                    data: body,
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
                            const desc =
                                (parsed && parsed.description) ||
                                'HTTP ' + res.status + ' ' + (res.responseText || '').slice(0, 160);
                            done(reject, new Error('Telegram API: ' + desc));
                        }
                    },
                    onerror: function () {
                        done(reject, new Error('Telegram request failed (network/CORS)'));
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
    // 5. NOTIFICATIONS
    // =====================================================================

    function playAlertSound() {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const notes = [880, 1174.66, 1318.51];
            notes.forEach(function (freq, i) {
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
            console.warn('[EBM] could not play alert sound', e);
        }
    }

    function showDesktopNotification(title, body) {
        const cfg = loadConfig();
        if (!cfg.browserNotifications) return;
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
            console.warn('[EBM] GM_notification failed, falling back', e);
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

    function buildAlertText(result) {
        const verified = result.verified
            ? 'Verified against Eventbrite ticket inventory.'
            : 'NOT fully verified — open the page and check before relying on this.';
        const names =
            result.checkout &&
            result.checkout.signals &&
            result.checkout.signals.selectableNames &&
            result.checkout.signals.selectableNames.length
                ? '\nTickets: ' + result.checkout.signals.selectableNames.join(', ')
                : '';
        return (
            describeState(result.state).toUpperCase() +
            '\n' +
            EVENT_NAME +
            names +
            '\n' +
            verified +
            '\n' +
            EVENT_URL
        );
    }

    function buildTelegramHtml(result) {
        const esc = function (s) {
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        };
        const head =
            result.state === STATES.AVAILABLE
                ? '🎟️ <b>TICKETS AVAILABLE</b>'
                : '⚠️ <b>POSSIBLY AVAILABLE (unconfirmed)</b>';
        const verified = result.verified
            ? '✅ Verified against Eventbrite ticket inventory'
            : '❓ Not fully verified — check the page yourself';
        const sig = result.checkout && result.checkout.signals;
        const extra =
            sig && sig.selectableNames && sig.selectableNames.length
                ? '\n<b>Tickets:</b> ' + esc(sig.selectableNames.join(', '))
                : '';
        const cap =
            sig && typeof sig.remainingCapacity === 'number'
                ? '\n<b>Remaining:</b> ' + sig.remainingCapacity
                : '';
        return (
            head +
            '\n\n' +
            esc(EVENT_NAME) +
            extra +
            cap +
            '\n' +
            verified +
            '\n\n' +
            '<a href="' + EVENT_URL + '">Open the booking page</a>\n' +
            '<i>' + esc(new Date().toLocaleString()) + '</i>'
        );
    }

    async function dispatchNotifications(result, reason) {
        const cfg = loadConfig();
        const title =
            result.state === STATES.AVAILABLE
                ? 'Tickets available — LDS Part 2 Feb 2027'
                : 'Possible availability — LDS Part 2 Feb 2027';

        showDesktopNotification(title, buildAlertText(result));
        if (cfg.sound) playAlertSound();

        let telegramOutcome = 'skipped (not configured)';
        if (cfg.telegramToken && cfg.telegramChatId) {
            try {
                await sendTelegram(cfg.telegramToken, cfg.telegramChatId, buildTelegramHtml(result));
                telegramOutcome = 'sent';
            } catch (e) {
                telegramOutcome = 'failed: ' + e.message;
                console.error('[EBM] Telegram notification failed', e);
            }
        }

        saveStatus({
            lastNotifiedState: result.state,
            lastNotifiedAt: Date.now()
        });
        pushLog({
            kind: 'notify',
            state: result.state,
            reason: reason,
            telegram: telegramOutcome
        });
        return telegramOutcome;
    }

    // =====================================================================
    // 6. SCHEDULING + CHECK CYCLE
    // =====================================================================

    const TAB_ID = Math.random().toString(36).slice(2) + '-' + Date.now();
    let inFlight = false;
    let heartbeatTimer = null;

    function acquireLock() {
        const lock = gmGet(K.lock, null);
        const now = Date.now();
        if (lock && lock.owner !== TAB_ID && now - lock.at < DEFAULTS.lockTtlMs) {
            return false; // another tab is mid-check
        }
        gmSet(K.lock, { owner: TAB_ID, at: now });
        return true;
    }

    function releaseLock() {
        const lock = gmGet(K.lock, null);
        if (lock && lock.owner === TAB_ID) gmSet(K.lock, null);
    }

    function scheduleNext(fromMs) {
        const cfg = loadConfig();
        const base = typeof fromMs === 'number' ? fromMs : Date.now();
        const next = base + cfg.intervalMinutes * 60 * 1000;
        saveStatus({ nextCheckAt: next });
        return next;
    }

    async function runCheck(manual) {
        if (inFlight) {
            return { skipped: 'already-running' };
        }
        if (!manual && !acquireLock()) {
            return { skipped: 'another-tab-holds-lock' };
        }
        inFlight = true;
        render();

        const cfg = loadConfig();
        let result = null;
        let error = null;

        try {
            // ---- Listing read -------------------------------------------------
            // Prefer a background fetch: it costs one request, keeps the panel
            // alive, and avoids a reload loop. The live DOM is only used when the
            // fetch fails, because __NEXT_DATA__ in this tab is frozen at load.
            let listing = null;
            try {
                const html = await httpGet(EVENT_URL + '?_ebm=' + Date.now());
                listing = detectFromListingHtml(html);
            } catch (e) {
                error = 'listing fetch failed: ' + e.message;
                const liveHtml = document.documentElement
                    ? document.documentElement.outerHTML
                    : '';
                const fromDom = detectFromListingHtml(liveHtml);
                // Only trust the stale in-page copy to say "still sold out".
                listing =
                    ALERT_STATES.indexOf(fromDom.state) === -1
                        ? Object.assign(fromDom, { confidence: 'stale-dom' })
                        : { source: 'listing', state: STATES.UNKNOWN, confidence: 'none', signals: {} };
            }

            // ---- Checkout verification ---------------------------------------
            // Only when the cheap read suggests something other than a plain
            // sold-out, so the steady state stays at exactly one request / cycle.
            let checkout = null;
            const worthVerifying =
                cfg.deepVerify &&
                (ALERT_STATES.indexOf(listing.state) !== -1 ||
                    listing.state === STATES.UNKNOWN);

            if (worthVerifying) {
                try {
                    const chtml = await httpGet(CHECKOUT_URL);
                    checkout = detectFromCheckoutHtml(chtml);
                } catch (e) {
                    checkout = {
                        source: 'checkout',
                        state: STATES.UNKNOWN,
                        confidence: 'none',
                        selectable: false,
                        signals: { reason: 'checkout fetch failed: ' + e.message }
                    };
                }
            }

            result = combineSignals(listing, checkout);
        } catch (e) {
            error = e.message;
            result = {
                state: STATES.UNKNOWN,
                confidence: 'none',
                verified: false,
                listing: null,
                checkout: null
            };
        }

        const now = Date.now();
        const prev = loadStatus();
        const decision = shouldNotify(prev, result, now, DEFAULTS.notifyCooldownMs);

        // How far past its deadline did this check actually land? Background-tab
        // throttling and machine sleep both show up here. We persist it so the
        // panel can keep reporting the delay after the catch-up check has
        // already moved the deadline forward.
        const overdueBy =
            !manual && typeof prev.nextCheckAt === 'number' && prev.nextCheckAt > 0
                ? Math.max(0, now - prev.nextCheckAt)
                : 0;

        saveStatus({
            lastOverdueMs: overdueBy,
            state: result.state,
            confidence: result.confidence,
            verified: result.verified,
            lastCheckedAt: now,
            lastError: error,
            checkCount: (prev.checkCount || 0) + 1,
            detail: {
                listing: result.listing ? result.listing.signals : null,
                checkout: result.checkout ? result.checkout.signals : null
            }
        });
        pushLog({
            kind: 'check',
            state: result.state,
            confidence: result.confidence,
            verified: result.verified,
            error: error,
            notified: decision.notify,
            notifyReason: decision.reason
        });

        if (decision.notify) {
            await dispatchNotifications(result, decision.reason);
        }

        if (loadConfig().monitoring) scheduleNext(now);

        inFlight = false;
        releaseLock();
        render();

        if (cfg.reloadOnCheck && loadConfig().monitoring && !manual) {
            setTimeout(function () {
                location.reload();
            }, 3000);
        }

        return { result: result, notified: decision.notify, error: error };
    }

    /**
     * Heartbeat rather than one long timer: background tabs throttle timers to
     * ~1/minute and a sleeping machine freezes them entirely, so we compare
     * wall-clock time against a persisted deadline on every tick instead of
     * trusting setTimeout to fire on schedule.
     */
    function heartbeat() {
        const cfg = loadConfig();
        if (!cfg.monitoring) {
            render();
            return;
        }
        const st = loadStatus();
        const now = Date.now();
        if (!st.nextCheckAt) {
            scheduleNext(now - cfg.intervalMinutes * 60 * 1000);
            return;
        }
        if (now >= st.nextCheckAt && !inFlight) {
            runCheck(false);
        } else {
            render();
        }
    }

    function startMonitoring() {
        saveConfig({ monitoring: true });
        const st = loadStatus();
        if (!st.lastCheckedAt) {
            runCheck(false);
        } else {
            scheduleNext(Date.now());
        }
        render();
    }

    function stopMonitoring() {
        saveConfig({ monitoring: false });
        saveStatus({ nextCheckAt: null });
        releaseLock();
        render();
    }

    function isStale() {
        const cfg = loadConfig();
        if (!cfg.monitoring) return false;
        const st = loadStatus();
        if (!st.nextCheckAt) return false;
        return Date.now() > st.nextCheckAt + cfg.intervalMinutes * 60 * 1000 * (DEFAULTS.staleFactor - 1);
    }

    // =====================================================================
    // 7. FLOATING PANEL  (Shadow DOM so Eventbrite's CSS cannot touch it)
    // =====================================================================

    let shadow = null;
    let host = null;

    const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { position: fixed; right: 16px; bottom: 16px; width: 310px; z-index: 2147483647;
  background: #ffffff; color: #1f2430; border: 1px solid #d9dee8; border-radius: 12px;
  box-shadow: 0 10px 30px rgba(16,24,40,.18); font-size: 13px; overflow: hidden; }
.wrap.collapsed .body { display: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer;
  background: #f7f9fc; border-bottom: 1px solid #e6ebf3; }
.head h1 { font-size: 12px; font-weight: 700; margin: 0; flex: 1; letter-spacing: .02em; text-transform: uppercase; color: #4a5468; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #9aa4b8; flex: none; }
.dot.on { background: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,.16); }
.dot.off { background: #9aa4b8; }
.chev { font-size: 11px; color: #8a94a8; }
.body { padding: 12px; }
.row { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; border-bottom: 1px dashed #edf1f7; }
.row:last-of-type { border-bottom: 0; }
.k { color: #6b7488; }
.v { font-weight: 600; text-align: right; word-break: break-word; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.badge.avail { background: #dcfce7; color: #14532d; }
.badge.maybe { background: #fef3c7; color: #78350f; }
.badge.sold { background: #fee2e2; color: #7f1d1d; }
.badge.unknown { background: #e5e7eb; color: #374151; }
.warn { margin-top: 8px; padding: 7px 9px; background: #fff7ed; border: 1px solid #fed7aa; color: #7c2d12; border-radius: 7px; font-size: 11.5px; }
.err { margin-top: 8px; padding: 7px 9px; background: #fef2f2; border: 1px solid #fecaca; color: #7f1d1d; border-radius: 7px; font-size: 11.5px; word-break: break-word; }
.btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
button { font: inherit; font-size: 12px; font-weight: 600; padding: 7px 8px; border-radius: 7px; border: 1px solid #d9dee8; background: #fff; color: #1f2430; cursor: pointer; }
button:hover { background: #f3f6fb; }
button.primary { background: #16a34a; border-color: #16a34a; color: #fff; }
button.primary:hover { background: #15803d; }
button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
button.danger:hover { background: #b91c1c; }
button:disabled { opacity: .55; cursor: not-allowed; }
.wide { grid-column: 1 / -1; }
fieldset { border: 1px solid #e6ebf3; border-radius: 8px; padding: 8px; margin: 10px 0 0; }
legend { font-size: 11px; color: #6b7488; padding: 0 4px; font-weight: 700; text-transform: uppercase; }
label { display: block; font-size: 11px; color: #6b7488; margin: 6px 0 2px; }
input[type=text], input[type=password], input[type=number] { width: 100%; padding: 6px 7px; border: 1px solid #d9dee8; border-radius: 6px; font-size: 12px; background: #fff; color: #1f2430; }
.check { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 11.5px; color: #4a5468; }
.check input { margin: 0; }
.note { font-size: 10.5px; color: #8a94a8; margin-top: 7px; line-height: 1.45; }
.toast { margin-top: 8px; font-size: 11.5px; padding: 6px 8px; border-radius: 6px; }
.toast.ok { background: #dcfce7; color: #14532d; }
.toast.bad { background: #fee2e2; color: #7f1d1d; }
@media (prefers-color-scheme: dark) {
  .wrap { background: #161a22; color: #e8ecf4; border-color: #2b3240; }
  .head { background: #1c222c; border-bottom-color: #2b3240; }
  .head h1 { color: #9aa4b8; }
  .row { border-bottom-color: #232a36; }
  .k { color: #9aa4b8; }
  button { background: #222935; border-color: #343d4d; color: #e8ecf4; }
  button:hover { background: #2a3240; }
  input[type=text], input[type=password], input[type=number] { background: #1c222c; border-color: #343d4d; color: #e8ecf4; }
  fieldset { border-color: #2b3240; }
}
`;

    function fmtTime(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function fmtRelative(ts) {
        if (!ts) return '—';
        const diff = ts - Date.now();
        const abs = Math.abs(diff);
        const mins = Math.round(abs / 60000);
        if (mins < 1) return diff >= 0 ? 'under a minute' : 'just now';
        const txt = mins < 60 ? mins + ' min' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
        return diff >= 0 ? 'in ' + txt : txt + ' ago';
    }

    function fmtDuration(ms) {
        const mins = Math.round((ms || 0) / 60000);
        if (mins < 1) return 'under a minute';
        if (mins < 60) return mins + ' min';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return h + 'h' + (m ? ' ' + m + 'm' : '');
    }

    function badgeClass(state) {
        if (state === STATES.AVAILABLE) return 'avail';
        if (state === STATES.AVAILABLE_UNCONFIRMED) return 'maybe';
        if (state === STATES.SOLD_OUT) return 'sold';
        return 'unknown';
    }

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
    function toast(msg, ok) {
        toastMsg = msg;
        toastOk = ok !== false;
        render();
        setTimeout(function () {
            toastMsg = null;
            render();
        }, 6000);
    }

    function render() {
        if (!shadow) return;
        const wrap = shadow.querySelector('.wrap');
        if (!wrap) return;

        const cfg = loadConfig();
        const st = loadStatus();
        const collapsed = wrap.classList.contains('collapsed');
        const state = st.state || STATES.UNKNOWN;
        const stale = isStale();
        const late =
            cfg.monitoring &&
            typeof st.lastOverdueMs === 'number' &&
            st.lastOverdueMs > cfg.intervalMinutes * 60 * 1000 * DEFAULTS.lateFactor;

        wrap.innerHTML =
            '<div class="head">' +
            '<span class="dot ' + (cfg.monitoring ? 'on' : 'off') + '"></span>' +
            '<h1>Booking Monitor</h1>' +
            '<span class="chev">' + (collapsed ? '▲' : '▼') + '</span>' +
            '</div>' +
            '<div class="body">' +
            row('Monitoring', cfg.monitoring ? (inFlight ? 'Checking…' : 'Active') : 'Stopped') +
            row('Availability', '<span class="badge ' + badgeClass(state) + '">' + describeState(state) + '</span>') +
            row('Verified', st.verified ? 'Yes — inventory checked' : 'No') +
            row('Last checked', st.lastCheckedAt ? fmtTime(st.lastCheckedAt) + ' (' + fmtRelative(st.lastCheckedAt) + ')' : 'Never') +
            row('Next check', cfg.monitoring && st.nextCheckAt ? fmtTime(st.nextCheckAt) + ' (' + fmtRelative(st.nextCheckAt) + ')' : '—') +
            row('Interval', cfg.intervalMinutes + ' min') +
            row('Checks run', String(st.checkCount || 0)) +
            (stale ? '<div class="warn"><b>Monitoring looks stalled.</b> The next check is overdue — the tab was probably throttled or the machine slept. It will catch up when this tab is active.</div>' : '') +
            (!stale && late ? '<div class="warn"><b>Last check ran ' + fmtDuration(st.lastOverdueMs) + ' late.</b> Background tabs get throttled and a sleeping machine freezes timers, so checks can drift. Keep this tab visible for closer-to-exact timing.</div>' : '') +
            (st.lastError ? '<div class="err"><b>Last error:</b> ' + escapeHtml(st.lastError) + '</div>' : '') +
            '<div class="btns">' +
            (cfg.monitoring
                ? '<button class="danger" data-act="stop">Stop</button>'
                : '<button class="primary" data-act="start">Start</button>') +
            '<button data-act="check"' + (inFlight ? ' disabled' : '') + '>Check now</button>' +
            '<button data-act="test-browser">Test desktop</button>' +
            '<button data-act="test-telegram">Test Telegram</button>' +
            '<button class="wide" data-act="open">Open booking page ↗</button>' +
            '</div>' +
            '<fieldset><legend>Settings</legend>' +
            '<label>Check interval (minutes, min ' + DEFAULTS.minIntervalMinutes + ')</label>' +
            '<input type="number" data-f="interval" min="' + DEFAULTS.minIntervalMinutes + '" max="' + DEFAULTS.maxIntervalMinutes + '" value="' + cfg.intervalMinutes + '">' +
            '<label>Telegram bot token</label>' +
            '<input type="password" data-f="token" placeholder="123456:ABC-DEF…" value="' + escapeAttr(cfg.telegramToken) + '">' +
            '<label>Telegram chat ID</label>' +
            '<input type="text" data-f="chat" placeholder="123456789" value="' + escapeAttr(cfg.telegramChatId) + '">' +
            '<div class="check"><input type="checkbox" data-f="browser"' + (cfg.browserNotifications ? ' checked' : '') + '><span>Desktop notifications</span></div>' +
            '<div class="check"><input type="checkbox" data-f="sound"' + (cfg.sound ? ' checked' : '') + '><span>Alert sound</span></div>' +
            '<div class="check"><input type="checkbox" data-f="deep"' + (cfg.deepVerify ? ' checked' : '') + '><span>Verify ticket inventory (recommended)</span></div>' +
            '<div class="check"><input type="checkbox" data-f="reload"' + (cfg.reloadOnCheck ? ' checked' : '') + '><span>Reload page after each check</span></div>' +
            '<div class="btns"><button class="wide" data-act="save">Save settings</button></div>' +
            '<div class="note">Credentials are stored only in Tampermonkey storage on this computer. Anyone with access to this browser profile can read them — treat the bot token like a password and revoke it in BotFather if it leaks.</div>' +
            '</fieldset>' +
            (toastMsg ? '<div class="toast ' + (toastOk ? 'ok' : 'bad') + '">' + escapeHtml(toastMsg) + '</div>' : '') +
            '<div class="note">This script never buys tickets and never touches CAPTCHA, login or the Eventbrite waiting room. It only reads public availability data.</div>' +
            '</div>';

        if (collapsed) wrap.classList.add('collapsed');
        wireEvents(wrap);
    }

    function row(k, v) {
        return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
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

    function wireEvents(wrap) {
        const head = wrap.querySelector('.head');
        if (head) {
            head.addEventListener('click', function () {
                wrap.classList.toggle('collapsed');
                render();
            });
        }

        wrap.querySelectorAll('[data-act]').forEach(function (btn) {
            btn.addEventListener('click', async function (ev) {
                ev.stopPropagation();
                const act = btn.getAttribute('data-act');

                if (act === 'start') {
                    const perm = await requestNotificationPermission();
                    if (perm !== 'granted' && perm !== 'unsupported') {
                        toast('Desktop notifications are blocked — Telegram still works.', false);
                    }
                    startMonitoring();
                } else if (act === 'stop') {
                    stopMonitoring();
                } else if (act === 'check') {
                    const r = await runCheck(true);
                    if (r && r.skipped) toast('Skipped: ' + r.skipped, false);
                    else if (r && r.error) toast('Checked with errors: ' + r.error, false);
                    else toast('Check complete.', true);
                } else if (act === 'open') {
                    window.open(EVENT_URL, '_blank');
                } else if (act === 'test-browser') {
                    const perm = await requestNotificationPermission();
                    showDesktopNotification(
                        'Test — Booking Monitor',
                        'This is a test notification.\n' + EVENT_NAME + '\n' + EVENT_URL
                    );
                    if (loadConfig().sound) playAlertSound();
                    toast(
                        perm === 'granted' || perm === 'unsupported'
                            ? 'Test notification sent.'
                            : 'Permission is "' + perm + '" — the OS may suppress it.',
                        perm === 'granted' || perm === 'unsupported'
                    );
                } else if (act === 'test-telegram') {
                    const cfg = loadConfig();
                    if (!cfg.telegramToken || !cfg.telegramChatId) {
                        toast('Enter a bot token and chat ID, then Save, then retry.', false);
                        return;
                    }
                    btn.disabled = true;
                    try {
                        await sendTelegram(
                            cfg.telegramToken,
                            cfg.telegramChatId,
                            '✅ <b>Booking Monitor test</b>\n\n' +
                                'Telegram notifications are working.\n' +
                                EVENT_NAME +
                                '\n<a href="' + EVENT_URL + '">Open the booking page</a>'
                        );
                        toast('Telegram test sent.', true);
                    } catch (e) {
                        toast(e.message, false);
                    } finally {
                        btn.disabled = false;
                    }
                } else if (act === 'save') {
                    const q = function (sel) {
                        return wrap.querySelector('[data-f="' + sel + '"]');
                    };
                    const before = loadConfig().intervalMinutes;
                    const cfg = saveConfig({
                        intervalMinutes: q('interval') ? q('interval').value : before,
                        telegramToken: q('token') ? q('token').value.trim() : '',
                        telegramChatId: q('chat') ? q('chat').value.trim() : '',
                        browserNotifications: q('browser') ? q('browser').checked : true,
                        sound: q('sound') ? q('sound').checked : true,
                        deepVerify: q('deep') ? q('deep').checked : true,
                        reloadOnCheck: q('reload') ? q('reload').checked : false
                    });
                    if (cfg.monitoring && cfg.intervalMinutes !== before) scheduleNext(Date.now());
                    toast('Settings saved (interval ' + cfg.intervalMinutes + ' min).', true);
                }
            });
        });
    }

    // =====================================================================
    // 8. BOOT
    // =====================================================================

    function boot() {
        if (window.top !== window.self) return; // belt and braces alongside @noframes
        if (document.getElementById('ebm-monitor-host')) return;

        buildPanel();

        // Catch up immediately if we came back from a refresh/sleep past the deadline.
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

        console.info(
            '[EBM] Booking monitor loaded for event ' + EVENT_ID + '. Monitoring=' + loadConfig().monitoring
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
