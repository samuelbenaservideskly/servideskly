import { z } from 'zod';
import { config } from '../config.js';
import { execute, queryOne } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/util.js';
import { isSealed, openMaybe, seal, type SealedValue } from '../lib/secret-box.js';

const log = logger.child({ module: 'settings' });

/**
 * Runtime settings.
 *
 * Everything an administrator can reasonably change while the service is
 * running lives here, is stored in the database and is editable from
 * Admin -> Settings. The environment supplies the initial values, so an
 * existing .env keeps working unchanged; anything set in the UI overrides it.
 *
 * Settings that genuinely cannot change without a restart stay in `config`:
 * HOST, PORT, APP_BASE_URL, DATABASE_URL, UPLOAD_DIR, SESSION_SECRET, TRUST_PROXY.
 */

const secretField = z.union([z.string(), z.object({ enc: z.string() })]).optional();

/** One colour mode's own colours; an empty string is "work it out". */
export interface ModePalette { background: string; surface: string; text: string }

/** Settings - Users - Other settings - Password policy, for password accounts. */
export interface PasswordPolicy {
  /** Never below the deployment's floor (12 in production): see minPasswordLength(). */
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  /** Not the part of the person's email address before the @. */
  notEmail: boolean;
  /** 0: never. Otherwise a password older than this is changed at the next sign-in. */
  maxAgeDays: number;
}

/** The details a person may be allowed to change themselves (Users - Other settings). */
export const SELF_EDIT_FIELDS = ['company', 'department', 'job_title', 'office', 'phone'] as const;
export type SelfEditField = (typeof SELF_EDIT_FIELDS)[number];

/**
 * What a new service desk asks of a password: eight characters with an
 * upper case letter, a lower case one, a digit and a symbol (asked for
 * 15 Oct 2026). It was length alone, which is defensible in isolation and
 * reads as no policy at all on the page that shows it.
 *
 * A deployment floor still applies on top: minPasswordLength() never lets
 * this fall below 12 in production.
 */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8, requireUpper: true, requireLower: true, requireDigit: true, requireSymbol: true, notEmail: false, maxAgeDays: 0,
};

const brandingAsset = z
  .object({
    file: z.string().min(1).max(200),
    contentType: z.string().min(1).max(100),
    byteSize: z.number().int().min(0),
    sha256: z.string().min(1).max(128),
    originalName: z.string().max(200),
    uploadedAt: z.string().max(40),
    // Absent on anything uploaded before this existed: see BrandingAsset.
    transparent: z.boolean().optional(),
  })
  .nullable();
const stringList = z.array(z.string().min(1).max(500)).max(200);

