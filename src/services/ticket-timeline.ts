/**
 * The ticket page's conversation, as one list in time order: the request
 * itself, every comment and internal note, and the files - each file shown
 * with the message it came with (redesign, 21 Oct 2026).
 *
 * It replaced three blocks - the description, "Conversation" and
 * "Attachments" - that made a reader put the story back together
 * themselves: a reply said "see the attached document" and the document was
 * in a list further down, with nothing to say which reply it belonged to.
 *
 * A file has no column naming its comment, and does not need one: a reply
 * and its files are stored by the same request, by the same person, within a
 * second of each other, with the same internal flag. That is the rule, with
 * room for a slow upload. Files the request was raised with (the form, or
 * an email's attachments) arrive the same way just after the ticket. Anything
 * else - a file uploaded on its own - is an entry of its own.
 */

/** How close a file and a message have to be to be one entry. */
const TOGETHER_MS = 20_000;
/** Files the ticket was raised with arrive just after it. */
const WITH_REQUEST_MS = 120_000;

export interface TimelineComment {
  id: string;
  author_id: string;
  is_internal: boolean | number;
  created_at: string;
}

export interface TimelineFile {
  id: string;
  uploaded_by: string;
  is_internal: boolean | number;
  created_at: string;
}

export type TimelineEntry<C, F> =
  | { kind: 'request'; at: string; files: F[] }
  | { kind: 'comment'; at: string; comment: C; files: F[] }
  | { kind: 'files'; at: string; by: string; internal: boolean; files: F[] };

const ms = (iso: string) => new Date(iso).getTime();
const internal = (v: boolean | number) => v === true || v === 1;

export function buildTimeline<C extends TimelineComment, F extends TimelineFile>(
  ticket: { created_at: string; requester_id: string; raised_by?: string | null },
  comments: readonly C[],
  files: readonly F[],
): TimelineEntry<C, F>[] {
  const request: TimelineEntry<C, F> & { kind: 'request' } = { kind: 'request', at: ticket.created_at, files: [] };
  const said = comments.map((comment) => ({ kind: 'comment' as const, at: comment.created_at, comment, files: [] as F[] }));
  const alone: (TimelineEntry<C, F> & { kind: 'files' })[] = [];
  const firstComment = said.length ? ms(said[0]!.at) : Number.POSITIVE_INFINITY;
  const raisers = new Set([ticket.requester_id, ticket.raised_by ?? ''].filter(Boolean));

  for (const file of files) {
    const at = ms(file.created_at);
    // The closest message by the same person, as private or as public.
    let best: (typeof said)[number] | null = null;
    let gap = TOGETHER_MS + 1;
    for (const entry of said) {
      const d = Math.abs(ms(entry.at) - at);
      if (entry.comment.author_id === file.uploaded_by && internal(entry.comment.is_internal) === internal(file.is_internal) && d < gap) {
        best = entry;
        gap = d;
      }
    }
    if (best && gap <= TOGETHER_MS) {
      best.files.push(file);
      continue;
    }
    const sinceRaised = at - ms(ticket.created_at);
    if (sinceRaised >= -TOGETHER_MS && sinceRaised <= WITH_REQUEST_MS && at <= firstComment && !internal(file.is_internal) &&
        (raisers.has(file.uploaded_by) || raisers.size === 0)) {
      request.files.push(file);
      continue;
    }
    // On its own: joined with the files just before it from the same person.
    const last = alone[alone.length - 1];
    if (last && last.by === file.uploaded_by && last.internal === internal(file.is_internal) && at - ms(last.files[last.files.length - 1]!.created_at) <= TOGETHER_MS) {
      last.files.push(file);
    } else {
      alone.push({ kind: 'files', at: file.created_at, by: file.uploaded_by, internal: internal(file.is_internal), files: [file] });
    }
  }

  const rest: TimelineEntry<C, F>[] = [...said, ...alone];
  rest.sort((a, b) => ms(a.at) - ms(b.at));
  return [request, ...rest];
}
