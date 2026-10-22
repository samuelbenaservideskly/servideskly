/*
 * Folding the sidebar at once (asked for 22 Oct 2026: "folding the sidebar
 * reloads the page and is not done real time").
 *
 * The fold button is a form post that sets a cookie and reloads the page
 * (routes/theme.ts), and it still is without this script. With it, the
 * press toggles the shell's class and writes the same cookie
 * (helpdesk_fold, middleware/theme.ts) here, so the next page is drawn the
 * same way. No request is made. Both buttons are in the page; the class
 * shows the right one.
 */
(function () {
  'use strict';
  var form = document.querySelector('form[data-sidebar-fold]');
  var shell = document.querySelector('.shell');
  if (!form || !shell) return;

  form.addEventListener('submit', function (e) {
    var compact = e.submitter ? e.submitter.value === 'compact' : !shell.classList.contains('shell--compact');
    e.preventDefault();
    shell.classList.toggle('shell--compact', compact);
    document.cookie =
      'helpdesk_fold=' + (compact ? 'compact; max-age=31536000' : '; max-age=0') +
      '; path=/; samesite=lax' + (location.protocol === 'https:' ? '; secure' : '');
    // Keep the keyboard on the control, which is now the other button.
    var next = form.querySelector('button[value="' + (compact ? 'full' : 'compact') + '"]');
    if (next) next.focus();
  });
})();
