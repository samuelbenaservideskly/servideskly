/*
 * Search in long dropdowns, and a dropdown that narrows another.
 * The fifth approved script (12 Oct 2026); see src/middleware/select-search.ts.
 *
 * - A <select> with more than 8 options (not `multiple`, not data-no-search)
 *   opens a panel with a search box in it instead of its own list: about
 *   eight options in view, filtered as you type, arrows and Enter to choose.
 *   The real select keeps the value. Touch screens keep their own picker.
 * - <select data-narrows="other-id"> limits the select with that id to the
 *   options whose data-kind equals its value ("" shows all).
 * - A list of more than 8 tick boxes (labels holding a checkbox, side by side
 *   in one parent - user groups to choose, say) gets a search box too. It
 *   only hides rows; a ticked one always stays in view.
 * - [data-needs-script] is revealed (it is hidden without this script, where
 *   it would do nothing); a select with data-autosubmit submits its form on
 *   change.
 *
 * Options are taken out and put back rather than hidden: iOS Safari ignores
 * `hidden` on an option. No fetch, no storage, no inline handlers.
 */
(function () {
  'use strict';

  var FROM = 8;

  /** Every option and optgroup of a select, remembered once in order. */
  function remember(select) {
    if (select._all) return select._all;
    select._all = Array.prototype.map.call(select.children, function (child) {
      return {
        node: child,
        options: child.tagName === 'OPTGROUP' ? Array.prototype.slice.call(child.children) : null,
      };
    });
    return select._all;
  }

  function text(option) {
    var group = option.parentNode && option.parentNode.tagName === 'OPTGROUP' ? option.parentNode.label + ' ' : '';
    return (group + option.textContent).toLowerCase();
  }

  /** Rebuilds the select from what passes both the search and the narrowing. */
  function apply(select) {
    var all = remember(select);
    var words = (select._search ? select._search.value : '').toLowerCase().split(/\s+/).filter(Boolean);
    var kind = select._kindFrom ? select._kindFrom.value : '';
    var chosen = select.value;
    var keep = function (option) {
      if (option.value === '' || option.value === chosen) return true;
      if (kind && option.getAttribute('data-kind') && option.getAttribute('data-kind') !== kind) return false;
      var t = text(option);
      return words.every(function (w) { return t.indexOf(w) >= 0; });
    };
    while (select.firstChild) select.removeChild(select.firstChild);
    all.forEach(function (entry) {
      if (!entry.options) {
        if (keep(entry.node)) select.appendChild(entry.node);
        return;
      }
      while (entry.node.firstChild) entry.node.removeChild(entry.node.firstChild);
      var shown = entry.options.filter(keep);
      shown.forEach(function (o) { entry.node.appendChild(o); });
      if (shown.length > 0) select.appendChild(entry.node);
    });
    select.value = chosen;
  }

  // -------------------------------------------------------------------------
  // A long dropdown opens a panel with a search box in it (asked for 15 Oct
  // 2026): the box at the top, the matching options below, about eight in
  // view and the rest a scroll away. The real <select> stays in the form and
  // on screen - the panel only chooses its value - so the form, narrowing
  // and data-autosubmit behave as before. A touch screen keeps the
  // phone's own picker; without this script it is an ordinary dropdown.
  // -------------------------------------------------------------------------

  var openPanel = null;
  var panelSeq = 0;

  function closePanel(refocus) {
    if (!openPanel) return;
    var p = openPanel;
    openPanel = null;
    p.panel.parentNode.removeChild(p.panel);
    var anchor = p.select._button || p.select;
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus();
  }

  function choose(select, value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // -------------------------------------------------------------------------
  // Several at once (data-multi), asked for 15 Oct 2026 on the Manager
  // dashboard's Group picker: the same panel, ticking as many as you like,
  // and the form reads them as a repeated parameter.
  //
  // The element in the form is an ordinary <select multiple>, so without
  // this script it is a list box that still chooses several and still
  // submits with the button beside it. With the script it is hidden and a
  // button that looks like a closed dropdown takes its place, because a
  // list box of every group is the thing this replaced.
  // -------------------------------------------------------------------------

  /** An option that means "all of them": ticking it clears the rest. */
  function isAllOption(option) {
    return option.hasAttribute('data-all');
  }

  function selectedOptions(select) {
    return Array.prototype.filter.call(select.options, function (o) { return o.selected; });
  }

  /** What the closed button says: the choice, two choices, or how many. */
  function multiLabel(select) {
    var chosen = selectedOptions(select).filter(function (o) { return !isAllOption(o); });
    if (chosen.length === 0) {
      var all = Array.prototype.filter.call(select.options, isAllOption)[0];
      return all ? all.textContent.trim() : 'Nothing chosen';
    }
    if (chosen.length <= 2) {
      return chosen.map(function (o) { return o.textContent.trim(); }).join(', ');
    }
    return chosen.length + ' chosen';
  }

  function toggle(select, value) {
    var option = Array.prototype.filter.call(select.options, function (o) { return o.value === value; })[0];
    if (!option) return;
    if (isAllOption(option)) {
      // "All of them" is an answer on its own, not one more tick.
      Array.prototype.forEach.call(select.options, function (o) { o.selected = isAllOption(o); });
    } else {
      option.selected = !option.selected;
      Array.prototype.forEach.call(select.options, function (o) { if (isAllOption(o)) o.selected = false; });
      // Nothing ticked means all of them again, so the control is never in a
      // state that asks for figures about no group at all.
      if (selectedOptions(select).length === 0) {
        Array.prototype.forEach.call(select.options, function (o) { if (isAllOption(o)) o.selected = true; });
      }
    }
    if (select._button) select._button.firstChild.nodeValue = multiLabel(select);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openFor(select) {
    if (openPanel && openPanel.select === select) return;
    closePanel(false);
    var id = 'combo-' + (++panelSeq);
    var panel = document.createElement('div');
    panel.className = 'combo-panel';
    var box = document.createElement('input');
    box.type = 'search';
    box.className = 'combo-panel__search';
    box.placeholder = 'Search';
    box.autocomplete = 'off';
    box.setAttribute('role', 'combobox');
    box.setAttribute('aria-expanded', 'true');
    box.setAttribute('aria-controls', id);
    box.setAttribute('aria-autocomplete', 'list');
    var label = select.id ? document.querySelector('label[for="' + select.id + '"]') : null;
    box.setAttribute('aria-label', 'Search ' + (label ? label.textContent.trim() : 'the list'));
    var list = document.createElement('ul');
    list.className = 'combo-panel__list';
    list.id = id;
    list.setAttribute('role', 'listbox');
    panel.appendChild(box);
    panel.appendChild(list);

    var items = [];
    var active = -1;

    function setActive(i) {
      if (items.length === 0) { active = -1; box.removeAttribute('aria-activedescendant'); return; }
      active = Math.max(0, Math.min(items.length - 1, i));
      items.forEach(function (it, n) { it.el.classList.toggle('is-active', n === active); });
      box.setAttribute('aria-activedescendant', items[active].el.id);
      items[active].el.scrollIntoView({ block: 'nearest' });
    }

    function render() {
      var words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
      while (list.firstChild) list.removeChild(list.firstChild);
      items = [];
      var lastGroup = null;
      // What the select offers now (after any narrowing), in its own order.
      Array.prototype.forEach.call(select.options, function (option) {
        if (option.disabled && option.value !== '') return;
        var t = text(option);
        if (!words.every(function (w) { return t.indexOf(w) >= 0; })) return;
        var group = option.parentNode && option.parentNode.tagName === 'OPTGROUP' ? option.parentNode.label : null;
        if (group && group !== lastGroup) {
          var head = document.createElement('li');
          head.className = 'combo-panel__group';
          head.setAttribute('role', 'presentation');
          head.textContent = group;
          list.appendChild(head);
        }
        lastGroup = group;
        var li = document.createElement('li');
        li.className = 'combo-panel__option';
        li.id = id + '-' + items.length;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', (select.multiple ? option.selected : option.value === select.value) ? 'true' : 'false');
        li.textContent = option.textContent;
        var value = option.value;
        li.addEventListener('mousedown', function (e) { e.preventDefault(); });
        li.addEventListener('click', function () {
          if (select.multiple) {
            // Ticking one is rarely the last thing somebody wants to do, so
            // the panel stays open and the search box keeps the focus.
            toggle(select, value);
            render();
            box.focus();
            return;
          }
          choose(select, value);
          closePanel(true);
        });
        list.appendChild(li);
        items.push({ el: li, value: value });
      });
      if (items.length === 0) {
        var none = document.createElement('li');
        none.className = 'combo-panel__none';
        none.setAttribute('role', 'presentation');
        none.textContent = 'Nothing matches';
        list.appendChild(none);
      }
      var current = items.findIndex(function (it) { return it.value === select.value; });
      setActive(words.length ? 0 : Math.max(0, current));
    }

    box.addEventListener('input', render);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'PageDown') { e.preventDefault(); setActive(active + 8); }
      else if (e.key === 'PageUp') { e.preventDefault(); setActive(active - 8); }
      else if (e.key === 'Enter') {
        // Never submits the form around it.
        e.preventDefault();
        if (select.multiple) {
          if (items[active]) { toggle(select, items[active].value); render(); }
          return;
        }
        if (items[active]) choose(select, items[active].value);
        closePanel(true);
      } else if (e.key === 'Escape') { e.preventDefault(); closePanel(true); }
      else if (e.key === 'Tab') { closePanel(false); }
    });

    // Under the control, as wide as it (at least 16rem), inside the page.
    var anchor = select._button || select;
    var holder = anchor.parentNode;
    if (getComputedStyle(holder).position === 'static') holder.classList.add('combo-host');
    holder.appendChild(panel);
    panel.style.top = (anchor.offsetTop + anchor.offsetHeight + 4) + 'px';
    panel.style.left = anchor.offsetLeft + 'px';
    panel.style.minWidth = Math.max(anchor.offsetWidth, 256) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    openPanel = { select: select, panel: panel };
    render();
    box.focus();
  }

  function addSearch(select) {
    var count = select.querySelectorAll('option').length;
    // `data-search` asks for the panel whatever the length: a short list can
    // still be worth one when the page is built around choosing from it, as
    // New ticket's Kind and Form are. `data-no-search` still wins.
    var asked = select.hasAttribute('data-search');
    if (select.hasAttribute('data-no-search')) return;
    if (select.multiple) { addMultiSearch(select); return; }
    if (!asked && count <= FROM) return;
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
    select.classList.add('combo-select');
    select.setAttribute('aria-haspopup', 'listbox');
    select.setAttribute('aria-expanded', 'false');
    // The browser's own list never opens; ours does.
    select.addEventListener('mousedown', function (e) {
      e.preventDefault();
      if (openPanel && openPanel.select === select) closePanel(true); else { select.focus(); openFor(select); }
    });
    select.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'F4' || (e.key === 'ArrowDown' && e.altKey)) {
        e.preventDefault();
        openFor(select);
      }
    });
  }

  /**
   * A <select multiple data-multi>: hidden, with a button in its place that
   * looks like a closed dropdown and opens the same panel.
   */
  function addMultiSearch(select) {
    if (!select.hasAttribute('data-multi') || select._button) return;
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'combo-select combo-select--button';
    button.appendChild(document.createTextNode(multiLabel(select)));
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    var label = select.id ? document.querySelector('label[for="' + select.id + '"]') : null;
    if (label) button.setAttribute('aria-label', label.textContent.trim() + ': ' + multiLabel(select));

    select.hidden = true;
    select.setAttribute('aria-hidden', 'true');
    select.parentNode.insertBefore(button, select);
    select._button = button;

    button.addEventListener('click', function () {
      if (openPanel && openPanel.select === select) closePanel(true); else openFor(select);
    });
  }

  document.addEventListener('mousedown', function (e) {
    if (openPanel && !openPanel.panel.contains(e.target) && e.target !== openPanel.select
        && e.target !== openPanel.select._button) closePanel(false);
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-needs-script]'), function (el) {
    el.hidden = false;
  });

  // ...and the other way round: a control that only exists because there may
  // be no script. New ticket's "Open this form" button is the way to submit
  // the picker without one; with one, choosing a form already opens it.
  Array.prototype.forEach.call(document.querySelectorAll('[data-has-script]'), function (el) {
    el.hidden = true;
  });

  Array.prototype.forEach.call(document.querySelectorAll('select'), addSearch);

  Array.prototype.forEach.call(document.querySelectorAll('select[data-narrows]'), function (from) {
    var target = document.getElementById(from.getAttribute('data-narrows'));
    if (!target) return;
    target._kindFrom = from;
    from.addEventListener('change', function () {
      var before = target.value;
      // A choice of the wrong kind no longer stands.
      var current = target.querySelector('option:checked');
      if (current && current.value && from.value && current.getAttribute('data-kind') !== from.value) target.value = '';
      apply(target);
      // ...and something has to stand in its place. A list with no empty
      // prompt in it (New ticket's Form) would otherwise show nothing at all
      // once the old choice was dropped, which reads as a broken control.
      if (target.selectedIndex < 0) {
        var first = target.querySelector('option');
        if (first) target.value = first.value;
      }
      // The stand-in is a choice too. New ticket's Form opens what is chosen
      // (data-autosubmit), and without this the narrowed list showed the new
      // kind's form while the page below still held the old one - choosing
      // the form it already showed changed nothing, so only the button got
      // anybody further (reported 21 Oct 2026).
      if (target.value && target.value !== before && target.hasAttribute('data-autosubmit') && target.form) {
        target.form.submit();
      }
    });
    apply(target);
  });

  /**
   * A long list of tick boxes or radios: a search box above the first,
   * hiding the rest as it is typed.
   *
   * `data-search-from` lowers the length it starts at - a list of templates
   * to raise a ticket from is worth searching at five, where a list of user
   * groups is not - and `data-search` asks for the box whatever the length,
   * the same meaning the attribute has on a dropdown.
   */
  function addListSearch(parent) {
    var rows = Array.prototype.filter.call(parent.children, function (el) {
      return el.tagName === 'LABEL' && el.querySelector('input[type="checkbox"], input[type="radio"]');
    });
    var from = parent.hasAttribute('data-search')
      ? 1
      : Number(parent.getAttribute('data-search-from')) || FROM;
    if (rows.length <= from || parent._listSearch) return;
    parent._listSearch = true;
    var box = document.createElement('input');
    box.type = 'search';
    box.className = 'select-search';
    box.placeholder = 'Search';
    box.autocomplete = 'off';
    var legend = parent.querySelector('legend');
    box.setAttribute('aria-label', 'Search ' + (legend ? legend.textContent.trim() : 'the list'));
    parent.insertBefore(box, rows[0]);
    box.addEventListener('input', function () {
      var words = box.value.toLowerCase().split(/\s+/).filter(Boolean);
      rows.forEach(function (row) {
        var t = row.textContent.toLowerCase();
        var show = row.querySelector('input').checked || words.every(function (w) { return t.indexOf(w) >= 0; });
        row.style.display = show ? '' : 'none';
      });
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') e.preventDefault();
    });
  }

  var parents = [];
  Array.prototype.forEach.call(
    document.querySelectorAll('label > input[type="checkbox"], label > input[type="radio"]'),
    function (input) {
      var parent = input.parentNode.parentNode;
      if (parent && parents.indexOf(parent) < 0) parents.push(parent);
    },
  );
  parents.forEach(addListSearch);

  Array.prototype.forEach.call(document.querySelectorAll('select[data-autosubmit]'), function (select) {
    select.addEventListener('change', function () {
      if (select.value && select.form) select.form.submit();
    });
  });
})();
