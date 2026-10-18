/**
 * The automation canvas: drag a step to move it, drag from a step's output
 * dot onto another step to connect them.
 *
 * Approved as an exception to "no JavaScript" for this one page
 * (Settings - Advanced - Automation, one automation). Like the template
 * builder's script it is an **addition**: every gesture ends in an ordinary
 * form post that the server checks, and the cards under the diagram do the
 * same things without it. There is no client-side state and no fetch - the
 * page reloads and draws what was saved.
 */
(function () {
  'use strict';

  var svg = document.querySelector('[data-canvas]');
  var moveForm = document.querySelector('[data-canvas-move]');
  var connectForm = document.querySelector('[data-canvas-connect]');
  var baseNode = document.querySelector('[data-canvas-base]');
  if (!svg || !moveForm || !connectForm || !baseNode) return;
  var base = baseNode.getAttribute('data-canvas-base');
  var NS = 'http://www.w3.org/2000/svg';

  /** A pointer position in the diagram's own units. */
  function point(event) {
    var p = svg.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    var m = svg.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : { x: event.clientX, y: event.clientY };
  }

  /** The step under a pointer, other than `except`. */
  function nodeAt(event, except) {
    var hit = document.elementFromPoint(event.clientX, event.clientY);
    var node = hit && hit.closest ? hit.closest('[data-node]') : null;
    return node && node !== except ? node : null;
  }

  function submit(form, action, values) {
    form.setAttribute('action', action);
    Object.keys(values).forEach(function (name) {
      form.querySelector('[name="' + name + '"]').value = values[name];
    });
    form.submit();
  }

  var drag = null;

  /**
   * The same curve the server draws (routes/automation-admin.ts, diagram()):
   * out of a dot to the right, into a box from the left, gentler when close.
   */
  function curve(x1, y1, x2, y2) {
    var dx = x2 - x1;
    if (dx >= 24) {
      var bend = Math.max(24, Math.min(120, dx / 2));
      return 'M' + x1 + ' ' + y1 + ' C' + (x1 + bend) + ' ' + y1 + ' ' + (x2 - bend) + ' ' + y2 + ' ' + x2 + ' ' + y2;
    }
    // Into a box to the left: round through a channel, never a loop.
    var BOX_H = 58; // routes/automation-admin.ts BOX_H
    var g = 24;
    var ym = Math.abs(y2 - y1) > BOX_H + 8 ? (y1 + y2) / 2 : Math.max(y1, y2) + BOX_H / 2 + 18;
    return 'M' + x1 + ' ' + y1 +
      ' C' + (x1 + g) + ' ' + y1 + ' ' + (x1 + g) + ' ' + ym + ' ' + x1 + ' ' + ym +
      ' L' + x2 + ' ' + ym +
      ' C' + (x2 - g) + ' ' + ym + ' ' + (x2 - g) + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }

  /** A wire's two ends, read from its path: the first point and the last. */
  function ends(path) {
    var n = (path.getAttribute('d') || '').match(/-?\d+(\.\d+)?/g) || [];
    return { x1: Number(n[0]), y1: Number(n[1]), x2: Number(n[n.length - 2]), y2: Number(n[n.length - 1]) };
  }

  /**
   * Everything attached to a box that has to follow it: the wires out of it
   * (their start moves), the wires into it (their end moves), and the Yes/No
   * labels by its dots. Remembered as they were when the drag began.
   */
  function attached(id) {
    var out = [];
    Array.prototype.forEach.call(svg.querySelectorAll('[data-wires] path'), function (p) {
      var from = p.getAttribute('data-from') === id;
      var to = p.getAttribute('data-to') === id;
      if (from || to) out.push({ path: p, from: from, to: to, at: ends(p) });
    });
    var labels = Array.prototype.map.call(svg.querySelectorAll('[data-label-from="' + id + '"]'), function (t) {
      return { text: t, x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')) };
    });
    return { wires: out, labels: labels };
  }

  /** Redraws what is attached, as if the box stood dx, dy away. */
  function follow(links, dx, dy) {
    links.wires.forEach(function (w) {
      var a = w.at;
      w.path.setAttribute('d', curve(
        w.from ? a.x1 + dx : a.x1, w.from ? a.y1 + dy : a.y1,
        w.to ? a.x2 + dx : a.x2, w.to ? a.y2 + dy : a.y2,
      ));
    });
    links.labels.forEach(function (l) {
      l.text.setAttribute('x', String(l.x + dx));
      l.text.setAttribute('y', String(l.y + dy));
    });
  }
  // When the last drag ended: the click that follows a drag must not also
  // open the step it was dropped on.
  var draggedAt = 0;

  // --- moving a step --------------------------------------------------------
  svg.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    var dot = event.target.closest && event.target.closest('[data-pin]');
    var node = event.target.closest && event.target.closest('[data-node]');
    if (!node) return;
    event.preventDefault();
    var start = point(event);

    if (dot) {
      // --- drawing a wire from an output dot ------------------------------
      var draft = document.createElementNS(NS, 'path');
      draft.setAttribute('class', 'automation-diagram__draft');
      svg.appendChild(draft);
      drag = {
        kind: 'wire',
        node: node,
        pin: dot.getAttribute('data-pin'),
        x0: Number(dot.getAttribute('cx')),
        y0: Number(dot.getAttribute('cy')),
        draft: draft,
        target: null,
      };
    } else {
      drag = {
        kind: 'move',
        node: node,
        start: start,
        x: Number(node.getAttribute('data-x')),
        y: Number(node.getAttribute('data-y')),
        moved: false,
        links: attached(node.getAttribute('data-node')),
      };
      node.classList.add('automation-diagram__node--dragging');
    }
    // A wire is captured at once. A move only once it really moves (below):
    // capturing on press sent a plain click to the svg instead of the box's
    // link, so clicking a box opened nothing.
    if (drag.kind === 'wire') svg.setPointerCapture(event.pointerId);
  });

  /**
   * The drawing is only as big as its boxes, so a box dragged past its edge
   * was clipped - invisible until the page reloaded with a bigger drawing.
   * It grows now, while the box moves, at the scale it is drawn.
   */
  function grow(right, bottom) {
    var vb = svg.viewBox.baseVal;
    var w = Math.max(vb.width, Math.ceil(right + 48));
    var h = Math.max(vb.height, Math.ceil(bottom + 32));
    if (w === vb.width && h === vb.height) return;
    var scale = (Number(svg.getAttribute('width')) || vb.width) / vb.width;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('width', String(Math.round(w * scale)));
    svg.setAttribute('height', String(Math.round(h * scale)));
  }

  /** Near an edge of the window, the window scrolls along with the drag. */
  var viewportEl = document.querySelector('[data-canvas-viewport]');
  function scrollNear(event) {
    if (!viewportEl) return;
    var r = viewportEl.getBoundingClientRect();
    var EDGE = 32;
    var STEP = 18;
    if (event.clientY > r.bottom - EDGE) viewportEl.scrollTop += STEP;
    else if (event.clientY < r.top + EDGE) viewportEl.scrollTop -= STEP;
    if (event.clientX > r.right - EDGE) viewportEl.scrollLeft += STEP;
    else if (event.clientX < r.left + EDGE) viewportEl.scrollLeft -= STEP;
  }

  svg.addEventListener('pointermove', function (event) {
    if (!drag) return;
    var p = point(event);
    if (drag.kind === 'move') {
      // Never above or left of the drawing: those cannot grow.
      var dx = Math.max(-drag.x, p.x - drag.start.x);
      var dy = Math.max(-drag.y, p.y - drag.start.y);
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        svg.setPointerCapture(event.pointerId);
        // On top of every other box while it moves, not under the later ones.
        drag.node.parentNode.appendChild(drag.node);
      }
      if (!drag.moved) return;
      drag.node.setAttribute('transform', 'translate(' + dx + ' ' + dy + ')');
      grow(drag.x + dx + Number(svg.getAttribute('data-box-w') || 200), drag.y + dy + Number(svg.getAttribute('data-box-h') || 58));
      scrollNear(event);
      // The wires follow as it moves, not only once it is let go.
      follow(drag.links, dx, dy);
      drag.dx = dx;
      drag.dy = dy;
      return;
    }
    var bend = Math.max(40, Math.abs(p.x - drag.x0) / 2);
    drag.draft.setAttribute(
      'd',
      'M' + drag.x0 + ' ' + drag.y0 + ' C' + (drag.x0 + bend) + ' ' + drag.y0 + ' ' + (p.x - bend) + ' ' + p.y + ' ' + p.x + ' ' + p.y,
    );
    // The capture makes the pointer report the svg; look underneath instead.
    svg.releasePointerCapture(event.pointerId);
    var over = nodeAt(event, drag.node);
    svg.setPointerCapture(event.pointerId);
    if (over && over.getAttribute('data-trigger') === '1') over = null; // nothing leads into the trigger
    if (drag.target && drag.target !== over) drag.target.classList.remove('automation-diagram__node--target');
    drag.target = over;
    if (over) over.classList.add('automation-diagram__node--target');
  });

  function finish() {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.kind === 'move') {
      d.node.classList.remove('automation-diagram__node--dragging');
      if (!d.moved) {
        d.node.removeAttribute('transform');
        return; // a click: let the link take the reader to the step's card
      }
      draggedAt = Date.now();
      submit(moveForm, base + d.node.getAttribute('data-node') + '/move', {
        x: String(Math.max(0, Math.round(d.x + d.dx))),
        y: String(Math.max(0, Math.round(d.y + d.dy))),
      });
      return;
    }
    d.draft.remove();
    if (d.target) {
      d.target.classList.remove('automation-diagram__node--target');
      submit(connectForm, base + d.node.getAttribute('data-node') + '/connect', {
        pin: d.pin,
        to: d.target.getAttribute('data-node'),
      });
    }
  }

  function cancel() {
    if (!drag) return;
    if (drag.kind === 'move') {
      drag.node.removeAttribute('transform');
      if (drag.links) follow(drag.links, 0, 0);
      drag.node.classList.remove('automation-diagram__node--dragging');
    }
    if (drag.draft) drag.draft.remove();
    if (drag.target) drag.target.classList.remove('automation-diagram__node--target');
    drag = null;
  }

  // The release is listened for on the window too: one outside the diagram
  // (or the capture lost to another window) used to go unseen, leaving the
  // box half-dragged and every later click on it swallowed.
  svg.addEventListener('pointerup', finish);
  window.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', cancel);
  svg.addEventListener('lostpointercapture', function () {
    // Capture is let go on purpose while a wire looks for its target.
    if (drag && drag.kind === 'move' && drag.moved) finish();
  });
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') cancel();
  });

  // A drag must not also follow the link it ended on.
  svg.addEventListener('click', function (event) {
    if (Date.now() - draggedAt < 400) event.preventDefault();
  });

  // Only now is the invitation shown, so it never promises a gesture that
  // cannot happen.
  svg.classList.add('automation-diagram--live');
  var hint = document.querySelector('[data-canvas-hint]');
  if (hint) hint.hidden = false;
})();

