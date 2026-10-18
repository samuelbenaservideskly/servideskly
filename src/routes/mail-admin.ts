import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { TYPE_LABELS } from '../services/tickets.js';
import { normaliseEmail, normaliseLine } from '../lib/util.js';
import { allowOwnFrames, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { listActiveGroups } from '../services/groups.js';
import {
  KIND_LABELS,
  MAILBOX_KINDS,
  createMailbox,
  deleteMailbox,
  findMailbox,
  listMailboxes,
  setDefaultMailbox,
  updateMailbox,
  type MailboxKind,
} from '../services/mail/mailboxes.js';
import {
  AUDIENCE,
  PLACEHOLDERS,
  findNotification,
  listNotificationsOfKind,
  createCustomNotification,
  deleteCustomNotification,
  isCustomNotification,
  render,
  resetAllNotifications,
  seedNotificationsFor,
  resetNotification,
  updateNotification,
} from '../services/mail/notifications.js';
import { flushOutbox, listOutbox, retryMail } from '../services/mail/outbox.js';
import { enabledLanguages } from '../i18n/index.js';
import { pollMailbox } from '../services/mail/inbound.js';
import { forgetTokens } from '../services/mail/transport.js';
import { LOGO_CID, logoProblem, previewHtml, usesLogo } from '../services/mail/inline-images.js';
import { cutProblem, stripSignature } from '../services/mail/signatures.js';
import { trimQuotedHistory } from '../services/mail/transport.js';
import { settings, updateSettings } from '../settings/index.js';
import {
  createRelay,
  deleteRelay,
  findRelay,
  listRelays,
  relayGroupMap,
  relayProblems,
  relayReady,
  relaysOnlyInForce,
  sendRelayTest,
  setDefaultRelay,
  setRelayOptions,
  updateRelay,
  type RelayInput,
} from '../services/mail/relay.js';
import {
  RULE_FIELDS,
  RULE_OPERATORS,
  createMailRule,
  deleteMailRule,
  firstMatchingRule,
  listMailRules,
  mailRuleProblems,
  moveMailRule,
  updateMailRule,
  type MailRuleInput,
} from '../services/mail/rules.js';
import { listActiveTemplates } from '../services/templates.js';
import { attempt, issueErrors, type FieldErrors } from './form-errors.js';
import { config } from '../config.js';
import { settingsView } from './settings-shared.js';

/**
 * Mail.
 *
 * Two tabs under one section: the mailboxes, and the notifications they send.
 * They are separate pages because a mailbox is a piece of infrastructure set
 * up once, and a notification is wording edited often.
 */
export const mailAdminRouter = Router();

const PAGE = '/admin/settings/mail';

const checkbox = (value: unknown): boolean => value === 'on' || value === 'true' || value === '1';
/** A number of days from a form: whole, not negative, and bounded. */
const wholeDays = (value: unknown): number => {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return 0;
  return Math.min(Math.floor(days), 365);
};

/** A notification's Sent from, as posted: a mailbox, the ticket's relay or one relay. */
function sentFrom(value: unknown): { mailboxId: string | null; viaRelay: boolean; relayId: string | null } {
  const v = typeof value === 'string' ? value : '';
  if (v === 'relay') return { mailboxId: null, viaRelay: true, relayId: null };
  if (v.startsWith('relay:')) return { mailboxId: null, viaRelay: true, relayId: v.slice(6) || null };
  return { mailboxId: v || null, viaRelay: false, relayId: null };
}

const text = (value: unknown): string => (typeof value === 'string' ? normaliseLine(value) : '');
const port = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
};

const mailboxBody = z.object({
  name: z.string().trim().min(2, 'Give the mailbox a name.').max(80),
  address: z.string().trim().email('That is not an email address.').max(200),
  kind: z.enum(MAILBOX_KINDS),
});

function mailboxFrom(raw: Record<string, unknown>) {
  return mailboxBody.safeParse({
    name: text(raw.name),
    address: normaliseEmail(String(raw.address ?? '')),
    kind: raw.kind,
  });
}

