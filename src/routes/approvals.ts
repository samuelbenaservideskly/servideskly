import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { normaliseEmail, normaliseText } from '../lib/util.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/security.js';
import { approvalPresentation } from './portal.js';
import {
  addComment,
  recordApproval,
  ticketByApprovalToken,
  TYPE_LABELS,
} from '../services/tickets.js';
import { notifyTicket } from '../services/mail/outbox.js';
import { audit } from '../lib/audit.js';

/**
 * Approving a request.
 *
 * **Signing in is required, as the person named.** This page used to be
 * reachable without an account, with the link as the whole authority - so a
 * forwarded email, or one read over a shoulder, could approve a purchase.
 * Now the link only says *which* ticket; who may answer is decided by who is
 * signed in, and it must be the address the request was sent to. With
 * just-in-time provisioning on, a line manager signing in through Entra ID
 * for the first time simply arrives as a user, so they still need nothing
 * set up in advance.
 *
 * What else holds:
 *
 * - **The token still matters.** 32 random bytes per ticket: being signed in
 *   as the approver does not let anybody browse to other tickets' approvals.
 * - **It shows one ticket and nothing else.** No queue, no search, no other
 *   reference - so a leaked link exposes the request it was sent about and
 *   stops there.
 * - **It can be used once.** `recordApproval` only moves a *pending* ticket,
 *   so a second press, a forwarded link or a mail client prefetching the URL
 *   cannot change an answer already given.
 * - **The decision is a POST**, never a link that decides on sight. A mail
 *   client that follows links to generate a preview would otherwise approve
 *   things on the approver's behalf.
 */
export const approvalRouter = Router();

/** True when the person signed in is the one this approval was sent to. */
function isApprover(req: Request, approvalEmail: string): boolean {
  const email = req.currentUser?.email;
  return Boolean(email) && normaliseEmail(email!) === normaliseEmail(approvalEmail);
}

/**
 * Somebody signed in as the wrong person. A 403 with the page, not an error
 * page: it has to say who the request is waiting for, so they can sign out
 * and back in as that person.
 */
function renderWrongPerson(req: Request, res: Response, ticket: { reference: string; approval_email: string }) {
  res.status(403).render('approval-wrong-person', {
    title: 'Approval ' + ticket.reference,
    reference: ticket.reference,
    approvalEmail: ticket.approval_email,
    signedInAs: req.currentUser?.email ?? '',
  });
}

// Sign-in first: a GET without a session goes to the sign-in page and comes
// back here afterwards.
approvalRouter.use(requireAuth());

approvalRouter.get(
  '/:token',
  approvalPresentation(),
  asyncHandler(async (req, res) => {
    const ticket = await ticketByApprovalToken(String(req.params.token));
    if (!ticket) throw notFound('That approval link is not valid.');
    if (!isApprover(req, ticket.approval_email)) {
      renderWrongPerson(req, res, ticket);
      return;
    }

    res.render('approval', {
      title: 'Approval ' + ticket.reference,
      ticket,
      typeLabel: TYPE_LABELS[ticket.type] ?? ticket.type,
      token: String(req.params.token),
      decided: ticket.approval_status !== 'pending',
      errors: {},
    });
  }),
);

approvalRouter.post(
  '/:token',
  writeLimiter,
  approvalPresentation(),
  asyncHandler(async (req, res) => {
    const token = String(req.params.token);
    const ticket = await ticketByApprovalToken(token);
    if (!ticket) throw notFound('That approval link is not valid.');
    // The rule, not just the page: a decision posted by anybody else is
    // refused before it is looked at.
    if (!isApprover(req, ticket.approval_email)) {
      renderWrongPerson(req, res, ticket);
      return;
    }

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const decision = raw.decision === 'approved' ? 'approved' : 'rejected';
    const note = typeof raw.note === 'string' ? normaliseText(raw.note).trim() : '';

    // Declining without saying why leaves the service desk with nothing to
    // tell the requester, so that half is required and approving is not.
    if (decision === 'rejected' && note.length < 3) {
      res.status(400).render('approval', {
        title: 'Approval ' + ticket.reference,
        ticket,
        typeLabel: TYPE_LABELS[ticket.type] ?? ticket.type,
        token,
        decided: ticket.approval_status !== 'pending',
        errors: { note: 'Please say why you are declining this request.' },
      });
      return;
    }

    const moved = await recordApproval(ticket.id, decision);
    if (!moved) {
      // Already answered. Not an error: show the page, which now says so.
      res.redirect('/approvals/' + token);
      return;
    }

    // On the ticket, so the service desk sees the answer where they work
    // rather than only in an email.
    await addComment({
      ticketId: ticket.id,
      authorId: ticket.requester_id,
      body:
        (decision === 'approved' ? 'Approved by ' : 'Declined by ') +
        ticket.approval_email +
        (note ? ': ' + note : '.'),
      isInternal: false,
    });

    audit({
      action: 'ticket.approval.' + decision,
      actorId: req.currentUser?.id ?? null,
      actorEmail: ticket.approval_email,
      targetType: 'ticket',
      targetId: ticket.id,
      detail: { reference: ticket.reference, note },
    });

    await notifyTicket('ticket.approval.decided', ticket.id, {
      authorName: ticket.approval_email,
    });

    res.redirect('/approvals/' + token);
  }),
);
