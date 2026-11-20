/**
 * Dashboard behaviour for the Booking Availability Monitor.
 *
 * Deliberately small. This page is a setup and information surface: it cannot
 * read Tampermonkey storage, it cannot see the Eventbrite page, and it does not
 * fabricate monitoring data. Everything here either links somewhere real or
 * tests something that genuinely happens in this browser, on this origin.
 */

(function () {
    'use strict';

    var EVENT_ID = '2004570995810';
    var EVENT_URL =
        'https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-' +
        EVENT_ID;
    var REPO_URL = 'https://github.com/Logeshsharma/booking-availability-monitor';
    var SCRIPT_PATH = 'userscript/booking-monitor.user.js';

    function $(id) {
        return document.getElementById(id);
    }

    function setText(id, text) {
        var el = $(id);
        if (el) el.textContent = text;
    }

    // ---------------------------------------------------------------- links

    function wireLinks() {
        ['event-link', 'event-link-2'].forEach(function (id) {
            var el = $(id);
            if (el) {
                el.href = EVENT_URL;
                el.target = '_blank';
                el.rel = 'noopener';
            }
        });

        var src = $('source-link');
        if (src) src.href = REPO_URL + '/blob/main/' + SCRIPT_PATH;

        // Serve the installer from wherever this page is actually hosted, so it
        // works identically on GitHub Pages and from a local file.
        var install = $('install-link');
        if (install) {
            install.href = new URL(SCRIPT_PATH, window.location.href).href;
        }

        var repoLine = $('repo-line');
        if (repoLine) {
            repoLine.innerHTML =
                'Source: <a href="' + REPO_URL + '" target="_blank" rel="noopener">' +
                REPO_URL.replace('https://', '') +
                '</a>';
        }
    }

    // --------------------------------------------------- notification check

    function describePermission(p) {
        switch (p) {
            case 'granted':
                return { label: 'granted', colour: 'var(--ok)' };
            case 'denied':
                return { label: 'blocked', colour: 'var(--bad)' };
            case 'default':
                return { label: 'not yet asked', colour: 'var(--warn)' };
            default:
                return { label: 'not supported in this browser', colour: 'var(--text-faint)' };
        }
    }

    function refreshPermission() {
        var supported = typeof window.Notification !== 'undefined';
        var perm = supported ? Notification.permission : 'unsupported';
        var d = describePermission(perm);
        setText('perm-state', d.label);
        var dot = $('perm-dot');
        if (dot) dot.style.background = d.colour;
        return perm;
    }

    function result(msg, ok) {
        var el = $('notify-result');
        if (!el) return;
        el.hidden = false;
        el.textContent = msg;
        el.style.color = ok ? 'var(--ok)' : 'var(--bad)';
    }

    function playAlertSound() {
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) {
                result('This browser has no Web Audio support, so no sound was played.', false);
                return false;
            }
            var ctx = new Ctx();
            [880, 1174.66, 1318.51].forEach(function (freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                var start = ctx.currentTime + i * 0.22;
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
            return true;
        } catch (e) {
            result('Could not play the alert sound: ' + e.message, false);
            return false;
        }
    }

    function fire() {
        try {
            var n = new Notification('Test — Booking Availability Monitor', {
                body:
                    'Notifications are working in this browser.\n' +
                    'The real alert will name the event and link to the booking page.',
                tag: 'bam-test',
                requireInteraction: false
            });
            n.onclick = function () {
                window.focus();
                window.open(EVENT_URL, '_blank', 'noopener');
            };
            result(
                'Test notification sent. If nothing appeared, check your operating system’s ' +
                    'notification settings and any Do Not Disturb / Focus mode.',
                true
            );
        } catch (e) {
            result('The browser refused to show the notification: ' + e.message, false);
        }
    }

    function wireTests() {
        var btn = $('test-notify');
        if (btn) {
            btn.addEventListener('click', function () {
                if (typeof window.Notification === 'undefined') {
                    result('This browser does not support the Notification API.', false);
                    return;
                }
                if (Notification.permission === 'granted') {
                    fire();
                    playAlertSound();
                    refreshPermission();
                    return;
                }
                if (Notification.permission === 'denied') {
                    result(
                        'Notifications are blocked for this site. Allow them in your browser’s ' +
                            'site settings (the icon at the left of the address bar), then try again. ' +
                            'Telegram alerts work regardless.',
                        false
                    );
                    return;
                }
                // Permission must be requested from a user gesture — this click.
                Notification.requestPermission().then(function (perm) {
                    refreshPermission();
                    if (perm === 'granted') {
                        fire();
                        playAlertSound();
                    } else {
                        result(
                            'Permission was not granted (' + perm + '), so no notification was shown.',
                            false
                        );
                    }
                });
            });
        }

        var sound = $('test-sound');
        if (sound) {
            sound.addEventListener('click', function () {
                if (playAlertSound()) {
                    result('Played the alert tone the monitor uses.', true);
                }
            });
        }
    }

    // ------------------------------------------------------------- startup

    function init() {
        wireLinks();
        refreshPermission();
        wireTests();

        // Keep the permission readout honest if the user changes it in another tab.
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) refreshPermission();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