const documentSchema = z
  .object({
    oidc: z.object({
      tenantId: z.string().max(200),
      clientId: z.string().max(200),
      clientSecret: secretField,
      scopes: stringList,
      extraIssuers: stringList,
    }),
    // Settings - Integrations - Google. Workspace accounts only: allowedDomains
    // is required, because "anyone with a Google account" is the whole world.
    google: z.object({
      clientId: z.string().max(300),
      clientSecret: secretField,
      allowedDomains: stringList,
    }),
    // Settings - Integrations - Okta. One Okta org; authServer is "default",
    // a custom server id, or empty for the org authorisation server.
    okta: z.object({
      domain: z.string().max(200),
      authServer: z.string().max(100),
      clientId: z.string().max(300),
      clientSecret: secretField,
    }),
    // Settings - Integrations - OpenID Connect: any other provider that
    // publishes a discovery document (Keycloak, ADFS, Authentik, Ping...).
    genericOidc: z.object({
      name: z.string().max(60),
      issuer: z.string().max(300),
      clientId: z.string().max(300),
      clientSecret: secretField,
      scopes: z.string().max(300),
      allowedDomains: stringList,
    }),
    provisioning: z.object({
      // Create an unknown account on its first successful sign-in. With
      // this off, only accounts SCIM has provisioned can get in.
      jitEnabled: z.boolean(),
      // The administrators the customer portal manages (auth/portal-admins.ts),
      // and the time of the last list it sent, which a replay cannot beat.
      portalAdmins: z.array(z.string().min(3).max(320)).max(50).default([]),
      portalAdminsAt: z.number().int().min(0).default(0),
    }),
    // Settings - Users - Local users. Off hides the password form on the
    // sign-in page and refuses a password sign-in; the accounts themselves
    // are untouched.
    localAccounts: z.object({
      signInEnabled: z.boolean(),
      // Sign in with a code sent by email instead of a password
      // (auth/sign-in-codes.ts). Members of the excluded user group keep
      // their passwords. The break-glass account has its own switch.
      otpEnabled: z.boolean(),
      otpExcludedGroupId: z.string().max(64).nullable(),
      breakGlassOtp: z.boolean(),
      // Settings - Users - Other settings - Password policy (auth/password.ts).
      passwordPolicy: z.object({
        minLength: z.number().int().min(8).max(64),
        requireUpper: z.boolean(),
        requireLower: z.boolean(),
        requireDigit: z.boolean(),
        requireSymbol: z.boolean(),
        notEmail: z.boolean(),
        maxAgeDays: z.number().int().min(0).max(730),
      }),
      // "Create an account" on the sign-in page (auth/registration.ts).
      registration: z.object({
        enabled: z.boolean(),
        domains: z.array(z.string().max(253)).max(50),
      }),
      /*
       * Conditional access for password accounts (auth/conditional-access.ts).
       *
       * Password accounts only: a directory account is its identity
       * provider's to gate, and it has conditional access of its own.
       */
      conditionalAccess: z
        .object({
          /** CIDR ranges sign-in is allowed from. Empty: anywhere. */
          allowedRanges: z.array(z.string().max(60)).max(100).default([]),
          /**
           * The break-glass account's own list, which the ranges above
           * never apply to. Empty: anywhere, which is what it was before
           * this existed. FORCE_LOCAL_SIGNIN ignores it.
           */
          breakGlassRanges: z.array(z.string().max(60)).max(100).default([]),
          /** Elsewhere, ask for a code by email rather than refuse. */
          elsewhereNeedsCode: z.boolean().default(false),
          /** A code by email on every sign-in, wherever it comes from. */
          codeForEveryone: z.boolean().default(false),
          /** Every password account (break-glass aside) must use an authenticator app; set up at the next sign-in. */
          requireAuthenticator: z.boolean().default(false),
        })
        .default({ allowedRanges: [], elsewhereNeedsCode: false, codeForEveryone: false }),
    }),
    // Settings - Customisation - Locale: how dates and times are shown, and
    // the time zone business hours are counted in.
    locale: z.object({
      timeZone: z.string().min(1).max(64),
      dateFormat: z.enum(['dd MMM yyyy', 'dd.MM.yyyy', 'd. M. yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']),
      timeFormat: z.enum(['24h', '12h']),
      // Whether somebody who has chosen nothing, and whose groups and email
      // domain say nothing, is served the language their browser asks for.
      followBrowser: z.boolean(),
    }),
    // Settings - Tickets - Other settings - SLA. Targets are in
    // business minutes, counted only inside the working hours below, in the
    // given time zone.
    // Settings - Advanced - JavaScript. Off by default: when on, custom
    // requester portals may run the administrator's own script (served as a
    // file, never inline), talking only to the listed origins.
    portalScripts: z.object({
      enabled: z.boolean(),
      allowedOrigins: stringList,
    }),
    // Settings - Mail - SMTP relays. The relays themselves are rows
    // (smtp_relays, migration 50); the connection fields here are the single
    // relay from before, moved into a row by adoptLegacyRelay() and cleared.
    // useForCodes: sign-in codes go through the default relay. relaysOnly:
    // every notification goes through a relay and mailboxes only read.
    smtpRelay: z.object({
      enabled: z.boolean(),
      host: z.string().max(253),
      port: z.number().int().min(1).max(65535),
      security: z.enum(['tls', 'starttls', 'none']),
      username: z.string().max(200),
      password: secretField,
      fromAddress: z.string().max(200),
      fromName: z.string().max(100),
      useForCodes: z.boolean(),
      relaysOnly: z.boolean().optional(),
    }),
    // Settings - Advanced - Automation. Off: HTTP steps may call only public
    // https addresses (services/http-client.ts).
    // Settings - Users - Other settings: how a display name is built from
    // [First], [Last], [Company]... (services/display-names.ts). Empty: off.
    people: z.object({
      displayNameFormat: z.string().max(200),
      // Which of their own details people may change on their profile.
      selfEdit: z.array(z.enum(SELF_EDIT_FIELDS)).max(5),
      /*
       * The directory at /people: who may look somebody up.
       *
       * Off for both by default. An administrator always may - they can see
       * every account under Settings anyway - and a technician or a
       * requester only while the service desk says so, because a list of
       * everybody with their department and telephone number is a thing an
       * organisation decides to publish, not something a helpdesk publishes
       * for it.
       */
      directory: z
        .object({
          technicians: z.boolean().default(false),
          users: z.boolean().default(false),
          /** A search then finds only people in the searcher's own company. */
          ownCompanyOnly: z.boolean().default(false),
        })
        .default({ technicians: false, users: false, ownCompanyOnly: false }),
    }),
    httpRequests: z.object({
      allowPrivateNetwork: z.boolean(),
    }),
    sla: z.object({
      enabled: z.boolean(),
      // Email the group's manager when a ticket misses a target.
      notifyManager: z.boolean(),
      // Time on hold does not count against the resolution target.
      pauseOnHold: z.boolean().optional(),
      // Days off: "2026-12-24" that day only, "12-25" every year.
      holidays: z.array(z.string().regex(/^(\d{4}-)?\d{2}-\d{2}$/)).max(200).optional(),
      timeZone: z.string().min(1).max(64),
      // 0 = Sunday ... 6 = Saturday, as Date#getDay.
      days: z.array(z.number().int().min(0).max(6)).max(7),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      targets: z.object({
        urgent: z.object({ response: z.number().int().min(1).max(525600), resolution: z.number().int().min(1).max(525600) }),
        high: z.object({ response: z.number().int().min(1).max(525600), resolution: z.number().int().min(1).max(525600) }),
        normal: z.object({ response: z.number().int().min(1).max(525600), resolution: z.number().int().min(1).max(525600) }),
        low: z.object({ response: z.number().int().min(1).max(525600), resolution: z.number().int().min(1).max(525600) }),
      }),
    }),
    scim: z.object({
      enabled: z.boolean(),
      // SHA-256 of the bearer token, hex. The token itself is shown once
      // at generation and never stored in a form it can be read back from.
      tokenHash: z.string().max(64),
      // Last four characters, so the right token can be recognised later.
      tokenHint: z.string().max(8),
      tokenSetAt: z.string().max(40).nullable(),
      // A SCIM DELETE disables the account instead of removing it, so the
      // tickets it raised keep their requester.
      disableOnDelete: z.boolean(),
    }),
    branding: z.object({
      appName: z.string().min(1).max(60),
      brandColour: z.string().max(40),
      inkColour: z.string().max(40),
      // One of FONTS in services/branding.ts; anything else draws the default.
      font: z.string().max(30),
      // Which colour modes people may choose; and each mode's own colours,
      // empty meaning "worked out from the two colours above" (services/branding.ts).
      colourModes: z.enum(['both', 'light', 'dark']),
      // What somebody who has chosen nothing gets. Light on a new
      // deployment (asked for 16 Oct 2026): a service desk should look the
      // same to everybody who opens it for the first time, whatever their
      // laptop was set to at sunset. "System default" is still a choice.
      defaultMode: z.enum(['system', 'light', 'dark']),
      light: z.object({ background: z.string().max(40), surface: z.string().max(40), text: z.string().max(40) }),
      dark: z.object({ background: z.string().max(40), surface: z.string().max(40), text: z.string().max(40) }),
      logo: brandingAsset,
      favicon: brandingAsset,
    }),
    attachments: z.object({
      enabled: z.boolean(),
      maxBytes: z.number().int().min(1024).max(100 * 1024 * 1024),
      maxPerTicket: z.number().int().min(1).max(200),
    }),
    // How a reference is written. Settings - Tickets - Other
    // settings.
    tickets: z.object({
      prefixes: z.object({
        incident: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
        service_request: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
        change_request: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
        task: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
        // A task under a change request, which is the only way one exists.
        change_task: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
      }),
      // Settings - Tickets - Other settings - Cancellation: a
      // ticket cancelled from its page needs a note, posted as a comment.
      requireCancelNote: z.boolean(),
      requireResolveNote: z.boolean().default(false),
      // Settings - Tickets - Other settings - Deleting old tickets. A closed
      // ticket is deleted this many days after it closed; 0 is off, which is
      // the default, because deleting somebody's record is not a thing to
      // start doing without being asked.
      deleteClosedAfterDays: z.number().int().min(0).max(3650).default(0),
      // Settings - Tickets - Service catalogue. On, "New ticket" opens the
      // catalogue instead of a form; the tiles are the forms it offers, in
      // the order they are listed. A tile whose template the reader may not
      // use is left out and the rest close the gap, so a catalogue reads the
      // same whether or not somebody can see all of it.
      catalogue: z
        .object({
          enabled: z.boolean().default(false),
          heading: z.string().max(80).default(''),
          // The grid a requester sees: how many tiles across, and how many
          // rows before the catalogue pages. Columns are a maximum - the
          // grid still narrows on a small screen.
          columns: z.number().int().min(1).max(5).default(3),
          rows: z.number().int().min(1).max(10).default(3),
          /*
           * Filter buttons above the tiles - Service request, Incident,
           * Change request - and with them a New ticket button that raises
           * that type's default template (asked for 16 Oct 2026). Off by
           * default: a catalogue of six tiles needs no filtering, and the
           * buttons would be three more things to read.
           */
          filters: z.boolean().default(false),
          tiles: z
            .array(
              z.object({
                id: z.string().min(1).max(40),
                templateId: z.string().min(1).max(40),
                // Empty: the template's own name and summary are shown, so a
                // renamed template renames its tile.
                label: z.string().max(60).default(''),
                description: z.string().max(140).default(''),
                icon: z.string().max(30).default('ticket'),
                // Which cell of the grid it sits in; absent on a tile
                // placed before cells existed (placedTiles() gives it one).
                cell: z.number().int().min(0).max(199).optional(),
              }),
            )
            .max(60)
            .default([]),
        })
        .default({ enabled: false, heading: '', columns: 3, rows: 3, filters: false, tiles: [] }),
    }),
    // What happens to a message after it has been read. Settings - Mail -
    // Ticket automation.
    automation: z.object({
      // Patterns that mark the start of a signature. Everything from the
      // first line one of these matches is cut off a mailed comment.
      signatureCuts: stringList,
      // Cut the quoted conversation below a reply (On ... wrote:, Outlook's
      // From/Sent block, a quote container). On by default.
      trimQuoted: z.boolean(),
      // Only raise a ticket for a sender who already has an account here.
      knownSendersOnly: z.boolean(),
      // Close a resolved ticket after this many days. 0 is off.
      autoCloseDays: z.number().int().min(0).max(365),
      // Let a requester reopen a closed ticket by replying to it.
      reopenOnReply: z.boolean(),
      // ...but only for this long after it closed. 0 means no limit.
      reopenWithinDays: z.number().int().min(0).max(365),
    }),
  })
  .strict();

