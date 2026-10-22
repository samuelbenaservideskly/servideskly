/**
 * Pictures shown where they were put in a ticket's text (asked 22 Oct 2026).
 *
 * A picture pasted into the description or a reply (public/js/reply-files.js)
 * or pasted into an email (services/mail/inbound.ts) is stored as an ordinary
 * attachment, and the text keeps a marker where it was: `[image: name.png]`.
 * The ticket page turns each marker into the picture. The text itself stays
 * plain - no HTML is ever stored - and anywhere else (a notification, the
 * API, an export) the marker simply reads as what it is.
 */

// "[image: shot.png]", or "[image: shot.png | 480]" for a picture resized to
// 480 pixels wide in the box (reply-files.js). A stored file name never holds
// "|" (sanitiseFilename drops it), so the two cannot be confused.
const MARKER = /\[image:\s*([^\]\n|]{1,200}?)\s*(?:\|\s*(\d{1,4})\s*)?\]/g;
const MIN_WIDTH = 40;
const MAX_WIDTH = 4000;

/** The marker for a stored file name. */
export const imageMarker = (name: string): string => '[image: ' + name + ']';

export interface InlineFile {
  id: string;
  filename: string;
  content_type: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The kinds the download route serves as a picture; anything else (SVG
// above all) is a download there, so it is never drawn here.
const isImage = (f: InlineFile) => /^image\/(png|jpeg|gif|webp)$/i.test(f.content_type);

/**
 * The text as HTML: escaped, with each marker that names a picture this
 * person can see replaced by it. The entry's own files are looked in first
 * (an email's image001.png is not the last one's), then the ticket's.
 * A marker for a picture that is not there stays as text.
 */
export function textWithImages(
  text: string,
  ticketId: string,
  ownFiles: readonly InlineFile[],
  ticketFiles: readonly InlineFile[] = [],
): string {
  let html = '';
  let at = 0;
  for (const match of text.matchAll(MARKER)) {
    const name = match[1]!;
    const width = match[2] ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(match[2]))) : 0;
    const file =
      ownFiles.find((f) => isImage(f) && f.filename === name) ??
      [...ticketFiles].reverse().find((f) => isImage(f) && f.filename === name);
    html += escapeHtml(text.slice(at, match.index));
    if (file) {
      const href = '/tickets/' + encodeURIComponent(ticketId) + '/attachments/' + encodeURIComponent(file.id);
      html +=
        '<a class="tk-inline-img" href="' + escapeHtml(href) + '" target="_blank" rel="noopener">' +
        '<img src="' + escapeHtml(href) + '?embed" alt="' + escapeHtml(name) + '"' +
        // An attribute, not a style: the page's policy refuses inline styles.
        (width ? ' width="' + width + '"' : '') +
        ' loading="lazy"></a>';
    } else {
      html += escapeHtml(match[0]);
    }
    at = match.index! + match[0].length;
  }
  return html + escapeHtml(text.slice(at));
}
