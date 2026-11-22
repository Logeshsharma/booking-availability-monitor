/**
 * Embeds the Eventbrite booking page and reloads that frame every 15 seconds,
 * leaving this page itself loaded.
 *
 * What this cannot do, and does not pretend to do: read anything inside the
 * frame. Eventbrite is a different origin, so the frame's document is walled
 * off (SecurityError on any access) and there is no Access-Control-Allow-Origin
 * header to make fetch work either. The frame can be shown and reloaded; it
 * cannot be inspected. Availability detection is the userscript's job.
 *
 * The reload works by building a fresh <iframe> and swapping it in once it has
 * loaded, rather than reassigning .src on the existing one. Two reasons:
 * assigning .src pushes an entry onto the iframe's session history, which
 * hijacks the browser Back button; and swapping on load means the old frame
 * stays visible until the new one is ready, so there is no blank flash.
 */

(function () {
    'use strict';

    var EVENT_URL =
        'https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810';

    var REFRESH_SECONDS = 60;
    var LOAD_TIMEOUT_MS = 20000;
    // Eventbrite is a Next.js app: its `load` event fires before React has
    // painted, so swapping the instant load fires shows a blank frame for a
    // moment. Hold the freshly loaded frame back briefly so it is painted
    // before it replaces the one on screen.
    var PAINT_SETTLE_MS = 2500;
    // Floor between a finished load and the next request, so a slow network
    // cannot turn the cycle into back-to-back page loads.
    var MIN_GAP_MS = 2000;
    var STORE_KEY = 'bam.frame.v1';
    var TICK_MS = 250;

    function $(id) { return document.getElementById(id); }
    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function clockTime(ts) {
        var d = new Date(ts);
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    // ---------------------------------------------------------------- state
    // Wrapped: storage throws in private windows and when site data is blocked.

    function readState() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            var o = raw ? JSON.parse(raw) : null;
            return o && typeof o === 'object' ? o : {};
        } catch (e) {
            return {};
        }
    }

    function writeState(o) {
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify(o));
        } catch (e) {
            /* page still works without persistence */
        }
    }

    // ---------------------------------------------------------------- links

    function wireLinks() {
        ['event-link', 'event-link-2', 'event-link-3'].forEach(function (id) {
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

    // ---------------------------------------------------------------- frame

    function start() {
        var wrap = $('framewrap');
        if (!wrap) return;

        var saved = readState();
        var count = typeof saved.count === 'number' ? saved.count : 0;
        var paused = saved.paused === true;

        var current = null;      // the <iframe> currently on screen
        var pending = null;      // the <iframe> loading in the background
        var pendingTimer = null;
        var paintTimer = null;
        var cycleStart = Date.now();
        var deadline = cycleStart + REFRESH_SECONDS * 1000;
        var lastLoadAt = null;

        var lastEl = $('r-last');
        var nextEl = $('r-next');
        var countEl = $('r-count');
        var dotEl = $('r-dot');
        var btnEl = $('r-toggle');
        var errEl = $('frame-error');

        function makeFrame() {
            var f = document.createElement('iframe');
            f.className = 'ebframe';
            f.title = 'Eventbrite booking page for the LDS Part 2 Exam, February 2027';
            // Cache-buster: the page is served through CloudFront with
            // s-maxage=300, so without this the browser may hand back a cached
            // copy and the "refresh" would show stale content.
            f.src = EVENT_URL + '?_r=' + Date.now();
            return f;
        }

        function hideUntilReady(f) {
            // Stacked on top would cover the old frame while still blank, so
            // keep the incoming frame invisible until the swap.
            f.style.visibility = 'hidden';
        }

        function reveal(f) {
            f.style.visibility = '';
        }

        function showError(on) {
            if (errEl) errEl.hidden = !on;
        }

        function paint() {
            if (dotEl) dotEl.className = 'rdot' + (paused ? ' paused' : '');
            if (btnEl) {
                btnEl.textContent = paused ? 'Resume' : 'Pause';
                btnEl.setAttribute('aria-pressed', paused ? 'true' : 'false');
            }
            if (countEl) countEl.textContent = String(count);
            if (lastEl) {
                lastEl.textContent = lastLoadAt ? clockTime(lastLoadAt) : 'loading…';
            }
            if (!nextEl) return;
            if (paused) { nextEl.textContent = 'paused'; return; }
            if (pending) { nextEl.textContent = 'refreshing…'; return; }
            // Measured against the wall clock, not by counting ticks, so a
            // throttled background tab cannot desync the countdown.
            nextEl.textContent = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + 's';
        }

        function settle(frame, ok) {
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
            if (pending !== frame) return;      // superseded
            pending = null;

            if (ok) {
                reveal(frame);
                if (current && current.parentNode) current.parentNode.removeChild(current);
                frame.classList.add('live');
                current = frame;
                lastLoadAt = Date.now();
                count += 1;
                writeState({ count: count, paused: paused });
                showError(false);
            } else {
                // Keep whatever is already on screen; just drop the failed frame.
                if (frame.parentNode) frame.parentNode.removeChild(frame);
                showError(!current);
            }
            // The cadence is measured from when the request went out, not from
            // when it came back, so "every 15 seconds" stays true regardless of
            // how long Eventbrite took — with a floor so a slow load cannot
            // trigger an immediate re-request.
            deadline = Math.max(
                cycleStart + REFRESH_SECONDS * 1000,
                Date.now() + MIN_GAP_MS
            );
            paint();
        }

        function refresh() {
            if (pending) return;                 // never stack loads
            cycleStart = Date.now();
            var f = makeFrame();
            pending = f;
            // The load event fires for cross-origin frames even though their
            // contents are unreadable, so it is a genuine signal that a fresh
            // document finished loading.
            f.addEventListener('load', function () {
                if (pending !== f) return;
                paintTimer = setTimeout(function () { settle(f, true); }, PAINT_SETTLE_MS);
            });
            f.addEventListener('error', function () { settle(f, false); });
            pendingTimer = setTimeout(function () { settle(f, false); }, LOAD_TIMEOUT_MS);
            hideUntilReady(f);
            wrap.appendChild(f);
            paint();
        }

        function tick() {
            paint();
            if (paused || pending) return;
            if (Date.now() >= deadline) refresh();
        }

        if (btnEl) {
            btnEl.addEventListener('click', function () {
                paused = !paused;
                if (!paused) deadline = Date.now() + REFRESH_SECONDS * 1000;
                writeState({ count: count, paused: paused });
                paint();
            });
        }

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) tick();
        });

        refresh();                 // first load immediately
        setInterval(tick, TICK_MS);
        paint();
    }

    function init() {
        wireLinks();
        start();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