/** The stored shape, with secrets possibly sealed. */
export type SettingsDocument = z.infer<typeof documentSchema>;

/** The shape handed to the rest of the application, with secrets in the clear. */
export interface EffectiveSettings {
  /** True when Entra ID sign-in has everything it needs to run. */
  ssoConfigured: boolean;
  /** True when any identity provider - Entra ID, Google, Okta or a generic one - can sign people in. */
  anySsoConfigured: boolean;
  google: {
    configured: boolean;
    clientId: string;
    clientSecret: string;
    allowedDomains: string[];
    discoveryUrl: string;
  };
  okta: {
    configured: boolean;
    domain: string;
    authServer: string;
    clientId: string;
    clientSecret: string;
    discoveryUrl: string;
  };
  genericOidc: {
    configured: boolean;
    /** What the sign-in button says: "Sign in with <name>". */
    name: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
    allowedDomains: string[];
    discoveryUrl: string;
  };
  oidc: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
    extraIssuers: string[];
    redirectUri: string;
    discoveryUrl: string;
  };
  provisioning: {
    jitEnabled: boolean;
    portalAdmins: string[];
    portalAdminsAt: number;
  };
  localAccounts: {
    signInEnabled: boolean;
    otpEnabled: boolean;
    otpExcludedGroupId: string | null;
    /** As stored; FORCE_LOCAL_SIGNIN overrides it in signsInWithCode(). */
    breakGlassOtp: boolean;
    passwordPolicy: PasswordPolicy;
    /** People may create their own account, confirmed by email; only these domains when listed. */
    registration: { enabled: boolean; domains: string[] };
    conditionalAccess: {
      allowedRanges: string[];
      breakGlassRanges: string[];
      elsewhereNeedsCode: boolean;
      codeForEveryone: boolean;
      requireAuthenticator: boolean;
    };
  };
  sla: SlaSettings;
  portalScripts: { enabled: boolean; allowedOrigins: string[] };
  people: {
    displayNameFormat: string;
    selfEdit: SelfEditField[];
    directory: { technicians: boolean; users: boolean; ownCompanyOnly: boolean };
  };
  httpRequests: { allowPrivateNetwork: boolean };
  smtpRelay: {
    enabled: boolean;
    /** Enabled, and enough is filled in to send. */
    configured: boolean;
    host: string;
    port: number;
    security: 'tls' | 'starttls' | 'none';
    username: string;
    password: string;
    fromAddress: string;
    fromName: string;
    useForCodes: boolean;
    /** Notifications only through the relays; mailboxes only read. */
    relaysOnly: boolean;
  };
  locale: LocaleSettings;
  scim: {
    enabled: boolean;
    /** True once a token has been generated. */
    configured: boolean;
    tokenHash: string;
    tokenHint: string;
    tokenSetAt: string | null;
    disableOnDelete: boolean;
    /** The tenant URL to paste into the Entra provisioning blade. */
    endpoint: string;
  };
  branding: {
    appName: string;
    brandColour: string;
    inkColour: string;
    font: string;
    colourModes: 'both' | 'light' | 'dark';
    defaultMode: 'system' | 'light' | 'dark';
    light: ModePalette;
    dark: ModePalette;
    logo: BrandingAssetRecord | null;
    favicon: BrandingAssetRecord | null;
  };
  attachments: {
    enabled: boolean;
    maxBytes: number;
    maxPerTicket: number;
  };
  automation: {
    signatureCuts: string[];
    trimQuoted: boolean;
    knownSendersOnly: boolean;
    autoCloseDays: number;
    reopenOnReply: boolean;
    reopenWithinDays: number;
  };
  tickets: {
    requireCancelNote: boolean;
    requireResolveNote: boolean;
    deleteClosedAfterDays: number;
    catalogue: {
      enabled: boolean;
      heading: string;
      columns: number;
      rows: number;
      filters: boolean;
      tiles: {
        id: string;
        templateId: string;
        label: string;
        description: string;
        icon: string;
        cell?: number;
      }[];
    };
    prefixes: {
      incident: string;
      service_request: string;
      change_request: string;
      task: string;
      change_task: string;
    };
  };
}

