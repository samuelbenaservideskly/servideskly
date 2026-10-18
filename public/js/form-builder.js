/**
 * The template form builder: drag and drop, moves saved without a reload,
 * and the builder's dialogs as popups.
 *
 * It is an **addition**: every gesture has a button that does the same
 * through an ordinary form post. Add beside a palette chip places a field,
 * the arrows beside a row move it, the bin takes it off. With this file
 * blocked, missing or broken the builder still works; nothing on the path to
 * raising, reading or answering a ticket touches it at all.
 *
 * Loaded by one page, which is why that page alone has `script-src 'self'`
 * (allowOwnScripts) and `connect-src 'self'` (allowOwnRequests) - and even
 * there an injected inline script is still refused.
 *
 * **Saving without a reload.** A move, a place or a removal posts the very
 * form the page would have posted, in the background; then the page is
 * fetched again and its <main> swapped in. The server still decides
 * everything - section blocks, positions, what may move where - so what is
 * on screen is always what is stored, and there is still no client-side
 * state to drift. Should either request fail, the form is submitted the
 * ordinary way.
 */
(function () {
  'use strict';

  /** The forms saved in place: the arrows and the canvas order, place, take off. */
  var IN_PLACE = /\/fields\/(order|[^/]+\/place|[^/]+\/remove)$/;
  var busy = false;

  function pathOf(form) {
    try {
      return new URL(form.action, location.href).pathname;
    } catch (e) {
      return '';
    }
  }

  /** Submits a form: in place when it is one of ours and the browser can, otherwise as usual. */
  function send(form, submitter) {
    if (window.fetch && window.DOMParser && IN_PLACE.test(pathOf(form))) {
      saveInPlace(form, submitter);
    } else {
      HTMLFormElement.prototype.submit.call(form);
    }
  }

  function saveInPlace(form, submitter) {
    if (busy) return;
    busy = true;
    var body = new URLSearchParams(new FormData(form));
    if (submitter && submitter.name) body.append(submitter.name, submitter.value);
    // What to put the focus back on: the same button, after the swap.
    var focusForm = submitter && submitter.getAttribute('form');
    var focusTitle = submitter && submitter.getAttribute('title');
    var moved = (form.querySelector('input[name="key"]') || {}).value || '';
    document.documentElement.classList.add('builder-saving');

    fetch(form.action, { method: 'POST', body: body, credentials: 'same-origin', redirect: 'manual' })
      .then(function (res) {
        // A save answers with a redirect back to the page; anything else (a
        // refusal shown on the page, an error) is left to the ordinary post.
        if (res.type !== 'opaqueredirect' && !(res.status >= 300 && res.status < 400)) throw new Error('not saved');
        return fetch(location.pathname + location.search, { credentials: 'same-origin' });
      })
      .then(function (res) {
        if (!res.ok) throw new Error('not drawn');
        return res.text();
      })
      .then(function (html) {
        var next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
        var main = document.querySelector('main');
        if (!next || !main) throw new Error('no page');
        var y = window.scrollY;
        main.innerHTML = next.innerHTML;
        window.scrollTo(0, y);
        bindBuilder();
        if (moved) {
          var row = document.querySelector('[data-key="' + CSS.escape(moved) + '"]');
          if (row) {
            row.classList.add('widget--moved');
            setTimeout(function () { row.classList.remove('widget--moved'); }, 900);
          }
        }
        if (focusForm) {
          var again = document.querySelector('[form="' + CSS.escape(focusForm) + '"]' + (focusTitle ? '[title="' + CSS.escape(focusTitle) + '"]' : ''));
          if (again && !again.disabled) again.focus({ preventScroll: true });
        }
      })
      .catch(function () {
        HTMLFormElement.prototype.submit.call(form);
      })
      .then(function () {
        busy = false;
        document.documentElement.classList.remove('builder-saving');
      });
  }

  // Every submit of one of these forms - a button, Enter - goes in place.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !IN_PLACE.test(pathOf(form)) || !window.fetch) return;
    event.preventDefault();
    send(form, event.submitter);
  });

  // ---------------------------------------------------------------------------
  // Drag and drop - bound again each time the builder is swapped in
  // ---------------------------------------------------------------------------

  /** What is being dragged: a row of the canvas, or a chip from the palette. */
  var dragging = null;

  function bindBuilder() {
    var canvas = document.querySelector('[data-builder]');
    if (!canvas) return;
    var list = canvas.querySelector('[data-builder-list]');
    var orderInput = canvas.querySelector('[data-builder-order]');
    var dropZone = canvas.querySelector('[data-builder-drop]');
    if (!list || !orderInput) return;

    function rows() {
      return Array.prototype.slice.call(list.querySelectorAll('[data-key]'));
    }

    function clearHighlights() {
      rows().forEach(function (row) {
        row.classList.remove('widget--over', 'widget--over-after');
      });
      if (dropZone) dropZone.classList.remove('canvas__drop--over');
      Array.prototype.slice.call(list.querySelectorAll('[data-section-drop]')).forEach(function (slot) {
        slot.classList.remove('canvas__drop--over');
      });
    }

    function keyOf(node) {
      return node.getAttribute('data-key') || '';
    }

    function isSection(key) {
      return key.indexOf('s:') === 0;
    }

    function saveKeys(keys) {
      orderInput.value = keys.join(',');
      send(canvas);
    }

    /** Submits the canvas in its current on-screen order. */
    function saveOrder() {
      saveKeys(rows().map(keyOf));
    }

    /** Submits the place form for a palette chip, at a position. */
    function placeAt(key, index) {
      var form = document.getElementById('place-' + key);
      if (!form) return;
      var slot = form.querySelector('[data-place-index]');
      if (slot) slot.value = String(index);
      send(form);
    }

    /**
     * Where a pointer lands among the rows, in reading order. Rows sit two to
     * a line inside a section, so the x position decides between neighbours
     * on the same line.
     */
    function indexFor(clientX, clientY, skip) {
      var all = rows().filter(function (r) { return r !== skip; });
      for (var i = 0; i < all.length; i++) {
        var box = all[i].getBoundingClientRect();
        if (clientY < box.top) return i;
        if (clientY <= box.bottom && clientX < box.left + box.width / 2) return i;
      }
      return all.length;
    }

    /** Whether a drop on this row means "after it" rather than "before it". */
    function dropsAfter(row, event) {
      var box = row.getBoundingClientRect();
      if (row.classList.contains('widget--half')) return event.clientX > box.left + box.width / 2;
      return event.clientY > box.top + box.height / 2;
    }

    /**
     * Moves a whole section - its heading and every field under it - before
     * or after the section a row belongs to, and saves.
     */
    function moveSection(sectionKey, onto, after) {
      var keys = rows().map(keyOf);
      var start = keys.indexOf(sectionKey);
      var end = start + 1;
      while (end < keys.length && !isSection(keys[end])) end++;
      var block = keys.splice(start, end - start);

      // The section the drop landed in: the row itself, or the heading above it.
      var at = keys.indexOf(keyOf(onto));
      while (at >= 0 && !isSection(keys[at])) at--;
      var insert;
      if (at < 0) {
        // Among the untitled fields at the top: just after them.
        insert = 0;
        while (insert < keys.length && !isSection(keys[insert])) insert++;
      } else if (after) {
        insert = at + 1;
        while (insert < keys.length && !isSection(keys[insert])) insert++;
      } else {
        insert = at;
      }
      keys.splice.apply(keys, [insert, 0].concat(block));
      saveKeys(keys);
    }

    // --- the canvas rows: drag to reorder ----------------------------------

    rows().forEach(function (row) {
      row.setAttribute('draggable', 'true');

      row.addEventListener('dragstart', function (event) {
        dragging = { kind: 'row', node: row };
        row.classList.add('widget--dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          // Firefox will not start a drag unless some data is set.
          event.dataTransfer.setData('text/plain', row.getAttribute('data-key') || '');
        }
      });

      row.addEventListener('dragend', function () {
        row.classList.remove('widget--dragging');
        clearHighlights();
        dragging = null;
      });

      row.addEventListener('dragover', function (event) {
        if (!dragging || dragging.node === row) return;
        event.preventDefault();
        var after = dropsAfter(row, event);
        row.classList.toggle('widget--over', !after);
        row.classList.toggle('widget--over-after', after);
      });

      row.addEventListener('dragleave', function (event) {
        if (row.contains(event.relatedTarget)) return;
        row.classList.remove('widget--over', 'widget--over-after');
      });

      row.addEventListener('drop', function (event) {
        if (!dragging || dragging.node === row) return;
        event.preventDefault();
        clearHighlights();

        if (dragging.kind === 'chip') {
          var keys = rows().map(keyOf);
          placeAt(dragging.key, keys.indexOf(keyOf(row)) + (dropsAfter(row, event) ? 1 : 0));
          return;
        }

        var after = dropsAfter(row, event);
        if (isSection(keyOf(dragging.node))) {
          moveSection(keyOf(dragging.node), row, after);
          return;
        }
        // A field dropped on a section heading goes to the top of that section.
        if (row.hasAttribute('data-section')) {
          var grid = row.parentNode.querySelector('.canvas-section__grid');
          if (grid) grid.insertBefore(dragging.node, grid.firstChild);
        } else {
          row.parentNode.insertBefore(dragging.node, after ? row.nextSibling : row);
        }
        saveOrder();
      });
    });

    // --- anywhere else on the form: the gaps between rows and sections ----

    canvas.addEventListener('dragover', function (event) {
      if (!dragging || event.defaultPrevented) return;
      event.preventDefault();
    });

    canvas.addEventListener('drop', function (event) {
      // A row, a section slot or the end slot has already taken it.
      if (!dragging || event.defaultPrevented) return;
      event.preventDefault();
      clearHighlights();
      if (dragging.kind === 'chip') {
        placeAt(dragging.key, indexFor(event.clientX, event.clientY, null));
        return;
      }
      var node = dragging.node;
      var keys = rows().filter(function (r) { return r !== node; }).map(keyOf);
      var at = indexFor(event.clientX, event.clientY, node);
      if (isSection(keyOf(node))) {
        var all = rows().filter(function (r) { return r !== node; });
        var near = all[Math.min(at, all.length - 1)];
        if (near) moveSection(keyOf(node), near, at >= all.length);
        return;
      }
      keys.splice(at, 0, keyOf(node));
      saveKeys(keys);
    });

    // --- the palette chips: drag onto the canvas ---------------------------

    Array.prototype.slice.call(document.querySelectorAll('[data-palette-key]')).forEach(function (chip) {
      chip.setAttribute('draggable', 'true');
      chip.classList.add('palette-chip--draggable');

      chip.addEventListener('dragstart', function (event) {
        dragging = { kind: 'chip', key: chip.getAttribute('data-palette-key') };
        chip.classList.add('palette-chip--dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('text/plain', dragging.key || '');
        }
      });

      chip.addEventListener('dragend', function () {
        chip.classList.remove('palette-chip--dragging');
        clearHighlights();
        dragging = null;
      });
    });

    // --- an empty section: somewhere to drop its first field ---------------

    Array.prototype.slice.call(list.querySelectorAll('[data-section-drop]')).forEach(function (slot) {
      slot.addEventListener('dragover', function (event) {
        if (!dragging || (dragging.kind === 'row' && isSection(keyOf(dragging.node)))) return;
        event.preventDefault();
        slot.classList.add('canvas__drop--over');
      });
      slot.addEventListener('dragleave', function () {
        slot.classList.remove('canvas__drop--over');
      });
      slot.addEventListener('drop', function (event) {
        if (!dragging) return;
        event.preventDefault();
        clearHighlights();
        var keys = rows().map(keyOf);
        var index = keys.indexOf(slot.getAttribute('data-section-drop')) + 1;
        if (dragging.kind === 'chip') {
          placeAt(dragging.key, index);
          return;
        }
        slot.parentNode.insertBefore(dragging.node, slot);
        saveOrder();
      });
    });

    // --- the empty slot at the end -----------------------------------------

    if (dropZone) {
      dropZone.addEventListener('dragover', function (event) {
        if (!dragging) return;
        event.preventDefault();
        dropZone.classList.add('canvas__drop--over');
      });

      dropZone.addEventListener('dragleave', function () {
        dropZone.classList.remove('canvas__drop--over');
      });

      dropZone.addEventListener('drop', function (event) {
        if (!dragging) return;
        event.preventDefault();
        clearHighlights();

        if (dragging.kind === 'chip') {
          placeAt(dragging.key, rows().length);
          return;
        }
        if (isSection(keyOf(dragging.node))) {
          var all = rows();
          moveSection(keyOf(dragging.node), all[all.length - 1], true);
          return;
        }
        list.insertBefore(dragging.node, dropZone);
        saveOrder();
      });
    }

    // Only now that the handlers are attached is the invitation to drag shown,
    // so a grip never suggests a gesture that cannot happen.
    canvas.classList.add('canvas--draggable');
  }

  bindBuilder();
})();

