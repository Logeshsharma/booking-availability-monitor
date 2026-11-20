/**
 * Unit tests for the Eventbrite availability detection core.
 *
 * Run with:  node --test tests/
 *
 * These exercise the pure functions against HTML fixtures whose shape was
 * copied from the real Eventbrite responses for event 2004570995810
 * (captured 2026-11-20, while the event was sold out).
 *
 * No network access and no browser are required.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const D = require('../userscript/booking-monitor.user.js');
const S = D.STATES;

const FIX = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

// ---------------------------------------------------------------------------
test('parsers', async (t) => {
    await t.test('extracts __NEXT_DATA__ from a listing page', () => {
        const d = D.parseNextData(fixture('listing-sold-out.html'));
        assert.ok(d, 'payload should parse');
        assert.strictEqual(
            d.props.pageProps.context.salesStatus.salesStatus,
            'sold_out'
        );
    });

    await t.test('returns null when the page has no Next payload (blocked)', () => {
        assert.strictEqual(D.parseNextData(fixture('listing-blocked.html')), null);
    });

    await t.test('returns null for malformed input rather than throwing', () => {
        assert.strictEqual(D.parseNextData(null), null);
        assert.strictEqual(D.parseNextData(''), null);
        assert.strictEqual(
            D.parseNextData('<script id="__NEXT_DATA__">{not json</script>'),
            null
        );
    });

    await t.test('extracts __SERVER_DATA__ from the checkout widget', () => {
        const sd = D.parseServerData(fixture('checkout-sold-out.html'));
        assert.ok(sd);
        assert.strictEqual(sd.ticketAvailabilityInfo.is_sold_out, true);
        assert.strictEqual(sd.tickets[0].on_sale_status, 'SOLD_OUT');
    });

    await t.test('returns null when the checkout response is a queue page', () => {
        assert.strictEqual(D.parseServerData(fixture('checkout-blocked.html')), null);
    });

    await t.test('extracts JSON-LD offers', () => {
        const blobs = D.parseJsonLd(fixture('listing-sold-out.html'));
        assert.strictEqual(blobs.length, 1);
        assert.strictEqual(blobs[0].offers[0].availability, 'SoldOut');
    });
});

// ---------------------------------------------------------------------------
test('sales status classification', async (t) => {
    await t.test('maps known Eventbrite statuses', () => {
        assert.strictEqual(D.classifySalesStatus('sold_out'), S.SOLD_OUT);
        assert.strictEqual(D.classifySalesStatus('on_sale'), S.AVAILABLE_UNCONFIRMED);
        assert.strictEqual(D.classifySalesStatus('sales_ended'), S.SALES_ENDED);
        assert.strictEqual(D.classifySalesStatus('not_yet_on_sale'), S.NOT_YET_ON_SALE);
        assert.strictEqual(D.classifySalesStatus('unavailable'), S.UNAVAILABLE);
    });

    await t.test('an unrecognised status is UNKNOWN, never available', () => {
        assert.strictEqual(D.classifySalesStatus('some_new_status'), S.UNKNOWN);
        assert.strictEqual(D.classifySalesStatus(''), S.UNKNOWN);
        assert.strictEqual(D.classifySalesStatus(undefined), S.UNKNOWN);
    });

    await t.test('maps schema.org availability, including full URLs', () => {
        assert.strictEqual(D.classifyOfferAvailability('SoldOut'), S.SOLD_OUT);
        assert.strictEqual(D.classifyOfferAvailability('InStock'), S.AVAILABLE_UNCONFIRMED);
        assert.strictEqual(
            D.classifyOfferAvailability('https://schema.org/InStock'),
            S.AVAILABLE_UNCONFIRMED
        );
        assert.strictEqual(D.classifyOfferAvailability('WeirdValue'), S.UNKNOWN);
    });
});

// ---------------------------------------------------------------------------
test('listing page detection', async (t) => {
    await t.test('the real sold-out page reads as SOLD_OUT with high confidence', () => {
        const r = D.detectFromListingHtml(fixture('listing-sold-out.html'));
        assert.strictEqual(r.state, S.SOLD_OUT);
        assert.strictEqual(r.confidence, 'high');
        assert.strictEqual(r.signals.salesStatus, 'sold_out');
        assert.strictEqual(r.signals.offerAvailability, 'SoldOut');
        assert.strictEqual(r.signals.domSoldOutMarker, true);
    });

    await t.test('an on-sale page reads as AVAILABLE_UNCONFIRMED, not AVAILABLE', () => {
        // The listing alone must never assert real availability — the checkout
        // inventory check is what promotes this to AVAILABLE.
        const r = D.detectFromListingHtml(fixture('listing-on-sale.html'));
        assert.strictEqual(r.state, S.AVAILABLE_UNCONFIRMED);
        assert.strictEqual(r.confidence, 'high');
    });

    await t.test('not-yet-on-sale and sales-ended are distinct states', () => {
        assert.strictEqual(
            D.detectFromListingHtml(fixture('listing-not-yet-on-sale.html')).state,
            S.NOT_YET_ON_SALE
        );
        assert.strictEqual(
            D.detectFromListingHtml(fixture('listing-sales-ended.html')).state,
            S.SALES_ENDED
        );
    });

    await t.test('conflicting signals resolve to UNKNOWN, never to available', () => {
        // salesStatus says on_sale, JSON-LD still says SoldOut.
        const r = D.detectFromListingHtml(fixture('listing-conflict.html'));
        assert.strictEqual(r.state, S.UNKNOWN);
        assert.strictEqual(r.confidence, 'conflict');
    });

    await t.test('a lingering sold-out DOM marker vetoes an available reading', () => {
        const r = D.detectFromListingHtml(fixture('listing-stale-marker.html'));
        assert.strictEqual(r.state, S.UNKNOWN);
        assert.strictEqual(r.confidence, 'conflict');
    });

    await t.test('a bot-check page reads as UNKNOWN, not available', () => {
        const r = D.detectFromListingHtml(fixture('listing-blocked.html'));
        assert.strictEqual(r.state, S.UNKNOWN);
        assert.strictEqual(r.confidence, 'none');
    });

    await t.test('an unexpected page shape reads as UNKNOWN', () => {
        const r = D.detectFromListingHtml(fixture('listing-shape-changed.html'));
        assert.strictEqual(r.state, S.UNKNOWN);
        assert.strictEqual(r.confidence, 'none');
    });

    await t.test('falls back to raw JSON-LD when the Next payload lacks offers', () => {
        const html =
            '<script type="application/ld+json">{"@type":"Event","offers":{"availability":"InStock"}}</script>' +
            '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"context":{}}}}</script>';
        const r = D.detectFromListingHtml(html);
        assert.strictEqual(r.signals.offerAvailability, 'InStock');
        assert.strictEqual(r.state, S.AVAILABLE_UNCONFIRMED);
        assert.strictEqual(r.confidence, 'low');
    });
});

// ---------------------------------------------------------------------------
test('checkout inventory detection', async (t) => {
    await t.test('the real sold-out inventory reads as SOLD_OUT and not selectable', () => {
        const r = D.detectFromCheckoutHtml(fixture('checkout-sold-out.html'));
        assert.strictEqual(r.state, S.SOLD_OUT);
        assert.strictEqual(r.selectable, false);
        assert.strictEqual(r.signals.remainingCapacity, 0);
        assert.strictEqual(r.signals.selectableCount, 0);
    });

    await t.test('genuine availability reads as AVAILABLE and selectable', () => {
        const r = D.detectFromCheckoutHtml(fixture('checkout-available.html'));
        assert.strictEqual(r.state, S.AVAILABLE);
        assert.strictEqual(r.selectable, true);
        assert.strictEqual(r.confidence, 'high');
        assert.deepStrictEqual(r.signals.selectableNames, [
            'LDS Part 2 February 2027 Booking'
        ]);
    });

    await t.test(
        'a ticket row that renders but caps quantity at 0 is NOT availability',
        () => {
            // This is the "Book button exists but you cannot actually book" case.
            const r = D.detectFromCheckoutHtml(fixture('checkout-not-selectable.html'));
            assert.notStrictEqual(r.state, S.AVAILABLE);
            // The decisive per-ticket evidence outranks the aggregate
            // has_available_tickets flag, so this is a firm sold-out.
            assert.strictEqual(r.state, S.SOLD_OUT);
            assert.strictEqual(r.selectable, false);
            assert.strictEqual(r.signals.selectableCount, 0);
            assert.strictEqual(r.signals.hasAvailableTickets, true);
        }
    );

    await t.test('sold out with an open waitlist is still SOLD_OUT', () => {
        const r = D.detectFromCheckoutHtml(fixture('checkout-waitlist-open.html'));
        assert.strictEqual(r.state, S.SOLD_OUT);
        assert.strictEqual(r.selectable, false);
        assert.strictEqual(r.signals.waitlistEnabled, true);
    });

    await t.test('missing inventory flags give only a weak yes', () => {
        const r = D.detectFromCheckoutHtml(fixture('checkout-flags-missing.html'));
        assert.strictEqual(r.state, S.AVAILABLE_UNCONFIRMED);
        assert.strictEqual(r.confidence, 'low');
    });

    await t.test('an unreadable checkout response is UNKNOWN', () => {
        const r = D.detectFromCheckoutHtml(fixture('checkout-blocked.html'));
        assert.strictEqual(r.state, S.UNKNOWN);
        assert.strictEqual(r.selectable, false);
    });

    await t.test('a sold_out_with_waitlist ticket is never counted as selectable', () => {
        const r = D.detectFromCheckoutData({
            tickets: [
                {
                    name: 'T',
                    on_sale_status: 'AVAILABLE',
                    maximum_quantity_per_order: 5,
                    onsale_status: { sold_out_with_waitlist: true }
                }
            ],
            ticketAvailabilityInfo: { has_available_tickets: true }
        });
        assert.notStrictEqual(r.state, S.AVAILABLE);
    });
});

// ---------------------------------------------------------------------------
test('signal combination', async (t) => {
    const listingSold = D.detectFromListingHtml(fixture('listing-sold-out.html'));
    const listingOnSale = D.detectFromListingHtml(fixture('listing-on-sale.html'));
    const checkoutSold = D.detectFromCheckoutHtml(fixture('checkout-sold-out.html'));
    const checkoutAvail = D.detectFromCheckoutHtml(fixture('checkout-available.html'));
    const checkoutBlocked = D.detectFromCheckoutHtml(fixture('checkout-blocked.html'));

    await t.test('listing on-sale + checkout confirmed ⇒ AVAILABLE, verified', () => {
        const r = D.combineSignals(listingOnSale, checkoutAvail);
        assert.strictEqual(r.state, S.AVAILABLE);
        assert.strictEqual(r.verified, true);
    });

    await t.test('checkout sold-out overrides an optimistic listing', () => {
        const r = D.combineSignals(listingOnSale, checkoutSold);
        assert.strictEqual(r.state, S.SOLD_OUT);
        assert.strictEqual(r.verified, true);
    });

    await t.test('sold out everywhere stays sold out and unverified-by-default', () => {
        const r = D.combineSignals(listingSold, null);
        assert.strictEqual(r.state, S.SOLD_OUT);
        assert.strictEqual(r.verified, false);
    });

    await t.test(
        'listing says available but checkout unreadable ⇒ unconfirmed, never verified',
        () => {
            const r = D.combineSignals(listingOnSale, checkoutBlocked);
            assert.strictEqual(r.state, S.AVAILABLE_UNCONFIRMED);
            assert.strictEqual(r.verified, false);
        }
    );

    await t.test('sold-out listing + unreadable checkout stays sold out', () => {
        const r = D.combineSignals(listingSold, checkoutBlocked);
        assert.strictEqual(r.state, S.SOLD_OUT);
    });

    await t.test(
        'an on-sale listing is overruled when no ticket is actually orderable',
        () => {
            const checkoutTrap = D.detectFromCheckoutHtml(
                fixture('checkout-not-selectable.html')
            );
            const r = D.combineSignals(listingOnSale, checkoutTrap);
            assert.strictEqual(r.state, S.SOLD_OUT);
            assert.strictEqual(
                D.shouldNotify({ state: S.SOLD_OUT }, r, Date.now()).notify,
                false
            );
        }
    );
});

// ---------------------------------------------------------------------------
test('notification de-duplication', async (t) => {
    const now = 1_700_000_000_000;
    const avail = { state: S.AVAILABLE };
    const sold = { state: S.SOLD_OUT };

    await t.test('fires on the sold-out → available transition', () => {
        const d = D.shouldNotify({ state: S.SOLD_OUT }, avail, now);
        assert.strictEqual(d.notify, true);
        assert.match(d.reason, /^transition:SOLD_OUT->AVAILABLE$/);
    });

    await t.test('does not fire while availability merely persists', () => {
        const d = D.shouldNotify({ state: S.AVAILABLE }, avail, now);
        assert.strictEqual(d.notify, false);
        assert.strictEqual(d.reason, 'already-alerted-for-this-run');
    });

    await t.test('never fires for sold out, unknown or not-yet-on-sale', () => {
        assert.strictEqual(D.shouldNotify({ state: S.AVAILABLE }, sold, now).notify, false);
        assert.strictEqual(
            D.shouldNotify({ state: S.SOLD_OUT }, { state: S.UNKNOWN }, now).notify,
            false
        );
        assert.strictEqual(
            D.shouldNotify({ state: S.SOLD_OUT }, { state: S.NOT_YET_ON_SALE }, now).notify,
            false
        );
    });

    await t.test('fires on the very first observation if already available', () => {
        const d = D.shouldNotify(null, avail, now);
        assert.strictEqual(d.notify, true);
        assert.strictEqual(d.reason, 'initial-observation');
        const d2 = D.shouldNotify({ state: null }, avail, now);
        assert.strictEqual(d2.notify, true);
    });

    await t.test('stays silent on a first observation that is sold out', () => {
        assert.strictEqual(D.shouldNotify(null, sold, now).notify, false);
    });

    await t.test('cooldown suppresses a rapid repeat of the same alert', () => {
        const prev = {
            state: S.UNKNOWN,
            lastNotifiedState: S.AVAILABLE,
            lastNotifiedAt: now - 60_000
        };
        const d = D.shouldNotify(prev, avail, now, 10 * 60 * 1000);
        assert.strictEqual(d.notify, false);
        assert.strictEqual(d.reason, 'within-cooldown');
    });

    await t.test('the same alert fires again once the cooldown has elapsed', () => {
        const prev = {
            state: S.UNKNOWN,
            lastNotifiedState: S.AVAILABLE,
            lastNotifiedAt: now - 30 * 60 * 1000
        };
        assert.strictEqual(D.shouldNotify(prev, avail, now, 10 * 60 * 1000).notify, true);
    });

    await t.test(
        'a confirmed sold-out → available alerts even inside the cooldown',
        () => {
            // Regression: a blind spot (UNKNOWN) followed by a genuine reopening
            // must not be silenced just because we alerted recently.
            const prev = {
                state: S.SOLD_OUT,
                lastNotifiedState: S.AVAILABLE,
                lastNotifiedAt: now - 5_000
            };
            const d = D.shouldNotify(prev, avail, now, 10 * 60 * 1000);
            assert.strictEqual(d.notify, true);
            assert.strictEqual(d.reason, 'transition:SOLD_OUT->AVAILABLE');
        }
    );

    await t.test('an unconfirmed-availability transition still alerts', () => {
        const d = D.shouldNotify(
            { state: S.SOLD_OUT },
            { state: S.AVAILABLE_UNCONFIRMED },
            now
        );
        assert.strictEqual(d.notify, true);
    });

    await t.test('a flap back to sold out re-arms the alert', () => {
        // available → sold_out → available must alert the second time too.
        assert.strictEqual(D.shouldNotify({ state: S.AVAILABLE }, sold, now).notify, false);
        const d = D.shouldNotify(
            { state: S.SOLD_OUT, lastNotifiedState: S.AVAILABLE, lastNotifiedAt: now - 3_600_000 },
            avail,
            now,
            10 * 60 * 1000
        );
        assert.strictEqual(d.notify, true);
    });
});

// ---------------------------------------------------------------------------
test('refresh interval configuration', async (t) => {
    await t.test('defaults to 15 seconds for absent or nonsense input', () => {
        assert.strictEqual(D.clampIntervalSeconds(undefined), 15);
        assert.strictEqual(D.clampIntervalSeconds(null), 15);
        assert.strictEqual(D.clampIntervalSeconds('abc'), 15);
        assert.strictEqual(D.clampIntervalSeconds(0), 15);
        assert.strictEqual(D.clampIntervalSeconds(-5), 15);
    });

    await t.test('accepts valid custom intervals', () => {
        assert.strictEqual(D.clampIntervalSeconds(15), 15);
        assert.strictEqual(D.clampIntervalSeconds('60'), 60);
        assert.strictEqual(D.clampIntervalSeconds(30.4), 30);
    });

    await t.test('clamps below the floor and above the ceiling', () => {
        assert.strictEqual(D.clampIntervalSeconds(1), D.DEFAULTS.minIntervalSeconds);
        assert.strictEqual(D.clampIntervalSeconds(999999), D.DEFAULTS.maxIntervalSeconds);
    });

    await t.test('the shipped default really is 15 seconds', () => {
        assert.strictEqual(D.DEFAULTS.intervalSeconds, 15);
    });
});

// ---------------------------------------------------------------------------
test('back-off on repeated failures', async (t) => {
    const INTERVAL = 15000;

    await t.test('no failures ⇒ the plain configured interval', () => {
        assert.strictEqual(D.backoffDelayMs(0, null, INTERVAL), INTERVAL);
    });

    await t.test('failures grow the delay exponentially', () => {
        const d1 = D.backoffDelayMs(1, null, INTERVAL);
        const d2 = D.backoffDelayMs(2, null, INTERVAL);
        const d3 = D.backoffDelayMs(3, null, INTERVAL);
        assert.strictEqual(d1, D.DEFAULTS.backoffStartMs);
        assert.strictEqual(d2, D.DEFAULTS.backoffStartMs * 2);
        assert.strictEqual(d3, D.DEFAULTS.backoffStartMs * 4);
        assert.ok(d1 < d2 && d2 < d3, 'delay must increase');
    });

    await t.test('a rate limit backs off harder than a generic failure', () => {
        const generic = D.backoffDelayMs(1, 500, INTERVAL);
        const limited = D.backoffDelayMs(1, 429, INTERVAL);
        const blocked = D.backoffDelayMs(1, 403, INTERVAL);
        assert.ok(limited > generic, '429 must back off more than a 500');
        assert.ok(blocked > generic, '403 must back off more than a 500');
        assert.strictEqual(limited, D.DEFAULTS.rateLimitStartMs);
    });

    await t.test('the delay is capped so it never grows without bound', () => {
        assert.strictEqual(D.backoffDelayMs(50, 429, INTERVAL), D.DEFAULTS.backoffMaxMs);
        assert.strictEqual(D.backoffDelayMs(99, null, INTERVAL), D.DEFAULTS.backoffMaxMs);
    });

    await t.test('back-off is never shorter than the configured interval', () => {
        for (let f = 0; f <= 10; f++) {
            assert.ok(D.backoffDelayMs(f, null, INTERVAL) >= INTERVAL, 'failures=' + f);
        }
    });
});

// ---------------------------------------------------------------------------
test('HTTP error descriptions', async (t) => {
    await t.test('names rate limiting and blocking explicitly', () => {
        assert.match(D.describeHttpError(429), /rate limited/i);
        assert.match(D.describeHttpError(403), /blocked/i);
    });

    await t.test('does not repeat the status inside the message', () => {
        // formatLogLine and the panel render the status separately.
        assert.doesNotMatch(D.describeHttpError(429), /429/);
        assert.doesNotMatch(D.describeHttpError(503), /503/);
    });

    await t.test('describes server errors and unknown statuses', () => {
        assert.match(D.describeHttpError(503), /server error/i);
        assert.strictEqual(D.describeHttpError(418), 'HTTP 418');
    });

    await t.test('falls back to the supplied message when there is no status', () => {
        assert.strictEqual(D.describeHttpError(0, 'Request timeout'), 'Request timeout');
        assert.strictEqual(D.describeHttpError(null, 'Network error'), 'Network error');
        assert.strictEqual(D.describeHttpError(null), 'Request failed');
    });
});

// ---------------------------------------------------------------------------
test('log formatting', async (t) => {
    // 16:30:00 local time on a fixed date
    const at = new Date(2026, 10, 20, 16, 30, 0).getTime();

    await t.test('a successful check matches the required format', () => {
        assert.strictEqual(
            D.formatLogLine({ at, ok: true, http: 200, state: S.SOLD_OUT, error: null }),
            '[16:30:00] SUCCESS - SOLD OUT'
        );
        assert.strictEqual(
            D.formatLogLine({ at, ok: true, http: 200, state: S.AVAILABLE, error: null }),
            '[16:30:00] SUCCESS - AVAILABLE'
        );
    });

    await t.test('a failure without a status matches the required format', () => {
        assert.strictEqual(
            D.formatLogLine({ at, ok: false, http: null, state: null, error: 'Request timeout' }),
            '[16:30:00] ERROR - Request timeout'
        );
    });

    await t.test('a failure with a status includes it', () => {
        assert.strictEqual(
            D.formatLogLine({
                at, ok: false, http: 429, state: null,
                error: D.describeHttpError(429)
            }),
            '[16:30:00] ERROR (HTTP 429) - Rate limited by Eventbrite'
        );
    });

    await t.test('zero-pads the clock', () => {
        const early = new Date(2026, 10, 20, 9, 5, 3).getTime();
        assert.strictEqual(D.clockTime(early), '09:05:03');
    });

    await t.test('every state has a log label', () => {
        for (const st of Object.values(S)) {
            assert.ok(D.logStateLabel(st).length > 0, st);
        }
        assert.strictEqual(D.logStateLabel(S.AVAILABLE_UNCONFIRMED), 'AVAILABLE (UNCONFIRMED)');
    });
});

// ---------------------------------------------------------------------------
test('panel status collapses to three values', async (t) => {
    await t.test('SOLD OUT / AVAILABLE / UNKNOWN', () => {
        assert.strictEqual(D.panelStatusLabel(S.SOLD_OUT), 'SOLD OUT');
        assert.strictEqual(D.panelStatusLabel(S.AVAILABLE), 'AVAILABLE');
        assert.strictEqual(D.panelStatusLabel(S.AVAILABLE_UNCONFIRMED), 'AVAILABLE?');
        assert.strictEqual(D.panelStatusLabel(S.UNKNOWN), 'UNKNOWN');
        assert.strictEqual(D.panelStatusLabel(S.SALES_ENDED), 'UNKNOWN');
        assert.strictEqual(D.panelStatusLabel(null), 'UNKNOWN');
    });
});

// ---------------------------------------------------------------------------
test('state labels', async (t) => {
    await t.test('every state has a human-readable label', () => {
        for (const s of Object.values(S)) {
            const label = D.describeState(s);
            assert.ok(typeof label === 'string' && label.length > 0, s);
        }
        assert.strictEqual(D.describeState(S.AVAILABLE), 'Available');
        assert.strictEqual(
            D.describeState(S.AVAILABLE_UNCONFIRMED),
            'Possibly available (unconfirmed)'
        );
        assert.strictEqual(D.describeState('garbage'), 'Unknown');
    });
});

// ---------------------------------------------------------------------------
test('end-to-end: the event as it actually is today', async (t) => {
    await t.test(
        'real sold-out listing + real sold-out inventory ⇒ SOLD_OUT, no alert',
        () => {
            const listing = D.detectFromListingHtml(fixture('listing-sold-out.html'));
            const checkout = D.detectFromCheckoutHtml(fixture('checkout-sold-out.html'));
            const combined = D.combineSignals(listing, checkout);
            assert.strictEqual(combined.state, S.SOLD_OUT);
            const decision = D.shouldNotify({ state: S.SOLD_OUT }, combined, Date.now());
            assert.strictEqual(decision.notify, false);
        }
    );

    await t.test('the moment it opens ⇒ AVAILABLE, verified, exactly one alert', () => {
        const listing = D.detectFromListingHtml(fixture('listing-on-sale.html'));
        const checkout = D.detectFromCheckoutHtml(fixture('checkout-available.html'));
        const combined = D.combineSignals(listing, checkout);
        assert.strictEqual(combined.state, S.AVAILABLE);
        assert.strictEqual(combined.verified, true);

        const first = D.shouldNotify({ state: S.SOLD_OUT }, combined, Date.now());
        assert.strictEqual(first.notify, true);

        // The next cycle, still available, must stay quiet.
        const second = D.shouldNotify({ state: S.AVAILABLE }, combined, Date.now());
        assert.strictEqual(second.notify, false);
    });
});
