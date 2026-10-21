/**
 * Demonstration data, to try the dashboard and reports with:
 *
 *   npm run demo:seed     # builds data/demo.sqlite (and data/demo-uploads)
 *   npm run dev:demo      # runs the helpdesk on it, http://localhost:3001
 *
 * A separate database: the owner's own data/ticketing.sqlite is never
 * touched. Refuses to run on anything but a file called demo*.sqlite, and
 * refuses a database that already has demo data (delete the three demo
 * files to start again).
 *
 * What it makes, all invented: five customer companies with requesters, five
 * technician groups each with a manager and technicians, SLA switched on, a
 * display name format, and some 75 days of tickets - most answered and
 * resolved in time, some late (SLA breached), some cancelled, some still
 * open. Technicians sign in with the local seed password (LOCAL_SEED_PASSWORD,
 * 1234 in development), like admin@local.
 */
import crypto from 'node:crypto';
import path from 'node:path';

const file = process.env.DATABASE_PATH ?? '';
if (!/^demo[^/\\]*\.sqlite$/i.test(path.basename(file)) || process.env.DATABASE_URL) {
  console.error('Refusing: run through "npm run demo:seed", which points DATABASE_PATH at data/demo.sqlite.');
  process.exit(1);
}

const { runMigrations, execute, queryOne, closeDatabase } = await import('../src/db/index.js');
const { loadSettings, updateSettings, settings } = await import('../src/settings/index.js');
const { ensureLocalAdmin, createLocalAccount } = await import('../src/auth/local-accounts.js');
const { ensureDefaultTemplate, ensureStarterTemplates } = await import('../src/services/templates.js');
const { seedNotifications } = await import('../src/services/mail/notifications.js');
const { adoptNewDefaultColours } = await import('../src/services/branding.js');
const { createGroup, setGroupManager, setMembersWithin } = await import('../src/services/groups.js');
const { createTicket } = await import('../src/services/tickets.js');
const { addBusinessMinutes } = await import('../src/services/sla.js');
const { applyAllDisplayNames } = await import('../src/services/display-names.js');
const { config } = await import('../src/config.js');
const { newId } = await import('../src/lib/util.js');

await runMigrations();
await loadSettings();
await adoptNewDefaultColours();
await ensureLocalAdmin();
await ensureDefaultTemplate();
await ensureStarterTemplates();
await seedNotifications();

if (await queryOne("SELECT key FROM seed_markers WHERE key = 'demo_data'")) {
  console.error('This database already has demo data. Delete data/demo.sqlite* and data/demo-uploads to start again.');
  await closeDatabase();
  process.exit(1);
}

// A fixed seed: the same demo every time it is built.
let state = 20261015;
const random = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
const chance = (p: number) => random() < p;

const PASSWORD = config.localAccounts.seedPassword ?? process.env.LOCAL_SEED_PASSWORD ?? '1234';

// --- settings: SLA on, a display name format ---------------------------------------

await updateSettings(
  {
    sla: {
      enabled: true,
      notifyManager: false,
      pauseOnHold: true,
      days: [1, 2, 3, 4, 5],
      start: '08:00',
      end: '17:00',
      targets: {
        urgent: { response: 30, resolution: 4 * 60 },
        high: { response: 2 * 60, resolution: 9 * 60 },
        normal: { response: 4 * 60, resolution: 3 * 9 * 60 },
        low: { response: 9 * 60, resolution: 5 * 9 * 60 },
      },
    },
    people: { displayNameFormat: '[First] [Last] - ([Company])' },
  },
  null,
);
const cal = settings().sla;

// --- people ------------------------------------------------------------------------

