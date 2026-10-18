# Service Desk - secure ticketing system

A self-contained ticketing/helpdesk web application with its own database.

It runs two ways, and the second does not depend on the first:

- **With local accounts**, out of the box. A username and password, no
  identity provider, nothing to configure - which is all a proof of concept,
  a demo or a development copy needs.
- **With Microsoft Entra ID**, when you want it. Users authenticate against
  your tenant over **OpenID Connect**, and accounts are created by
  **just-in-time provisioning**, by **SCIM** push from an assigned group,
  or both. All of it is switched on from the UI, later, without touching a
  config file.

- **Everything is configurable from the web UI.** Tenant credentials, the
  SCIM endpoint and its token, attachment limits, ticket templates, and the
  application's name, logo, favicon and colours are all edited under
  *Admin → Settings* and take effect immediately, without a restart.
- **Roles are assigned in the application, never by the directory.** Nothing
  in an Entra token grants access: everyone arrives as a plain user and is
  promoted under *Admin → Users*.
- **No bundled branding.** The application ships no logo of its own: upload
  yours under *Settings → Customisation*, and the palette is generated from the
  two colours you choose.
- **A local break-glass administrator** always exists, so a misconfigured or
  unreachable identity provider can never lock you out of the settings needed
  to fix it. Further password accounts, with any role, are created under
  *Admin → Accounts*.
- **No sign-in bypass.** There is no development login mode: a session requires
  either a verified Entra ID assertion or a real password.
- **Ticket templates with a form builder** - arrange the fields a requester
  sees by dragging them onto the form, mark each one optional, mandatory or
  view only, and choose which template every ticket starts from.
- Server-rendered, with **one script on one page** (the form builder's
  drag-and-drop). Every other response is `script-src 'none'`.
- Roles (`user` / `agent` / `admin`) mapped from Entra ID groups or app roles.
- Ticket **attachments** with type verification from file contents, added
  while raising the ticket or at any time after.
- **Light and dark mode**, following the operating system by default and
  overridable per reader - with no client-side JavaScript.
- **SQLite** by default: the database is a file, so there is nothing to
  install and nothing to run.
- Full audit trail of authentication, authorisation and data changes.

---

## Contents