function mailboxInput(raw: Record<string, unknown>, parsed: z.infer<typeof mailboxBody>) {
  return {
    ...parsed,
    kind: parsed.kind as MailboxKind,
    groupId: typeof raw.groupId === 'string' && raw.groupId ? raw.groupId : null,
    tenantId: text(raw.tenantId),
    clientId: text(raw.clientId),
    clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : '',
    graphUserId: text(raw.graphUserId),
    imapHost: text(raw.imapHost),
    imapPort: port(raw.imapPort, 993),
    imapTls: checkbox(raw.imapTls),
    smtpHost: text(raw.smtpHost),
    smtpPort: port(raw.smtpPort, 587),
    smtpTls: checkbox(raw.smtpTls),
    username: text(raw.username),
    // Not trimmed of its inner characters, only its edges: a password may
    // legitimately contain anything.
    password: typeof raw.password === 'string' ? raw.password.trim() : '',
    receiveEnabled: checkbox(raw.receiveEnabled),
    isActive: checkbox(raw.isActive),
  };
}

async function mailboxesView(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return settingsView('mail', {
    tab: 'mailboxes',
    mailboxes: await listMailboxes(),
    groups: await listActiveGroups(),
    kinds: MAILBOX_KINDS,
    kindLabels: KIND_LABELS,
    outbox: await listOutbox(20),
    // Notifications go through the relays: the mailboxes only read.
    relaysOnly: await relaysOnlyInForce(),
    values: {},
    errors: {},
    openDialog: null as string | null,
    ...extra,
  });
}

mailAdminRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/mail', await mailboxesView());
  }),
);

mailAdminRouter.post(
  '/mailboxes',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = mailboxFrom(raw);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/mail',
        await mailboxesView({ values: raw, errors, openDialog: 'new-mailbox' }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      createMailbox(mailboxInput(raw, parsed.data), req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }

    flash(req, 'success', 'Mailbox "' + attempted.value.address + '" added.');
    res.redirect(PAGE);
  }),
);

mailAdminRouter.post(
  '/mailboxes/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!(await findMailbox(id))) throw notFound('That mailbox no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const parsed = mailboxFrom(raw);

    const refuse = async (errors: FieldErrors): Promise<void> => {
      res.status(400).render(
        'admin/settings/mail',
        await mailboxesView({ values: raw, errors, openDialog: 'mailbox-' + id }),
      );
    };

    if (!parsed.success) {
      await refuse(issueErrors(parsed.error));
      return;
    }

    const attempted = await attempt(() =>
      updateMailbox(id, mailboxInput(raw, parsed.data), req.currentUser?.id ?? null),
    );
    if (!attempted.ok) {
      await refuse(attempted.errors);
      return;
    }

    // Credentials may have changed, so a cached token is no longer the one
    // to use.
    forgetTokens(id);
    flash(req, 'success', 'Mailbox "' + attempted.value.address + '" saved.');
    res.redirect(PAGE);
  }),
);

mailAdminRouter.post(
  '/mailboxes/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const mailbox = await findMailbox(id);
    if (!mailbox) throw notFound('That mailbox no longer exists.');

    await deleteMailbox(id, req.currentUser?.id ?? null);
    forgetTokens(id);
    flash(req, 'success', 'Mailbox "' + mailbox.address + '" removed.');
    res.redirect(PAGE);
  }),
);

/** Hands the default to another mailbox. There is always exactly one. */
mailAdminRouter.post(
  '/mailboxes/:id/default',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const mailbox = await findMailbox(String(req.params.id));
    if (!mailbox) throw notFound('That mailbox no longer exists.');

    await setDefaultMailbox(mailbox.id, req.currentUser?.id ?? null);
    flash(req, 'success', '"' + mailbox.address + '" is now the default mailbox.');
    res.redirect(PAGE);
  }),
);

