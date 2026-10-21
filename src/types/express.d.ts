import type { UserRow } from '../services/users.js';

declare global {
  namespace Express {
    interface Request {
      /** Authenticated, active account for this request, if any. */
      currentUser?: UserRow;
      /** Per-response CSP nonce (reserved for styles; no scripts are served). */
      cspNonce?: string;
      /** Synchroniser token for this session, exposed to templates. */
      csrfToken?: string;
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    /** Local user id. Presence of this field means "signed in". */
      userId?: string;
    /** Epoch ms when the session was created, for the absolute timeout. */
    createdAt?: number;
    /** Epoch ms of the last request, for the idle timeout. */
    lastSeenAt?: number;
    /** CSRF synchroniser token, minted once per session. */
    csrfToken?: string;
    /** Identity provider session id, used for single logout. */
    idpSessionIndex?: string;
    idpNameId?: string;
    idpNameIdFormat?: string;
    /** A refused reply's words, put back in the box once (routes/tickets.ts). */
    replyDraft?: { ticketId: string; body: string; internal: boolean; notify?: boolean };
    /** One-shot messages rendered on the next page load. */
    flash?: { type: 'success' | 'error' | 'info'; message: string; where?: string }[];
    /** Requester portal an administrator is previewing full screen. */
    portalPreview?: string;
    /** The answer to an automation step's "Save and test", shown once. */
    httpTest?: { nodeId: string; ok: boolean; line: string; status: number; contentType: string; preview: string };
    /**
     * The account that gave the right password and now has to prove the
     * second step - a code by email, asked for by conditional access. There
     * is no session yet: the sign-in finishes when the code is right.
     */
    mfaUserId?: string;
    mfaReturnTo?: string;
    /** That account also has a password it must replace, after the code. */
    mfaMustChange?: boolean;
    /**
     * The account that signed in with a password it has to replace. There is
     * no session yet: the sign-in finishes when the new password is set.
     */
    mustChangeUserId?: string;
    mustChangeReturnTo?: string;
    /** Step one of signing in: the address, until the password is entered. */
    signinEmail?: string;
    signinReturnTo?: string;
    /** Address a sign-in code was asked for, until it is entered. */
    otpEmail?: string;
    otpReturnTo?: string;
    /** A connection being signed in to as a person (OAuth authorization code). */
    connectionAuth?: { id: string; state: string; verifier: string; at: number };
    /** The identity provider this session signed in through, for sign-out. */
    idpProvider?: string;
    /** That sign-in's ID token and login_hint, handed back at sign-out (endSessionUrl). Kept server-side only. */
    idpIdToken?: string;
    idpLoginHint?: string;
    /** A provider sign-in waiting for the password account with its address to be proved (/login/link). */
    linkPending?: { userId: string; identity: import('../auth/provisioning.js').DirectoryIdentity; redirectTo: string | null; provider?: string; idToken?: string; loginHint?: string; at: number };
  }
}

export {};
