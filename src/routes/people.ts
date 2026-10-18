import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { isStaff, findUserById, listUsers, type UserRow } from '../services/users.js';
import { groupsForUser } from '../services/groups.js';
import { listUserGroups, userGroupIdsFor } from '../services/user-groups.js';
import { settings } from '../settings/index.js';
import { listTickets, PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../services/tickets.js';

/**
 * People: the directory at /people, and one person at /people/:id.
 *
 * Clicking a name used to go to that person's page under Settings - Users,
 * which is an administrator's page about an *account*: roles, groups,
 * passwords, the danger zone. A technician saw no page at all, so a name in
 * the queue was a dead end for everybody but an administrator - reported
 * 15 Oct 2026.
 *
 * Four decisions:
 *
 * 1. **Who may look somebody up is a setting**, off by default for
 *    technicians and for requesters (Settings - Users - Other settings). An
 *    administrator always may: they can read every account under Settings
 *    anyway, so a switch there would be a second answer to a settled
 *    question. A list of everybody with their telephone number is something
 *    an organisation publishes, not something a helpdesk publishes for it.
 * 2. **Own company only** narrows a search to the searcher's own company,
 *    for a service desk that serves several - one customer's staff list is
 *    not another's to read. An administrator is not narrowed.
 * 3. **Nothing is settable.** Everything that changes an account stays under
 *    Settings - Users, and an administrator gets a link to it from here.
 * 4. **Tickets are read with the reader's own permissions** (`listTickets`
 *    with the viewer), so a technician sees what they could have found in
 *    the queue and no more - and a requester allowed to look somebody up is
 *    shown no ticket lists at all, only how to reach them.
 */
export const peopleRouter = Router();

peopleRouter.use(requireAuth());

/** Whether this person may look other people up at all. */
export function canUseDirectory(user: Pick<UserRow, 'role'>): boolean {
  if (user.role === 'admin') return true;
  const { directory } = settings().people;
  return user.role === 'agent' ? directory.technicians : directory.users;
}

/**
 * Whether this person may open one person's page.
 *
 * Staff always: a technician already sees that name, and its tickets, in
 * the queue - gating the page behind the directory switch would turn a
 * name they can read into a 404. The switch is about *searching*, which is
 * the thing that publishes a staff list.
 */
export function canSeePerson(user: Pick<UserRow, 'role'>): boolean {
  return isStaff(user.role) || canUseDirectory(user);
}

/** The company a search is confined to, or '' for all of them. */
function confinedTo(viewer: UserRow): string {
  if (viewer.role === 'admin') return '';
  return settings().people.directory.ownCompanyOnly ? (viewer.company ?? '') : '';
}

const PER_PAGE = 25;

peopleRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const viewer = req.currentUser;
    // The same 404 as a page that does not exist. A refusal would say the
    // directory is here and closed, which is nobody's business either.
    if (!viewer || !canUseDirectory(viewer)) throw notFound();

    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const asked = Number(req.query.page);
    const page = Number.isInteger(asked) && asked > 0 ? asked : 1;
    const company = confinedTo(viewer);

    // listUsers leaves out the accounts that are not people - the mail
    // sender and the Anonymous placeholder - on every tab.
    const found = await listUsers({
      ...(search ? { search } : {}),
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    });

    /*
     * The company rule is applied here rather than inside listUsers: it is
     * the viewer's own company rather than a filter they chose, and that
     * query is already the one every other page shares.
     *
     * The break-glass account goes with it (asked for 16 Oct 2026). It is
     * not a colleague anybody needs to find: it exists for the day
     * everything else is broken, it has no phone or department to look up,
     * and every page that manages it is Settings - Users - Break-glass.
     */
    const listed = found.rows.filter((person) => !(person.role === 'admin' && person.role_locked));
    const people = company
      ? listed.filter((person) => (person.company ?? '') === company)
      : listed;

    res.render('people/index', {
      title: 'People',
      people,
      total: found.total,
      search,
      page,
      pages: Math.max(1, Math.ceil(found.total / PER_PAGE)),
      confined: Boolean(company),
      company,
    });
  }),
);

peopleRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const viewer = req.currentUser;
    if (!viewer || !canSeePerson(viewer)) throw notFound();

    const person = await findUserById(String(req.params.id));
    if (!person) throw notFound();

    // A requester who may look somebody up still sees only how to reach
    // them: what a colleague has raised is not theirs to read.
    const seesTickets = isStaff(viewer.role);
    const empty = { items: [] as Awaited<ReturnType<typeof listTickets>>['items'], total: 0 };

    const [raised, open, assigned, technicianGroups, userGroupIds] = await Promise.all([
      seesTickets
        ? listTickets(viewer, { scope: 'all', status: 'any', requesterId: person.id, includeTasks: false, page: 1, perPage: 8 })
        : empty,
      seesTickets
        ? listTickets(viewer, { scope: 'all', status: 'active', requesterId: person.id, includeTasks: false, page: 1, perPage: 1 })
        : empty,
      seesTickets
        ? listTickets(viewer, { scope: 'all', status: 'active', assigneeId: person.id, includeTasks: false, page: 1, perPage: 5 })
        : empty,
      groupsForUser(person.id),
      userGroupIdsFor(person.id),
    ]);

    // The names of the user groups they are in, from the one list.
    const userGroups = (await listUserGroups())
      .filter((group) => userGroupIds.includes(group.id))
      .map((group) => group.name);

    const details = [
      { label: 'Email', value: person.email, href: person.email ? 'mailto:' + person.email : '' },
      { label: 'Phone', value: person.phone, href: person.phone ? 'tel:' + person.phone : '' },
      { label: 'Company', value: person.company, href: '' },
      { label: 'Department', value: person.department, href: '' },
      { label: 'Job title', value: person.job_title, href: '' },
      { label: 'Office', value: person.office, href: '' },
    ].filter((line) => line.value);

    res.render('people/show', {
      title: person.display_name,
      person,
      details,
      seesTickets,
      raised: raised.items,
      raisedTotal: raised.total,
      openCount: open.total,
      assigned: assigned.items,
      assignedTotal: assigned.total,
      technicianGroups: seesTickets ? technicianGroups : [],
      userGroups: seesTickets ? userGroups : [],
      isAdmin: viewer.role === 'admin',
      isSelf: viewer.id === person.id,
      priorityLabels: PRIORITY_LABELS,
      statusLabels: STATUS_LABELS,
      typeLabels: TYPE_LABELS,
    });
  }),
);