/** Reads a mailbox now, so the setup can be proved without waiting. */
mailAdminRouter.post(
  '/mailboxes/:id/poll',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const mailbox = await findMailbox(String(req.params.id));
    if (!mailbox) throw notFound('That mailbox no longer exists.');

    const result = await pollMailbox(mailbox);
    if (result.error) {
      flash(req, 'error', 'Could not read the mailbox: ' + result.error);
    } else {
      flash(
        req,
        'success',
        result.fetched +
          ' message(s) read: ' +
          result.created +
          ' new ticket(s), ' +
          result.comments +
          ' comment(s), ' +
          result.ignored +
          ' ignored.',
      );
    }
    res.redirect(PAGE);
  }),
);

/** Sends whatever is waiting, rather than waiting for the timer. */
mailAdminRouter.post(
  '/outbox/flush',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await flushOutbox();
    flash(req, 'success', result.sent + ' sent, ' + result.failed + ' failed.');
    res.redirect(PAGE);
  }),
);

mailAdminRouter.post(
  '/outbox/:id/retry',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await retryMail(String(req.params.id), req.currentUser?.id ?? null);
    await flushOutbox();
    flash(req, 'success', 'Tried again.');
    res.redirect(PAGE);
  }),
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function notificationsView(
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return settingsView('mail', {
    sectionTitle: 'Mail',
    tab: 'notifications',
    kind: 'builtin',
    notifications: await listNotificationsOfKind(
      (extra.kind as 'builtin' | 'custom' | undefined) ?? 'builtin',
      (extra.language as string | undefined) ?? '',
    ),
    // A tab per language that has been switched on, labelled with the two
    // characters the owner asked for (CZ beside EN).
    languages: enabledLanguages().map((l) => ({ tag: l.tag, label: l.label || l.tag, name: l.name })),
    language: '',
    openDialog: null,
    values: {},
    audience: AUDIENCE,
    mailboxes: await listMailboxes(),
    relays: await listRelays(),
    relaysOnly: await relaysOnlyInForce(),
    placeholders: PLACEHOLDERS,
    errors: {},
    ...extra,
  });
}

/**
 * Stand-in values for the preview.
 *
 * A preview of a template full of {{placeholders}} tells nobody whether the
 * wording reads well, so it is filled in with a plausible ticket. Deliberately
 * not a real one: the preview would then differ for every administrator, and
 * an empty service desk would have nothing to show.
 */
function sampleValues(): Record<string, string> {
  return {
    reference: 'TKT-000123',
    title: 'Tiskárna nefunguje',
    description: 'It makes a noise and then stops.',
    status: 'open',
    priority: 'normal',
    type: 'Incident',
    requesterName: 'Jan Novák',
    requesterFirstName: 'Jan',
    requesterLastName: 'Novák',
    requesterCompany: 'Contoso',
    assigneeFirstName: 'Sam',
    assigneeLastName: 'Carter',
    assigneeName: 'Sam Carter',
    groupName: 'Desktop Support',
    authorName: 'Sam Carter',
    comment: 'I have ordered a replacement drum.',
    createdAt: new Date().toISOString(),
    ticketUrl: config.publicOrigin + '/tickets/example',
    slaClock: 'first response',
    slaDue: new Date().toISOString(),
  };
}

/** Everything the single-notification page needs. */
async function notificationView(
  notification: Awaited<ReturnType<typeof findNotification>>,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return settingsView('mail', {
    sectionTitle: notification?.name ?? 'Notification',
    tab: 'notifications',
    notification,
    // A custom one has no shipped wording to restore, and no fixed audience.
    isCustom: notification ? isCustomNotification(notification) : false,
    audience: AUDIENCE,
    mailboxes: await listMailboxes(),
    relays: await listRelays(),
    relaysOnly: await relaysOnlyInForce(),
    placeholders: PLACEHOLDERS,
    sample: sampleValues(),
    previewSubject: notification ? render(notification.subject, sampleValues()) : '',
    logoCid: LOGO_CID,
    // Only warned about when this body actually asks for the logo. A page
    // that says the logo cannot be sent, to somebody who was not sending it,
    // is noise - and the warning has to be here rather than in somebody's
    // inbox a week later.
    logoProblem: notification && usesLogo(notification.body_html) ? logoProblem() : '',
    errors: {},
    ...extra,
  });
}

mailAdminRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const kind = req.query.kind === 'custom' ? 'custom' : 'builtin';
    /*
     * A language's set is created the first time somebody opens its tab,
     * copied from the English rows. Doing it here rather than when the
     * language is added means a language switched on today has its
     * notifications the moment anybody goes looking for them - and a
     * service desk that never translates its mail never carries the rows.
     */
    const wanted = String(req.query.lang ?? '');
    const language = enabledLanguages().find((l) => l.tag === wanted)?.tag ?? '';
    if (language) await seedNotificationsFor(language);
    res.render('admin/settings/mail-notifications', await notificationsView({ kind, language }));
  }),
);

/** A new custom notification, from the dialog on the Custom tab. */
mailAdminRouter.post(
  '/notifications',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const name = typeof (req.body as Record<string, unknown>)?.name === 'string'
      ? String((req.body as Record<string, unknown>).name).trim().slice(0, 120)
      : '';
    const refuse = async (message: string) => {
      res.status(400).render(
        'admin/settings/mail-notifications',
        await notificationsView({ kind: 'custom', openDialog: 'new-notification', errors: { name: message }, values: { name } }),
      );
    };
    if (!name) {
      await refuse('Give the notification a name.');
      return;
    }
    const created = await attempt(() => createCustomNotification(name, req.currentUser?.id ?? null));
    if (!created.ok) {
      await refuse(created.errors.name ?? created.errors.form ?? 'That could not be created.');
      return;
    }
    flash(req, 'success', 'Notification created. An automation decides when it is sent.');
    res.redirect(PAGE + '/notifications/' + created.value.id);
  }),
);

/*
 * Before /notifications/:id, which would otherwise read "reset-all" as a
 * notification id and answer 404 - the same trap the automation runs page
 * hit.
 */
mailAdminRouter.post(
  '/notifications/reset-all',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const restored = await resetAllNotifications(req.currentUser?.id ?? null);
    flash(
      req,
      'success',
      restored + ' notifications put back to the design they ship with.',
    );
    res.redirect(PAGE + '/notifications');
  }),
);

mailAdminRouter.post(
  '/notifications/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await attempt(() => deleteCustomNotification(String(req.params.id), req.currentUser?.id ?? null));
    if (result.ok) flash(req, 'success', 'Notification removed.');
    else flash(req, 'error', result.errors.form ?? Object.values(result.errors)[0] ?? '');
    res.redirect(PAGE + '/notifications?kind=custom');
  }),
);

/**
 * One notification, on its own page.
 *
 * Seven long HTML editors stacked on one page is a page nobody can find
 * anything on. The list says what each is and whether it is on; this is where
 * one is edited, with a preview of what it will actually look like.
 */
mailAdminRouter.get(
  '/notifications/:id',
  allowOwnFrames(),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const notification = await findNotification(id);
    if (!notification) throw notFound('That notification no longer exists.');

    res.render(
      'admin/settings/mail-notification',
      await notificationView(notification, { values: {} }),
    );
  }),
);

/**
 * The preview, rendered in its own document.
 *
 * Served to an iframe rather than inlined, for two reasons. The body is HTML
 * an administrator wrote, and dropping it into this page would let its styles
 * - or a stray unclosed tag - reach the settings page around it. And a mail
 * client renders a message as its own document, so this is a truer preview.
 *
 * Its own Content-Security-Policy, the strictest one that still shows a
 * message: no script, no network, nothing but inline styles and the page
 * itself.
 */
mailAdminRouter.get(
  '/notifications/:id/preview',
  asyncHandler(async (req, res) => {
    const notification = await findNotification(String(req.params.id));
    if (!notification) throw notFound('That notification no longer exists.');

    const values = sampleValues();
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
    );
    // Every other response in this process carries `X-Frame-Options: DENY`,
    // which a browser obeys whatever the policy above says - it would block
    // this one from being framed at all. The CSP that replaces it is not
    // weaker: `frame-ancestors 'self'` is the same rule, stated for one page.
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // `cid:` means nothing to a browser, so the logo is substituted with the
    // real file's bytes - and substituted with nothing when it could not be
    // sent, leaving the preview as broken as the email would be. That is why
    // the policy above allows `data:` images and no other source.
    res.send(
      '<!doctype html><html><head><meta charset="utf-8">' +
        '<title>Preview</title></head><body style="margin:0;padding:16px">' +
        (await previewHtml(render(notification.body_html, values))) +
        '</body></html>',
    );
  }),
);

