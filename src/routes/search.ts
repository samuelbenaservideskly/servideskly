import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { canSeeTicket, getTicketById, listTickets, PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../services/tickets.js';
import { listUsers } from '../services/users.js';
import { ticketFor } from './hooks.js';
import { canUseDirectory } from './people.js';

/**
 * The search bar above every page.
 *
 * It said "Search tickets, people, references..." and searched tickets, so
 * two thirds of its own promise went nowhere. This is the page it posts to
 * now.
 *
 * Three decisions:
 *
 * 1. **A reference goes straight to its ticket.** Typing INC-000123 means
 *    "open that ticket", not "show me a page with one result on it" - and
 *    it is the one search where the answer is certain. Only when the reader
 *    may see that ticket; otherwise it falls through to the ordinary search,
 *    which finds nothing, so the jump never says a ticket exists.
 * 2. **Each section is read with the reader's own permissions.**
 *    \`listTickets\` with the viewer, and people only when the directory is
 *    open to them (routes/people.ts). A requester searching sees their own
 *    tickets, which is what the bar has always done for them.
 * 3. **A few of each, then the way to the rest.** The page is for finding
 *    one thing; the ticket list and the directory are the places to page
 *    through many, and each section links to itself with the same words.
 */
export const searchRouter = Router();

searchRouter.use(requireAuth());

const SHOWN = 8;

searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewer = req.currentUser;
    if (!viewer) throw forbidden();

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.render('search', {
        title: 'Search',
        q,
        tickets: [],
        ticketTotal: 0,
        people: [],
        peopleTotal: 0,
        canSearchPeople: canUseDirectory(viewer),
        ...LABELS,
      });
      return;
    }

    // A reference, when it names a ticket this person may open.
    const referenced = await ticketFor(q);
    if (referenced) {
      const ticket = await getTicketById(referenced);
      if (ticket && (await canSeeTicket(viewer, ticket))) {
        res.redirect('/tickets/' + ticket.id);
        return;
      }
    }

    const canSearchPeople = canUseDirectory(viewer);
    const [tickets, people] = await Promise.all([
      listTickets(viewer, { scope: 'all', status: 'any', search: q, includeTasks: false, page: 1, perPage: SHOWN }),
      canSearchPeople ? listUsers({ search: q, limit: SHOWN, offset: 0 }) : Promise.resolve({ rows: [], total: 0 }),
    ]);

    res.render('search', {
      title: 'Search',
      q,
      tickets: tickets.items,
      ticketTotal: tickets.total,
      people: people.rows,
      peopleTotal: people.total,
      canSearchPeople,
      ...LABELS,
    });
  }),
);

const LABELS = {
  priorityLabels: PRIORITY_LABELS,
  statusLabels: STATUS_LABELS,
  typeLabels: TYPE_LABELS,
};
