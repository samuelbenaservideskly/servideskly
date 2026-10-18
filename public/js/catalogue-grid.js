/*
 * Dragging a tile in the service catalogue's preview.
 * The seventh approved script (15 Oct 2026); asked for as "like in ticket
 * template", and built the same way as form-builder.js.
 *
 * Every gesture is a form the server already accepts: dropping a tile posts
 * the cell it was dropped on to /tiles/position, which is what the arrows
 * beside it post one cell at a time. There is no client-side model - the
 * page reloads and the server draws the grid it stored.
 *
 * A tile can be dropped on **any** cell, empty or taken: an empty one is a
 * move, a taken one swaps the two, and both look the same to the person
 * dragging. Without this file the page is unchanged: the arrows move a
 * tile, the + in a cell adds one there, the gear opens its settings and the
 * bin removes it. Nothing here is the only way to do anything.
 */
(function () {
  'use strict';

  var grids = document.querySelectorAll('[data-catalogue-grid]');
  if (!grids.length) return;

  var form = document.getElementById('tile-position-form');
  if (!form) return;

  var dragging = null;

  /** Posts "put this tile in this cell" and lets the page reload. */
  function drop(tile, cell) {
    form.querySelector('[name="id"]').value = tile.getAttribute('data-tile');
    form.querySelector('[name="cell"]').value = String(cell);
    form.submit();
  }

  /** The cell a pointer is over: a tile's own, or an empty slot's. */
  function cellOf(target) {
    if (!target || !target.closest) return null;
    var holder = target.closest('[data-cell]');
    if (!holder) return null;
    var cell = Number(holder.getAttribute('data-cell'));
    return Number.isFinite(cell) ? { cell: cell, el: holder } : null;
  }

  function clearMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.is-over'), function (el) {
      el.classList.remove('is-over');
    });
  }

  Array.prototype.forEach.call(grids, function (grid) {
    grid.classList.add('catalogue-preview--draggable');

    // The arrows are for a browser without this file. Dragging replaces them.
    Array.prototype.forEach.call(grid.querySelectorAll('[data-has-script]'), function (el) {
      el.hidden = true;
    });

    grid.addEventListener('dragstart', function (e) {
      var tile = e.target.closest ? e.target.closest('[data-tile]') : null;
      if (!tile) return;
      dragging = tile;
      tile.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without this.
        e.dataTransfer.setData('text/plain', tile.getAttribute('data-tile') || '');
      }
    });

    grid.addEventListener('dragend', function () {
      if (dragging) dragging.classList.remove('is-dragging');
      clearMarks();
      dragging = null;
    });

    grid.addEventListener('dragover', function (e) {
      if (!dragging) return;
      // Every cell is a target, which is what "place it anywhere" means.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      var over = cellOf(e.target);
      clearMarks();
      if (over && over.el !== dragging) over.el.classList.add('is-over');
    });

    grid.addEventListener('drop', function (e) {
      if (!dragging) return;
      e.preventDefault();
      var over = cellOf(e.target);
      if (!over || over.el === dragging) return;
      drop(dragging, over.cell);
    });
  });
})();