mailAdminRouter.post(
  '/notifications/:id',
  writeLimiter,
  // The 400 branch re-renders the page, preview iframe and all.
  allowOwnFrames(),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const notification = await findNotification(id);
    if (!notification) throw notFound('That notification no longer exists.');

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const subject = text(raw.subject);
    if (!subject) {
      res.status(400).render(
        'admin/settings/mail-notification',
        await notificationView(notification, {
          errors: { subject: 'A notification needs a subject.' },
          values: raw,
        }),
      );
      return;
    }

    await updateNotification(
      id,
      {
        subject,
        // Not normalised: this is HTML an administrator wrote, and collapsing
        // its whitespace would mangle the markup.
        bodyHtml: typeof raw.bodyHtml === 'string' ? raw.bodyHtml : '',
        isEnabled: checkbox(raw.isEnabled),
        // "relay" is the ticket's own relay, "relay:<id>" one relay - not
        // mailbox ids.
        ...sentFrom(raw.mailboxId),
      },
      req.currentUser?.id ?? null,
    );

    flash(req, 'success', '"' + notification.name + '" saved.');
    res.redirect(PAGE + '/notifications/' + id);
  }),
);

mailAdminRouter.post(
  '/notifications/:id/reset',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const restored = await resetNotification(id, req.currentUser?.id ?? null);
    flash(req, 'success', '"' + restored.name + '" put back to the wording it shipped with.');
    res.redirect(PAGE + '/notifications/' + id);
  }),
);

// ---------------------------------------------------------------------------
// Ticket automation
// ---------------------------------------------------------------------------

/**
 * What happens to a message once it has been read.
 *
 * A third tab rather than more of the mailbox page: a mailbox is
 * infrastructure set up once, and these are rules about the tickets it
 * produces. More will land here - acting on behalf of somebody else is the
 * next one - so it is a page with room rather than a corner of another.
 */

/** A sample reply, so the cut can be seen working rather than described. */
const SAMPLE_REPLY = [
  'The printer is working again, thank you.',
  '',
  'It turned out to be the drum after all.',
  '',
  'Kind regards,',
  'Jan Novak',
  'IT Support | Example s.r.o.',
  '+420 123 456 789',
  '',
  'From: Service Desk <servicedesk@example.com>',
  'Sent: Monday, 12 October 2026 9:14',
  'Subject: [INC-000123] Printer on floor 2',
  '',
  'Hello Jan, could you try printing a test page?',
].join('\n');

async function automationView(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const automation = settings().automation;
  return settingsView('mail', {
    sectionTitle: 'Mail',
    tab: 'automation',
    automation,
    sample: SAMPLE_REPLY,
    // Run against the stored patterns, so the box shows what a reply arriving
    // now would actually keep.
    samplePreview: stripSignature(automation.trimQuoted !== false ? trimQuotedHistory(SAMPLE_REPLY) : SAMPLE_REPLY, automation.signatureCuts),
    errors: {},
    ...extra,
  });
}

mailAdminRouter.get(
  '/automation',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/mail-automation', await automationView());
  }),
);

mailAdminRouter.post(
  '/automation',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;

    await updateSettings(
      {
        automation: {
          knownSendersOnly: checkbox(raw.knownSendersOnly),
          autoCloseDays: wholeDays(raw.autoCloseDays),
          reopenOnReply: checkbox(raw.reopenOnReply),
          reopenWithinDays: wholeDays(raw.reopenWithinDays),
        },
      },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.mail_automation.changed',
      targetType: 'settings',
      detail: settings().automation,
    });

    flash(req, 'success', 'Settings saved.');
    res.redirect(PAGE + '/automation');
  }),
);