export interface BrandingAssetRecord {
  file: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalName: string;
  uploadedAt: string;
  /** The artwork has its own transparency, so it needs no white plate. */
  transparent?: boolean;
}

export const DATE_FORMATS = [
  'dd MMM yyyy',
  'dd.MM.yyyy',
  'd. M. yyyy',
  'dd/MM/yyyy',
  'MM/dd/yyyy',
  'yyyy-MM-dd',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface LocaleSettings {
  timeZone: string;
  dateFormat: DateFormat;
  timeFormat: '24h' | '12h';
  /** Serve the language the browser asks for, when nothing else decides. */
  followBrowser: boolean;
}

export interface SlaTarget {
  /** Business minutes to the first response. */
  response: number;
  /** Business minutes to resolution. */
  resolution: number;
}

export interface SlaSettings {
  enabled: boolean;
  notifyManager: boolean;
  /** Time on hold does not count against the resolution target. */
  pauseOnHold?: boolean;
  /** Days off: "2026-12-24" that day only, "12-25" every year. */
  holidays?: string[];
  timeZone: string;
  days: number[];
  start: string;
  end: string;
  targets: { urgent: SlaTarget; high: SlaTarget; normal: SlaTarget; low: SlaTarget };
}

/** Defaults taken from the environment, used until something is saved. */
function documentFromEnvironment(): SettingsDocument {
  return {
    oidc: {
      tenantId: config.oidc.tenantId,
      clientId: config.oidc.clientId,
      clientSecret: config.oidc.clientSecret,
      scopes: [...config.oidc.scopes],
      extraIssuers: [...config.oidc.extraIssuers],
    },
    google: { clientId: '', clientSecret: undefined, allowedDomains: [] },
    okta: { domain: '', authServer: 'default', clientId: '', clientSecret: undefined },
    genericOidc: { name: '', issuer: '', clientId: '', clientSecret: undefined, scopes: 'openid profile email', allowedDomains: [] },
    provisioning: {
      jitEnabled: config.provisioning.jitEnabled,
      portalAdmins: [],
      portalAdminsAt: 0,
    },
    localAccounts: {
      signInEnabled: true,
      otpEnabled: false,
      otpExcludedGroupId: null,
      breakGlassOtp: false,
      // Length is what matters; the rest is off until an organisation asks.
      passwordPolicy: { ...DEFAULT_PASSWORD_POLICY },
      registration: { enabled: false, domains: [] },
      conditionalAccess: {
        allowedRanges: [],
        breakGlassRanges: [],
        elsewhereNeedsCode: false,
        codeForEveryone: false,
        requireAuthenticator: false,
      },
    },
    locale: {
      timeZone: 'Europe/Prague',
      dateFormat: 'dd MMM yyyy',
      timeFormat: '24h',
      followBrowser: true,
    },
    portalScripts: { enabled: false, allowedOrigins: [] },
    people: {
      displayNameFormat: '',
      selfEdit: [],
      directory: { technicians: false, users: false, ownCompanyOnly: false },
    },
    httpRequests: { allowPrivateNetwork: false },
    smtpRelay: {
      enabled: false,
      host: '',
      port: 587,
      security: 'starttls',
      username: '',
      password: undefined,
      fromAddress: '',
      fromName: '',
      useForCodes: false,
    },
    sla: {
      // Off until somebody sets it up: a target nobody chose would mark
      // tickets breached for no reason anyone agreed to.
      enabled: false,
      notifyManager: false,
      pauseOnHold: false,
      holidays: [],
      timeZone: 'Europe/Prague',
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
    scim: {
      enabled: false,
      tokenHash: '',
      tokenHint: '',
      tokenSetAt: null,
      disableOnDelete: true,
    },
    branding: {
      appName: 'Service Desk',
      // Defaults only; everything here is set under Customisation.
      // Petrol on linen by default (18 Oct 2026); the quick colours offer the rest.
      brandColour: '#1a5d74',
      inkColour: '#16181d',
      font: 'system',
      colourModes: 'both',
      defaultMode: 'light',
      light: { background: '', surface: '', text: '' },
      dark: { background: '', surface: '', text: '' },
      logo: null,
      favicon: null,
    },
    attachments: {
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
      maxPerTicket: 10,
    },
    tickets: {
      requireCancelNote: false,
      requireResolveNote: false,
      deleteClosedAfterDays: 0,
      catalogue: { enabled: false, heading: '', columns: 3, rows: 3, filters: false, tiles: [] },
      prefixes: {
        incident: 'INC',
        service_request: 'SR',
        change_request: 'CR',
        task: 'TSK',
        change_task: 'CTSK',
      },
    },
    automation: {
      // Empty, like the category catalogue: the phrases an organisation signs
      // off with are theirs, and in their language. Inventing a list would
      // only mean deleting it first.
      signatureCuts: [],
      // On: a comment that carries the whole thread below it is the
      // complaint that asked for this (18 Oct 2026).
      trimQuoted: true,
      // Off, because a service desk that silently drops mail from somebody
      // without an account is a service desk losing requests. Turned on
      // deliberately, by somebody who knows every requester has one.
      knownSendersOnly: false,
      // Off, because closing somebody's ticket while they are still waiting
      // for an answer is worse than a queue with old resolved tickets in it.
      autoCloseDays: 0,
      // On: a reply to a closed ticket is somebody saying it is not fixed,
      // and a new ticket with none of the history is the wrong answer.
      reopenOnReply: true,
      // A month. After that a reply is usually a new problem that happens to
      // quote an old thread.
      reopenWithinDays: 30,
    },
  };
}

interface SettingsCache {
  document: SettingsDocument;
  effective: EffectiveSettings;
  updatedAt: string | null;
}

/**
 * Settings are read on nearly every request, and by templates, so `settings()`
 * stays synchronous: the whole document is held in memory and replaced only
 * when it changes. The cache is seeded from the environment at import time so
 * the accessor is never empty, then `loadSettings()` replaces it with the
 * stored row during startup and after every write.
 *
 * With more than one application instance each holds its own copy, so a change
 * made on one is not seen by the others until they reload. See the scaling
 * note in DEPLOYMENT.md.
 */
let cache: SettingsCache = (() => {
  const doc = documentFromEnvironment();
  return { document: doc, effective: derive(doc), updatedAt: null };
})();

const listeners = new Set<() => void>();

/** Registers a callback invoked after any settings change. */
export function onSettingsChanged(listener: () => void): void {
  listeners.add(listener);
}

function derive(doc: SettingsDocument): EffectiveSettings {
  const tenant = encodeURIComponent(doc.oidc.tenantId);
  const clientSecret = openMaybe(doc.oidc.clientSecret);

  const ssoConfigured =
    doc.oidc.tenantId !== '' && doc.oidc.clientId !== '' && clientSecret !== '';

  const googleSecret = openMaybe(doc.google.clientSecret);
  const googleConfigured =
    doc.google.clientId !== '' && googleSecret !== '' && doc.google.allowedDomains.length > 0;
  const oktaSecret = openMaybe(doc.okta.clientSecret);
  const oktaConfigured = doc.okta.domain !== '' && doc.okta.clientId !== '' && oktaSecret !== '';
  const genericSecret = openMaybe(doc.genericOidc.clientSecret);
  const genericIssuer = issuerOf(doc.genericOidc.issuer);
  const genericConfigured = doc.genericOidc.issuer !== '' && doc.genericOidc.clientId !== '' && genericSecret !== '';
  const genericScopes = doc.genericOidc.scopes.split(/\s+/).filter(Boolean);

  return {
    ssoConfigured,
    anySsoConfigured: ssoConfigured || googleConfigured || oktaConfigured || genericConfigured,
    genericOidc: {
      configured: genericConfigured,
      name: doc.genericOidc.name || 'single sign-on',
      issuer: genericIssuer,
      clientId: doc.genericOidc.clientId,
      clientSecret: genericSecret,
      // openid is what makes it OpenID Connect; never left out.
      scopes: genericScopes.includes('openid') ? genericScopes : ['openid', ...genericScopes],
      allowedDomains: doc.genericOidc.allowedDomains.map((d) => d.toLowerCase()),
      discoveryUrl: genericIssuer + '/.well-known/openid-configuration',
    },
    google: {
      configured: googleConfigured,
      clientId: doc.google.clientId,
      clientSecret: googleSecret,
      allowedDomains: doc.google.allowedDomains.map((d) => d.toLowerCase()),
      discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    },
    okta: {
      configured: oktaConfigured,
      domain: doc.okta.domain,
      authServer: doc.okta.authServer,
      clientId: doc.okta.clientId,
      clientSecret: oktaSecret,
      discoveryUrl:
        'https://' + doc.okta.domain +
        (doc.okta.authServer ? '/oauth2/' + encodeURIComponent(doc.okta.authServer) : '') +
        '/.well-known/openid-configuration',
    },
    oidc: {
      tenantId: doc.oidc.tenantId,
      clientId: doc.oidc.clientId,
      clientSecret,
      scopes: doc.oidc.scopes.length > 0 ? doc.oidc.scopes : ['openid', 'profile', 'email'],
      extraIssuers: doc.oidc.extraIssuers,
      redirectUri: config.publicOrigin + '/auth/oidc/callback',
      discoveryUrl:
        'https://login.microsoftonline.com/' + tenant + '/v2.0/.well-known/openid-configuration',
    },
    provisioning: {
      jitEnabled: doc.provisioning.jitEnabled,
      portalAdmins: doc.provisioning.portalAdmins ?? [],
      portalAdminsAt: doc.provisioning.portalAdminsAt ?? 0,
    },
    localAccounts: {
      // FORCE_LOCAL_SIGNIN is the way back in when the directory is the
      // only other door and it has stopped working. It overrides the stored
      // choice without changing it.
      signInEnabled: doc.localAccounts.signInEnabled || config.forceLocalSignIn,
      otpEnabled: doc.localAccounts.otpEnabled,
      otpExcludedGroupId: doc.localAccounts.otpExcludedGroupId,
      breakGlassOtp: doc.localAccounts.breakGlassOtp,
      passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, ...(doc.localAccounts.passwordPolicy ?? {}) },
      registration: doc.localAccounts.registration ?? { enabled: false, domains: [] },
      // The schema gives this a default, so a document written before it
      // existed already arrives complete.
      conditionalAccess: doc.localAccounts.conditionalAccess,
    },
    // SLA counts in the Locale time zone: one place to set it. The SLA's
    // own timeZone field predates Locale and is kept only because the stored
    // document has it.
    sla: { ...doc.sla, timeZone: doc.locale.timeZone },
    portalScripts: doc.portalScripts,
    people: {
      displayNameFormat: doc.people.displayNameFormat,
      selfEdit: doc.people.selfEdit ?? [],
      directory: doc.people.directory ?? { technicians: false, users: false, ownCompanyOnly: false },
    },
    httpRequests: doc.httpRequests,
    smtpRelay: (() => {
      const r = doc.smtpRelay;
      const password = openMaybe(r.password);
      return {
        enabled: r.enabled,
        configured: r.enabled && r.host !== '' && r.fromAddress !== '' && (r.username === '' || password !== ''),
        host: r.host,
        port: r.port,
        security: r.security,
        username: r.username,
        password,
        fromAddress: r.fromAddress,
        fromName: r.fromName,
        useForCodes: r.useForCodes,
        relaysOnly: r.relaysOnly ?? false,
      };
    })(),
    locale: doc.locale,
    scim: {
      enabled: doc.scim.enabled,
      configured: doc.scim.tokenHash !== '',
      tokenHash: doc.scim.tokenHash,
      tokenHint: doc.scim.tokenHint,
      tokenSetAt: doc.scim.tokenSetAt,
      disableOnDelete: doc.scim.disableOnDelete,
      endpoint: config.publicOrigin + '/scim/v2',
    },
    branding: doc.branding,
    attachments: doc.attachments,
    automation: doc.automation,
    tickets: doc.tickets,
  };
}

function mergeStored(stored: Record<string, unknown>): SettingsDocument {
  const fallback = documentFromEnvironment();
  // Merge section by section, so a document written by an older version still
  // picks up defaults for sections it does not carry.
  const merged = {
    ...fallback,
    ...stored,
    oidc: { ...fallback.oidc, ...((stored.oidc as object) ?? {}) },
    google: { ...fallback.google, ...((stored.google as object) ?? {}) },
    okta: { ...fallback.okta, ...((stored.okta as object) ?? {}) },
    genericOidc: { ...fallback.genericOidc, ...((stored.genericOidc as object) ?? {}) },
    provisioning: { ...fallback.provisioning, ...((stored.provisioning as object) ?? {}) },
    localAccounts: { ...fallback.localAccounts, ...((stored.localAccounts as object) ?? {}) },
    locale: { ...fallback.locale, ...((stored.locale as object) ?? {}) },
    portalScripts: { ...fallback.portalScripts, ...((stored.portalScripts as object) ?? {}) },
    people: { ...fallback.people, ...((stored.people as object) ?? {}) },
    httpRequests: { ...fallback.httpRequests, ...((stored.httpRequests as object) ?? {}) },
    smtpRelay: { ...fallback.smtpRelay, ...((stored.smtpRelay as object) ?? {}) },
    sla: {
      ...fallback.sla,
      ...((stored.sla as object) ?? {}),
      targets: {
        ...fallback.sla.targets,
        ...(((stored.sla as { targets?: object })?.targets as object) ?? {}),
      },
    },
    scim: { ...fallback.scim, ...((stored.scim as object) ?? {}) },
    branding: { ...fallback.branding, ...((stored.branding as object) ?? {}) },
    attachments: { ...fallback.attachments, ...((stored.attachments as object) ?? {}) },
    automation: { ...fallback.automation, ...((stored.automation as object) ?? {}) },
    tickets: {
      ...fallback.tickets,
      ...((stored.tickets as object) ?? {}),
      prefixes: {
        ...fallback.tickets.prefixes,
        ...(((stored.tickets as { prefixes?: object })?.prefixes as object) ?? {}),
      },
      catalogue: {
        ...fallback.tickets.catalogue,
        ...(((stored.tickets as { catalogue?: object })?.catalogue as object) ?? {}),
      },
    },
  };
  return documentSchema.parse(merged);
}

/**
 * Reads the stored settings into the in-memory cache.
 *
 * Called once during startup, and again after every write. A stored row that
 * cannot be parsed is reported and ignored rather than taking the service
 * down: falling back to the environment leaves an administrator able to sign
 * in and fix it.
 */
export async function loadSettings(): Promise<EffectiveSettings> {
  const row = await queryOne<{ document: unknown; updated_at: string }>(
    "SELECT document, updated_at FROM settings WHERE id = 'current'",
  );

  if (!row) {
    const doc = documentFromEnvironment();
    cache = { document: doc, effective: derive(doc), updatedAt: null };
    return cache.effective;
  }

  try {
    // jsonb comes back already parsed; a text column would not.
    const stored =
      typeof row.document === 'string'
        ? (JSON.parse(row.document) as Record<string, unknown>)
        : (row.document as Record<string, unknown>);
    const doc = mergeStored(stored);
    cache = { document: doc, effective: derive(doc), updatedAt: row.updated_at };
  } catch (err) {
    log.error({ err }, 'stored settings are unreadable, falling back to the environment');
    const doc = documentFromEnvironment();
    cache = { document: doc, effective: derive(doc), updatedAt: row.updated_at };
  }
  return cache.effective;
}

/** Re-reads the stored settings, for an instance that did not make the change. */
export const reloadSettings = loadSettings;

/** Effective settings, with secrets decrypted. Read from the memory cache. */
export function settings(): EffectiveSettings {
  return cache.effective;
}

/** The stored document, with secrets still sealed. For the settings form. */
export function settingsDocument(): SettingsDocument {
  return cache.document;
}

export function settingsUpdatedAt(): string | null {
  return cache.updatedAt;
}

/** True when a provider's secret is stored, without revealing it. */
/**
 * An OpenID Connect issuer as typed: without trailing slashes, and without
 * /.well-known/openid-configuration, which is added when it is fetched. The
 * whole discovery address is what providers show, and pasted as the issuer
 * it was fetched with the suffix twice - a 500 at sign-in (reported 18 Oct
 * 2026, with Auth0).
 */
export function issuerOf(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/\.well-known\/openid-configuration$/i, '').replace(/\/+$/, '');
}

