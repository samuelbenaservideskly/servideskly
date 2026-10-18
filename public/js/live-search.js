/**
 * Search as you type, for a GET search form marked `data-live-search="<id>"`:
 * a moment after the typing stops (or the page size changes), the same
 * request the form would make is fetched and the element with that id is
 * swapped for the new page's copy. The address follows, so a reload or a
 * shared link shows the same results. Asked for on the "Find people to add"
 * picker (technician and user groups), 15 Oct 2026.
 *
 * An addition only: without this file the form searches on Enter or with
 * its Search button, which this hides (`data-live-hide`). The server still
 * does the searching and paging. The page's policy allows `script-src
 * 'self'` and `connect-src 'self'` for this (allowOwnScripts,
 * allowOwnRequests) - to this server only.
 */
(function () {
  'use strict';
  if (!window.fetch || !window.DOMParser) return;

  Array.prototype.slice.call(document.querySelectorAll('form[data-live-search]')).forEach(function (form) {
    var targetId = form.getAttribute('data-live-search');
    if (!document.getElementById(targetId)) return;
    var timer = null;
    var latest = 0;

    Array.prototype.slice.call(form.querySelectorAll('[data-live-hide]')).forEach(function (el) {
      el.hidden = true;
    });

    function run() {
      var params = new URLSearchParams(new FormData(form));
      // A new search starts at its first page.
      params.delete('page');
      // The address without any fragment or query of its own, then this search.
      var url = form.action.split('#')[0].split('?')[0] + '?' + params.toString();
      var ticket = ++latest;
      fetch(url, { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('search failed');
          return res.text();
        })
        .then(function (html) {
          // An older answer arriving after a newer one is ignored.
          if (ticket !== latest) return;
          var fresh = new DOMParser().parseFromString(html, 'text/html').getElementById(targetId);
          var current = document.getElementById(targetId);
          if (!fresh || !current) return;
          current.innerHTML = fresh.innerHTML;
          history.replaceState(null, '', url + location.hash);
        })
        .catch(function () {
          /* the Search button is gone, but Enter still submits the form */
        });
    }

    function soon() {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    }

    form.addEventListener('input', function (event) {
      if (event.target && event.target.type === 'search') soon();
    });
    form.addEventListener('change', function (event) {
      if (event.target && event.target.tagName === 'SELECT') run();
    });
  });
})();
