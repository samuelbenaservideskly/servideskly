# ServiDeskly

**A source-available service desk: tickets, request forms, email, service
levels and automation - in one self-hosted web application.**

ServiDeskly is a helpdesk for IT and service teams. Requesters raise tickets
through forms you design or by email; technicians work them in a queue with
service-level clocks; administrators set up everything from the browser -
no configuration files to edit after the first start.

It is built to be **secure by default**: server-rendered pages with a strict
Content-Security-Policy and almost no JavaScript, single sign-on through
OpenID Connect, roles that never come from a directory, an audit trail of
every change, and personal data and attachments encrypted at rest.

## What it does

- **Tickets** - incidents, service requests, change requests and tasks, each
  with its own reference prefix; on-hold reasons, cancellation and
  resolution notes, approvals, mandatory tasks, deletion with a reason.
- **Request forms** - a drag-and-drop form builder with sections, two
  columns, custom fields, conditional sections, defaults and a service
  catalogue of tiles.
- **Email** - Microsoft 365 (Graph) or any IMAP/SMTP mailbox; replies thread
  onto the right ticket, attachments are kept, signatures are stripped,
  rules raise tickets from chosen templates; notifications in several
  languages.
- **Service levels** - response and resolution targets per priority in
  business hours, holidays, pause on hold, breach alerts.
- **Automation** - a visual editor: triggers, conditions, ticket changes,
  HTTP requests with OAuth, API-key or certificate connections; an API to
  read and change tickets.
- **Sign-in** - Microsoft Entra ID, Google, Okta or any OpenID Connect
  provider; SCIM provisioning; password accounts with sign-in codes,
  conditional access and password policy.
- **People** - technician groups with managers and rules, user groups,
  a people directory, display-name formats, right-to-erasure.
- **Dashboards and reports** - a technician's and a manager's dashboard,
  personal boards, reports with an Excel export.
- **Your look** - colours, light and dark mode, fonts, logo, and fully
  custom requester portals.
- **Languages** - translate the whole interface; the string catalogue is
  generated from the code.

## Quick start

Node.js 24 is required.

```bash
git clone https://github.com/servideskly/servideskly.git
cd servideskly
npm install
npm run dev
```

Open http://localhost:3000/login and sign in as `admin@local` with the
password `1234` (development only - set by `LOCAL_SEED_PASSWORD`).

For sample data: `npm run demo:seed`, then `npm run dev:demo` on port 3001.

Check everything - typecheck, the whole test suite and `npm audit`:

```bash
npm run verify
```

## Running it for real

| Where | Guide |
| --- | --- |
| A server with Docker (SQLite) | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Azure App Service with PostgreSQL and Key Vault | [AZURE-DEPLOYMENT.md](AZURE-DEPLOYMENT.md) |

**The first administrator.** A production helpdesk has no default account.
Create the first administrator with a one-time link, signed with the
helpdesk's own `SESSION_SECRET`:

```bash
npm run setup-link -- you@example.com
```

(on a built deployment: `node dist/auth/setup-link-cli.js you@example.com`).
Open the link within the hour and choose a password.

**Back up `SESSION_SECRET`.** Personal details, the audit trail and every
attachment are encrypted with a key derived from it; losing it loses that
data.

## Documentation

- [docs/MANUAL.md](docs/MANUAL.md) - the administrator's manual: every
  feature and setting.
- [CLAUDE.md](CLAUDE.md) - the design decisions and the traps, by feature:
  read before changing the code.
- [AGENTS.md](AGENTS.md) and [HANDOFF.md](HANDOFF.md) - how to work on the
  codebase and where everything lives.
- [REPORTING.md](REPORTING.md) - what each report figure means.

## Would you like access, or to see it running?

Write to **[support@servideskly.com](mailto:support@servideskly.com)** - for a
demo, a hosted helpdesk, or help getting yours running.

## Support the project

If you find this project useful and would like to support its development,
you can make a one-time contribution via
**[GitHub Sponsors](https://github.com/sponsors/servideskly)**.

Contributions are entirely optional and help me dedicate more time to
maintaining and improving the project.

Thank you for your support!

## About the author

ServiDeskly is written and maintained by the ServiDeskly authors.

## License

Copyright (C) 2026 the ServiDeskly authors.

ServiDeskly is **source-available** under the
**[PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0)**
- see [LICENSE](LICENSE).

In short:

- **You may** read, use and change it, and run it for yourself or your own
  organisation - companies included - free of charge.
- **You may not** use it to provide a product that competes with
  ServiDeskly: selling it, hosting it for others, offering it as a service,
  or building a rival helpdesk product from it - paid or free.
- Anyone you share it with must get the license and its `Required Notice`
  line too.

For anything the license does not allow - hosting it for customers, say -
ask: **[support@servideskly.com](mailto:support@servideskly.com)**.

The six bundled fonts are under the SIL Open Font License 1.1
([public/fonts/NOTICES.md](public/fonts/NOTICES.md)).