export function hasProviderSecret(provider: 'google' | 'okta' | 'genericOidc'): boolean {
  const value = settingsDocument()[provider].clientSecret;
  return isSealed(value) ? true : typeof value === 'string' && value.length > 0;
}

/** True when the SMTP relay has a password stored, without revealing it. */
export function hasRelayPassword(): boolean {
  const value = settingsDocument().smtpRelay.password;
  return isSealed(value) ? true : typeof value === 'string' && value.length > 0;
}

/** True when a secret is present, without revealing it. */
export function hasOidcClientSecret(): boolean {
  const value = settingsDocument().oidc.clientSecret;
  return isSealed(value) ? true : typeof value === 'string' && value.length > 0;
}

export interface SettingsPatch {
  oidc?: Partial<Omit<SettingsDocument['oidc'], 'clientSecret'>> & { clientSecret?: string };
  google?: Partial<Omit<SettingsDocument['google'], 'clientSecret'>> & { clientSecret?: string };
  okta?: Partial<Omit<SettingsDocument['okta'], 'clientSecret'>> & { clientSecret?: string };
  genericOidc?: Partial<Omit<SettingsDocument['genericOidc'], 'clientSecret'>> & { clientSecret?: string };
  provisioning?: Partial<SettingsDocument['provisioning']>;
  localAccounts?: Partial<SettingsDocument['localAccounts']>;
  sla?: Partial<SettingsDocument['sla']>;
  locale?: Partial<SettingsDocument['locale']>;
  portalScripts?: Partial<SettingsDocument['portalScripts']>;
  people?: Partial<SettingsDocument['people']>;
  httpRequests?: Partial<SettingsDocument['httpRequests']>;
  smtpRelay?: Partial<Omit<SettingsDocument['smtpRelay'], 'password'>> & { password?: string; clearPassword?: boolean };
  scim?: Partial<SettingsDocument['scim']>;
  branding?: Partial<SettingsDocument['branding']>;
  attachments?: Partial<SettingsDocument['attachments']>;
  automation?: Partial<SettingsDocument['automation']>;
  tickets?: {
    prefixes?: Partial<SettingsDocument['tickets']['prefixes']>;
    requireCancelNote?: boolean;
    requireResolveNote?: boolean;
    deleteClosedAfterDays?: number;
    // Whole, never merged: the tiles are a list, and a patch that merged
    // them index by index could not remove one.
    catalogue?: SettingsDocument['tickets']['catalogue'];
  };
}

