import type { Request } from 'express';

/**
 * The reading half of the member picker.
 *
 * Shared because a technician group and a user group ask the same three
 * questions of the query string, and a picker that paged differently in the
 * two places would be a picker nobody trusts.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_SIZE = 10;

/**
 * "All" is still a number.
 *
 * Somebody asking for every name wants the page to render, not the process to
 * read the whole directory into memory, so the cap stays - it is just far
 * above anything a service desk has.
 */
export const ALL_CAP = 1000;

export interface PickerQuery {
  q: string;
  /** A number, or the literal 'all'. */
  size: number | 'all';
  page: number;
  limit: number;
  offset: number;
  /** The members table pages on its own, with its own size. */
  msize: number | 'all';
  mpage: number;
}

/** One page of a list already in memory, for the members table. */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pages: number;
  size: number | 'all';
}

export function pageOf<T>(rows: readonly T[], size: number | 'all', page: number): Paged<T> {
  const total = rows.length;
  if (size === 'all') return { rows: [...rows], total, page: 1, pages: 1, size };

  const pages = Math.max(1, Math.ceil(total / size));
  // A page past the end shows the last one rather than nothing: a group can
  // shrink between a link being drawn and being followed.
  const safe = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((safe - 1) * size, safe * size), total, page: safe, pages, size };
}

export function pickerQuery(req: Request): PickerQuery {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';

  const rawSize = typeof req.query.size === 'string' ? req.query.size : '';
  const size: number | 'all' =
    rawSize === 'all'
      ? 'all'
      : PAGE_SIZES.find((option) => String(option) === rawSize) ?? DEFAULT_SIZE;

  const rawPage = Number(req.query.page);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;

  const limit = size === 'all' ? ALL_CAP : size;
  const offset = size === 'all' ? 0 : (page - 1) * size;

  // The members table has its own size and page, so searching for somebody to
  // add does not move the list of who is already in the group.
  const rawMsize = typeof req.query.msize === 'string' ? req.query.msize : '';
  const msize: number | 'all' =
    rawMsize === 'all'
      ? 'all'
      : PAGE_SIZES.find((option) => String(option) === rawMsize) ?? DEFAULT_SIZE;

  const rawMpage = Number(req.query.mpage);
  const mpage = Number.isInteger(rawMpage) && rawMpage > 0 ? Math.min(rawMpage, 10_000) : 1;

  return { q, size, page, limit, offset, msize, mpage };
}

/** The values a save needs to return to the page it was made on. */
export function pickerReturn(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['q', 'size', 'page', 'msize', 'mpage']) {
    const value = body[key];
    if (typeof value === 'string' && value) {
      parts.push(key + '=' + encodeURIComponent(value.slice(0, 100)));
    }
  }

  return (parts.length > 0 ? '?' + parts.join('&') : '') + '#members';
}

/** The ids a submitted picker page had on screen, and which were ticked. */
export function pickerSelection(body: Record<string, unknown>): {
  shown: string[];
  ticked: string[];
} {
  return { shown: asIdList(body.shown), ticked: asIdList(body.members) };
}

function asIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).slice(0, ALL_CAP);
  if (typeof value === 'string' && value) return [value];
  return [];
}
