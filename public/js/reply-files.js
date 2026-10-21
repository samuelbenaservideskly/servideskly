/*
 * The files a reply will carry, as chips under the box (ticket page, asked
 * for 21 Oct 2026: "implement both with the script").
 *
 * The form works without this: an ordinary file picker posts the files with
 * the words (POST /tickets/:id/comments). What this adds:
 *
 * - each chosen file as a chip with its size and a cross to take it off;
 * - choosing again ADDS to the list - a file picker on its own replaces it,
 *   which loses the first screenshot when the second is picked;
 * - files dropped onto the reply box join the list too.
 *
 * The real <input type=file> stays in the form and holds the list
 * (DataTransfer), so the post is exactly what the plain picker would send.
 * No request is made from here, and nothing a file is called reaches the
 * page as markup - names go in as text.
 */
/*
 * Any form that asks for it (data-file-form) gets the same treatment: the
 * reply box on a ticket, and New ticket (21 Oct 2026). Inside it,
 * data-file-input is the file input, data-file-list the chips and
 * data-file-add the button that opens the picker.
 */
(function () {
  'use strict';
  Array.prototype.forEach.call(document.querySelectorAll('form[data-file-form]'), enhance);

  function enhance(form) {
  var input = form.querySelector('[data-file-input]');
  var list = form.querySelector('[data-file-list]');
  var add = form.querySelector('[data-file-add]');
  if (!input || !list || !add) return;

  // Without DataTransfer a list cannot be built, and the plain picker stays.
  var chosen;
  try {
    chosen = new DataTransfer();
  } catch (e) {
    return;
  }

  var removeLabel = form.getAttribute('data-remove-label') || 'Remove';

  input.classList.add('file-input--hidden');
  Array.prototype.forEach.call(form.querySelectorAll('[data-file-add]'), function (el) { el.hidden = false; });

  function size(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function same(a, b) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  }

  function draw() {
    while (list.firstChild) list.removeChild(list.firstChild);
    Array.prototype.forEach.call(chosen.files, function (file, index) {
      var li = document.createElement('li');
      li.className = 'tk-chip';
      var name = document.createElement('span');
      name.className = 'tk-chip__name';
      name.textContent = file.name;
      name.title = file.name;
      var meta = document.createElement('span');
      meta.className = 'tk-chip__size';
      meta.textContent = size(file.size);
      var cross = document.createElement('button');
      cross.type = 'button';
      cross.className = 'tk-chip__remove';
      cross.setAttribute('aria-label', removeLabel + ' ' + file.name);
      cross.textContent = '×';
      cross.addEventListener('click', function () {
        var next = new DataTransfer();
        Array.prototype.forEach.call(chosen.files, function (f, i) {
          if (i !== index) next.items.add(f);
        });
        chosen = next;
        draw();
        add.focus();
      });
      li.appendChild(name);
      li.appendChild(meta);
      li.appendChild(cross);
      list.appendChild(li);
    });
    list.hidden = chosen.files.length === 0;
    input.files = chosen.files;
  }

  function take(files) {
    Array.prototype.forEach.call(files, function (file) {
      var known = Array.prototype.some.call(chosen.files, function (f) { return same(f, file); });
      if (!known) chosen.items.add(file);
    });
    draw();
  }

  // The browser has just replaced the input's list with the new pick.
  input.addEventListener('change', function () {
    take(input.files);
  });

  // The label is a button to a keyboard too.
  add.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  add.tabIndex = 0;

  form.addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
      e.preventDefault();
      form.classList.add('file-form--drop');
    }
  });
  form.addEventListener('dragleave', function (e) {
    if (!form.contains(e.relatedTarget)) form.classList.remove('file-form--drop');
  });
  form.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    form.classList.remove('file-form--drop');
    take(e.dataTransfer.files);
  });
  }
})();