/**
 * Zoom: - / Fit / +, and the wheel over the diagram. Fit (the default) is
 * the diagram at the window's width, never larger than drawn; a zoom sets the
 * SVG's width and lets the window scroll. Kept for this automation across the
 * reload a move or a save causes, so the view does not jump back each time.
 * Drag, wires and the menu read positions through getScreenCTM, so they keep
 * working at any zoom.
 */
(function () {
  'use strict';

  var svg = document.querySelector('[data-canvas]');
  var viewport = document.querySelector('[data-canvas-viewport]');
  var controls = document.querySelector('[data-canvas-zoom]');
  if (!svg || !viewport || !controls) return;
  var natural = Number(svg.getAttribute('width')) || 600;
  var naturalH = Number(svg.getAttribute('height')) || 200;
  var KEY = 'automation-zoom:' + location.pathname;
  var zoom = null; // null is "fit"

  function apply() {
    var vb = svg.viewBox.baseVal;
    if (vb && vb.width) {
      natural = vb.width;
      naturalH = vb.height;
    }
    if (zoom === null) {
      viewport.classList.remove('automation-viewport--zoomed');
      svg.setAttribute('width', String(natural));
      svg.setAttribute('height', String(naturalH));
    } else {
      viewport.classList.add('automation-viewport--zoomed');
      svg.setAttribute('width', String(Math.round(natural * zoom)));
      svg.setAttribute('height', String(Math.round(naturalH * zoom)));
    }
    try {
      if (zoom === null) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, String(zoom));
    } catch (e) {
      /* private mode: the zoom simply is not remembered */
    }
  }

  /** The scale the diagram is drawn at right now. */
  function current() {
    return zoom === null ? svg.getBoundingClientRect().width / natural : zoom;
  }

  function set(next) {
    zoom = Math.max(0.3, Math.min(2.5, Math.round(next * 10) / 10));
    apply();
  }

  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved !== null && Number(saved) > 0) zoom = Number(saved);
  } catch (e) {
    zoom = null;
  }
  apply();

  controls.hidden = false;
  controls.addEventListener('click', function (event) {
    var b = event.target.closest && event.target.closest('[data-zoom]');
    if (!b) return;
    var how = b.getAttribute('data-zoom');
    if (how === 'fit') {
      zoom = null;
      apply();
    } else {
      set(current() + (how === 'in' ? 0.2 : -0.2));
    }
  });

  // The wheel over the diagram zooms, keeping the point under the pointer
  // where it is. The page scrolls with the wheel anywhere else.
  viewport.addEventListener(
    'wheel',
    function (event) {
      if (event.deltaY === 0) return;
      event.preventDefault();
      var before = current();
      var box = viewport.getBoundingClientRect();
      var ox = event.clientX - box.left;
      var oy = event.clientY - box.top;
      var px = (viewport.scrollLeft + ox) / before;
      var py = (viewport.scrollTop + oy) / before;
      set(before * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
      var after = current();
      viewport.scrollLeft = px * after - ox;
      viewport.scrollTop = py * after - oy;
    },
    { passive: false },
  );
})();