/** The switch for the quoted conversation; the phrases are their own forms. */
mailAdminRouter.post(
  '/advanced/signatures/quoted',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const on = checkbox((req.body as Record<string, unknown>)?.trimQuoted);
    await updateSettings({ automation: { trimQuoted: on } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.mail_quoted.changed', targetType: 'settings', detail: { trimQuoted: on } });
    flash(req, 'success', on ? 'The quoted conversation is cut from replies.' : 'Replies are kept whole, quotes included.');
    res.redirect(PAGE + '/advanced/signatures');
  }),
);

mailAdminRouter.post(
  '/advanced/signatures/phrases',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const phrase = text((req.body as Record<string, unknown>)?.phrase);

    // Compiled here, where somebody can fix it. A pattern that throws at the
    // point a reply arrives would mean losing the cut silently, on mail
    // nobody is watching.
    const problem = cutProblem(phrase);
    if (problem) {
      res.status(400).render(
        'admin/settings/mail-signatures',
        await automationView({ tab: 'advanced', errors: { phrase: problem }, phrase }),
      );
      return;
    }

    const current = settings().automation.signatureCuts;
    if (current.some((entry) => entry.toLowerCase() === phrase.toLowerCase())) {
      res.status(400).render(
        'admin/settings/mail-signatures',
        await automationView({ tab: 'advanced', errors: { phrase: 'That phrase is already in the list.' }, phrase }),
      );
      return;
    }

    await updateSettings(
      { automation: { signatureCuts: [...current, phrase] } },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.mail_automation.phrase_added',
      targetType: 'settings',
    });
    flash(req, 'success', 'Added.');
    res.redirect(PAGE + '/advanced/signatures');
  }),
);

mailAdminRouter.post(
  '/advanced/signatures/phrases/remove',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const phrase = text((req.body as Record<string, unknown>)?.phrase);
    const current = settings().automation.signatureCuts;

    await updateSettings(
      { automation: { signatureCuts: current.filter((entry) => entry !== phrase) } },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.mail_automation.phrase_removed',
      targetType: 'settings',
    });
    flash(req, 'success', 'Removed.');
    res.redirect(PAGE + '/advanced/signatures');
  }),
);

// ---------------------------------------------------------------------------
// SMTP relays
// ---------------------------------------------------------------------------

const RELAY = '/admin/settings/mail/relay';

async function relaysView(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const relays = await listRelays();
  return settingsView('mail', {
    tab: 'relay',
    relays,
    ready: Object.fromEntries(relays.map((r) => [r.id, relayReady(r)])),
    groups: await listActiveGroups(),
    // Every group's current relay, for the ticks and "now: <relay>".
    groupRelay: Object.fromEntries(await relayGroupMap()),
    options: settings().smtpRelay,
    relaysOnlyInForce: await relaysOnlyInForce(),
    mailboxCount: (await listMailboxes()).length,
    openDialog: null as string | null,
    errors: {},
    values: {},
    ...extra,
  });
}

function relayInput(raw: Record<string, unknown>): RelayInput {
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
  const security = s('security');
  const ids = raw.groupIds;
  return {
    name: normaliseLine(s('name')).slice(0, 100),
    enabled: raw.enabled === 'on',
    host: s('host'),
    port: Number.parseInt(s('port') || '0', 10),
    security: security === 'tls' || security === 'none' ? security : 'starttls',
    username: s('username').slice(0, 200),
    password: typeof raw.password === 'string' ? raw.password.slice(0, 500) : '',
    fromAddress: normaliseEmail(s('fromAddress')),
    fromName: normaliseLine(s('fromName')).slice(0, 100),
    groupIds: (Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : []).filter((x): x is string => typeof x === 'string'),
  };
}

mailAdminRouter.get(
  '/relay',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/mail-relay', await relaysView());
  }),
);

/** A new relay, from the dialog. */
mailAdminRouter.post(
  '/relay',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const input = relayInput(raw);
    // Secrets are never put back into a refused form.
    const refuse = async (errors: FieldErrors) => {
      res.status(400).render('admin/settings/mail-relay', await relaysView({ openDialog: 'new-relay', errors, values: { ...raw, password: '' } }));
    };
    const problems = await relayProblems(input);
    if (Object.keys(problems).length > 0) return refuse(problems);
    const done = await attempt(() => createRelay(input, req.currentUser?.id ?? null));
    if (!done.ok) return refuse(done.errors);
    flash(req, 'success', 'Relay added. Send a test message to check it.');
    res.redirect(RELAY + '#relay-test');
  }),
);