1. [Your data is kept](#your-data-is-kept)
2. [Requirements](#requirements)
3. [First run](#first-run)
4. [Local accounts](#local-accounts)
5. [Configuring Entra ID](#configuring-entra-id)
6. [User provisioning](#user-provisioning)
7. [Roles and permissions](#roles-and-permissions)
8. [Technician groups](#technician-groups)
9. [Mail](#mail)
10. [Attachments](#attachments)
11. [Ticket templates](#ticket-templates)
12. [Categories](#categories)
13. [Light and dark mode](#light-and-dark-mode)
14. [Customisation](#customisation)
15. [Your profile](#your-profile)
16. [Settings: UI versus environment](#settings-ui-versus-environment)
17. [Running in Docker](#running-in-docker)
18. [Production deployment](#production-deployment)
19. [Security design](#security-design)
20. [Operations](#operations)
21. [Project layout](#project-layout)
22. [Scope and known limitations](#scope-and-known-limitations)

---

## Your data is kept

The database is a single file, `data/ticketing.sqlite`, with uploads beside it
in `data/uploads`. Stopping the application, restarting it, rebooting the
machine or upgrading it all leave both alone - upgrades only ever add to the
schema, never replace it.

The only way to lose your local data is to delete those files yourself:

```bash
rm -rf data/ticketing.sqlite* data/uploads
```

That is the "start again from nothing" button, and nothing else does it. Back
it up by copying the `data/` folder while the application is stopped.

---
## Requirements

| | |
|---|---|
| Node.js | 22 or newer (developed and tested on 24) |
| Database | SQLite, bundled. A file under `data/` - nothing to install, nothing to run |
| TLS | Required in production; terminate at a reverse proxy or load balancer |
| Entra ID | An app registration for sign-in, and optionally an enterprise application for SCIM provisioning - both can be added later, from the UI |

```bash
npm install
```

For a container deployment none of this is needed on the host - see
[Running in Docker](#running-in-docker); read on only if you are working on
the code.

`npm install` runs native install scripts for `better-sqlite3` and `esbuild`.
If your npm blocks them, approve them explicitly:

```bash
npm approve-scripts better-sqlite3 && npm approve-scripts esbuild && npm install
```

---

## First run

The application starts with **no identity provider configured at all**. That is
a supported state: you sign in as the local administrator and complete the
setup through the UI.

```bash
cp .env.example .env
```

For a local run you only need:

```ini
NODE_ENV=development
APP_BASE_URL=http://localhost:3000

# Two accounts, admin and user, both with this password. Development only:
# production ignores it and generates a random one instead.
LOCAL_SEED_PASSWORD=1234
PASSWORD_MIN_LENGTH=4
```

```bash
npm run dev
```

The database is a SQLite file at `DATABASE_PATH` (`./data/ticketing.sqlite`
by default), created on the first start along with its directory. There is
no server to install or start. To begin again from nothing:

```bash
rm -rf data/ticketing.sqlite* data/uploads
```

### The two local accounts

Outside production the first start creates both of these:

| Username | Role | For |
| --- | --- | --- |
| `admin` | Administrator | Triage, settings, templates, accounts |
| `user` | User | Raising tickets, seeing only their own |

Both use `LOCAL_SEED_PASSWORD`. Change either under **Profile → Password**,
or reset it and create more accounts under **Admin → Accounts**.

`admin` is the break-glass administrator: it cannot be deleted, demoted or
disabled, so a broken or unconfigured identity provider can never lock
everybody out. In production it is created with a random password written to
the log once, `LOCAL_SEED_PASSWORD` is ignored, no `user` account is made,
and the minimum password length is forced back to 12.

Open <http://localhost:3000/login> and sign in as `admin`.

In production, where `LOCAL_SEED_PASSWORD` is ignored, the password is
instead generated and printed to the log exactly once:

```
Local administrator created. Sign in at /login with username "admin" and this
one-time password, then change it on your profile page:

    <32 random characters, different on every install>

This password is not stored in readable form and will not be shown again.
```

From there, configure the sign-in method, tenant credentials and role
mappings in the UI. Nothing else needs to go in `.env`.
---

## Local accounts

Accounts that authenticate with a username and password rather than through
Entra ID, administered under **Admin → Accounts**. `admin` is always one of
them and is the break-glass account; any number of others can be created,
with any role, which is what lets the service be used before - or entirely
without - a directory.

**Why it exists.** Roles are assigned under *Admin → Users*, and reaching
that page requires the admin role - which only an existing administrator can
grant. Without a local account, a fresh install, an expired client secret, a
mistyped tenant id or an identity provider outage would leave the service
unadministrable. This account is the way back in, and it is why nothing in
the directory needs to be able to grant privilege here.

**Creating and managing them.** *Admin → Accounts* lists every password
account and lets an administrator add one (username, display name, role),
reset a password - leave the box empty to have one generated - change a
role, disable an account, or remove it. Removing an account that has already
raised or been assigned tickets disables it instead, so its history is not
destroyed along with it.

Resetting a password signs that account out of every session it had, and the
owner is asked to replace the administrator-set password at next sign-in.

**The trade-off is real and deliberate:** a standing password credential is
something to protect. Every account here is therefore:

- created with a **random password** in production, never a default one,
  printed once (outside production `LOCAL_SEED_PASSWORD` is used instead,
  so a proof of concept can be signed into without reading the log);
- hashed with **scrypt** (memory-hard, parameters stored per hash, upgraded
  opportunistically when the cost is raised);
- **rate limited**, and **locked out for 15 minutes** after 5 failed attempts;
- **audited** on every attempt, success or failure;
- **invisible to SCIM**, so the directory cannot deactivate or remove it;
- required to prove the **current password** before the owner changes it, so
  someone who hijacks a session cannot silently seize the account.

And `admin` specifically is **not demotable, not disablable and not
removable** through the UI - that is what makes it the way back in.

Change the password on **your own profile page** (the account name, top
right), not in the global settings - it is a self-service action rather than a
system setting. Store it in your password manager, and treat it as you would
any other break-glass credential.

> If you lose the `admin` password, stop the service, delete its credential
> row and restart - the account is recreated with a fresh password:
>
> ```bash
> sqlite3 data/ticketing.sqlite "DELETE FROM local_credentials WHERE username='admin';"
> ```

---

## Configuring Entra ID

This is the recommended integration. It uses the authorization code flow with
PKCE, a confidential client, and ID token validation against the tenant's
published signing keys.

### 1. Register the application

*Entra admin centre → App registrations → New registration*

| Field | Value |
|---|---|
| Name | Service Desk (or whatever you call it) |
| Supported account types | Accounts in this organizational directory only |
| Redirect URI | **Web** → `https://helpdesk.example.com/auth/oidc/callback` |

The exact redirect URI to register is shown at the top of *Admin → Settings*.

Note the **Application (client) ID** and **Directory (tenant) ID** from the
Overview blade.

### 2. Create a client secret

*Certificates & secrets → New client secret*. Copy the value immediately; it is
shown once. Record its expiry - sign-in breaks when it lapses.

### 3. Emit the claims the application needs

*Token configuration → Add optional claim* → ID token → `email`, `upn`.

That is all. **No groups claim and no app roles are needed**, because
nothing in the token decides what anyone is allowed to do - see
[Roles and permissions](#roles-and-permissions). If your tenant emits them
anyway, they are ignored.

### 4. Enter it in the UI

*Admin → Settings → Authentication*: fill in the directory ID, application
ID and client secret. The change applies immediately - the discovery
document and signing keys are re-fetched, and the **Sign in with Microsoft**
button becomes active on the login page.

The same values can be seeded from the environment instead
(`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`) if you prefer
to deploy them with configuration management.

---
## User provisioning

Two ways an Entra ID account can exist here, and they compose:

| | What it does | Where |
| --- | --- | --- |
| **Just-in-time** | Creates the account on its first successful sign-in. | *Settings → Provisioning* |
| **SCIM** | Entra pushes the members of an assigned group: creates, updates, deactivates. | *Settings → Provisioning* |

Neither grants a role. Everyone arrives as a plain **user**.

### Just-in-time provisioning

On by default. Anyone in your tenant who can complete sign-in gets an
account. Turn it off and only accounts SCIM has provisioned may sign in - everyone else is refused with a clear message, and the refusal is audited.

An existing account is never re-created: its profile (display name, UPN,
object id) is refreshed from the token, and its **role is left alone**.

### SCIM provisioning from Entra ID

This is how you sync the members of a group. Entra tells this service who
should exist, rather than this service polling Microsoft Graph.

**Set it up:**

1. *Admin → Settings → Provisioning* → **Generate token**. The token is shown
   **once** - only a SHA-256 of it is stored. Copy it.
2. In Entra ID: *Enterprise applications → your application → Provisioning*,
   set Provisioning Mode to **Automatic**.
3. Paste the two values the page shows:

   | Entra field | Value |
   | --- | --- |
   | Tenant URL | `{APP_BASE_URL}/scim/v2` |
   | Secret Token | the generated token |

4. **Test Connection**, then Save.
5. Under *Mappings*, leave **Provision Microsoft Entra ID Groups** off - this
   service has no groups to provision into. Keep the Users mapping.
6. Assign the group whose members should get accounts, and start provisioning.

**What the endpoint supports:**

| Operation | Behaviour |
| --- | --- |
| `POST /Users` | Creates the account, always as a plain **user**. |
| `GET /Users?filter=…` | `userName eq`, `externalId eq`, `emails.value eq`. Anything else is refused rather than matching everything. |
| `GET /Users/{id}` | One account. |
| `PUT` / `PATCH /Users/{id}` | Updates the profile and the active flag. Both the `path` and the pathless Entra patch shapes are understood, and `"True"`/`"False"` strings as well as booleans. |
| `DELETE /Users/{id}` | **Disables** the account by default, rather than removing it - see below. |
| `GET /Groups` | An empty list, so an Entra probe does not log errors. Writes are refused with a clear 501. |
| `ServiceProviderConfig`, `ResourceTypes`, `Schemas` | Discovery. |

**What it deliberately does not do:**

- **Assign roles.** A `roles` attribute in a SCIM payload is ignored, not
  refused - refusing would quarantine the whole provisioning job over
  something that is simply not this application's model.
- **Delete people who have used the service.** Tickets reference their
  requester, so a real delete would either fail or take the ticket history
  with it. A SCIM `DELETE` disables the account instead. That is a setting
  (*Treat a SCIM delete as "disable"*), and even with it off an account that
  has tickets is disabled rather than removed.

**Security.** The endpoint is mounted ahead of the browser pipeline: bearer
token only, no session is allocated, no CSRF token applies, and it has its
own JSON parser and its own SCIM error documents - Entra never receives a
page of HTML as a failure. Only accounts SCIM itself provisioned are visible
through it, so the directory cannot see or deactivate a local account.
Revoking the token takes effect on the next request.

---
## Roles and permissions

| | `user` | `agent` | `admin` |
|---|---|---|---|
| Raise a ticket | ✅ | ✅ | ✅ |
| See own tickets | ✅ | ✅ | ✅ |
| See all tickets | - | ✅ | ✅ |
| Comment | own | all | all |
| Internal notes | - | ✅ | ✅ |
| Attach files | own tickets | all | all |
| Internal attachments | - | ✅ | ✅ |
| Change status / priority / assignee | - | ✅ | ✅ |
| Manage users, roles and templates | - | - | ✅ |
| Change settings, read audit trail | - | - | ✅ |

### Roles are assigned in the application, not by the directory

**Nothing in an Entra ID token grants access here.** Group membership, app
roles and email addresses are all ignored. Signing in never changes a role
that is already set, and SCIM never sets one.

Everyone - whether created on first sign-in or provisioned by SCIM - arrives
as a plain `user` and stays one until an administrator promotes them under
*Admin → Users*.

The trade is deliberate:

- **For it:** a tenant administrator cannot grant themselves access here by
  editing a group, role changes happen and are audited in one place, and
  there is no mapping to get subtly wrong. A token is proof of *identity*
  only, never of *authorisation*.
- **Against it:** a new colleague needs an administrator to promote them,
  rather than it following their group membership automatically.

The role is read from the database on **every request**, so a role change or
a lockout takes effect immediately rather than at session expiry.

The application refuses to remove the last active administrator, refuses to
let an administrator demote or disable their own account, and refuses to
demote, disable or remove the local `admin` account at all.

### Changing an account's email

A password account's address is set on its own page, under **Email address**.
It starts as `username@local`, which is fine for signing in but cannot receive
anything - so set a real one before testing notifications.

They sign in with their **username**, so changing the address does not affect
getting in; it only changes where their mail goes.

An account that signs in through Entra ID takes its address from the
directory, and that address is refreshed at every sign-in - so it is shown
rather than offered for editing. Change it in Entra ID.

### Adding an account

Under *Settings → Users*, **New account** opens a dialog over the list. It is
for someone who has no Entra ID account, or for testing: anyone who signs in
through Entra ID appears here on their own and needs no adding.

---
## Technician groups

A team a ticket can be routed to - desktop support, networks, and so on - so
the queue can be filtered by who is *meant* to pick something up rather than
only by who already has. Managed under *Settings → Technician groups*, where
**New group** opens a dialog over the list.

Worth knowing:

- **Membership grants nothing.** Being in a group never lets anyone see or do
  more than their role already allows, which is why only agents and
  administrators can be members.
- **Groups are listed alphabetically**, case-insensitively. There is no order
  to set: a list that is read by name has no right answer for a number.
- **Retiring a group keeps it** but stops it being offered for routing, so the
  tickets already routed to it stay readable.
- A group is reached by selecting its name, where its description, members and
  whether it is active are all set.

---
## Mail

Under *Settings - Mail*. Two tabs: the mailboxes, and the notifications they
send.

### Mailboxes

Add as many as you need. Choose how each one connects, and **the form changes
to match** - you are only ever asked for the credentials that kind actually
uses.

**Microsoft Graph** signs in with OAuth2 client credentials, so no password is
stored anywhere. Register an application in Entra ID, grant it
`Mail.ReadWrite` and `Mail.Send` as *application* permissions, and restrict it
to the mailboxes it should touch with an application access policy. Then give
this application the tenant id, the client id and a client secret.

**IMAP and SMTP** take a host, a port and a username and password - these
protocols have no notion of a tenant or a client secret, so none is asked for.
Note that Microsoft 365 has basic authentication turned off, so a Microsoft
mailbox wants Graph.

Seznam.cz, as a worked example: IMAP `imap.seznam.cz:993`, SMTP
`smtp.seznam.cz:465`, TLS from the start on both, username and password the
full address and its password - or an application password if two-factor
authentication is on.

Either way the secret or password is encrypted at rest, never shown again, and
never written back into the page. Editing a mailbox leaves it alone unless you
type a new one.

- **Each mailbox may handle one technician group's tickets.** A ticket routed
  to HR is answered from the HR mailbox, so the whole conversation stays on one
  address.
- **One mailbox is the default**, used for anything whose group has no mailbox
  of its own. The first one you add becomes it; **Make default** moves it.
- **Reading is optional.** Clear it and the mailbox only sends, which is a
  perfectly good no-reply address.
- **Read now** proves the setup without waiting for the timer, and says what it
  found.

### Notifications

Seven, pre-written and ready to edit:

| Notification | Goes to |
| --- | --- |
| Thanks for your request | the requester |
| A new ticket for your group | the technician group |
| A ticket was assigned to you | the technician, by name |
| Your request changed status | the requester |
| Your request has been resolved | the requester |
| A note was added to your request | the requester |
| The requester has replied | the technician group |

*When* each is sent is fixed; the **wording is yours**. The body is HTML, so a
notification can look like something your organisation would send, and
placeholders like `{{reference}}` and `{{title}}` are filled in when it is
sent. Values are escaped, so a ticket title containing a tag cannot break the
markup. **Put the wording back** restores the original at any time.

Each notification has its own page: the list says what it is, who it goes to,
which mailbox sends it and whether it is on, and opening one is where the
wording is edited. At the bottom of that page is a **preview** - the message
as it will look, filled in with an example ticket rather than left full of
placeholders. It is drawn in a frame of its own, the way a mail client shows a
message, so what you see is what will arrive. Save to refresh it.

Each can be turned off, and each can be pinned to one mailbox - though leaving
that as it is, so the ticket's own group decides, is almost always what you
want.

### Your logo in a notification

Put `<img src="cid:logo" alt="">` anywhere in a notification body and the logo
from *Settings - Customisation* is carried inside the message. That is the part
that matters: it shows straight away, without the reader clicking "show
images", and it needs no connection back to this server.

It has to be a **PNG or JPEG under 100 KB** - smaller than the 1 MB the logo
may be in the browser, because every notification carries a copy. SVG is
refused because no mail client draws one, and WebP because Outlook does not.
If the logo cannot be sent the page says so as soon as you use the tag, and the
preview shows the same broken image the reader would get rather than quietly
looking fine.

Files attached to a ticket are **not** sent out with notifications, though
files arriving on an email are kept - see below.

### Approvals, cancelling and deleting

A template can ask for a **Send for approval** address. That person is emailed
a link, and until they answer the ticket cannot be resolved or closed. They
need no account here: the link is the whole of their authority, so it is for
them alone and the email says so. Declining asks for a reason.

**Cancelled** is a status beside Closed - closed says the work was done,
cancelled says it will not be. **On-hold** asks for a reason, which is posted
as a comment and included in the email to the requester.

An administrator can **delete** a ticket outright. It asks for a reason, every
other administrator is emailed it, and the ticket, its comments and its files
are gone for good. Cancelling is usually what you want instead.

### Closing and reopening

Under *Settings - Mail - Ticket automation*: close a resolved ticket after a
set number of days, and let a requester reopen one by replying, optionally
only for a while after it closed. Both are off or generous by default - a
service desk that closes tickets out from under people is worse than a long
queue.

### Email in

If a mailbox reads, anything arriving in it becomes a ticket, and a **reply
becomes a comment on the ticket it belongs to**.

Files on the email are kept too. They land on the ticket exactly as if someone
had picked them in the browser, with the same accepted types and the same size
limit, and anything refused is explained in an internal note so a technician is
not left wondering where the screenshot went. A logo from an email signature is
not collected: an inline image under 25 KB is taken for one, and the same file
is never stored twice on one ticket.

Replies are matched three ways, strongest first: the `In-Reply-To` header
against the messages we sent, the `References` chain for clients that drop it,
and the `[TKT-000123]` reference in the subject for clients that strip headers
entirely. Subject text alone is never matched - that is how two people's
problems end up merged into one ticket.

- A reply **from the service desk** becomes a visible comment from that
  technician; a reply from anybody else is the requester adding to their
  request. Either way the other side is notified.
- **Somebody with no account gets a ticket, not an account.** Their address is
  recorded on the ticket so replies reach them, but they cannot sign in: who
  may sign in stays entirely under *Provisioning*.
- The same message arriving twice raises **one** ticket, and a message is only
  marked read once its ticket or comment exists - so a crash mid-poll means it
  is read again rather than lost.
- A message from the mailbox to itself is dropped, so two auto-replies cannot
  loop.

---
## Attachments

Files can be attached **while the ticket is being raised**, and afterwards by
anyone who can see it. Limits are set under *Admin → Settings → Attachments*
(default 10 MB per file, 10 files per ticket).

On the *Raise a ticket* form the files are verified **before** the ticket is
created, so a rejected file sends the form back with the text intact rather
than leaving a half-made ticket behind for the requester to raise a second
time.

Accepted types are fixed in code: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`,
`.pdf`, `.docx`, `.xlsx`, `.pptx`, `.zip`, `.txt`, `.log`, `.csv`.

How uploads are handled:

- The extension must be on the allowlist **and** the file's own leading bytes
  must match that type. HTML or SVG renamed to `.png` is rejected, and so is a
  real image renamed to something the browser would treat as active content.
- Text types have no magic bytes, so they are validated by decoding as UTF-8
  and rejecting embedded control characters.
- Nothing is written to disk until the type is proved.
- Files are stored **outside the document root**, under
  `$UPLOAD_DIR/attachments`, with **random names** never derived from the
  uploaded filename, mode `0600`.
- The uploaded name is sanitised (directory components discarded, header-unsafe
  characters removed, length bounded) and used only for display and the
  download filename.
- Downloads are always served as `application/octet-stream` with
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, so an uploaded file
  can never execute in the application's origin.
- Access is checked against the ticket: another requester's attachment returns
  404, and attachments marked internal are invisible to the requester.
- Uploads, downloads and deletions are all audited, with the SHA-256 of the
  stored bytes.

---

## Ticket templates

A template is a saved starting point for a kind of request that comes in
repeatedly. It carries the **ticket type**, category, priority, opening text,
a default **technician group**, and the questions the service desk would
otherwise have to go back and ask for - and it decides **which fields the
form shows, in what order, and which of them can be changed**.

Administrators manage them under *Settings → Ticket templates*.

### Ticket types

| Type | What it is |
| --- | --- |
| **Incident** | Something is broken. |
| **Service request** | Something is wanted. |
| **Change request** | Something is to be changed. |
| **Task** | A unit of work under one of the other three. |

A template declares which of the first three it raises. Tasks are not raised
on their own - they are attached to a template, below.

### Tasks

A template can carry **tasks**: the work that always goes with that kind of
request. Raising the template raises the ticket *and* its tasks, each as its
own ticket under the parent, each routed to its own technician group.

**Add a task** opens a dialog that asks which template the task is raised
with, the same way a subcategory is asked which category it sits under. A
template carries as many tasks as the work needs, each with its own team and
priority, and they are raised in the order they were added.

A new starter request might raise *Prepare the laptop* for desktop support and
*Create the accounts* for identity - tracked separately, visible together on
the parent.

Tasks are deliberately kept out of the queue; they would otherwise appear
twice, once under their parent and once alongside it. They are reached from
the ticket they belong to, or with the Type filter.

### Default routing

A template can set the technician group a ticket lands with, so routine work
reaches the right team without anyone triaging it first.

### The form builder

A template does not just prefill the form - it **is** the form. Open a
template and there are two panels: the **canvas** on the left, showing the
form as a requester will see it, and the **palette** on the right, holding
everything not on it yet.

Above them is a short strip for the things that are *not* form fields: what
the template is called, what kind of ticket it raises, which team it goes to,
where it sits in the list, and whether it is offered at all. Everything else
belongs to a field, and is set on that field.

**A new template's form is empty.** Nothing is on it until you put it there,
which is the point: you are building the form, not switching parts of a
fixed one off.

- **Drag a field from the palette onto the canvas** to add it, dropping it
  where you want it in the order. Or press **Add** beside it, which puts it on
  the end.
- **Drag a row** to move it, or use the ▲▼ buttons.
- **Hover a row** for its gear and bin. The gear sets how the field behaves;
  the bin takes it off the form.
- Every change saves as you make it. There is no draft to lose, and no Save
  button for the layout.

The palette holds the five built-in fields - title, category, priority,
description, attachments - and any question you have written. **Write a
question** adds a new one to the end of the form.

#### A field left in the palette is not asked for

It is not missing; it is decided. A template with no Category field on its
form files every ticket under the category the template sets, without
bothering the requester about it. Same for priority, and for the description,
which falls back to the template's opening text.

**That value is set on the field itself.** Every row in the builder states
what it falls back to - *Default priority: High*, *Default category:
Hardware* - with a **Change** link beside it; a field waiting in the palette
has a **Set** link. The default title, category, sub category, item, priority
and opening text each live with the field they belong to, and there is no
second copy of them elsewhere on the page.

The one exception is the **title**: a ticket with no title is unreadable in a
queue and there is nothing sensible to invent, so a template with no Title
field is not offered to requesters at all. The builder says so plainly rather
than letting you discover it later.

#### The three modes

| Mode | What a requester sees |
| --- | --- |
| **Optional** | Shown. They may fill it in or leave it. |
| **Mandatory** | Shown. They cannot submit without it. |
| **View only** | Shown as the value this template sets, with no way to change it. |

Not every mode fits every field, and the gear only offers the ones that work.
**Title** is never merely optional - a template either asks for one or fixes
it. **Attachments** cannot be view only, because there is no value to display;
a template can require a file, or not ask for one.

All of this is enforced **on the server**. `readonly` and `disabled` are
hints to the browser, and a browser can be told to post anything, so whatever
arrives for a view-only field - or for a field that is not on the form at all - is discarded and the template's own value used instead.

#### Taking something off

The bin does not destroy anything: the field goes back to the palette with its
settings, and a question keeps its wording, so taking something off to see how
the form reads without it costs nothing to undo. Deleting a question for good
is a separate button, on the chip in the palette and in the gear dialog. A
built-in is never deleted - the most a template can do is leave it off its
own form.

#### Category, Sub category and Item

The three levels of the catalogue are **three separate fields**, so you can put
any of them on a form and make each one mandatory on its own - a template might
insist on a category and a sub category but leave the item optional.

The two deeper lists are grouped under the branch they belong to, so you can
see at a glance which sub category goes with which category. They are not
narrowed as you choose - that would need JavaScript, and the ticket form has
none - so if you pick a pair that does not go together the form says so rather
than filing the ticket somewhere nobody meant.

The ticket is filed against the **deepest level you answered**: choosing an
item implies its sub category and category too.

#### The hint inside the box

Each text box carries its guidance as grey placeholder text rather than a line
underneath, so the form reads as a short list of labels rather than a wall of
advice. **Hint inside the box** in a field's gear rewrites it; leave it blank
for the standard wording. Only fields that are typed into have one - a
dropdown prompts with its first option, and a file picker has nowhere to put
it.

#### Questions

Each question becomes a box on the form, and its answer is folded into the
description under its own heading. A mandatory question blocks submission
until it is answered, naming the ones that are missing. A question left blank
is omitted rather than written out empty.

The result is an ordinary ticket - searchable, editable, and unaffected if the
template is later edited or retired.

#### About the one script

Dragging needs JavaScript, and this is the only place in the application that
has any. Every drag has a button that does the same thing through an ordinary
form post - **Add** beside a palette chip places a field, the ▲▼ buttons move
a row, the bin takes it off - so the page works with the script blocked or
missing. The relaxed policy is `script-src 'self'`, never `'unsafe-inline'`,
so an injected inline script is still refused even here.

#### Templates made before the builder

They keep the form they always had. The upgrade gives every existing template
the old fixed layout - title, category, priority, its questions, description,
attachments - once, so nothing has to be rebuilt by hand. Only templates
created afterwards start empty.

### The default template

Every ticket is raised on a form, and that form is a template - so **there is
always exactly one default**, and the application creates it for you. On a
fresh database you get *Default request*, asking for a title, category,
priority, description and attachments. Rearrange it, rename it, or hand the
role to another template; you cannot end up with none.

Choose it from the template list, where you can see what you are choosing
between: **Make default** on any finished, active template takes it on, and
the one holding it is marked ★ Default.

- **The default cannot be removed or retired.** Make another template the
  default first, and then it can go. The list says so instead of offering a
  button that would fail.
- A template with no Title field on its form cannot take the role, because
  every ticket raised from it would have no title.
- There is no "blank ticket" any more. The default *is* the plain form, so the
  picker only appears once there is more than one template, and the "Using the
  X form" note only when you have picked something other than the default.

---

## Categories

Three levels, managed on one page under *Settings → Ticket templates →
Categories*:

```
Hardware             <- category
  Not working        <- subcategory
    Mouse            <- item
```

**Nothing is created for you.** The classification your organisation uses is
yours to decide, and shipping an invented one would only mean deleting it
first.

All three levels share one page rather than three, because the only thing
that matters about them is how they connect - and building a single branch
across three screens would mean clicking between them.

### Adding something

Four buttons across the top: **New Category**, **New Sub Category**, **New
Item** and **Tree View**. Each opens a popup over the list.

| Dialog | Asks for |
| --- | --- |
| New Category | Name, description, optional technician group |
| New Sub Category | Name, description, **Category**, optional group |
| New Item | Name, description, **Sub Category**, optional group |

A category takes as many subcategories as you need, and a subcategory as many
items - they are rows in one self-referencing table, so that is simply how it
works rather than a limit anyone lifted.

Two conveniences:

- **Save and Add Sub Category** (and, from a subcategory, **Save and Add
  Item**) saves and opens the next dialog with what you just created already
  selected, so a whole branch is built without returning to the list.
- **New Item** lists subcategories by their full path - `Hardware › Not
  working` - rather than asking for the category first. One list covers every
  branch, and there is no JavaScript here to filter a second dropdown from the
  first.

Clicking the gear beside any entry opens the same dialog for editing, where
the name, description, group, order and whether it is offered can be changed,
and where it can be removed if nothing is filed against it.

### Routing work from the catalogue

Any level can name a technician group, and the setting is **inherited
downwards**: an item with no group of its own falls back to its subcategory,
then to its category. So a whole branch is routed with one setting, and an
exception is one override rather than a rewrite.

When a ticket is raised, a template that names a group wins - it was set up
deliberately for that kind of request. Otherwise the group comes from the
category it was filed against.

A few other properties worth knowing:

- **A ticket can be filed at any depth.** Hardware on its own is as valid as
  the full path, so the catalogue is useful from the first entry and can grow
  as you learn what you need.
- **Names are unique among siblings, not globally.** The same name can sit
  under two different categories and mean different things.
- **Filtering on a category includes everything beneath it.** Filtering on
  Hardware finds tickets filed against an item three levels down.
- **Retiring hides a branch; removing is refused while it is in use.** How a
  ticket was classified is a record, not a setting. Retire a node to take it
  out of the pickers and leave the history readable.

---
## Light and dark mode

Every page offers a **Colour mode** control in the masthead, to the right,
with three choices:

| Choice | Behaviour |
| --- | --- |
| **System** (default) | Follows the operating system through `prefers-color-scheme`. |
| **Light** | Light, whatever the system says. |
| **Dark** | Dark, whatever the system says. |

The choice is stored in a cookie, so it survives sign-out and applies on the
sign-in page too - which is where a reader is most likely to notice the
theme is wrong. It is a form submission rather than a link, because it
writes state; the CSRF token applies as it does everywhere else.

No client-side JavaScript is involved. The preference is rendered as a
`data-theme` attribute on `<html>`, and the stylesheet emits the dark
palette twice: once behind the media query, so *System* works, and once
behind `[data-theme='dark']`, so an explicit choice overrides it. The media
query excludes `[data-theme='light']` so that choice is honoured too.

Both palettes are generated from the two colours set under *Customisation*,
with the accent adjusted per theme so text always reaches 4.5:1.

---

## Customisation

*Admin → Settings → Customisation*.

**Name.** The application name appears in the browser tab, the footer, and top
left whenever no logo is uploaded.

**Logo.** Upload an SVG, PNG, JPEG or WebP up to 1 MB. It is shown top left and
on the sign-in card. A wide, transparent image works best; it is placed on a
white plate so its own colours stay exact and legible against the dark theme.
With no logo uploaded, the application name is shown instead - the application
deliberately ships no artwork of its own.

**Favicon.** Upload an SVG, PNG, ICO or GIF. Until you do, a plain square in
your brand colour is served, with no lettering or invented mark.

**Colours.** Two colours drive the whole palette:

| | |
|---|---|
| **Brand colour** | buttons, links, highlights, the bar under the header |
| **Text / surface colour** | body text in the light theme; page and card backgrounds in the dark theme |

Each has a native colour picker and a text box that accepts `#a3182f`,
`a3182f`, `rgb(163, 24, 47)` or `163, 24, 47`. The typed value wins when it is
filled in, so you can work either way. The current value is shown next to the
picker in both hex and RGB.

Everything else is derived. The accent used for text and links is darkened or
lightened **per theme until it reaches a 4.5:1 contrast ratio** against its
background, so a brand colour that would be unreadable as text - a mid-tone on
white, or a dark red on near-black - still produces a legible interface. The
generated values are served as `/branding/theme.css`, a real same-origin
stylesheet, because the Content-Security-Policy forbids inline styles entirely.

Colour input is parsed into numeric components and re-serialised, so a value
like `#fff; } body { display: none }` is rejected outright rather than
sanitised - it can never reach the stylesheet.

---

## Your profile

The account name in the header links to **your profile**: what the application
knows about you, where it came from, and your ticket counts.

- A **directory account** sees its email, UPN, role, whether that role was set
  by hand, its directory groups, and a note that its password is managed by the
  organisation. There is no password form.
- The **local administrator** sees the same details plus a password form, which
  requires the current password. Failed attempts there are audited and counted
  towards the same lockout as the sign-in form.

---

## Settings: UI versus environment

Anything that can be changed while the service runs lives in the database and
is edited in the UI. Anything that changes the service's identity or storage
stays in the environment.

**Editable in *Admin → Settings*** (takes effect immediately):

**Authentication** - tenant/client id · client secret · scopes · extra issuers

**Provisioning** - just-in-time on/off · SCIM on/off · SCIM bearer token ·
whether a SCIM delete disables or removes

**Users** (*Admin → Users*) - the role of every account. This is the only
place a role can be set.

**Customisation** - application name · logo · favicon · brand and text colours

**Attachments** - on/off · maximum size · maximum count per ticket

**Templates** (*Admin → Templates*) - name · summary · default title, text,
category and priority · questions and which are required · order · retired
or offered

**Accounts** (*Admin → Accounts*) - create · reset password · change role ·
disable · remove

**Your profile** - your own password

**Per reader, from the footer** - light / dark / follow the system

**Environment only** (needs a restart):

`NODE_ENV` · `HOST` · `PORT` · `APP_BASE_URL` · `TRUST_PROXY` ·
`DATABASE_PATH` · `DATABASE_BUSY_TIMEOUT_MS` · `UPLOAD_DIR` ·
`SESSION_SECRET` · `LOG_LEVEL` · `LOCAL_SEED_PASSWORD` · `PASSWORD_MIN_LENGTH`

Environment variables for the first group still work - they seed the initial
values. Once a setting is saved in the UI, the stored value wins.

Secrets saved through the UI (the client secret) are
encrypted at rest with **AES-256-GCM**, using a key derived with HKDF from
`SESSION_SECRET`. They are never rendered back to the browser and never written
to the audit log. Rotating `SESSION_SECRET` makes them unreadable, which is
reported clearly so they can be re-entered.

---

## Running in Docker

The repository ships a container stack: the application, and a reverse proxy
that obtains its own TLS certificate. There is no database service - SQLite
is a file in the `data` volume, next to the attachments.

```
   internet ──► proxy (Caddy) ──[edge]──► app (Node) ──► /data volume
```

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build. Runs as uid 1000, read-only root filesystem, all capabilities dropped, `tini` as PID 1 so `SIGTERM` reaches the graceful shutdown. |
| `compose.yaml` | The two services, one network and three named volumes. |
| `deploy/Caddyfile` | Proxy and TLS configuration. |
| `deploy/env.example` | The three values the stack needs. Copy to `.env`. |

```bash
cp deploy/env.example .env      # then fill in HELPDESK_DOMAIN,
chmod 600 .env                  #   ACME_EMAIL and SESSION_SECRET
docker compose up -d --build
docker compose logs app | grep -A6 'local administrator'   # the one-time password
```

All durable state - database, attachments, branding - is the single `data`
volume. Schema migrations run automatically at start-up, each in its own
transaction.

> **One container only.** SQLite is a file, not a server, so a second
> application container cannot share it. That also rules out a volume on a
> network share. Scaling past one instance is the point at which the
> database has to move to a server - see DEPLOYMENT.md §3.3.

**[DEPLOYMENT.md](DEPLOYMENT.md) is the full guide** - the local proof of
concept, the Docker stack, backups and restores, upgrades, what has to change
for Azure Web App and SQL Server, troubleshooting, and a pre-launch checklist.
---

## Production deployment

This section covers running the built output directly. For containers, see
[Running in Docker](#running-in-docker).

```bash
npm ci
npm run build
NODE_ENV=production node dist/server.js
```

Generate a session key:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`SESSION_SECRET` accepts a comma-separated list, newest first: the first key
signs new cookies while the older keys still verify existing ones, so keys can
be rotated without signing everybody out. **Keep the last entry stable**, as
stored secrets are encrypted with a key derived from it.

### Behind a reverse proxy

Set `TRUST_PROXY` to the number of proxy hops in front of the app (usually `1`).
Leave it **empty** when the app is exposed directly - otherwise a client could
spoof its address through `X-Forwarded-For`, which would corrupt the audit trail
and let it evade rate limiting. The proxy must terminate TLS and set
`X-Forwarded-Proto`.

### The configuration loader fails closed

Startup is refused, with a specific message, when `SESSION_SECRET` is missing,
short or a placeholder in production, or when `APP_BASE_URL` is not `https://`
in production or carries a path.

Identity provider credentials are deliberately **not** required at startup: an
unconfigured install is a legitimate state. Instead, the sign-in route refuses
to start a flow that cannot complete, and the settings form refuses to store a
configuration that would lock everybody out.

### Troubleshooting

**Every sign-in fails with 403 "your session has expired or the form was
stale".** Almost always `APP_BASE_URL` is `https://` while `TRUST_PROXY` is
unset. The session cookie is then marked `Secure`, and Express will not send a
`Secure` cookie on a connection it believes is plain HTTP - no cookie, no
session, so the CSRF token can never match. Set `TRUST_PROXY=1` and make the
proxy send `X-Forwarded-Proto: https`. The application detects this and logs an
explicit error on the first affected request.

**Nobody can sign in and no administrator is available.** Sign in with the local
administrator and fix the configuration under *Admin → Settings*.

**A stored secret stopped working after a deployment change.** `SESSION_SECRET`
was rotated, so secrets encrypted with the previous key can no longer be read.
Re-enter them under *Admin → Settings*.

**Sign-in succeeds but the user has the wrong role.** Check the groups claim is
actually being emitted (*Token configuration → groups claim*, **Group ID**),
that the admin/agent group lists hold group **object ids**, and that the
account's role is not `locked` on the *Admin → Users* page. The account's
directory groups are listed under its name there.

**`AADSTS50011` (redirect URI mismatch).** The registered redirect URI must
equal the one shown at the top of *Admin → Settings*, exactly.

**Entra provisioning says "Testing connection failed".** Check the Tenant URL
ends in `/scim/v2`, that the token was pasted whole, and that SCIM is switched
on under *Settings → Provisioning* - the endpoint answers 401 to everything
while it is off, which is what Entra reports.

**A provisioned person signs in but sees only their own tickets.** That is
correct: SCIM creates plain users. Promote them under *Admin → Users*.

### Backups

There are two pieces of durable state and a backup needs **both**: the SQLite
file at `DATABASE_PATH`, and the uploaded files under `UPLOAD_DIR`
(attachments and branding assets). A database copy on its own restores
tickets whose attachments all 404. With the default paths both live under
`data/`, so one archive covers it.

Copying the `.sqlite` file while the service is writing to it produces a
torn backup. Either stop the service first, or use SQLite's own backup,
which is safe against a running writer:

```bash
node -e "new (require('better-sqlite3'))(process.env.DATABASE_PATH, { readonly: true })
  .backup('helpdesk-backup.sqlite').then(() => console.log('done'))"
tar czf uploads.tar.gz -C "$UPLOAD_DIR" .
```

For the Docker stack, including restores, see
[DEPLOYMENT.md](DEPLOYMENT.md#backups).

---

## Security design

### Authentication

- **OIDC**: authorization code flow with **PKCE (S256)**, confidential client.
  The ID token is verified against the tenant JWKS (signature, `iss`, `aud`,
  `exp`/`iat` with 60 s tolerance, `tid`, `nonce`). Symmetric and `none`
  algorithms are rejected outright.
- **SCIM**: a 256-bit bearer token, stored only as a SHA-256 digest and
  compared in constant time. The endpoint allocates no session, is mounted
  outside the browser pipeline, and exposes only the accounts it provisioned
  itself - the directory cannot see or deactivate a local account. Revoking
  the token takes effect on the next request.
- **Local password**: scrypt with per-password salt and stored parameters,
  constant-time comparison, lockout after repeated failures, and identical
  responses for an unknown username and a wrong password.
- **Login CSRF** is blocked by binding each in-flight login to the browser that
  started it, via a short-lived `HttpOnly` cookie whose SHA-256 is stored with
  the flow. Every `state` / `RelayState` value is single-use, enforced by an
  atomic conditional update.
- Sessions are **server-side** (the cookie holds only a signed opaque id), the
  session id is **regenerated on login** to prevent fixation, and there is both
  a rolling idle timeout and an absolute lifetime.
- **No credential-free sign-in route exists.** The test suite mints sessions
  through its own helper rather than through the application.

### Authorisation

- Roles are re-read from the database per request; disabling an account also
  **revokes its live sessions** immediately.
- Row-level access is enforced **in SQL**, not in templates: a requester's
  query is constrained to their own `requester_id`, and internal notes and
  attachments are filtered out in the query itself, so a template change cannot
  leak them.
- Another user's ticket or attachment returns **404, not 403**, so ids are not
  confirmed to people who should not see them.
- Ticket and attachment URLs use random UUIDs, so they cannot be enumerated;
  the sequential `TKT-000123` reference is display-only.

### Web hardening

| Control | Implementation |
|---|---|
| CSP | `default-src 'none'`, `script-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`. One page - the template form builder - relaxes `script-src` to `'self'`, never `'unsafe-inline'` |
| CSRF | Per-session synchroniser token, constant-time compare, plus `Sec-Fetch-Site` and `Origin` checks |
| XSS | Server-rendered EJS with escaping by default; no `innerHTML`, no inline script anywhere - including on the one page that may load a script |
| SQL injection | Parameterised statements only; `LIKE` patterns escaped with an explicit `ESCAPE` |
| File upload | Extension allowlist plus magic-byte verification; random storage names outside the document root; forced download with `nosniff` and a sandbox CSP |
| Uploaded SVG | Screened for script, handlers, external references and entities, and served with `sandbox` in its CSP so script cannot run even if the screen is incomplete |
| Theme injection | Colours are parsed to numeric components and re-serialised into the generated stylesheet; a value carrying CSS is rejected, never escaped |
| Clickjacking | `X-Frame-Options: DENY` plus `frame-ancestors 'none'` |
| Transport | HSTS (2 years, includeSubDomains) when the origin is HTTPS |
| Cookies | `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix in production |
| Open redirect | `returnTo` validated to a single-slash local path; absolute, protocol-relative, backslash and control-character forms rejected |
| Rate limiting | Separate budgets for global traffic, login attempts, SSO callbacks and writes |
| Secrets at rest | AES-256-GCM with an HKDF-derived key; never rendered back or logged |
| Caching | `no-store` on every dynamic response |
| Error handling | Only user-facing messages are rendered; server faults return a correlation id, and stack traces are limited to 5xx outside production |
| Input validation | Zod schemas on every request body and query, with closed enums |
| Data integrity | `STRICT` tables, `CHECK` constraints, foreign keys enforced, multi-row writes in transactions |
| Logging | Cookies, tokens, assertions, codes, passwords and secrets redacted at the logger |

No browser-facing endpoint accepts a cross-site POST. The SAML assertion
consumer used to be the one exception; with SAML removed, every
state-changing request is same-site and subject to both the CSRF token and
the `Sec-Fetch-Site` check. The SCIM endpoint is not in that pipeline at all:
it is a bearer-token API, mounted before sessions and CSRF.
Attachment uploads are exempt from the *global* CSRF middleware only
because it runs before any multipart parser; the route validates the token
itself once the body is parsed, and the `Sec-Fetch-Site` and `Origin` checks
still apply.

### Audit trail

`audit_log` records sign-ins and refusals (with reason), local administrator
attempts and lockouts, authorisation denials, JIT provisioning, role and status
changes, settings changes (never their secret values), ticket creation and
every field change, attachment uploads, downloads and deletions, and sync runs - each with actor, client IP, user agent and a JSON detail. Per-ticket history
is additionally shown on the ticket itself. Browse it under *Admin → Audit*.

---

## Operations

```bash
npm run dev            # development server with reload
npm run build          # compile TypeScript to dist/
npm start              # run the compiled build
npm run migrate        # apply schema migrations and exit
npm test               # unit and HTTP integration tests
npm run typecheck      # type-check src and tests
npm run verify         # typecheck + tests + npm audit
```

Each test file gets its own SQLite file in its own temp directory, removed
when the process exits, so the files are isolated from one another and can
never touch development data. That costs nothing to set up, which is most of
the argument for SQLite here.

Migrations run automatically at start-up, each inside a transaction together
with the row that records it, so a fresh deployment needs no separate step
and a failure leaves neither half applied.

### Health checks

Both answer without allocating a session and are excluded from request
logging:

- `GET /healthz` - liveness. Touches nothing, so a database outage does not
  make the container look dead and trigger a restart loop. This is what the
  image's `HEALTHCHECK` uses.
- `GET /readyz` - readiness. Runs `SELECT 1` and answers `503` if the
  database does not respond, so the proxy stops sending traffic. This is what
  the Caddy health check uses.

### Adding a schema change

Append a new entry to `src/db/migrations.ts` with the next version number.
Never edit a migration that has already shipped.

### Branding internals

Branding is data, not code. Uploaded images live under
`$UPLOAD_DIR/branding/` with random filenames; the metadata sits in the
settings row in the database.

`public/css/app.css` declares every colour as a custom property, and those
values are only fallbacks - `/branding/theme.css` is linked after it and
overrides them from the configured colours. To change the shipped defaults,
edit the `:root` block at the top of `public/css/app.css`; to change a running
installation, use *Settings → Customisation*.

---

## Project layout

```
src/
  config.ts              environment configuration; fails closed
  settings/              runtime settings stored in the database
  app.ts                 middleware stack and router mounts
  server.ts              listener, scheduler, graceful shutdown
  auth/
    oidc.ts              discovery, PKCE, code exchange, ID token validation
    local-accounts.ts    password accounts, including the break-glass admin
    password.ts          scrypt hashing and password rules
    flow-state.ts        single-use login state and browser binding
    provisioning.ts      the just-in-time policy (never roles)
    session-store.ts     server-side sessions, stored in the database
  middleware/            security headers, sessions, CSRF, guards, errors
  routes/                auth, tickets, admin, settings, profile, branding
  services/              users, tickets, templates, catalogue, groups,
                         attachments, branding, scim
  lib/color.ts           colour parsing and WCAG contrast derivation
  db/                    connection, migrations, type conventions, pruning
  lib/                   logging, auditing, formatting, secret encryption
views/                   EJS templates (escaping on by default)
  admin/settings/        one page per settings section
public/
  css/app.css            the stylesheet (no bundled artwork)
  js/form-builder.js     the only script served, for one admin page
tests/                   unit and HTTP integration tests
data/                    the SQLite database and uploaded files (gitignored)
Dockerfile               production image
compose.yaml             app + TLS proxy, one volume for all state
deploy/
  Caddyfile              proxy and TLS configuration
  env.example            the values the compose stack needs
```

---

## Scope and known limitations

Deliberate omissions, so you know what you are getting:

- **No JSON API.** The application is server-rendered only, which is what
  keeps the CSP as tight as it is. An API would need its own token-based
  authentication.
- **Almost no JavaScript, and that is a constraint not an accident.** Exactly
  one page loads one script, for the form builder's drag-and-drop, and that
  page works without it. A feature that genuinely needs scripting is a
  decision to take deliberately, not a detail to slip in.
- **No attachment virus scanning.** Type verification is not malware detection.
  If you need scanning, put an ICAP/AV step in front of the storage directory.
- **One instance only, on local disk.** SQLite is a file, not a server: two
  processes cannot share it, and its locking is unreliable on a network
  filesystem (an SMB/NFS mount, an Azure Files share). This is the limit that
  decides when the database has to move to a server - see
  [DEPLOYMENT.md §3.3](DEPLOYMENT.md#33-moving-to-sql-server), which lists
  exactly what that change touches. The data layer was written to keep it
  contained to `src/db/`.
- **Attachments are on a filesystem, not object storage.** They live under
  `UPLOAD_DIR` beside the database, which is the same constraint again.
- **Runtime settings are cached per process**, refreshed when that process
  writes them. Irrelevant at one instance; it becomes a real issue the moment
  there are several, so it is worth fixing at the same time as the database.
- **No notifications beyond email.** No Azure Communication Services, no
  webhooks, no chat. Mail goes through a mailbox the organisation already
  owns; anything else is a second service to pay for and secure.
- **Sign-out at the identity provider is best-effort**: the local session is
  always destroyed first, so a failure to reach Entra still signs the user
  out here.
- **SCIM covers users, not groups.** Group membership grants nothing in this
  application, so there is nothing to provision a group into.