/**
 * Right-click on the canvas: add an action there, or - on a step - add one
 * after it, edit it, or remove it. The menu is server-drawn markup; this only
 * places it and fills in where. Every item is a form post.
 */
(function () {
  'use strict';

  var svg = document.querySelector('[data-canvas]');
  var menu = document.querySelector('[data-canvas-menu]');
  if (!svg || !menu) return;
  var form = menu.querySelector('[data-canvas-menu-form]');
  var heading = menu.querySelector('[data-menu-heading]');
  var branch = menu.querySelector('[data-menu-branch]');
  var pinSelect = menu.querySelector('[data-menu-pin]');
  var nodePart = menu.querySelector('[data-menu-node]');
  var edit = menu.querySelector('[data-menu-edit]');
  var removeForm = menu.querySelector('[data-menu-remove-form]');
  var wirePart = menu.querySelector('[data-menu-wire]');
  var wireHeading = menu.querySelector('[data-menu-wire-heading]');

  function nameOf(id) {
    var box = svg.querySelector('[data-node="' + id + '"] .automation-diagram__label');
    return box ? box.textContent : 'a step';
  }

  /** The menu for one wire: what it joins, and Remove this connection. */
  function openWire(hit, event) {
    var from = hit.getAttribute('data-from');
    var to = hit.getAttribute('data-to');
    var pin = hit.getAttribute('data-pin') || 'next';
    menu.querySelector('[data-wire-from]').value = from;
    menu.querySelector('[data-wire-pin]').value = pin;
    menu.querySelector('[data-wire-to]').value = to;
    wireHeading.textContent = nameOf(from) + (pin === 'true' ? ' (yes)' : pin === 'false' ? ' (no)' : '') + ' to ' + nameOf(to);
    form.hidden = true;
    nodePart.hidden = true;
    wirePart.hidden = false;
    show(event);
  }

  function show(event) {
    menu.hidden = false;
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    menu.style.left = Math.min(event.clientX, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - h - 8) + 'px';
    var first = menu.querySelector('[data-menu-wire]:not([hidden]) button, form:not([hidden]) button, a');
    if (first) first.focus({ preventScroll: true });
  }

  svg.addEventListener('click', function (event) {
    var hit = event.target.closest && event.target.closest('.automation-diagram__wire-hit');
    if (!hit) return;
    event.preventDefault();
    openWire(hit, event);
  });
  var base = document.querySelector('[data-canvas-base]').getAttribute('data-canvas-base');
  var set = function (sel, value) {
    menu.querySelector(sel).value = value;
  };

  function close() {
    menu.hidden = true;
  }

  function point(event) {
    var p = svg.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    var m = svg.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : { x: event.clientX, y: event.clientY };
  }

  svg.addEventListener('contextmenu', function (event) {
    event.preventDefault();
    var hit = event.target.closest && event.target.closest('.automation-diagram__wire-hit');
    if (hit) {
      openWire(hit, event);
      return;
    }
    form.hidden = false;
    wirePart.hidden = true;
    var node = event.target.closest && event.target.closest('[data-node]');
    var p = point(event);

    if (node) {
      var id = node.getAttribute('data-node');
      var pins = Array.prototype.map.call(node.querySelectorAll('[data-pin]'), function (d) {
        return d.getAttribute('data-pin');
      });
      var isIf = pins.indexOf('true') >= 0;
      var label = node.querySelector('.automation-diagram__label');
      heading.textContent = 'Add an action after ' + (label ? label.textContent : 'this step');
      branch.hidden = !isIf;
      set('[data-menu-x]', '');
      set('[data-menu-y]', '');
      var after = function () {
        set('[data-menu-after]', id + ':' + (isIf ? pinSelect.value : 'next'));
      };
      after();
      pinSelect.onchange = after;
      nodePart.hidden = false;
      edit.setAttribute('href', '#edit-' + id);
      removeForm.setAttribute('action', base + id + '/delete');
      removeForm.hidden = node.getAttribute('data-trigger') === '1';
    } else {
      heading.textContent = 'Add an action here';
      branch.hidden = true;
      set('[data-menu-x]', String(Math.max(0, Math.round(p.x - 100))));
      set('[data-menu-y]', String(Math.max(0, Math.round(p.y - 29))));
      set('[data-menu-after]', '');
      nodePart.hidden = true;
    }

    menu.hidden = false;
    // Kept on screen whichever corner was clicked.
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    menu.style.left = Math.min(event.clientX, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - h - 8) + 'px';
    var first = menu.querySelector('button, a');
    if (first) first.focus({ preventScroll: true });
  });

  document.addEventListener('pointerdown', function (event) {
    if (!menu.hidden && !menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('scroll', close, { passive: true });
  edit.addEventListener('click', close);
  if (form) form.addEventListener('submit', close);
})();

/**
 * The popups open and close in place: no jump to a fragment, Escape closes,
 * and after a save the page comes back where it was. Without this file they
 * are :target dialogs, which work the same with a scroll.
 */
(function () {
  'use strict';

  var KEY = 'automation-scroll:' + location.pathname;
  var saved = null;
  try {
    saved = sessionStorage.getItem(KEY);
    if (saved !== null) sessionStorage.removeItem(KEY);
  } catch (e) {
    saved = null;
  }
  // A new action arrives with its popup open (#edit-<id>): no restore then.
  if (saved !== null && location.hash.indexOf('#edit-') !== 0) {
    var y = Number(saved);
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    var restore = function () {
      window.scrollTo(0, y);
    };
    restore();
    window.addEventListener('load', function () {
      restore();
      requestAnimationFrame(restore);
    });
  }

  document.addEventListener(
    'submit',
    function () {
      try {
        sessionStorage.setItem(KEY, String(window.scrollY));
      } catch (e) {
        /* private mode: the fragment still lands near the step */
      }
    },
    true,
  );

  var opener = null;

  function open(dialog, from) {
    opener = from || null;
    // Its own class, not .dialog--open: app.css hides a server-reopened
    // .dialog--open once the address names something else (#diagram after a
    // move, #row-x after a save) - which hid every popup opened here.
    dialog.classList.add('dialog--shown');
    var first = dialog.querySelector('input:not([type=hidden]), select, textarea, button');
    if (first) first.focus({ preventScroll: true });
  }

  function shut(dialog, link) {
    dialog.classList.remove('dialog--open', 'dialog--shown');
    // A popup opened by the address (a new action arrives as #edit-<id>) is
    // shown by :target, and replaceState does not make a browser re-check
    // :target - Cancel and the cross then did nothing. A real fragment change
    // does: go to where the close link points (the step's card), replacing
    // this history entry, and stay at the same scroll position.
    if (dialog.matches(':target')) {
      var close = dialog.querySelector('.dialog__close');
      var to = (link && link.getAttribute('href')) || (close && close.getAttribute('href')) || '#top';
      var y = window.scrollY;
      location.replace(to.charAt(0) === '#' ? to : '#top');
      window.scrollTo(0, y);
    }
    if (opener) opener.focus({ preventScroll: true });
    opener = null;
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href^="#"]');
    if (!link) return;
    var id = link.getAttribute('href').slice(1);
    var target = id ? document.getElementById(id) : null;
    if (target && target.classList.contains('dialog')) {
      event.preventDefault();
      open(target, link);
      return;
    }
    var dialog = link.closest('.dialog');
    if (dialog && (link.classList.contains('dialog__backdrop') || link.classList.contains('dialog__close') || link.classList.contains('btn--quiet'))) {
      event.preventDefault();
      shut(dialog, link);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var openOne = document.querySelector('.dialog.dialog--shown, .dialog.dialog--open, .dialog:target');
    if (openOne) shut(openOne);
  });
})();