/**
 * The builder's dialogs as popups.
 *
 * Without this file they are `:target` dialogs: opening and closing one is a
 * jump to a fragment, which scrolls the page - closing a field's settings
 * moved the screen. With it, they open and close in place (a class, no
 * fragment), Escape closes them, and after a save the page comes back to the
 * exact scroll position it was at, not to the anchor the redirect names.
 * Listeners sit on the document, so they keep working after the builder is
 * swapped in.
 */
(function () {
  'use strict';

  var KEY = 'builder-scroll:' + location.pathname;

  // --- coming back after a save --------------------------------------------
  var saved = null;
  try {
    saved = sessionStorage.getItem(KEY);
    if (saved !== null) sessionStorage.removeItem(KEY);
  } catch (e) {
    saved = null;
  }
  if (saved !== null) {
    var y = Number(saved);
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    var restore = function () {
      window.scrollTo(0, y);
    };
    // Now, and again once the browser has finished jumping to the fragment.
    restore();
    window.addEventListener('load', function () {
      restore();
      requestAnimationFrame(restore);
    });
  }

  // A form that does reload the page (a field's settings, a task...):
  // remember where we were. One saved in place has cancelled its submit.
  document.addEventListener('submit', function (event) {
    if (event.defaultPrevented) return;
    try {
      sessionStorage.setItem(KEY, String(window.scrollY));
    } catch (e) {
      /* private mode: the anchor still lands near the field */
    }
  });

  // --- open and close in place -----------------------------------------------
  var opener = null;

  function openDialog(dialog, from) {
    opener = from || null;
    // Its own class, not .dialog--open: app.css hides a server-reopened
    // .dialog--open once the address names something else (#diagram after a
    // move, #row-x after a save) - which hid every popup opened here.
    dialog.classList.add('dialog--shown');
    var first = dialog.querySelector('input:not([type=hidden]), select, textarea, button');
    if (first) first.focus({ preventScroll: true });
  }

  function closeDialog(dialog, link) {
    dialog.classList.remove('dialog--open', 'dialog--shown');
    // Opened by the address (#field-<key>, #add-question...): :target keeps
    // it shown until the fragment really changes, so go where the close link
    // points, replacing this history entry, at the same scroll position.
    if (dialog.matches(':target')) {
      var close = dialog.querySelector('.dialog__close');
      var to = (link && link.getAttribute('href')) || (close && close.getAttribute('href')) || '#top';
      var y = window.scrollY;
      location.replace(to.charAt(0) === '#' ? to : '#top');
      window.scrollTo(0, y);
    }
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    opener = null;
  }

  function isCloser(link) {
    return (
      link.classList.contains('dialog__backdrop') ||
      link.classList.contains('dialog__close') ||
      link.classList.contains('btn--quiet')
    );
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href^="#"]');
    if (!link) return;
    var id = link.getAttribute('href').slice(1);
    var target = id ? document.getElementById(id) : null;

    // A link that opens a dialog: open it here, no fragment, no scroll.
    if (target && target.classList.contains('dialog')) {
      event.preventDefault();
      openDialog(target, link);
      return;
    }

    // Backdrop, x or Cancel inside an open dialog: close it in place.
    var dialog = link.closest('.dialog');
    if (dialog && isCloser(link)) {
      event.preventDefault();
      closeDialog(dialog, link);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var open = document.querySelector('.dialog.dialog--shown, .dialog.dialog--open, .dialog:target');
    if (open) closeDialog(open);
  });
})();
