/**
 * Copy-to-clipboard buttons, on Settings - Customisation - Custom images and
 * Settings - Advanced - API keys (the new key, and each code example).
 *
 * An addition, like form-builder.js: every button is rendered `hidden` and
 * only this file reveals it, so with the script blocked or missing there are
 * no dead buttons - and each snippet is still one click to select by itself
 * (`user-select: all`). The page that loads this is the only one whose
 * policy allows a script, and only `'self'`; see allowOwnScripts.
 *
 * A button carries its text in `data-copy`. Inside a <summary> it must not
 * also open or close the row, so the click stops there.
 */
(function () {
  'use strict';

  var buttons = document.querySelectorAll('[data-copy]');
  if (!buttons.length) return;

  function flash(button, ok) {
    button.classList.add(ok ? 'copy-btn--done' : 'copy-btn--failed');
    var label = button.querySelector('.copy-btn__status');
    if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    setTimeout(function () {
      button.classList.remove('copy-btn--done', 'copy-btn--failed');
      if (label) label.textContent = '';
    }, 1500);
  }

  /** The clipboard API, or the old selection trick where it is refused. */
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallback(text); },
      );
    }
    return Promise.resolve(fallback(text));
  }

  function fallback(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  Array.prototype.forEach.call(buttons, function (button) {
    button.hidden = false;
    button.addEventListener('click', function (event) {
      // In a <summary>, a click would also toggle the row.
      event.preventDefault();
      event.stopPropagation();
      copy(button.getAttribute('data-copy') || '').then(function (ok) {
        flash(button, ok);
      });
    });
  });
})();
