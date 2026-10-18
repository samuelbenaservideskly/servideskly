/**
 * Two additions to a password box, neither of which decides anything.
 *
 * 1. **The eye** (partials/password-input.ejs): press it to see what was
 *    typed, press again to hide it. Asked for on the Users pages, where an
 *    administrator sets a person's password, 15 Oct 2026.
 * 2. **The rules box** (partials/password-rules.ejs): each line ticks as the
 *    password meets it. Asked for 15 Oct 2026 for the profile page.
 *
 * An addition only. Without this file the eye stays hidden, the box is an
 * ordinary password box, and the rules are a plain list that still says what
 * is required. **The rules are enforced on the server** by
 * `passwordProblems()`; these ticks are a mirror of it, never the check.
 *
 * No request is made; the page's policy allows `script-src 'self'` for it.
 */
(function () {
  'use strict';
  Array.prototype.slice.call(document.querySelectorAll('.password-reveal')).forEach(function (wrap) {
    var input = wrap.querySelector('input[data-reveal]');
    var toggle = wrap.querySelector('.password-reveal__toggle');
    if (!input || !toggle) return;
    toggle.hidden = false;
    wrap.classList.add('password-reveal--ready');
    toggle.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      wrap.classList.toggle('password-reveal--shown', show);
      input.focus({ preventScroll: true });
    });
    // Never submitted, or left on screen, in plain text by accident.
    if (input.form) {
      input.form.addEventListener('submit', function () {
        input.type = 'password';
      });
    }
  });

  // --- the rules box ------------------------------------------------------

  /**
   * The same checks as `passwordProblems()` in src/auth/password.ts, in the
   * same Unicode terms: an accented capital is an upper-case letter, and a
   * symbol is anything that is not a letter, a digit or a space.
   *
   * `tests/password-policy.test.ts` asserts this object names every rule
   * `passwordRules()` can return, so turning a new rule on cannot leave a
   * line here that never ticks.
   */
  var RULES = {
    length: function (value, min) { return value.length >= min; },
    upper: function (value) { return /\p{Lu}/u.test(value); },
    lower: function (value) { return /\p{Ll}/u.test(value); },
    digit: function (value) { return /\p{Nd}/u.test(value); },
    symbol: function (value) { return /[^\p{L}\p{Nd}\s]/u.test(value); },
  };

  Array.prototype.slice.call(document.querySelectorAll('[data-pw-rules]')).forEach(function (box) {
    var input = document.getElementById(box.getAttribute('data-pw-rules'));
    if (!input) return;

    var rows = Array.prototype.slice.call(box.querySelectorAll('[data-rule]'));
    if (rows.length === 0) return;
    box.classList.add('pw-rules--live');

    function check() {
      var value = input.value || '';
      var met = 0;
      rows.forEach(function (row) {
        var test = RULES[row.getAttribute('data-rule')];
        var ok = !!test && test(value, Number(row.getAttribute('data-min') || 0));
        row.classList.toggle('pw-rule--met', ok);
        // Read out as a list of done/not done rather than silently changing.
        row.setAttribute('aria-label', row.textContent.trim() + (ok ? ': done' : ': not yet'));
        if (ok) met++;
      });
      // Empty is neither met nor failed: nothing is marked wrong until there
      // is something to be wrong about.
      box.classList.toggle('pw-rules--started', value.length > 0);
      box.classList.toggle('pw-rules--all', met === rows.length);
    }

    input.addEventListener('input', check);
    input.addEventListener('blur', check);
    check();
  });
})();
