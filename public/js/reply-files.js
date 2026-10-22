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
        // A pasted picture taken off the list leaves the text too.
        forget(file.name);
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

  /*
   * A text box that shows pictures (asked for 22 Oct 2026). A <textarea>
   * holds only text, so where a box asks for it (data-paste-images) an
   * editable area takes its place on screen, and the textarea stays in the
   * form, hidden, holding what is posted: the words, with "[image: name]"
   * where each picture is. The server and the stored ticket are what they
   * were - plain text - and the ticket page draws the markers
   * (lib/inline-images.ts). Nothing typed or pasted is kept as markup:
   * a paste is plain text or pictures, formatting is refused, and the text
   * is read back from text nodes and line breaks only.
   *
   * A pasted picture joins the files like any other. Taking it out of the
   * text takes it off the list, and undo puts it back; its cross on the
   * list takes it out of the text.
   */
  var pictures = {};
  var editors = [];
  // "[image: name]", or "[image: name | 480]" once resized (lib/inline-images.ts).
  var MARKER = /\[image:\s*([^\]\n|]{1,200}?)\s*(?:\|\s*(\d{1,4})\s*)?\]/g;

  function has(name) {
    return Array.prototype.some.call(chosen.files, function (f) { return f.name === name; });
  }

  function forget(name) {
    if (!pictures[name]) return;
    editors.forEach(function (ed) {
      Array.prototype.forEach.call(ed.el.querySelectorAll('img[data-image]'), function (img) {
        if (img.getAttribute('data-image') === name) img.parentNode.removeChild(img);
      });
      ed.sync();
    });
    delete pictures[name];
  }

  // Which pasted pictures the text holds now, against the list: deleted ones
  // come off it, undone deletions go back on.
  function reconcile() {
    var shown = {};
    editors.forEach(function (ed) {
      Array.prototype.forEach.call(ed.el.querySelectorAll('img[data-image]'), function (img) {
        shown[img.getAttribute('data-image')] = true;
      });
    });
    var next = new DataTransfer();
    var changed = false;
    Array.prototype.forEach.call(chosen.files, function (f) {
      if (pictures[f.name] && !shown[f.name]) changed = true;
      else next.items.add(f);
    });
    Object.keys(shown).forEach(function (name) {
      if (pictures[name] && !has(name)) {
        next.items.add(pictures[name].file);
        changed = true;
      }
    });
    if (changed) {
      chosen = next;
      draw();
    }
  }

  // The words, with a marker for each picture: text nodes and line breaks
  // only, so anything else that got in reads as its text.
  function read(node) {
    var out = '';
    Array.prototype.forEach.call(node.childNodes, function (n) {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/ /g, ' ');
      } else if (n.nodeName === 'BR') {
        out += '\n';
      } else if (n.nodeName === 'IMG') {
        if (n.getAttribute('data-image')) {
          var width = n.getAttribute('width');
          out += '[image: ' + n.getAttribute('data-image') + (width ? ' | ' + width : '') + ']';
        }
      } else if (n.nodeType === 1) {
        var block = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL)$/.test(n.nodeName);
        if (block && out && !/\n$/.test(out)) out += '\n';
        out += read(n);
        if (block && !/\n$/.test(out)) out += '\n';
      }
    });
    return out;
  }

  function picture(name, width) {
    var img = document.createElement('img');
    img.src = pictures[name].url;
    img.alt = name;
    img.setAttribute('data-image', name);
    if (width) img.setAttribute('width', width);
    return img;
  }

  // The posted text back on screen (a refused reply's draft). A marker for a
  // picture this page does not hold - the browser cannot put files back -
  // stays as its text.
  function write(el, text) {
    var at = 0;
    var parts = [];
    text.replace(MARKER, function (whole, name, width, index) {
      parts.push(text.slice(at, index));
      parts.push(pictures[name] ? { name: name, width: width } : whole);
      at = index + whole.length;
      return whole;
    });
    parts.push(text.slice(at));
    parts.forEach(function (part) {
      if (typeof part === 'string') {
        if (part) el.appendChild(document.createTextNode(part));
      } else {
        el.appendChild(picture(part.name, part.width));
      }
    });
  }

  function picturesIn(data) {
    var found = [];
    Array.prototype.forEach.call(data.items || [], function (item) {
      if (item.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(item.type)) {
        var blob = item.getAsFile();
        if (blob) found.push(blob);
      }
    });
    return found;
  }

  function richBox(box) {
    var el = document.createElement('div');
    el.className = 'rich-box';
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    el.setAttribute('data-placeholder', box.getAttribute('placeholder') || '');
    if (box.required) el.setAttribute('aria-required', 'true');
    var label = box.id ? form.querySelector('label[for="' + box.id + '"]') : null;
    if (label) {
      if (!label.id) label.id = box.id + '-label';
      el.setAttribute('aria-labelledby', label.id);
    }
    write(el, box.value);

    var ed = { el: el, box: box };
    ed.sync = function () {
      var text = read(el);
      // The line break a browser keeps after the last line is not a line.
      if (el.lastChild && el.lastChild.nodeName === 'BR') text = text.replace(/\n$/, '');
      box.value = text;
      el.classList.toggle('rich-box--empty', text === '' && !el.querySelector('img'));
    };
    editors.push(ed);

    // The textarea stays in the form for the post and the browser's own
    // "fill this in"; it hands its focus to the box it stands for.
    box.classList.add('rich-box__source');
    box.tabIndex = -1;
    box.setAttribute('aria-hidden', 'true');
    box.addEventListener('focus', function () { el.focus(); });
    box.addEventListener('invalid', function () { setTimeout(function () { el.focus(); }, 0); });
    var wrap = document.createElement('div');
    wrap.className = 'rich-wrap';
    box.parentNode.insertBefore(wrap, box);
    wrap.appendChild(el);
    ed.sync();

    /*
     * Resizing a picture, as in Outlook: click it and drag a corner. The
     * width is kept as an attribute (never a style - the policy refuses
     * inline ones) and posted in its marker, "[image: name | 480]"; the
     * height follows the picture's own proportions. Positions are set
     * through the CSSOM, which the policy allows.
     */
    var picked = null;
    var drag = null;
    var size = document.createElement('span');
    size.className = 'rich-size';
    size.hidden = true;
    var handles = ['nw', 'ne', 'sw', 'se'].map(function (corner) {
      var h = document.createElement('span');
      h.className = 'rich-handle rich-handle--' + corner;
      h.setAttribute('data-corner', corner);
      h.setAttribute('aria-hidden', 'true');
      h.hidden = true;
      h.addEventListener('pointerdown', startDrag);
      wrap.appendChild(h);
      return h;
    });
    wrap.appendChild(size);

    function pick(img) {
      if (picked) picked.classList.remove('rich-box__chosen');
      picked = img;
      if (picked) picked.classList.add('rich-box__chosen');
      place();
    }

    function place() {
      if (picked && !el.contains(picked)) picked = null;
      if (!picked) {
        handles.forEach(function (h) { h.hidden = true; });
        return;
      }
      var w = wrap.getBoundingClientRect();
      var r = picked.getBoundingClientRect();
      var box2 = el.getBoundingClientRect();
      // A picture scrolled out of the box has no handles in view.
      var inView = r.bottom > box2.top && r.top < box2.bottom;
      var at = { nw: [r.left, r.top], ne: [r.right, r.top], sw: [r.left, r.bottom], se: [r.right, r.bottom] };
      handles.forEach(function (h) {
        var p = at[h.getAttribute('data-corner')];
        h.style.left = (p[0] - w.left) + 'px';
        h.style.top = (p[1] - w.top) + 'px';
        h.hidden = !inView;
      });
      size.style.left = (r.right - w.left + 8) + 'px';
      size.style.top = (r.bottom - w.top - 24) + 'px';
    }

    function startDrag(e) {
      if (!picked) return;
      e.preventDefault();
      var handle = e.currentTarget;
      var corner = handle.getAttribute('data-corner');
      drag = {
        handle: handle,
        x: e.clientX,
        width: picked.getBoundingClientRect().width,
        fromLeft: corner === 'nw' || corner === 'sw',
        ratio: picked.naturalWidth ? picked.naturalHeight / picked.naturalWidth : 1,
      };
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', moveDrag);
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
      handle.addEventListener('lostpointercapture', endDrag);
    }

    function moveDrag(e) {
      if (!drag || !picked) return;
      var grow = (e.clientX - drag.x) * (drag.fromLeft ? -1 : 1);
      var widest = el.clientWidth - 24;
      var width = Math.round(Math.max(40, Math.min(widest, drag.width + grow)));
      picked.setAttribute('width', String(width));
      size.textContent = width + ' × ' + Math.round(width * drag.ratio);
      size.hidden = false;
      place();
    }

    function endDrag() {
      if (!drag) return;
      var handle = drag.handle;
      handle.removeEventListener('pointermove', moveDrag);
      handle.removeEventListener('pointerup', endDrag);
      handle.removeEventListener('pointercancel', endDrag);
      handle.removeEventListener('lostpointercapture', endDrag);
      drag = null;
      size.hidden = true;
      ed.sync();
      place();
    }

    el.addEventListener('click', function (e) {
      pick(e.target && e.target.nodeName === 'IMG' && e.target.getAttribute('data-image') ? e.target : null);
    });
    el.addEventListener('scroll', place);
    el.addEventListener('blur', function () {
      // Leaving the box drops the handles; dragging one keeps them.
      setTimeout(function () { if (!drag && document.activeElement !== el) pick(null); }, 0);
    });
    window.addEventListener('resize', place);

    el.addEventListener('input', function () {
      ed.sync();
      reconcile();
      place();
    });

    // Bold, italics and the like: this is plain text.
    el.addEventListener('beforeinput', function (e) {
      if (/^format/.test(e.inputType)) e.preventDefault();
    });

    // Enter is a line break, not a new block of markup.
    // A chosen picture: Delete or Backspace removes it (undo brings it back),
    // anything else typed lets it go.
    el.addEventListener('keydown', function (e) {
      if (picked && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        var range = document.createRange();
        range.selectNode(picked);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        pick(null);
        document.execCommand('delete');
        return;
      }
      if (picked && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') pick(null);
      if (e.key === 'Enter' && !e.isComposing && document.execCommand('insertLineBreak')) e.preventDefault();
    });

    el.addEventListener('paste', function (e) {
      var data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      var text = data.getData('text/plain') || '';
      // Only a paste that is nothing but pictures: copying cells from Excel
      // brings a picture of them too, and there the words are what was meant.
      var found = text.trim() === '' ? picturesIn(data) : [];
      if (found.length) found.forEach(paste);
      else if (text) document.execCommand('insertText', false, text);
    });

    // Text dragged in arrives as text; files are the form's (above).
    el.addEventListener('drop', function (e) {
      if (!e.dataTransfer || e.dataTransfer.files.length) return;
      var text = e.dataTransfer.getData('text/plain');
      e.preventDefault();
      if (!text) return;
      var spot = document.caretRangeFromPoint
        ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : (function () {
            var p = document.caretPositionFromPoint && document.caretPositionFromPoint(e.clientX, e.clientY);
            if (!p) return null;
            var r = document.createRange();
            r.setStart(p.offsetNode, p.offset);
            return r;
          })();
      if (spot) {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(spot);
      }
      document.execCommand('insertText', false, text);
    });

    function paste(blob) {
      var file = new File([blob], pastedName(blob.type), { type: blob.type, lastModified: Date.now() });
      var sel = window.getSelection();
      var range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      var reader = new FileReader();
      reader.onload = function () {
        // A data: address: the page's policy draws images from itself and
        // data: only, and the bytes never leave the browser until the post.
        pictures[file.name] = { file: file, url: String(reader.result) };
        take([file]);
        el.focus();
        if (range && el.contains(range.startContainer)) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        var name = file.name.replace(/[^\w.-]/g, '');
        document.execCommand('insertHTML', false, '<img src="' + pictures[file.name].url + '" alt="' + name + '" data-image="' + name + '">');
        // Typing goes on under the picture (a <br> in the markup is dropped).
        document.execCommand('insertLineBreak');
        ed.sync();
      };
      reader.readAsDataURL(blob);
    }
  }

  // Without these the plain textarea stays, and pictures cannot be pasted.
  if (typeof document.execCommand === 'function' && 'contentEditable' in document.body) {
    Array.prototype.forEach.call(form.querySelectorAll('textarea[data-paste-images]'), richBox);
  }
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
