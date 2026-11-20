/**
 * Minimal install-page behaviour.
 *
 * This page is a static installation surface. It cannot read Tampermonkey
 * storage or see the Eventbrite tab, so it shows no monitoring data at all —
 * every live value lives in the panel on the Eventbrite page.
 */

(function () {
    'use strict';

    var EVENT_URL =
        'https://www.eventbrite.co.uk/e/licence-in-dental-surgery-part-2-exam-february-2027-tickets-2004570995810';

    function init() {
        ['event-link', 'event-link-2'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) {
                el.href = EVENT_URL;
                el.target = '_blank';
                el.rel = 'noopener';
            }
        });

        // Serve the installer from wherever this page is actually hosted, so it
        // works the same on GitHub Pages and from a local file.
        var install = document.getElementById('install-link');
        if (install) {
            install.href = new URL('userscript/booking-monitor.user.js', window.location.href).href;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