/**
 * Applies a partial change and persists the whole document.
 *
 * Secrets are sealed before storage. An empty string for a secret means "leave
 * the stored one alone", so the form never has to round-trip it; the caller
 * clears a secret explicitly with `clearOidcClientSecret`.
 */
async function persist(document: SettingsDocument, actorId: string | null): Promise<void> {
  await execute(
    `INSERT INTO settings (id, document, updated_at, updated_by)
     VALUES ('current', ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       document = excluded.document,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [JSON.stringify(document), nowIso(), actorId],
  );
}

export async function updateSettings(
  patch: SettingsPatch,
  actorId: string | null,
): Promise<EffectiveSettings> {
  const current = settingsDocument();

  const next: SettingsDocument = {
    oidc: {
      ...current.oidc,
      ...patch.oidc,
      clientSecret:
        patch.oidc?.clientSecret !== undefined && patch.oidc.clientSecret !== ''
          ? seal(patch.oidc.clientSecret)
          : current.oidc.clientSecret,
    },
    // Secrets: blank means "keep the stored one", as for Entra ID.
    google: {
      ...current.google,
      ...patch.google,
      clientSecret:
        patch.google?.clientSecret !== undefined && patch.google.clientSecret !== ''
          ? seal(patch.google.clientSecret)
          : current.google.clientSecret,
    },
    okta: {
      ...current.okta,
      ...patch.okta,
      clientSecret:
        patch.okta?.clientSecret !== undefined && patch.okta.clientSecret !== ''
          ? seal(patch.okta.clientSecret)
          : current.okta.clientSecret,
    },
    genericOidc: {
      ...current.genericOidc,
      ...patch.genericOidc,
      clientSecret:
        patch.genericOidc?.clientSecret !== undefined && patch.genericOidc.clientSecret !== ''
          ? seal(patch.genericOidc.clientSecret)
          : current.genericOidc.clientSecret,
    },
    provisioning: { ...current.provisioning, ...patch.provisioning },
    localAccounts: { ...current.localAccounts, ...patch.localAccounts },
    sla: { ...current.sla, ...patch.sla },
    locale: { ...current.locale, ...patch.locale },
    portalScripts: { ...current.portalScripts, ...patch.portalScripts },
    people: { ...current.people, ...patch.people },
    httpRequests: { ...current.httpRequests, ...patch.httpRequests },
    // The relay password: blank keeps it, clearPassword removes it.
    smtpRelay: (() => {
      const { password, clearPassword, ...rest } = patch.smtpRelay ?? {};
      return {
        ...current.smtpRelay,
        ...rest,
        password: clearPassword
          ? undefined
          : password !== undefined && password !== ''
            ? seal(password)
            : current.smtpRelay.password,
      };
    })(),
    scim: { ...current.scim, ...patch.scim },
    branding: { ...current.branding, ...patch.branding },
    attachments: { ...current.attachments, ...patch.attachments },
    automation: { ...current.automation, ...patch.automation },
    tickets: {
      prefixes: { ...current.tickets.prefixes, ...patch.tickets?.prefixes },
      requireCancelNote: patch.tickets?.requireCancelNote ?? current.tickets.requireCancelNote ?? false,
      requireResolveNote: patch.tickets?.requireResolveNote ?? current.tickets.requireResolveNote ?? false,
      deleteClosedAfterDays:
        patch.tickets?.deleteClosedAfterDays ?? current.tickets.deleteClosedAfterDays ?? 0,
      catalogue: patch.tickets?.catalogue ?? current.tickets.catalogue,
    },
  };

  await persist(documentSchema.parse(next), actorId);
  await loadSettings();

  // Notify after the write has committed and the cache has been refreshed,
  // so listeners that rebuild caches or restart timers see the new values.
  notifyChanged();
  return settings();
}

/** Removes a stored secret entirely. */
export async function clearSecret(
  which: 'oidcClientSecret' | 'googleClientSecret' | 'oktaClientSecret' | 'genericClientSecret',
  actorId: string | null,
): Promise<void> {
  const current = settingsDocument();
  const next: SettingsDocument =
    which === 'googleClientSecret'
      ? { ...current, google: { ...current.google, clientSecret: undefined } }
      : which === 'oktaClientSecret'
        ? { ...current, okta: { ...current.okta, clientSecret: undefined } }
        : which === 'genericClientSecret'
          ? { ...current, genericOidc: { ...current.genericOidc, clientSecret: undefined } }
          : { ...current, oidc: { ...current.oidc, clientSecret: undefined } };

  await persist(documentSchema.parse(next), actorId);
  await loadSettings();
  notifyChanged();
}

/**
 * Checks a prospective change for the mistakes that would lock everybody out,
 * so the settings form can refuse it with a clear message instead of the next
 * sign-in failing.
 */
export function settingsProblems(candidate: {
  oidc: { tenantId: string; clientId: string; hasSecret: boolean };
  scim: { enabled: boolean; configured: boolean };
  provisioning: { jitEnabled: boolean };
}): string[] {
  const problems: string[] = [];

  if (!candidate.oidc.tenantId) problems.push('OpenID Connect needs a directory (tenant) ID.');
  if (!candidate.oidc.clientId) problems.push('OpenID Connect needs an application (client) ID.');
  if (!candidate.oidc.hasSecret) problems.push('OpenID Connect needs a client secret.');

  if (candidate.scim.enabled && !candidate.scim.configured) {
    problems.push(
      'SCIM provisioning needs a bearer token. Generate one before switching it on.',
    );
  }

  // With neither on, the only way in is a local account - which is a
  // legitimate state for a proof of concept, but worth saying out loud.
  if (!candidate.provisioning.jitEnabled && !candidate.scim.enabled) {
    problems.push(
      'With just-in-time provisioning off and SCIM off, no directory account can sign in. Turn one of them on, or expect local accounts only.',
    );
  }

  return problems;
}
/** Tells dependants that any configuration they captured is now stale. */
export function notifyChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      log.error({ err }, 'a settings change listener threw');
    }
  }
}

/** Test seam: resets the cache to the environment defaults. */
export function resetSettingsCache(): void {
  const doc = documentFromEnvironment();
  cache = { document: doc, effective: derive(doc), updatedAt: null };
}

export type { SealedValue };