/** The two switches: sign-in codes, and notifications only through relays. */
mailAdminRouter.post(
  '/relay/options',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const options = { useForCodes: raw.useForCodes === 'on', relaysOnly: raw.relaysOnly === 'on' };
    const done = await attempt(() => setRelayOptions(options, req.currentUser?.id ?? null));
    if (!done.ok) {
      res.status(400).render(
        'admin/settings/mail-relay',
        await relaysView({ errors: { options: done.errors.form ?? Object.values(done.errors)[0] } }),
      );
      return;
    }
    flash(req, 'success', 'Saved.');
    res.redirect(RELAY);
  }),
);

mailAdminRouter.post(
  '/relay/test',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = normaliseEmail(typeof body.to === 'string' ? body.to : '');
    const relayId = typeof body.relayId === 'string' ? body.relayId : '';
    if (!/^[^@\s]+@[^@\s]+$/.test(to)) {
      flash(req, 'error', 'Enter the address to send the test message to.', 'relay-test');
      res.redirect(RELAY + '#relay-test');
      return;
    }
    try {
      await sendRelayTest(relayId, to);
      auditRequest(req, { action: 'settings.smtp_relay.tested', targetType: 'smtp_relay', targetId: relayId, detail: { to } });
      flash(req, 'success', 'Test message sent to ' + to + '.', 'relay-test');
    } catch (err) {
      auditRequest(req, { action: 'settings.smtp_relay.tested', outcome: 'failure', targetType: 'smtp_relay', targetId: relayId, detail: { to } });
      flash(req, 'error', 'The relay did not accept it: ' + (err instanceof Error ? err.message : String(err)), 'relay-test');
    }
    res.redirect(RELAY + '#relay-test');
  }),
);

mailAdminRouter.post(
  '/relay/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await findRelay(id);
    if (!existing) throw notFound('That relay no longer exists.');
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const input = relayInput(raw);
    const refuse = async (errors: FieldErrors) => {
      res.status(400).render('admin/settings/mail-relay', await relaysView({ openDialog: 'relay-' + id, errors, values: { ...raw, password: '' } }));
    };
    const problems = await relayProblems(input, existing);
    if (Object.keys(problems).length > 0) return refuse(problems);
    const done = await attempt(() => updateRelay(id, input, req.currentUser?.id ?? null));
    if (!done.ok) return refuse(done.errors);
    flash(req, 'success', input.enabled ? 'Relay saved.' : 'Relay saved. It is switched off.');
    res.redirect(RELAY + '#row-' + id);
  }),
);

mailAdminRouter.post(
  '/relay/:id/default',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await setDefaultRelay(String(req.params.id), req.currentUser?.id ?? null);
    flash(req, 'success', 'Default relay changed.');
    res.redirect(RELAY);
  }),
);

mailAdminRouter.post(
  '/relay/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const moved = await deleteRelay(String(req.params.id), req.currentUser?.id ?? null);
    flash(
      req,
      'success',
      'Relay removed.' + (moved > 0 ? ' ' + moved + ' notification' + (moved === 1 ? '' : 's') + ' now send from the mailboxes.' : ''),
    );
    res.redirect(RELAY);
  }),
);

// ---------------------------------------------------------------------------
// Advanced settings: signature stripping and mail automation
// ---------------------------------------------------------------------------

mailAdminRouter.get('/advanced', (_req, res) => {
  res.redirect(PAGE + '/advanced/signatures');
});

mailAdminRouter.get(
  '/advanced/signatures',
  asyncHandler(async (_req, res) => {
    res.render('admin/settings/mail-signatures', await automationView({ tab: 'advanced' }));
  }),
);

// Signature stripping used to live under Other settings; old posts follow it.
mailAdminRouter.use('/automation/phrases', (req, res) => {
  res.redirect(308, PAGE + '/advanced/signatures/phrases' + req.url.replace(/^\/$/, ''));
});