const COMPANIES = [
  { name: 'Contoso', domain: 'contoso.com' },
  { name: 'Fabrikam', domain: 'fabrikam.com' },
  { name: 'Northwind Traders', domain: 'northwind.com' },
  { name: 'Tailspin Toys', domain: 'tailspintoys.com' },
  { name: 'Adventure Works', domain: 'adventure-works.com' },
];
const FIRST = ['Emma', 'James', 'Olivia', 'Thomas', 'Sophie', 'Daniel', 'Grace', 'Michael', 'Chloe', 'Ryan', 'Hannah', 'David', 'Lucy', 'Jack', 'Amelia', 'Ethan', 'Isabel', 'Adam', 'Megan', 'Sam', 'Alex', 'Laura', 'Nina', 'Oliver', 'Kate'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Taylor', 'Wilson', 'Davies', 'Evans', 'Thomas', 'Roberts', 'Walker', 'Wright', 'Thompson', 'White', 'Hughes', 'Edwards', 'Green', 'Hall', 'Wood', 'Harris'];
const DEPARTMENTS = ['Finance', 'Sales', 'Marketing', 'HR', 'Operations', 'Legal', 'Warehouse', 'Customer care'];

const used = new Set<string>();
async function person(company: { name: string; domain: string }, role: 'user' | 'agent', department: string) {
  let first = '', last = '', email = '';
  do {
    first = pick(FIRST);
    last = pick(LAST);
    email = (first + '.' + last).toLowerCase() + '@' + company.domain;
  } while (used.has(email));
  used.add(email);
  const user = await createLocalAccount(
    {
      email,
      displayName: first + ' ' + last,
      firstName: first,
      lastName: last,
      company: company.name,
      role,
      // Requesters never sign in to the demo; technicians use the seed password.
      password: role === 'agent' ? PASSWORD : crypto.randomBytes(18).toString('base64url'),
    },
    null,
  );
  await execute('UPDATE users SET department = ? WHERE id = ?', [department, user.id]);
  return user;
}

const requesters = [];
for (const company of COMPANIES) {
  for (let i = 0; i < 7; i += 1) requesters.push(await person(company, 'user', pick(DEPARTMENTS)));
}

const DESK = { name: 'Service Desk', domain: 'servicedesk.demo' };
const GROUPS = [
  { name: 'Service Desk', description: 'First line: everything arrives here.', size: 4 },
  { name: 'Desktop Support', description: 'Laptops, printers, peripherals.', size: 3 },
  { name: 'Network', description: 'Wi-Fi, VPN, firewalls.', size: 2 },
  { name: 'Identity & Access', description: 'Accounts, groups, permissions.', size: 2 },
  { name: 'Facilities', description: 'Desks, keys, the building.', size: 2 },
];
const groups: { id: string; name: string; techs: string[]; manager: string }[] = [];
const technicians: { email: string; group: string; role: string }[] = [];
for (const g of GROUPS) {
  const group = await createGroup({ name: g.name, description: g.description, isActive: true }, null);
  const techs = [];
  for (let i = 0; i < g.size; i += 1) {
    const t = await person(DESK, 'agent', 'IT');
    techs.push(t.id);
    technicians.push({ email: t.email, group: g.name, role: i === 0 ? 'manager' : 'technician' });
  }
  await setMembersWithin(group.id, techs, techs, null);
  // The first technician of each group manages it.
  await setGroupManager(group.id, techs[0]!, null);
  groups.push({ id: group.id, name: g.name, techs, manager: techs[0]! });
}

// --- tickets -----------------------------------------------------------------------

const TITLES: Record<string, string[]> = {
  'Service Desk': ['Cannot open Outlook', 'Password expired', 'Teams keeps crashing', 'New starter next Monday', 'Software install request', 'Shared mailbox access'],
  'Desktop Support': ['Printer on floor 2 jams', 'Laptop battery swollen', 'Second monitor flickers', 'Docking station not detected', 'Keyboard missing keys', 'New laptop request'],
  Network: ['VPN disconnects every hour', 'Wi-Fi slow in meeting room', 'Cannot reach the ERP from home', 'Firewall rule for supplier portal'],
  'Identity & Access': ['Access to the finance share', 'MFA phone replaced', 'Account locked out', 'Leaver: disable account', 'Add to the Sales distribution list'],
  Facilities: ['Desk chair broken', 'Office too cold', 'New access card', 'Meeting room screen does not turn on'],
};
const PRIORITY_MIX = ['normal', 'normal', 'normal', 'normal', 'high', 'high', 'low', 'low', 'urgent'] as const;
const TYPE_MIX = ['incident', 'incident', 'incident', 'service_request', 'service_request', 'change_request'] as const;
const GROUP_WEIGHTS = [0, 0, 0, 1, 1, 2, 3, 4];

const now = Date.now();
const DAY = 86_400_000;
let made = 0;

async function event(ticketId: string, actorId: string, from: string, to: string, at: Date) {
  await execute(
    "INSERT INTO ticket_events (id, ticket_id, actor_id, kind, field, old_value, new_value, created_at) VALUES (?, ?, ?, 'field_changed', 'status', ?, ?, ?)",
    [newId(), ticketId, actorId, from, to, at.toISOString()],
  );
}
async function comment(ticketId: string, authorId: string, body: string, at: Date) {
  await execute(
    'INSERT INTO ticket_comments (id, ticket_id, author_id, body, is_internal, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [newId(), ticketId, authorId, body, at.toISOString()],
  );
}

for (let daysAgo = 75; daysAgo >= 0; daysAgo -= 1) {
  const day = new Date(now - daysAgo * DAY);
  const weekend = [0, 6].includes(day.getUTCDay());
  const count = weekend ? (chance(0.5) ? 1 : 0) : 4 + Math.floor(random() * 6);
  for (let i = 0; i < count; i += 1) {
    const created = new Date(day);
    created.setUTCHours(6 + Math.floor(random() * 10), Math.floor(random() * 60), Math.floor(random() * 60), 0);
    if (created.getTime() > now) continue;

    const group = groups[pick(GROUP_WEIGHTS)]!;
    const priority = pick(PRIORITY_MIX);
    const type = pick(TYPE_MIX);
    const requester = pick(requesters);
    const ticket = await createTicket({
      title: pick(TITLES[group.name]!),
      description: 'Created for the demonstration. Nothing here is real.',
      priority,
      category: 'other',
      requesterId: requester.id,
      groupId: group.id,
      type,
    });
    made += 1;

    const target = cal.targets[priority];
    // Most answered in time; about one in eight late.
    const responseLate = chance(0.13);
    const responseMinutes = Math.max(5, Math.round(target.response * (responseLate ? 1.3 + random() * 2 : 0.1 + random() * 0.8)));
    const responded = addBusinessMinutes(created, responseMinutes, cal);
    const assignee = chance(0.92) ? pick(group.techs) : null;

    const cancelled = chance(0.06);
    const resolutionLate = chance(0.16);
    const resolutionMinutes = Math.round(target.resolution * (resolutionLate ? 1.15 + random() * 1.5 : 0.2 + random() * 0.75));
    const resolved = addBusinessMinutes(created, Math.max(resolutionMinutes, responseMinutes + 10), cal);

    let status = 'open';
    let resolvedAt: Date | null = null;
    let closedAt: Date | null = null;
    const actor = assignee ?? group.manager;

    if (responded.getTime() <= now) {
      await comment(ticket.id, actor, 'Thanks, we are looking into it.', responded);
      await event(ticket.id, actor, 'open', 'in_progress', responded);
      status = 'in_progress';
    }
    if (cancelled && responded.getTime() <= now) {
      const at = new Date(responded.getTime() + 3_600_000);
      if (at.getTime() <= now) {
        await event(ticket.id, actor, status, 'cancelled', at);
        status = 'cancelled';
      }
    } else if (resolved.getTime() <= now) {
      // A few go on hold first, waiting for the requester.
      if (chance(0.15)) {
        const hold = new Date(responded.getTime() + (resolved.getTime() - responded.getTime()) / 3);
        await event(ticket.id, actor, status, 'pending', hold);
        await event(ticket.id, actor, 'pending', 'in_progress', new Date(hold.getTime() + (resolved.getTime() - hold.getTime()) / 2));
      }
      await comment(ticket.id, actor, 'Sorted - please let us know if it comes back.', resolved);
      await event(ticket.id, actor, 'in_progress', 'resolved', resolved);
      status = 'resolved';
      resolvedAt = resolved;
      // Closed three days later, if that has happened yet.
      if (resolved.getTime() + 3 * DAY <= now) {
        closedAt = new Date(resolved.getTime() + 3 * DAY);
        await event(ticket.id, actor, 'resolved', 'closed', closedAt);
        status = 'closed';
      }
    } else if (chance(0.25) && status === 'in_progress') {
      await event(ticket.id, actor, 'in_progress', 'pending', new Date(Math.min(now, responded.getTime() + 2 * 3_600_000)));
      status = 'pending';
    }

    const updated = closedAt ?? resolvedAt ?? (responded.getTime() <= now ? responded : created);
    await execute(
      `UPDATE tickets SET created_at = ?, updated_at = ?, status = ?, assignee_id = ?, resolved_at = ?, closed_at = ? WHERE id = ?`,
      [created.toISOString(), updated.toISOString(), status, assignee, resolvedAt?.toISOString() ?? null, closedAt?.toISOString() ?? null, ticket.id],
    );
    await execute("UPDATE ticket_events SET created_at = ? WHERE ticket_id = ? AND kind = 'created'", [created.toISOString(), ticket.id]);
  }
}

await applyAllDisplayNames();
await execute("INSERT INTO seed_markers (key, done_at) VALUES ('demo_data', ?)", [new Date().toISOString()]);

console.log('\nDemo data: ' + requesters.length + ' requesters at ' + COMPANIES.length + ' companies, ' + groups.length + ' groups, ' + made + ' tickets over 75 days.');
console.log('Run it with: npm run dev:demo   (http://localhost:3001)');
console.log('Sign in as admin@local, or as a manager or technician (password: the local seed password):');
for (const t of technicians) console.log('  ' + t.email.padEnd(36) + t.role.padEnd(12) + t.group);
await closeDatabase();
