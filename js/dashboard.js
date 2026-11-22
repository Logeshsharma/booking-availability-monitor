/**
 * Install-page behaviour.
 *
 * Two jobs, both small:
 *   1. point the install/event links at the right places;
 *   2. reload this page every 15 seconds, with a visible countdown.
 *
 * What this does NOT do: check ticket availability. A page served from
 * github.io cannot read eventbrite.co.uk — Eventbrite sends no
 * Access-Control-Allow-Origin header, so fetch/XHR are blocked and an
 * embedded frame is unreadable. Availability checking is the userscript's
 * job. Nothing here is a reading of the booking page.
 */

(function () {
    'use strict';

    var EVENT_URL =
        'https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810';

    var REFRESH_SECONDS = 15;
    var STORE_KEY = 'bam.refresh.v1';
    var TICK_MS = 250;

    function $(id) { return document.getElementById(id); }

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function clockTime(ts) {
        var d = new Date(ts);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    // ------------------------------------------------------------- links

    function wireLinks() {
        ['event-link', 'event-link-2'].forEach(function (id) {
            var el = $(id);
            if (el) {
                el.href = EVENT_URL;
                el.target = '_blank';
                el.rel = 'noopener';
            }
        });

        var install = $('install-link');
        if (install) {
            install.href = new URL('userscript/booking-monitor.user.js', window.location.href).href;
        }
    }

    // ----------------------------------------------------------- storage
    // Wrapped because storage throws in private windows and when site data
    // is blocked; the countdown must still work if it is unavailable.

    function readState() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            if (!raw) return null;
            var o = JSON.parse(raw);
            return o && typeof o === 'object' ? o : null;
        } catch (e) {
            return null;
        }
    }

    function writeState(o) {
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify(o));
        } catch (e) {
            /* ignore — the page still works without persistence */
        }
    }

    // ----------------------------------------------------------- refresh

    function initRefresh() {
        var bar = $('refresh-bar');
        if (!bar) return;

        var loadedAt = Date.now();
        var prev = readState() || {};
        var count = (typeof prev.count === 'number' ? prev.count : 0) + 1;
        var paused = prev.paused === true;

        writeState({ count: count, paused: paused, lastAt: loadedAt });

        var deadline = loadedAt + REFRESH_SECONDS * 1000;
        var reloading = false;

        var lastEl = $('r-last');
        var nextEl = $('r-next');
        var countEl = $('r-count');
        var dotEl = $('r-dot');
        var btnEl = $('r-toggle');

        if (lastEl) lastEl.textContent = clockTime(loadedAt);
        if (countEl) countEl.textContent = String(count);

        function paint() {
            if (dotEl) dotEl.className = 'rdot' + (paused ? ' paused' : '');
            if (btnEl) {
                btnEl.textContent = paused ? 'Resume' : 'Pause';
                btnEl.setAttribute('aria-pressed', paused ? 'true' : 'false');
            }
            if (!nextEl) return;
            if (paused) {
                nextEl.textContent = 'paused';
                return;
            }
            // Compare against the wall clock rather than counting ticks, so a
            // throttled background tab or a sleeping machine cannot desync it.
            var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            nextEl.textContent = left + 's';
        }

        function tick() {
            paint();
            if (paused || reloading) return;
            if (Date.now() >= deadline) {
                reloading = true;
                if (nextEl) nextEl.textContent = 'refreshing…';
                window.location.reload();
            }
        }

        if (btnEl) {
            btnEl.addEventListener('click', function () {
                paused = !paused;
                if (!paused) deadline = Date.now() + REFRESH_SECONDS * 1000;
                var s = readState() || {};
                s.paused = paused;
                writeState(s);
                paint();
            });
        }

        paint();
        setInterval(tick, TICK_MS);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) tick();
        });
    }

    function init() {
        wireLinks();
        initRefresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
