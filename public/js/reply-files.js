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

  // A picture pasted into the text (asked for 22 Oct 2026): it joins the
  // files like any other, and the text gets "[image: name]" where the caret
  // was, which the ticket page draws as the picture (lib/inline-images.ts).
  // Only a paste that is nothing but pictures: copying cells from Excel
  // brings a picture of them too, and there the words are what was meant.
  Array.prototype.forEach.call(form.querySelectorAll('textarea[data-paste-images]'), function (box) {
    box.addEventListener('paste', function (e) {
      var data = e.clipboardData;
      if (!data || (data.getData('text/plain') || '').trim() !== '') return;
      var pictures = [];
      Array.prototype.forEach.call(data.items || [], function (item) {
        if (item.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(item.type)) {
          var blob = item.getAsFile();
          if (blob) pictures.push(blob);
        }
      });
      if (!pictures.length) return;
      e.preventDefault();
      var markers = pictures.map(function (blob) {
        var file = new File([blob], pastedName(blob.type), { type: blob.type, lastModified: Date.now() });
        take([file]);
        return '[image: ' + file.name + ']';
      });
      var start = box.selectionStart;
      var before = box.value.slice(0, start);
      var text = (before && !/\n$/.test(before) ? '\n' : '') + markers.join('\n') + '\n';
      box.setRangeText(text, start, box.selectionEnd, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  }

  // pasted-image-20261022-143005-2.png: unique on the ticket, and nothing in
  // it the server's file name rules would change.
  var pasted = 0;
  function pastedName(type) {
    var d = new Date();
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    pasted += 1;
    var ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
    return 'pasted-image-' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' +
      two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()) + '-' + pasted + '.' + ext;
  }
})();