async function renderRules(
  req: import('express').Request,
  res: import('express').Response,
  extra: { status?: number; openDialog?: string | null; errors?: FieldErrors; values?: Record<string, unknown> } = {},
): Promise<void> {
  const [rules, active] = await Promise.all([listMailRules(), listActiveTemplates()]);
  // The default first: it is what a new rule starts on.
  const templates = [...active.filter((t) => t.is_default), ...active.filter((t) => !t.is_default)];
  // "Try a message": which rule this one would meet. Nothing is raised.
  const trySubject = typeof req.query.trySubject === 'string' ? req.query.trySubject.slice(0, 300) : '';
  const tryFrom = typeof req.query.tryFrom === 'string' ? req.query.tryFrom.slice(0, 200) : '';
  const asked = req.method === 'GET' && (trySubject !== '' || tryFrom !== '');
  const hit = asked
    ? await firstMatchingRule({ subject: trySubject, from: tryFrom || 'someone@example.com', body: '' } as never)
    : undefined;
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/mail-rules',
    settingsView('mail', {
      tab: 'advanced',
      rules,
      templates,
      templateNames: Object.fromEntries(templates.map((t) => [t.id, t.name])),
      typeLabels: TYPE_LABELS,
      fields: RULE_FIELDS,
      operators: RULE_OPERATORS,
      fieldLabels: Object.fromEntries(RULE_FIELDS.map((f) => [f.key, f.label])),
      operatorLabels: Object.fromEntries(RULE_OPERATORS.map((o) => [o.key, o.label])),
      tried: { asked, subject: trySubject, from: tryFrom, rule: hit?.rule.name ?? '', template: hit?.template.name ?? '' },
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
    }),
  );
}

function readRule(body: Record<string, unknown>): MailRuleInput {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  return {
    name: normaliseLine(s('name')),
    field: s('field'),
    operator: s('operator'),
    value: s('value').trim(),
    templateId: s('templateId'),
    dedupeHours: s('dedupeHours') === '' ? 0 : Number(s('dedupeHours')),
    isEnabled: body.isEnabled === 'on',
  };
}

mailAdminRouter.get('/advanced/rules', asyncHandler(async (req, res) => renderRules(req, res)));

mailAdminRouter.post(
  '/advanced/rules',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = readRule(body);
    const errors = await mailRuleProblems(input);
    if (Object.keys(errors).length > 0) return renderRules(req, res, { status: 400, openDialog: 'new-rule', errors, values: body });
    const done = await attempt(() => createMailRule(input, req.currentUser?.id ?? null));
    if (!done.ok) return renderRules(req, res, { status: 400, openDialog: 'new-rule', errors: done.errors, values: body });
    flash(req, 'success', 'Rule "' + input.name + '" added.');
    res.redirect(PAGE + '/advanced/rules');
  }),
);

mailAdminRouter.post(
  '/advanced/rules/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = readRule(body);
    const errors = await mailRuleProblems(input);
    if (Object.keys(errors).length > 0) return renderRules(req, res, { status: 400, openDialog: 'rule-' + id, errors, values: body });
    const done = await attempt(() => updateMailRule(id, input, req.currentUser?.id ?? null));
    if (!done.ok) return renderRules(req, res, { status: 400, openDialog: 'rule-' + id, errors: done.errors, values: body });
    flash(req, 'success', 'Rule saved.');
    res.redirect(PAGE + '/advanced/rules');
  }),
);

mailAdminRouter.post(
  '/advanced/rules/:id/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const direction = (req.body as Record<string, unknown>)?.direction === 'up' ? 'up' : 'down';
    await moveMailRule(String(req.params.id), direction, req.currentUser?.id ?? null);
    res.redirect(PAGE + '/advanced/rules#row-' + String(req.params.id));
  }),
);

mailAdminRouter.post(
  '/advanced/rules/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await deleteMailRule(String(req.params.id), req.currentUser?.id ?? null);
    flash(req, 'success', 'Rule removed.');
    res.redirect(PAGE + '/advanced/rules');
  }),
);
