# Project context

> **The current handover (22 Oct 2026) is kept in the private
> servideskly-portal repository**, at `../servideskly-portal/docs/handover/`:
> start there. It names hosting details, so it is never committed here.

> **Start with [TODO.md](TODO.md)**: what was done last, what is not yet
> checked, and what is next.
>
> **An agent picking this up?** [AGENTS.md](AGENTS.md) says how the owner
> wants the work done and how to edit safely here.
>
> **Picking this up?** Start with [HANDOFF.md](HANDOFF.md): how to run it, a map of
> where each feature lives, what changed most recently and what is still open.

Read this before changing anything. It records the decisions and the traps - the things that are **not** obvious from the code, and that have already cost
time once.

---

## What this is

A self-contained helpdesk/ticketing web application. Server-rendered EJS,
with **one script on one page** - see below. Every other response is
`script-src 'none'`. Node 24, TypeScript (ESM, `NodeNext`, `strict`),
Express 4, SQLite.

Current state: **a working local proof of concept**, 1,057 tests passing, 0
vulnerabilities.

### The exceptions to "no JavaScript" - an explicit list

Every response is `script-src 'none'` except these, each approved by the
owner by name. Everything else - every requester-facing page, every other
settings page - is unchanged.

| Script | Page | Why | Without it |
| --- | --- | --- | --- |
| `public/js/form-builder.js` | `/admin/settings/templates/:id` | drag-and-drop anywhere on the form builder, and moves saved without a reload (`connect-src 'self'`, `allowOwnRequests()`, this page only; asked for 15 Oct 2026) | ▲▼ buttons do the same, with a reload |
| `public/js/copy.js` | `/admin/settings/customization/images` | copy-to-clipboard buttons | buttons stay hidden; snippets are one-click selectable |
| `public/js/copy.js` | `/admin/settings/advanced/api-keys` | copy the new key, and each code example; approved 12 Oct 2026 | buttons stay hidden; the key selects with one click |
| `public/js/copy.js` | `/boards` | copy a pin's address beside it; asked for 15 Oct 2026 | buttons stay hidden; the address selects with one click |
| `public/js/reply-files.js` | `/tickets/:id` and `/tickets/new` (`allowOwnScripts()` on each GET; any `form[data-file-form]`) | the reply box's chosen files as chips with a cross, choosing again adds rather than replaces, files dropped on the box join them; **the description and the reply are a box that shows pictures** (`textarea[data-paste-images]`, 22 Oct 2026): an editable area stands in for the textarea, which stays in the form hidden and holds what is posted - plain text with `[image: name]` where each pasted picture is (drawn on the ticket by `lib/inline-images.ts`). Pastes are plain text or pictures, formatting is refused, the text is read from text nodes and line breaks only; a pasted picture joins the files, deleting it from the text takes it off the list and undo puts it back, its × takes it out of the text. Pictures are shown as `data:` URLs (img-src allows `'self' data:`); **a picture is resized by its corners**, as in Outlook - the width is an attribute (never a style) and travels in the marker, `[image: name | 480]`, which the ticket page draws as `width="480"` (40-4000); no requests - the real file input holds the list (asked for 21 Oct 2026, "implement both with the script") | an ordinary file picker, which posts the same files, and a plain text box: a pasted picture does nothing |
| `public/js/sidebar.js` | every page with the sidebar shell (served by the page-scripts list in `middleware/select-search.ts` when the page holds `data-sidebar-fold`) | folding the sidebar at once, no reload: toggles `shell--compact` and writes the `helpdesk_fold` cookie itself (not httpOnly - a display preference; the old httpOnly `helpdesk_sidebar` is moved over once); no requests (asked for 22 Oct 2026, "folding the sidebar reloads the page and is not done real time") | the fold button posts to `/sidebar` and the page reloads |
| `public/js/catalogue-grid.js` | `/admin/settings/templates/catalogue` | drag a tile onto another in the service catalogue grid (asked for 15 Oct 2026, "like in ticket template") | the ▲▼ buttons on each tile do the same, and the script hides them only when it runs |
| `public/js/automation-canvas.js` | `/admin/settings/advanced/automation/:id` | drag steps, draw wires; approved 11 Oct 2026 | the step cards do the same with forms |
| `public/js/password-reveal.js` | every page of the Users router (`allowOwnScripts()` on `userAdminRouter`), **`/profile`**, `/login/new-password` and **`/setup`** (asked for 18 Oct 2026) | the eye beside a password box an administrator types into (`partials/password-input.ejs`), and the rules box ticking as a password is typed (`partials/password-rules.ejs`); no requests; both approved 15 Oct 2026 | an ordinary password box, and the rules as a plain list that still says what is required |
| `public/js/live-search.js` | `/admin/settings/groups/:id` and `/admin/settings/groups/users/:id` | "Find people to add" searches as you type: fetches the page and swaps `#people-results` (`connect-src 'self'`, `allowOwnRequests()`); asked for 15 Oct 2026 | the Search button, or Enter |
| `public/js/select-search.js` | any page whose HTML has a dropdown of more than 8 options or a `data-narrows` one (decided on the finished page by `selectSearch()`); never sign-in, approval or framed previews | a search box above long dropdowns; on New ticket the Kind narrows the Form list; approved 12 Oct 2026 | dropdowns work as before, the Kind field stays hidden, forms are grouped by kind |
| an administrator's portal script (`/portal/<id>/script.js`) | custom requester portal pages, signed in only | Settings - Advanced - JavaScript; **off by default**, enabled behind a warning; approved 11 Oct 2026 | portals are HTML and CSS only |

### Portal scripts are the one exception that is not our code

Settings - Advanced settings - JavaScript lets a custom requester portal run
a script the administrator writes. It is the only script here this project
did not write, so the fences are tighter, not looser:

- **Off by default.** Turning it on goes through a `:target` warning dialog
  with a required "I understand the risks" checkbox (checked server-side
  too), and is audited (`settings.portal_scripts.*`). Turning it off stops
  every portal script at once; the code stays in `portal_themes.script`
  (migration 30).
- **A file, never inline.** The JavaScript tab's code is served from
  `/portal/<id>/script.js` (signed in only; an administrator may fetch any,
  anybody else only the portal they are shown). The policy becomes
  `script-src 'self' <origins>`, never `'unsafe-inline'` or `'unsafe-eval'`,
  so injected inline script and `on*=` handlers stay refused.
- **Allowed origins** are bare https origins (`isScriptOrigin()`), at most 20,
  and widen `script-src` and `connect-src` together - and only those.
- **Where it never runs:** the sign-in page (passwords are typed there), the
  approval page, Settings, and the editor's framed preview. `portalRunsScript()`
  plus the guard in `portalPresentation` (`allowPortalScripts()`) are the
  whole of it. The full-screen preview does run it.
- The JavaScript tab only exists while the switch is on (`partsFor()`), and
  the part route 404s otherwise.

Three things keep that from eroding:

- The directive is **`'self'`, never `'unsafe-inline'`**, so an injected
  inline script is still refused *on that page too*. Only a file already
  served from `/assets` can run.
- The page **works without it.** Every card has ▲▼ buttons that post to the
  same endpoint the script posts to, so the feature degrades to the no-JS
  design rather than breaking.
- It is applied by `allowOwnScripts()` on one route. Removing the exception
  means deleting one middleware call and one `<script>` tag.

**Do not add to this list on your own.** If a new feature seems to need a
script, the honest options are to design it the way the dialogs and the
`▲▼` buttons were designed, or to raise the question with the owner - and
only then add a row above. Scripts never use `fetch`: they fill in a form
and submit it, so `connect-src` stays `'none'` everywhere - **except the
template builder**, whose script posts the same form in the background and
then fetches the page and swaps its <main> in (`saveInPlace()`). The server
still decides every move; on any failure the form is submitted normally. A
test asserts `connect-src 'self'` there and `'none'` elsewhere.

### Run it

```bash
npm install && npm run dev       # http://localhost:3000/login
```

Two seeded accounts, both password `1234` (from `LOCAL_SEED_PASSWORD`):

| Email (the sign-in name) | Role |
| --- | --- |
| `admin@local` | Administrator - break-glass, cannot be demoted, disabled or removed |
| `user@local` | Plain user |

There are **no usernames**: a password account signs in with its email
address (migration 22 turned `admin` into `admin@local`).
`local_credentials.username` survives only because migrations add, and it
always holds the email.

### Data survives a restart, and only one thing wipes it

`npm run dev` keeps everything. The database is a file - `data/ticketing.sqlite`,
set by `DATABASE_PATH` - and uploads sit beside it in `data/uploads`. Stopping
the server, rebooting, editing source, a `tsx watch` reload: none of them touch
it. Migrations only ever add.

The **only** way to lose it is to delete those files by hand:

```bash
rm -rf data/ticketing.sqlite* data/uploads
```

(Three files, not one: `-wal` and `-shm` are the write-ahead log and its
shared-memory index. Deleting only `.sqlite` leaves a WAL that SQLite will
replay, which looks like the data coming back from the dead.)

So if a local database appears to reset, somebody ran that command - it does
not happen on its own. Say so rather than going looking for a bug in start-up.

### Verify

```bash
npm run verify        # typecheck (src AND tests) + 1,057 tests + npm audit
```

---

## Decisions that are deliberate - don't "fix" them

### Roles never come from the directory
Nothing in an Entra ID token grants access. Group claims, app roles and email
addresses are all ignored; signing in never changes a role that is already
set; SCIM never sets one. Everyone arrives as `user` and is promoted under
**Settings → Users**.

Why: a tenant administrator cannot then grant themselves access here by
editing a group, and role changes happen and are audited in one place. The
cost - a new colleague needs a human to promote them - is accepted.

`INITIAL_ROLE` in `src/auth/provisioning.ts` is the single point of truth.

### The customer portal names a hosted helpdesk's administrators

The one other place a role comes from (asked for 17 Oct 2026). A hosted
helpdesk has **no break-glass account**: production never creates one, and
one made before is removed the first time the portal sends a list
(`retireBreakGlass`). Development and the tests keep `admin@local`.

- The portal sends the **whole list**, signed: `POST /portal-sync/administrators`,
  `X-Portal-Signature: t=<ms>,v1=<HMAC>`, key derived from SESSION_SECRET
  (`helpdesk-portal-admins-v1`); within five minutes and newer than the last
  list, so a replay is refused. Mounted beside SCIM, outside sessions and CSRF.
  `auth/portal-admins.ts`; the list is `settings().provisioning.portalAdmins`.
- On the list: an account that exists is promoted and told; an address with
  none is **invited** to `/setup?t=` (a signed link, 7 days) to set a
  password; an identity provider's account is promoted at its first sign-in
  (`promoteIfListed` in `establishSession`) and needs no password. Off the
  list: demoted to user.
- **The helpdesk manages its own administrators** (22 Oct 2026, reversing
  18 Oct): an administrator here may promote anybody, and demote, disable
  or remove one the portal listed. `portalManagesAdmins()` now always
  answers false, and the "managed in the customer portal" lock is gone.
- **Only its own addresses**: an administrator promoted under Settings -
  Users is left alone by the portal's list.
- Still never a token: the identity provider says who somebody is; the
  list, kept by the customer in the portal, says what they may do.

### OpenID Connect is the only SSO method
SAML was removed entirely (migration 2 drops its tables). Consequence worth
knowing: **no browser-facing endpoint accepts a cross-site POST any more**, so
`CROSS_SITE_ENDPOINTS` in `src/app.ts` is empty and the binding cookie is
`SameSite=Lax` throughout.

### Three identity providers, one OpenID Connect implementation

Entra ID, Google and Okta (Settings - Integrations) all go through
`src/auth/oidc.ts`: `providerConfig(key)` gives each one's discovery URL,
client and scopes; discovery and keys are cached per provider; the shared
callback `/auth/oidc/callback` knows which provider from
`auth_requests.provider` (migration 29). Provider-specific checks:

- **Entra ID**: the token's `tid` must be our tenant.
- **Google**: **`hd` (Workspace domain) must be in the allowed list and the
  email verified** (`checkGoogleAccount`). A Google page cannot be saved
  without a domain - otherwise anyone with a Google account could sign in.
- **Okta**: one private org; the issuer check suffices.

Secrets are sealed like the Entra one and never echoed. `anySsoConfigured`
(not `ssoConfigured`, which is Entra only) decides whether single sign-on
exists. Disabling local sign-in requires an active administrator **whose
issuer belongs to a configured provider** - an Entra admin is no way in when
only Google is set up. The session records `idpProvider` so sign-out ends
the right provider's session (Google publishes no end-session endpoint).
Just-in-time account creation (Entra - Provisioning) applies to every
provider.

### SQLite or PostgreSQL - one SQL, two drivers

`DATABASE_URL` set (postgres://...) runs on PostgreSQL; otherwise SQLite at
`DATABASE_PATH`, as always. Azure customers get PostgreSQL (a database each
on the shared server, its URL a Key Vault reference); local development, the
tests and the Hetzner plan keep SQLite. CI runs the whole suite on both.

- **The SQL above `src/db/index.ts` stays in the SQLite dialect**, written
  once. `toPostgres()` turns `?` into `$1..` and `LIKE` into `ILIKE`
  (SQLite's LIKE ignores case), outside literals, quoted identifiers and
  comments. `sqlNow` and `sqlJsonText()` are the only dialect-aware
  expressions; use them rather than writing `strftime` or `json_extract`.
- **Things SQLite allows and PostgreSQL refuses** - all found once already:
  comparing a 0/1 column with `true`/`false` (write `= 0`/`= 1`);
  `SELECT DISTINCT ... ORDER BY` an expression not selected; `max(x), y ...
  GROUP BY` taking y from the max row (use a correlated subquery).
- **Transactions keep SQLite's one-writer guarantee**: an advisory lock at
  BEGIN, and every query made while one is open - through its client or the
  plain helpers (AsyncLocalStorage) - runs on its connection. A nested
  transaction joins the outer one.
- **Schema**: `src/db/pg-schema.ts` is GENERATED by
  `npx tsx scripts/pg-schema.ts` from SQLite's schema after every migration
  (INTEGER -> BIGINT, the "now" default, the JSON index, tables in foreign-key
  order, plus the rows migrations insert). A new PostgreSQL database is
  created from it and records migrations up to `PG_BASELINE_VERSION` (63).
  **A migration after that needs a `pg` variant** (`Migration.pg`);
  `tests/pg-schema.test.ts` fails when one is missing or the schemas drift.
- Integers come back as numbers (pg type parsers for int8/numeric).
- Tests on PostgreSQL: `TEST_PG_ADMIN_URL` gives each test file a database
  of its own (`tests/support/env.ts`, `bootstrap.ts`). The pool has
  `allowExitOnIdle`, or every test file would wait 30 s to exit.

### The first administrator of a hosted helpdesk

`/setup?t=<token>` (`routes/admin-setup.ts`, `auth/setup-token.ts`): the
customer portal's "Set up your administrator account" button signs a token -
the order owner's email and a 24-hour expiry, HMAC with a key derived from
this helpdesk's SESSION_SECRET (`helpdesk-admin-setup-v1`), which only the
helpdesk and the portal's provisioner can read from Key Vault - and
redirects the browser here. The person chooses their password; a local
administrator with that email is created; the seed marker `admin_setup`
then refuses every later link, valid or not.

**The marker is claimed before the account is created** (`INSERT ... ON
CONFLICT DO NOTHING`), and removed again if creating fails. A double-click
sends the form twice, and the browser drops the first request but the
server still runs it - so without the claim the second hit
`users_email_uq` and showed a 500 to somebody whose account had just been
made (seen on the first hosted helpdesk). Whoever loses the claim, or posts
a valid link after setup, is sent to /login with "Your administrator account
is ready".

**On Azure, attachments are files, not rows**: the portal sets
`UPLOAD_DIR=/home/data/uploads` - App Service's persistent `/home`, outside
`wwwroot` so a clean deploy keeps it, deleted with the web app. PostgreSQL
holds only each attachment's row. Blob Storage is the intended home (HANDOFF
section 6).

### SQLite, and what that forbids
One process, local disk. SQLite is a file, not a server: two containers cannot
share it, and its locking is unreliable on a network filesystem (SMB, NFS,
**Azure Files**). See `DEPLOYMENT.md` §3 - deploying as-is to an Azure Web App
will lose data, and §3.3 lists exactly what moving to SQL Server touches.

### A SCIM delete disables rather than deletes
Tickets reference their requester with `ON DELETE RESTRICT`. A real delete
would either fail or take the ticket history with it. Even with
`disableOnDelete` off, an account that has tickets is disabled instead.

### The category catalogue is never seeded
Categories, subcategories and items are one self-referencing table
(`ticket_categories`) and ship **empty**. The classification an organisation
uses is theirs; inventing one would only mean deleting it first. A ticket can
be filed at any depth, so the top level works before the tree is deep.

The old fixed `category` enum column is vestigial - still written with its
default, no longer surfaced anywhere. Drop it when convenient.

Each level may name a technician group (`ticket_categories.group_id`,
migration 5), and `routingGroupFor()` inherits it **downwards**: an item with
no group falls back to its subcategory, then to its category. On the raise-a-
ticket path a template's group wins; otherwise the catalogue decides. Without
that fallback in `routes/tickets.ts` the field would be decorative.

### Technician groups are ordered by name, not by hand
Groups used to carry a `sort_order`, which meant inventing a number for every
group before it could be created - a decision with no right answer for a list
that is read by name. `listGroups`/`listActiveGroups` now order by
`lower(name)`.

The column still exists (migrations are forward-only) and is written with its
default; nothing reads it, and `GroupRow` no longer declares it. Same status as
the vestigial `category` enum. Categories and templates **keep** their order - there the sequence is a real editorial choice about what a requester sees
first.


### The member picker is two tables, and paging it is load bearing

Members and the people you can add are **separate tables**, each paged at ten,
on separate query parameters (`mpage`/`msize` and `page`/`size`) so searching
for somebody to add does not move the list of who is already in. They were one
list of ticked checkboxes, which answers "who is in this group?" only by
reading every row - fine for four people, useless for four hundred.

**The save changes membership only for the ids it was sent.** Every row posts
the one id it acts on, and `setMembersWithin` adds or removes exactly those.
The old `setMembers` replaced the whole list, which was right while the form
always carried everybody - and the moment the form carried one page of them it
would have emptied the group of everyone else, silently.

Searching and paging happen in **SQL** (`listUsers`, `listAssignableStaffPage`),
not by filtering a list of everybody in memory. "Show all" is still capped, at
`ALL_CAP`.

### Creating things happens in a dialog behind a button
The catalogue (New Category / New Sub Category / New Item / Tree View),
technician groups (New group) and users (New account) all add through a popup,
not through a form sitting below the list. **Follow this for anything new** - a long create form under a table was the complaint that produced the pattern.

There is no JavaScript to open them. They are `display: none` until the
fragment in the address bar matches (`.dialog:target` in `app.css`); a link to
`#top` closes one (`<span id="top">` is the first thing in `<body>`).

**Close to `#top`, never `#`.** A dialog the server reopened
(`.dialog--open`) has no fragment to lose, so a link to `#` changed nothing
and Cancel and × did nothing after a refused save - reported. The rule
`:root:has(:target) .dialog--open:not(:target)` hides a reopened dialog as
soon as anything else is the target, which `#top` or `#row-<id>` is.

Two consequences:

- **After a POST there is no fragment**, so a validation error would render
  behind a closed dialog. The router therefore sends `openDialog` and the view
  adds `.dialog--open`, which is the same rule applied server-side. Every 400
  branch must set it - and every GET that renders the page must pass
  `openDialog: null`, or the template throws on an undefined local.
- **A dependent pair of dropdowns cannot be filtered** without a script, so
  New Item asks for one subcategory listed by its full path
  (`Hardware › Not working`) rather than Category and Sub Category separately.
  One list covers every branch.

"Save and Add Sub Category" redirects to `?add=<level>&parent=<id>`, which is
why the GET handler honours those two query parameters.

### There is one form on the template page, not two
The title, category, priority and opening text used to be **settings** at the
top of the page *and* **fields** in the builder below it, with nothing to say
they were the same thing. That was reported as confusing, and it was.

Now:

- The strip at the top carries only what is not a form field - name, summary,
  what kind of ticket it raises, which team it goes to, sort order, whether it
  is offered. `templateBody` is the zod schema for exactly that list.
- **The value a field falls back to is set in that field's gear.**
  `FIELD_DEFAULTS` says which fields have one and which control to show;
  `setFieldDefault()` writes it, validating the priority and the category id
  rather than trusting the form.
- `keepDefaults()` is why the settings form cannot clobber them: it supplies
  the stored values on an update and blanks on a create, so a stale page
  cannot undo what the gear just set. There is a test that posts `title` and
  `priority` to the settings form and asserts both were ignored.

The value still lives in its own column (`title`, `body`, `priority`,
`category_id`), not in the fields JSON, because it is what the raised ticket
gets when the field is **off** the form - so it has to exist whether or not
the form mentions it.

A palette chip has a **Set** link too, for the same reason: a field that is
not on the form still has a value worth setting.

**Do not hide these behind hover.** The row tools were revealed on hover,
copying the reference product, and the result was that nothing on the page
suggested a template's category or priority could be set at all - reported as
"I cannot set the category, priority, etc myself". Each row now states its own
fallback (`.widget__default`) with a Change link, and the tools stay visible.
A control needed on every row is not a decoration.

Two things that follow:

- The row shows **its own level**, not the stored path.
  `categoryTrail()` spreads one `category_id` back across Category, Sub
  category and Item, because all three read the same column and printing the
  full path on each made them look identical.
- Each catalogue gear lists **only its own depth**. It offered the whole
  flattened tree before, so choosing a category for the Item field produced a
  refusal from `setFieldDefault` instead of simply not being offered.

### Sections, and two columns

A template's form is laid out in **sections**, each a card of fields in two
columns (in the builder and on /tickets/new). The screenshot that asked for
it was a ServiceDesk Plus form; "not just a single column" was the point.

- **A section is an entry in the same field list**: `kind: 'section'`, key
  `s:<id>`, its title in `label`, always placed. Every field after it
  belongs to it until the next one. That is why ordering, drag and drop and
  the ▲▼ arrows needed no second model: they still move keys in one list.
- **`templateLayout()` never returns a section.** Everything that reads a
  ticket's fields (validation, `modeOf()`, `isUsable()`) is unchanged;
  `formSections()` is the only thing that groups, for drawing. Fields before
  the first section are an untitled group. An empty section is kept in the
  builder (`keepEmpty`) as a drop target and left off the ticket form.
- **Width** is per field: `half` (default) or `full` - Description and
  Attachments default to full (`defaultWidth()`). Set in the gear.
- **Moving a section moves its fields** (`moveField` swaps whole blocks;
  form-builder.js does the same on drag). A section never moves above the
  untitled group, or it would swallow it.
- **Removing a section deletes only the heading**; its fields join the
  section above. There is nowhere to park a section.
- **Per-section options** (the section's gear): labels **beside** the
  controls (wide screens only) and **folding** - a `<details>`, no script,
  open or folded to start. **A section with a mandatory field never folds**
  (`formSections` drops the option): a required control a requester folded
  away is a form that will not submit for a reason they cannot see.
- **Shown only for some answers** (`showWhen` on the section, set in its
  gear): any ticked answer of a choice / several-choices field, or Priority,
  from another section. No script: `/tickets/form/<template>/sections.css`
  (`sectionsCss`) uses `:has()` inside `@supports`, so a browser without
  `:has()` simply shows every section. **The server decides**
  (`hiddenFieldKeys`): a hidden section's fields count as off the form -
  their answers dropped, their mandatory ones not asked - and nothing in a
  conditional section carries `required` in the browser, because a hidden
  required control blocks the whole form.
- The ticket form's per-field markup is `views/tickets/_field.ejs`; the
  builder's row is `views/admin/settings/_builder-widget.ejs`.

### Custom fields have a type

"Add a custom field" (formerly "Write a question"): **single line, several
lines, choice, several choices, date, number** (`TemplateField.fieldType`;
absent means single line, so every question from before still is one).
A choice carries `options` (one per line, at least two, at most 30).

- **An answer is checked against its type** (`answerProblems`): a choice
  must be one of its options - a browser can post anything - a date a
  date, a number a number. Refused beside the form like a missing answer.
- Several choices post as several values and are stored joined with ", ".
- Answers still go into the description as "Label:\nanswer"; nothing new is
  stored per ticket.

### A template's form starts empty and is built by hand
The canvas is **not** a list of every field with some switched off. A new
template has `fields: []` - no form at all - and each field is put on it
deliberately. `placed` on `TemplateField` is the whole model:

| | On the form | In the palette |
| --- | --- | --- |
| Built-in | entry with `placed: true` | absent, or `placed: false` |
| Question | entry with `placed: true` | `placed: false`, wording kept |

`templateLayout()` returns only what is placed. `availableFields()` returns
the palette. **There is no `hidden` mode** - a field simply not on the form
says the same thing more plainly, so the modes are optional, mandatory and
view only.

Five things that are easy to get wrong:

0. **A field on the form must render even when it has nothing to offer.**
   Category with an empty catalogue used to render nothing at all, so a field
   an administrator had placed silently vanished - reported as a bug. It now
   renders disabled. The line under it explaining why ("Nothing has been set
   up at this level yet") was removed on 21 Oct 2026 - "not needed at all";
   the disabled box says enough to a requester. The same trap applies to any
   field whose options come from elsewhere.
1. **A field the form does not offer must not be settable by posting it.**
   This is the security-relevant one. `readonly` and `disabled` are display
   hints and a browser can post anything, so `routes/tickets.ts` computes
   `modeOf()` - which returns `'absent'` for an unplaced field - and discards
   whatever arrived for anything `absent` or `view_only`. There are tests that
   post a forged title, priority and category. **If you add a built-in, add it
   there too.**
2. **The settings form must not write `fields`.** The builder saves each
   change on its own, so if the settings form carried the field list it could
   silently undo a layout change made after the page was drawn. That is what
   `keepFields()` is for.
3. **A reorder must carry the parked fields along.** `reorderFields()` appends
   the unplaced ones after the sorted list; dropping them would quietly lose
   the wording of a question somebody set aside.
4. **A template with no title field is not offered.** `isUsable()` checks for
   it, `listActiveTemplates()` and `defaultTemplate()` filter on it, and the
   builder says so in a warning card. Being half-built is a normal state, so
   this is checked at the point of use rather than refused on save.
5. **The bin does not delete.** It unplaces, back to the palette.
   `deleteQuestion()` is the destructive one and refuses a built-in outright,
   because a built-in belongs to the ticket rather than the template.

### The catalogue is three fields, and the pairing is checked server-side
Category, Sub category and Item are **separate built-in fields** - `categoryId`, `subcategoryId`, `itemId` - so each can be placed and made
mandatory on its own. One flattened picker listing `Hardware › Not working ›
Mouse` was what this replaced.

Nothing narrows a list as you choose, because that needs a script and none is
served on the ticket form. Instead:

- Each level offers **all** of its nodes, with the two deeper ones grouped by
  `<optgroup>` naming the branch. That is what keeps them readable: "sam"
  alone means nothing, "sam" under "Hardware" is obvious.
- The **pairing is checked on submit** - a sub category must sit under the
  chosen category, an item under the chosen sub category - and a mismatch is
  refused in words ("X is not under Y") rather than filed somewhere nobody
  meant.
- The ticket is filed against the **deepest level answered**, which implies
  its ancestors, so one `category_id` column still holds the whole branch.
  `levelValues()` spreads that trail back across the three pickers when the
  form is drawn.
- All three set the same `category_id` when used as a template default, and
  `setFieldDefault` refuses a node of the wrong depth.

**A level left off the form is not settable by posting it** - the same rule as
every other field, and there is a test that posts an `itemId` for a form that
does not offer Item.

### Two traps this uncovered
1. **A template may leave Description off its form**, and then the description
   is empty - which the old `createBody` schema refused with "Describe the
   problem in a little more detail", pointing at a box the requester could not
   see. The ten-character minimum now applies **only when the form asks**.
2. **`<%= %>` escapes, so it cannot build an attribute.**
   `<label<%= locked ? '' : ' for="priority"' %>>` rendered as
   `for=&#34;priority&#34;`, quietly joining every label to nothing. Write the
   attribute literally, or restructure the branch - never interpolate one.

### Help goes inside the box, and the template can rewrite it
Every input used to carry a line of help underneath. That is now the
**placeholder** - the same words, where the reader is already looking, gone as
soon as they type.

- `TemplateField.placeholder` holds the template's own text; empty means "use
  the standard one", which `LayoutField.ghost` resolves from
  `BuiltinSpec.placeholder`. Blanking it in the gear therefore restores the
  default rather than leaving an empty box.
- Only fields that are **typed into** have one. `acceptsPlaceholder()` is the
  single test, and `LayoutField.typed` carries it to the views: a select
  prompts with its first option, and a file input has nowhere to put it.
- Two hints survive on the ticket form, deliberately: the attachment limits
  (facts a file picker cannot show) and **one** credentials warning above the
  submit button. That warning used to appear under both the description and
  the attachments, which is how a warning stops being read.

The description's label is always "Description". It briefly read "Anything
else" when a template was in use - from when a template meant "questions
first, then the remainder" - but every form is a template now, so it said that
on the plain form too.

### Tasks are added through a dialog that picks their parent
`POST /:id/tasks` takes a `parentId` from the dialog rather than assuming the
page it was opened from, the same shape as a subcategory choosing its
category. A template carries as many tasks as the work needs; a task cannot
carry tasks of its own, and that is refused rather than nested.

Field keys are `title|category|priority|description|attachments` and
`q:<uuid>`. A question carried over from the old `{label, required}` shape
keeps the key `q:legacy<n>` **and the input name `field_<n>`**, so a form
already open in a browser still submits.

**Migration 7 is why old templates still work.** Before the builder the form
was fixed, and a template stored only its questions - so an untouched row
would have come out of this change with no form at all. Migration 7 gives
every row that existed at that moment the layout it always had (title,
category, priority, questions, description, attachments) in one SQL pass. Rows
created afterwards start empty. It skips entries that already name a built-in
and entries with no prompt, so running it against a part-migrated row does not
duplicate anything.

### There is always exactly one default template, and it cannot be removed
Raising a ticket always goes through a form, and that form is a template - so
one has to exist before the first requester arrives. **`ensureDefaultTemplate()`
runs at start-up** (`server.ts`, step 5) and only ever adds: if a default is
already set it does nothing, so a restart never overwrites a form somebody has
arranged. With nothing to adopt it creates *Default request* with the standard
five fields placed.

What that invariant then buys, and costs:

- There is **no "clear the default"**. The flag moves to another template;
  `setDefaultTemplate` takes a non-null id and refuses a retired, unfinished
  or task template.
- `deleteTemplate` and `updateTemplate` **refuse the default** - `protectedReason()` is the single source of that message. Handing the flag
  on is the way out, which is a step an administrator takes on purpose rather
  than a side effect of a delete.
- The database still enforces singularity with a partial unique index
  (`WHERE is_default = 1`), and `setDefaultTemplate` clears and sets in one
  transaction - in the other order the index rejects the write.
- **The default is chosen on the list page**, not inside a template: it is a
  choice *between* templates, so `POST /:id/default` redirects to the list.

Consequences on `/tickets/new`: there is no blank ticket any more, so the
picker only appears when more than one template exists, and the "Using the X
form" banner only when the chosen one is **not** the default - on the form
everybody lands on it would describe a choice they did not make.

### Templates are ordered by name; their tasks keep a sequence
Templates have no sort order - the column is vestigial, like the `category`
enum, and `ORDER BY lower(name)` replaces it.

A template's **tasks do** keep `sort_order`, because sequence genuinely
matters there, but nobody types it: `addTaskTemplate` numbers each new task
ten after the last. `created_at` alone was not enough - two tasks added in
the same millisecond came back in whichever order their names sorted in, which
broke a test and would have reordered somebody's checklist.



**Cancelled** was added beside it (migration 17). Closed says the work was
done; cancelled says it will not be, which reports differently and reads
differently. SQLite cannot alter a CHECK constraint, so the column was
rebuilt - and **the index on it has to be dropped first**: RENAME COLUMN
rewrites every index that mentions the column, so the rename points the index
at `status_old` and dropping that column then fails with "no such column".

### A reference is a number with a prefix, and only the number identifies it

`INC-000123`. The prefix is set per ticket type under **Settings - Ticket
templates - Other settings**; the number is the `seq` column, allocated once.

Three consequences, each of which is a way this goes wrong if forgotten:

1. **The prefix is stored on the ticket** (`ref_prefix`, migration 15), not
   worked out from the type when a page is drawn. A reference already in
   somebody's inbox must keep naming the same ticket, so changing a prefix
   applies to tickets raised afterwards and never rewrites one that exists.
2. **Each kind counts on its own** (`ref_seq`, migration 16). INC-000001 and
   SR-000001 are different tickets, so the subject matcher needs the prefix
   **and** the number - matching the number alone would hand a reply to
   whichever ticket was found first. A reference from before the counters were
   split still matches, by falling back to the global `seq`.
3. **A change task is decided at creation.** A task is a change task when the
   ticket it hangs off is a change request - that is a fact about the moment
   it was raised, and there is no other way to make one. `prefixFor()` is the
   single place that rule lives.
4. **The subject matcher accepts any prefix**, `[A-Za-z]{1,8}-\d{6,}`, not the
   configured ones. The number is the identity, so a reply quoting a reference
   from before a prefix changed - or from before they were configurable at all
   - still threads. A prefix is validated to letters and digits precisely so
   it cannot contain something that would break that pattern.

### "Pending" is called On-hold, and needs a reason; Cancelled exists

The label is On-hold; the stored value is still `pending`, because it is in
every row and every query and a label is not worth a migration that rewrites
both. Putting a ticket on hold **requires a reason**, which is posted as an
ordinary visible comment and carried into the notification as
`{{statusNote}}`. On hold with nothing said is the state a ticket is
forgotten in: a week later nobody knows what it is waiting for.

Only when the status is *changing* to on hold - editing the priority of a
ticket that is already on hold is not a new decision to explain.


### Approval: signed in, as the person it was sent to

A template can carry a **Send for approval** field: an email address that has
to say yes before the ticket can be resolved or closed.

**This reverses an earlier decision.** The page used to be reachable without
an account, the link being the whole authority - so a forwarded email could
approve a purchase. It was asked for directly that approval require
authentication. Now:

- **Sign-in is required** (`requireAuth()` on the router), and the signed-in
  email must equal `approval_email`, case-insensitively. Anybody else gets a
  403 page naming who the request is waiting for. The POST checks the same,
  so this is the rule, not just the page.
- The approver still needs nothing set up in advance **if JIT provisioning is
  on**: a line manager signing in through Entra ID arrives as a user. With
  JIT off, or without Entra, they need an account first - that is the cost.
- **The token still matters**: it says which ticket, so being the approver
  of one request does not open another's.
- The audit entry now carries the approver's user id.
- **The page shows one ticket and offers one decision.** No queue, no search.
  A leaked link exposes the request it was sent about and stops there.
- **It can be used once.** `recordApproval` only moves a ticket that is still
  `pending`, so a second press, a forwarded link or a mail client prefetching
  the URL cannot overwrite an answer.
- **The decision is a POST**, never a link that decides on sight - a client
  that follows links to build a preview would approve things by itself.
- **Declining requires a reason**; approving does not. A refusal the service
  desk cannot explain to the requester is worse than no answer.

`approvalBlocks()` is the gate, and it deliberately blocks only **resolved**
and **closed**. Cancelled is not blocked: withdrawing a request nobody
approved is exactly what should stay possible, and needing approval to cancel
would be a trap.

### Deleting a ticket

Administrator only, a reason required, **the manager of its group emailed** (with no
group, no manager, or the manager deleting it: every other administrator -
`manager_or_admins`; asked for 15 Oct 2026), and
the audit entry written **before** the row goes - afterwards there is nothing
left to describe. A real delete, not a flag: a ticket kept behind a "deleted"
column is still a ticket a query that forgets the column will show, and the
reason for deleting one is usually that its contents should not be here.

Comments, attachment rows, mail threads and any tasks beneath it go through
ON DELETE CASCADE. The attachment **files** are removed by hand, after the
row, because the filesystem has no foreign keys - so a failure leaves an
unreferenced file rather than a ticket pointing at a file that is gone.

Cancelling is what somebody usually wants instead, and the page says so.

### Closing and reopening, on a timer and on a reply

- **Auto-close** is a sweep (`autoCloseResolved`, hourly), not an alarm per
  ticket: one query answers "what is overdue" for all of them, and a restart
  cannot lose a timer that only existed in memory. **Resolved only** - that is
  the one state where silence is consent.
- **A reply reopens**, when the setting allows and the reply is from outside
  the service desk: a technician answering a closed ticket is tidying up, not
  reporting that it is still broken. The window exists because a reply three
  months later is usually a new problem quoting an old thread.

### Mandatory tasks, and closing a ticket by its tasks

A template's task can be **mandatory**, and a template has two rules
(migration 37), all three **copied onto the ticket when it is raised** - the
same reasoning as the reference prefix: a ticket already open keeps the
rules it was raised under.

- **Close automatically when every mandatory task is done**
  (`closeParentIfDone` in `services/tickets.ts`, run by `updateTicket` when
  a task reaches a done status). Never with no mandatory task at all - that
  would close the ticket on the first task done - and never past the
  ticket's own gates (an approval awaited, the rule below). It posts a
  public "Closed automatically" comment.
- **Resolve or close only when every task is done** (`tasksBlock`): checked
  by the page first, so the refusal lands beside the triage form, and again
  in `updateTicket`, so an automation or any other caller is refused too.
- **Done** is resolved, closed or **cancelled** (`DONE_STATUSES`): a task
  that will not be done must not hold the ticket for ever.

### Cancellation and resolution notes

Settings - Ticket templates - Other settings - **Status notes**
(`/other/status-notes`; `/other/cancellation` 308-redirects), two switches,
both off by default: `settings().tickets.requireCancelNote` and
`requireResolveNote`. On, changing a ticket **to** cancelled / resolved on
the triage form needs a note (refused beside the form, `where: 'update'`);
a note given is posted either way as a visible `Cancelled: <note>` /
`Resolved: <note>` comment and reaches the notification as
`{{statusNote}}` ("Reason: ..." / "Resolution: ..."; the resolved
notification's default body carries it - an existing stored body needs it
added by hand). Closing is not resolving and needs no note. Each box shows
only while its status is selected (`:has()`, like the on-hold reason).

**An automation is not bound by the setting.** Its Set status step has its
own "Add a note" switch (`addNote`, `note` with variables, `noteInternal`),
so a rule can cancel silently even while people must explain themselves.

### The requester's card

On a ticket, staff can click the requester's name (`.person-link`) to open a
`:target` popup (`#requester-card`, closes to `#requester`): email and
phone as links, department, job title, office, open and total counts, their
five latest other tickets, **All their tickets** (`/tickets?requester=<id>`,
a staff-only queue filter - for a requester the SQL already restricts to
their own) and, for an administrator, **Open in Users**. Mail from a stranger
shows the stranger's address and nothing else: the hidden account carries
every stranger's tickets. `requesterCardFor()` in routes/tickets.ts.

### Search in dropdowns, and Kind then Form on New ticket

`src/middleware/select-search.ts` runs on every GET and looks at the HTML a
page is about to send: only when it holds a long dropdown (> `SEARCH_FROM`
options, not `multiple`) or a `data-narrows` one does it switch the policy
to `script-src 'self'` and append the script before `</body>`. Every other
page keeps `'none'`. `res.render` calls `send` before Express sets the
content type, so an unset type with a `<!doctype html>` body counts.

The script **takes options out and puts them back** rather than hiding
them (iOS Safari ignores `hidden` on an option), and always keeps the chosen
one, so a search never changes an answer. `data-no-search` opts a select
out; `data-needs-script` is revealed by it; `data-autosubmit` submits on
change. New ticket's picker is a GET form: Kind (`data-narrows`, hidden
without the script) and Form (`optgroup` per kind, `?template=`).


Two attributes beside `data-no-search`, both added 15 Oct 2026:

- **`data-search`** asks for the panel whatever the length. New ticket's
  Kind and Form carry it: the card exists to choose from them, and a service
  desk with many forms is where the panel earns its place. The middleware
  looks for it too, or a page with only short lists would never be served
  the script.
- **`data-has-script`** is the mirror of `data-needs-script`: the element is
  **hidden** when the script runs. "Open this form" is the way to submit the
  picker without one; with one, choosing a form already opens it.

The picker has **no empty prompt** ("Choose a form"), against the house rule
for selects, because a form is always chosen - the default if nothing else -
so the prompt could never be the answer and only added a dead row to the
panel. Removing it exposed a bug worth remembering: when narrowing cleared a
choice of the wrong kind, the select had nothing to fall back to and
rendered blank. It now selects the first option still showing.
### Group lists are searched and paged in SQL

Technician groups and user groups: a search bar (`?q=`, name or
description, every word must match, `%` and `_` are text) and pages of 50
(`searchGroups`, `searchUserGroups`; views `_list-search.ejs` and
`_list-pages.ejs`, reusable for any other list). A list of thousands is
never read whole. In forms, a list of more than 8 tick boxes sharing a name
(the user groups a template is offered to, say) gets a search box from
select-search.js - it hides rows and never hides a ticked one.


### The password rules tick as you type

The profile page's Change your password card: half-width boxes, and the
policy as a list beside them that ticks each rule as the password meets it
(asked for 15 Oct 2026, "like apple does").

- `passwordRules()` in `auth/password.ts` returns the rules **in force**, so
  a service desk asking only for length shows one line. The partial is
  `views/partials/password-rules.ejs`.
- **The server draws them**, so the box says what is required with the
  script blocked, and `passwordProblems()` is still the only thing that
  decides. The ticks are a mirror, never the check.
- The patterns live in `public/js/password-reveal.js` (`RULES`) and must
  stay in step with `passwordProblems()`. A test walks `passwordRules()` and
  asserts the script names every one, so turning a rule on cannot leave a
  line that never ticks.
- The box sits in the **right column of a two-column grid** whose left
  column holds all three boxes (`.pw-grid`). In a row of its own it made
  that row as tall as itself and left a gap the same height under New
  password - reported twice while getting it right. `grid-row: 2 / span 2`,
  not `2 / -1`: with no explicit rows, `-1` resolves to the start of the
  grid and the box lands beside Current password.
### Every password account changes its own password

The profile page used to offer it to break-glass only. Now any local
account does (`isLocalAccount`, `setLocalPassword`, current password
required, audited `local_account.password.*` / `local_admin.password.*`);
one that signs in with an emailed code is told it has no password.

### On behalf of

A built-in field (`onbehalf`, posted as `onBehalfOf`, migration 40): the
email address of the colleague the ticket is for. Filled in, that active
account becomes the **requester** and the person who filled in the form is
`tickets.raised_by` - who may still read it (`canViewTicket`) and sees it in
their list. Like every field, not settable unless the form offers it. The
requester gets **"A ticket was raised for you"** (`ticket.created.on_behalf`,
placeholder `{{raisedByName}}`) instead of the usual thanks. An unknown or
disabled address is refused beside the field; one's own address is an
ordinary ticket.

**Only within a team** (21 Oct 2026, `services/teams.ts`, migration 66
`users.manager_id`): a requester may raise for their manager, their reports
and colleagues under the same manager - nobody else; service desk staff for
anybody. The manager is set on the person's page under Settings - Users (an
address; themselves or a loop refused) or by SCIM (the enterprise
extension's `manager`, our own id; one not provisioned yet is skipped and
comes again next cycle). Nobody has a manager until one is set, so until
then a requester cannot raise for anybody.

### Tasks live under a parent, not in the queue
`listTickets` excludes `parent_id IS NOT NULL` unless asked, or every task
would appear twice: once under its parent and once alongside it.


### An attachment opens in the browser when it is safe to, and only then

Downloading a screenshot to look at it is a trip to a downloads folder, so an
image, a PDF or plain text is served `inline` with its real type. What makes
that safe is three headers together, not the disposition:

- `Content-Security-Policy: default-src 'none'; sandbox` puts the response in
  an **opaque origin**, so even a file that did contain script could not reach
  this application's session;
- `X-Content-Type-Options: nosniff` stops the browser second-guessing the
  type;
- the type comes from `VIEWABLE_TYPES` keyed on the **verified** type in the
  database, decided from the file's own bytes - never from what an uploader
  claimed.

Everything else is still `application/octet-stream` and `attachment`. **Never
add SVG or HTML to that set**: a document format with `<script>` in it
rendered in place is the whole reason this route was octet-stream to begin
with. `?download` forces the download for anything.

`.msg`, `.eml` and `.7z` are accepted uploads; none is viewable, so all three
download like a zip.

### Attachments are verified before the ticket is created
On the raise-a-ticket form, files are checked **before** the insert. Verifying
afterwards left an orphaned ticket on every rejected file, and the requester
would submit again - so the queue filled with duplicates of exactly the
tickets that had already gone wrong once. There is a test for the absence of
that orphan.

### Customisation has three tabs; attachments moved there

Appearance, Attachments, Requester portal (`_customization-tabs.ejs`).
Attachments is no longer a sidebar section: `/admin/settings/attachments`
308-redirects its whole subtree to `/admin/settings/customization/attachments`.

### Back links, row actions and the bin

- "All portals", "All users" and the like are `partials/back-link.ejs`, a
  pill button with a chevron - not a text arrow.
- `td.row-actions` must stay `display: table-cell`: flex on a cell takes
  it out of the row, and its border stops lining up. Actions stay on one
  line; the table scrolls on a narrow screen.
- Remove in a table row is `partials/bin-button.ejs`: an icon with an
  accessible label, shown **disabled with the reason** when the row cannot
  be removed.

### The requester portal dresses pages; it never replaces them

Settings - Customisation - Requester portal. An administrator writes a
**layout** (must contain `{{page}}` once), a **CSS** file, and optionally HTML
for each requester page - Home, My tickets, New ticket, Ticket, Profile - which
must contain `{{content}}` once. `{{content}}` is the page rendered by its usual
view, so a portal can restyle the service desk but cannot break raising a
ticket. A blank page part means "just the content inside the layout".

- **The standard portal is not a row.** It is the code (`header.ejs` as it
  always was), so it cannot be deleted or broken, and "no row has
  `is_active = 1`" means "use it". `is_active` **means "default"** (the UI says
  Set default); a partial unique index keeps at most one, and
  `setDefaultPortal` clears and sets in one transaction.
- **A portal can be assigned to user groups** (`portal_group_assignments`,
  migration 20, one row per group so a group follows exactly one portal;
  `portal_id` may be `'standard'`, hence no foreign key). `portalForUser()`
  is the single resolver: the assigned portal of the member's first group
  by name, else the default. Deleting a portal returns its groups to the
  default in the same transaction. The groups dialog posts **every** ticked
  group, so unticked means "not this portal".
- **Only role `user` sees a portal.** Staff always get the built-in look. An
  administrator sees one only in the editor frame (`?portalFrame=<id>`,
  admin-only, the one place `allowFramingBySelf()` relaxes
  `frame-ancestors`) or in a full-screen preview held in
  `session.portalPreview`, with a banner on every page.
- **It is applied in the header and footer partials**, from
  `res.locals.portal`, set by `portalPresentation()` on `/home`, `/tickets`
  and `/profile` only. No page view knows about it. A portal that fails to
  compose falls back to the standard look rather than failing the page.
- **The CSP is unchanged.** CSS is served as a file
  (`/portal/:id/theme.css`), because `style-src 'self'` forbids inline
  styles; and a save containing `<script>`, an `on*=` handler, `<style>` or a
  `style=` attribute is **refused** with a reason, since each would be stored
  and then silently do nothing.
- **Variable values are escaped; the administrator's HTML is not.** Unknown
  variables are refused on save, so a typo cannot reach requesters.
  `{{button_template:<id>}}` must name an active template when saved, and
  quietly drops out if it is retired later.
- **No live preview, on purpose.** The preview is a real page in a sandboxed,
  non-interactive frame, and shows what is saved. Updating it as you type
  would need a script, which is the "second exception" this file warns
  against - raise it rather than add it.
- **Sign-in password** and **Sign-in code** are parts of their own (the two
  second steps of signing in); blank, each uses the Sign-in part. The
  editor's frame shows them with a sample address.
- The editor's right side is the preview only; the page's own HTML (as a
  requester receives it) is a read-only panel under the code.
- **The header dresses a page only for a composed portal** (`dressed` in
  header.ejs checks for `stylesheet`): a view's own `portal` local - the
  editor passes the row it edits - once stripped the editor of its top bar.
- `/` and the sign-in default now go to **`/home`**, which redirects to
  `/tickets` unless the active portal has a Home page - so nothing moves for
  anybody until a portal says so.

### Settings are cached per process
`settings()` is **synchronous** on purpose - making it async would cascade into
every template and middleware. It reads an in-memory cache refreshed by
`await loadSettings()`. Fine at one instance; a real issue at several.

---

## Traps that have already bitten

### 1. `?` placeholders are positional - this caused ~20 silent bugs
During the PostgreSQL → SQLite conversion, `$1, $2` became `?`. PostgreSQL
placeholders can **repeat and appear out of order**; `?` cannot. A naive
rewrite produced statements with wrong or missing arguments - `setUserRole` was writing the user id into the role column.

**If you ever rewrite SQL in bulk, check every call site's argument order by
hand.** A count check is not enough: `UPDATE x SET a = $2 WHERE id = $1` has
the right count and the wrong order.

### 2. Heredocs mangle backslashes and quotes
`cat <<'EOF'` has repeatedly corrupted `\n`, `\\`, backticks and nested
quotes in this project, silently producing broken source. **Use the Write tool
for source files, and write patch scripts to a file rather than `node -e`**
when they contain regexes or nested quotes.

### 3. `tsconfig.test.json` must not inherit `exclude`
It once inherited `exclude: ["tests"]`, so the tests were never typechecked.
Fixing that revealed 183 errors. It now sets its own `exclude`.

### 4. ESM circular imports are a crash, not a warning
`admin.ts` → `settings.ts` → `admin.ts` produced
`Cannot access 'auditRouter' before initialization` **at start-up**. The audit
router lives in its own `audit-admin.ts` for exactly this reason.

### 5. Every settings page needs the shell locals
Pages under `/admin/settings/*` render inside `_layout.ejs`, which needs
`sections`, `section`, `sectionTitle`, `problems`, `updatedAt`, `fixed`.
**Wrap every render - including the 400 error branches - in `settingsView()`**
from `routes/settings-shared.ts`. Forgetting one turns a validation error into
a 500.

### 6. A refused write must not become an error page
The services refuse by throwing - `conflict('A group with that name already
exists.')`. The error handler renders that as a standalone 409 page, which in
a browser means the person loses everything they typed and has to navigate
back to read what was wrong. **This was reported as a bug, and it will be
again** if a new form calls a writer directly.

So every browser-facing write goes through `attempt()` in
`routes/form-errors.ts`, which converts a 400/404/409 into field errors and
rethrows everything else. The routes keep one `refuse()` closure so the
validation path and the conflict path render identically.

Two things to keep true:

- Any view with an `errors` local needs an **`errors.form`** branch, because
  a code not in `CONFLICT_FIELD` lands there.
- `attempt()` deliberately does **not** swallow 403 or 500. Re-rendering a
  form is not an answer to "you may not" or "something broke".

### 7. Moved URLs need the whole subtree
Admin pages moved under `/admin/settings/*`. The redirect in `admin.ts` is a
prefix middleware, not a list of exact paths - the first version matched only
the section roots, so `/admin/templates/new` and every
`/admin/users/{id}/...` returned a 404. It is a 308 so the method and
body survive, and it carries the remaining path and the query string.

### 8. Stylesheet caching
`/assets` is served with a **seven-day max-age**, so every stylesheet link
carries a content-hash version (`app.locals.assetVersion`). Without it a CSS
change is invisible to anyone who has visited before - this bit once, mid-way
through building the colour-mode control, and looked like broken CSS rather
than a cache. Both `header.ejs` and `error.ejs` must keep the `?v=`.

### 9. The branding stylesheet's cache key
`brandingVersion()` hashes the **generated stylesheet**, not just the colours.
A change to the generator must invalidate cached copies, or browsers keep
serving CSS from the previous version.

### 10. CSS class names are global, and a collision is silent
A template-builder palette rule was called `.chip` - which already meant the
comment-count badge on the ticket list. Every ticket then carried a small
empty box under its title with a bare "1" in it, which read as a rendering
bug rather than a name clash. The builder's is now `.palette-chip`.
**Before adding a class, grep the stylesheet for the name.** One stylesheet
serves every page, so a plausible short word is probably taken.

---

## Data layer conventions (`src/db/index.ts`)

The API is `async` even though better-sqlite3 is synchronous: callers already
await, and the eventual move to a server database is then one file.

| Thing | How |
| --- | --- |
| Placeholders | positional `?` |
| Timestamps | TEXT, ISO-8601 UTC with ms. Sorts correctly as text. `sqlNow` is the SQL expression; `Date` params are converted on the way in |
| Booleans | 0/1 on disk. Converted both ways for the columns in `BOOLEAN_COLUMNS` - **add new boolean columns to that set** |
| JSON | TEXT, parsed on read for the columns in `JSON_COLUMNS` |
| Transactions | `BEGIN IMMEDIATE`, because read-then-write otherwise fails with `SQLITE_BUSY_SNAPSHOT` |
| Ticket `seq` | allocated inside the transaction; SQLite has no sequences |

Migrations are forward-only in `src/db/migrations.ts`. **Never edit one that
has shipped** - append.

---

## Layout

```
src/
  config.ts              env, fails closed; warns about SQLite in production
  settings/              runtime settings (one JSON row), cached in memory
  app.ts                 middleware order matters - see below
  server.ts              explicit start-up order, graceful shutdown
  auth/
    oidc.ts              discovery, PKCE, ID token validation
    local-accounts.ts    password accounts + the break-glass admin
    provisioning.ts      the JIT policy (never roles)
  routes/
    settings-shared.ts   SETTINGS_SECTIONS + settingsView()
    users-admin.ts       merged users list + detail (roles, groups, password)
    groups-admin.ts      technician groups
    scim.ts              SCIM 2.0, mounted OUTSIDE the browser pipeline
  services/              users, tickets, templates, groups, attachments,
                         branding, scim
tests/                   1,057 tests; one SQLite file per test file
```

### Middleware order in `app.ts` is load-bearing
SCIM is mounted **before** sessions, CSRF and the global rate limiter: it is a
bearer-token API that must not allocate a session, and a provisioning cycle is
a burst of requests. It has its own JSON parser and its own SCIM error
documents - Entra must never receive HTML as a failure.

---

## Mail

Settings - Mail, two tabs: the mailboxes, and the notifications they send.
This reverses the old "no notifications of any kind" decision, so the reasons
behind the shape it took are worth keeping.

### Threading has to be right, so it is tried three ways

A reply that starts a second ticket is worse than no email integration at all:
the conversation splits and nobody notices. `matchTicket()` tries, strongest
first:

1. **In-Reply-To** against `mail_threads`, which holds the Message-ID of
   everything we have sent. Exact: we minted the id and it was quoted back.
2. **References**, for a client that drops In-Reply-To, newest first.
3. **The `[TKT-000123]` reference in the subject**, for clients that strip
   headers.

**A match is not a licence to write.** A reference in a subject is easy to
guess, so a matched reply from somebody **not on the ticket** - not staff,
not the requester, whoever raised it or the assignee, nor the stranger
address it came from - becomes an internal note "Email from x, who is not
on this ticket", its files internal: no reopening, nobody emailed
(security review, 21 Oct 2026). A colleague copied in lands there too; a
technician decides. A forged staff address is still believed - telling it
apart needs the mail server's DMARC result.

**Subject text alone is never matched.** "Re: printer broken" finding the last
ticket of that name is how two people's problems get merged into one. The
subject pattern is built from `TICKET_PREFIX` so it cannot drift from the
references themselves, and it is anchored to the brackets so a reference
mentioned in passing does not attach anything.

### Four things that would otherwise bite

1. **Everything is queued, never sent inline.** `mail_outbox` plus a timer.
   Somebody raising a ticket must not wait on Microsoft, and a failure needs
   somewhere to be seen and retried rather than a log line.
2. **Every inbound message is recorded in `mail_seen` by Message-ID**, and a
   message is acknowledged only *after* the ticket or comment exists. A poll
   that is retried, or a restart partway through one, must not raise the
   ticket twice - and a crash must re-read rather than lose.
3. **A mail from the mailbox to itself is dropped.** One check, at the only
   place a loop can start.
4. **A notification body is HTML the administrator wrote and is not escaped;
   every interpolated value is.** `render()` escapes the values only. Without
   that a ticket title of `<img src=x onerror=...>` is markup in somebody's
   mail client.


### One notification per page, with a preview

Seven HTML editors stacked on one page was a page nobody could find anything
on. The list says what each notification is, who it goes to, which mailbox
sends it and whether it is on; `/notifications/:id` is where one is edited.

The preview is an **iframe**, not inlined markup, for two reasons: the body is
HTML an administrator wrote, so inlining would let its styles - or a stray
unclosed tag - reach the settings page around it, and a mail client renders a
message as its own document anyway, so a frame is the truer preview. It is
filled with `sampleValues()`, a plausible invented ticket: a preview full of
`{{placeholders}}` tells nobody whether the wording reads well, and a real
ticket would differ for every administrator and be missing entirely on an
empty service desk.

Two headers have to give way for that frame, and **both** are needed - each
alone leaves a blank box that looks like broken CSS:

- the editor page's policy, relaxed to `frame-src 'self'` by
  `allowOwnFrames()` - the same one-response trick as `allowOwnScripts()`;
- `X-Frame-Options: DENY`, which helmet sets on every response and a browser
  obeys whatever the CSP says. The preview route removes it and sets
  `frame-ancestors 'self'` instead, which is the same rule.

The framed response keeps the strictest policy that still shows a message:
`default-src 'none'; style-src 'unsafe-inline'; img-src data:`. No script, no
network, nothing fetched. `tests/mail-notification-pages.test.ts` asserts
every one of those headers, including that no other page gained `frame-src`.


### A logo in an email is a CID attachment, and only that

Three ways to put an image in a notification, and two do not work: a remote
`<img src="https://...">` is blocked by Outlook and Gmail until the reader
asks for images, and a `data:` URI is stripped outright by both. So the body
writes `<img src="cid:logo">` and the image travels **inside** the message,
which is what every organisation's mail does.

`inline-images.ts` is the whole of it. Four decisions worth keeping:

1. **The image is the branding logo, not a second upload.** There is
   deliberately no uploader on the notification page: one logo for the system
   means Customisation changes every email at once, and no new storage,
   validation or cleanup. `cid:logo` is the only reference understood.
2. **Resolved at send, not at queue.** `flushOutbox()` reads it, so the queue
   never holds a copy of an image and a logo changed while something waited
   goes out as the new one.
3. **Narrower than what the browser accepts.** The uploader allows SVG and
   WebP because a browser draws them; no mail client renders SVG and Outlook
   on Windows does not render WebP, so `SENDABLE_TYPES` is PNG, JPEG and GIF
   only. The cap is **100 KB**, not the browser's 1 MB, because this is paid
   for on every notification and base64 adds a third.
4. **A logo that cannot be attached never stops the mail.**
   `inlineImagesFor()` returns an empty list instead of throwing - one broken
   image beats a ticket update that never arrives - and `logoProblem()` says
   why on the page, shown only when that body actually asks for the logo.


### A ticket's files go with the reply they belong to

**Since the redesign of 21 Oct 2026** the ticket page has one file picker, in
the reply box (POST `/:id/comments`, multipart): a technician's **reply**
emails its files with it, an **internal note**'s files are internal and go
nowhere, and **files with no words** are attached and emailed to nobody.
Every file is verified **before** anything is stored, so a bad second file
cannot leave the first behind; a refusal puts the typed words back in the
box once (`session.replyDraft`). The route checks the CSRF token itself,
before it looks the ticket up - the path is in `isAttachmentUploadPath`
because the global check runs before a multipart body is read.

The page shows each file **with the message it came with**
(`services/ticket-timeline.ts`): same person, same internal flag, within
20 seconds; files raised with the request sit with the request. There is
no column naming a file's comment, and none is needed.

`POST /:id/attachments` (the old upload form, "Inform the requester",
which **requires a message**) still works for anything that posts to it,
and its refusals now land beside the reply box. What follows is true of
both.

- The ids ride on the queue (`mail_outbox.attachment_ids`, migration 13) and
  the bytes are read at send time, so the queue never holds a copy and a file
  deleted meanwhile is simply not sent. Capped at 15 MB in total.
- **Internal and informed are mutually exclusive**, and refused together
  rather than silently resolved one way.
- The attachment row records `emailed_at` (migration 14) and the ticket shows
  an **Emailed** mark beside the file (it read "Requester informed" before the redesign). A file the requester has seen and one only
  the service desk holds look identical otherwise, and the difference decides
  whether somebody already has the thing being discussed.
- SMTP wraps this in `multipart/mixed` **outside** the `related` container:
  related says "pieces of the body", mixed says "sent alongside it", and a
  client lists only the second kind as attachments.

### The two transports carry it differently

- **Graph**: an `attachments` entry with `contentId` and `isInline: true`.
  `isInline` is what keeps it out of the attachment list a reader sees.
- **SMTP**: `buildMessage()` becomes **`multipart/related`** - the HTML part
  first, then one part per image with `Content-ID: <logo>`. `related`, not
  `mixed`: related says the parts are pieces of the body, which is why a
  client draws the logo in place rather than offering it as a download.

With no images the message is byte-for-byte what it was before, a plain
`text/html` part. A notification that uses no logo gains nothing to go wrong.

Two things in that code that look fussy and are not:

- **The boundary contains `_`.** Every part is base64, whose alphabet has no
  underscore, so no amount of body can accidentally end a part - the one way
  a multipart message goes badly wrong.
- **`mimeName()` strips quotes and non-ASCII** from the filename. It sits
  inside a quoted header parameter and came from an uploaded file, so a quote
  in it would end the parameter early and a newline would inject a header.

The **preview substitutes the bytes as a `data:` URI** (`previewHtml()`),
because `cid:` means nothing to a browser - and substitutes nothing when the
logo could not be sent, so the preview is exactly as broken as the email
would be. That is why the preview's policy allows `data:` images and no other
source.

**Outgoing is still inline images only.** A ticket's own attachments are not
sent with a notification, and that is a data-leaving-the-system decision
rather than a formatting one: notifications go to group members and, on the
stranger path, to unverified addresses. Files coming **in** are a different
question and are kept - see below.


### A file on an incoming email becomes a ticket attachment

Mail is how most people send a screenshot of the thing that is broken, so a
message whose files were dropped loses the evidence the ticket exists for.
They were dropped until this was reported.

`inbound-attachments.ts` holds the policy; `IncomingMessage.attachments`
carries them. The rules are **the same store as the browser uses** -
`verifyType()` on the bytes, the configured size limit, the per-ticket cap -
because a file arriving by mail deserves less trust than one picked by a
signed-in person, not more.

Five decisions:

1. **An inline image under 25 KB is taken for a signature logo and dropped.**
   Outlook sends a corporate signature's logo on every message, and a ticket
   that collects one per reply is a ticket nobody can find the screenshot in.
   A pasted screenshot is hundreds of KB; a 200x60 logo is a few. This is the
   only heuristic in the file, and it never applies to a file the sender
   actually attached, however small.
2. **Identical bytes are stored once per ticket**, by sha256. That catches the
   signature logo that did clear the floor, and the attachment quoted back on
   every reply in a long thread.
3. **A message with files and no words is no longer "empty".** `ingest()`
   dropped it, which threw away the only thing it carried; the body becomes
   "(no message text)" when there is something attached.
4. **What was refused is said in an internal note.** A technician reading
   "see the attached screenshot" needs to know why there is no screenshot;
   the requester does not need to read about type rules.
5. **Nothing here may cost the ticket.** Each file is tried on its own and the
   whole step is wrapped, so a misconfigured limit cannot turn a request into
   a message that vanished.

**A picture pasted into an email is drawn where it was** (22 Oct 2026,
`placeInlineImages`): the text's `[cid:...]` becomes `[image: name]`, one
with no marker goes at the end, one whose marker was in the cut quoted
history is left out, a signature logo's marker is removed, and pictures
sharing a name (Apple Mail's image.png) are renamed so each marker names its
own file. The ticket page draws a marker only for a PNG, JPEG, GIF or WebP
the reader may open (`?embed`, which is not an audit line per view).

**Graph needs a second call per message.** `$expand=attachments` on a list
returns every byte of every attachment in one response, and twenty-five
messages of that is a response large enough to fail - so the list asks for
`hasAttachments` and only those messages are followed up. Only a
`fileAttachment` is kept: an `itemAttachment` is a whole message and a
`referenceAttachment` is a OneDrive link, and neither has bytes to store.

**IMAP needs no second call** - mailparser has already decoded every part. A
part with no filename gets one made from its declared subtype, because the
store decides a type from the extension and a nameless part would be refused
for having none. If that subtype lies, `verifyType()` still catches it.


### Mail automation: incoming mail raised from a chosen template

Settings - Mail - **Advanced settings** has two sub-tabs: **Signature
stripping** (moved here from Other settings; `/mail/automation/phrases`
308-redirects) and **Mail automation** (`services/mail/rules.ts`, migration
38). A rule is "subject / sender / text contains / starts with / is / ends
with / matches the expression ...", mapped to a template; rules are tried in
order and the first match raises the ticket from that template - its type,
priority, routing, task rules and tasks (`raiseFromRule`).

**It never raises what already exists.** In `ingest()`, in this order:
the Message-ID already seen (`mail_seen`) is ignored; a reply to a ticket
(In-Reply-To, References, `[INC-000123]` in the subject) is a comment
there, whatever the rules say; only then is a rule looked for - and the
rule's own check, `repeatOf`: an **open** ticket from the **same sender**
with the **same subject**, raised from the same template within the rule's
window (24 h by default, 0 off), takes the mail as a comment
(`via: 'repeat'`). The sender has to match, so two people's identical
subjects are never merged - the reason subject text alone is matched
nowhere. A "Try a message" box shows which rule a subject would meet.

### Other settings: after a message is read

Settings - Mail - Other settings: known senders, auto-close and reopening.

- **Signature stripping.** `signatures.ts`. The patterns ship **empty**, like
  the category catalogue: what an organisation signs off with is theirs, and
  in their language. The rule is blunt on purpose - the first line that
  matches, and everything after it, goes - because a signature is always at
  the end and anything cleverer would be guessing. It never empties a message:
  a reply that is only "Kind regards, Jan" is still a reply.
- **A pattern is a regular expression, compiled where it is typed.**
  `cutProblem()` refuses one that cannot compile, at the point somebody can
  do something about it; a pattern that threw when a reply arrived would lose
  the cut on mail nobody is watching. Matching is line by line and skips a
  line over 400 characters, which bounds the backtracking a careless pattern
  can cause.
- **Known senders only.** Off by default: a service desk that silently drops
  mail from somebody without an account is a service desk losing requests.
  It governs **new** tickets only - a reply that matched an existing ticket is
  already part of a conversation this service desk started.

### Mail from a stranger gets a ticket, never an account

Tickets reference their requester with ON DELETE RESTRICT and the column is
not nullable, so one hidden disabled account carries them all and
`tickets.external_email` records who it was really from - which is also where
the reply goes. Who may *sign in* stays a question for Provisioning: a mailbox
anybody can write to must not be a way in.

### A password account's email can be changed; a directory one's cannot
`setLocalEmail()`, on the user's page. It exists because without it a local
test account is stuck at `username@local` and can never receive a
notification - which is how the gap was found.

Three things it has to get right:

- **Only a local account.** A directory account's address is rewritten by
  `upsertUserFromDirectory` on every sign-in, so offering to edit it would
  hand somebody a change that silently reverts. The page shows it as a value
  with "from the directory" instead.
- **The address is the sign-in name**, so changing it changes what the
  person types to get in; `setLocalEmail` moves the credential with it, and
  the page says so.
- **A clash is refused**, not shrugged at: `users_email_uq` would reject the
  write anyway, and an unexplained 500 is worse than a message.

### A form that changes with a choice, and no JavaScript to do it
The mailbox dialog showed OAuth2 *and* IMAP/SMTP at once, which asked every
administrator for four credentials they did not have. It now shows only the
half that applies.

The technique, since it is the only one available here:

- The choice is **two radio buttons placed first in the form**, dressed as a
  segmented control with `<label for>`. The panels are their **later
  siblings**, so `.kind-radio--graph:checked ~ .only-imap { display: none }`
  does the switching.
- **A `<select>` cannot do this.** CSS has no selector for "which option is
  chosen", which is why the control is radios rather than a dropdown.
- The radios are **visually hidden, not `display: none`** - a hidden input
  cannot be focused, and these must be reachable with a keyboard. There is a
  `:focus-visible` rule so the segmented control shows focus.

Reuse this before reaching for a script. Anything that reveals part of a form
based on a choice can be built the same way.

### The two kinds take different credentials
Graph uses **OAuth2 client credentials**; IMAP and SMTP use a **username and
password**. They are different columns, and `assertComplete()` asks only for
what the chosen kind needs - a form demanding a tenant id for IMAP is a form
asking the wrong question.

Both secrets are sealed with `secret-box`, both are blank-means-keep on an
edit so a page never echoes one, and `assertComplete` takes the existing row
so an edit need not retype what is stored.

Worth knowing when testing: **Microsoft 365 has basic authentication turned
off**, so a Microsoft mailbox wants Graph. The IMAP/SMTP path is for everything
else.

### SMTP relays: several, each for some groups

Settings - Mail - Other settings - SMTP relays (`services/mail/relay.ts`,
migration 50): an organisation's own relays, sending without a mailbox. Rows
in `smtp_relays`, one marked default (the first added; deleting the default
hands it to the oldest survivor, as with mailboxes). They never receive.

- **Which relay sends** a notification: the one it names in **Sent from**
  (`relay:<id>`); "The ticket's own SMTP relay" (`relay`) is the
  ticket's group's relay, else the default (`relayForGroup`). A group
  follows **one** relay (`smtp_relay_groups`, keyed by group): ticking it
  on another relay moves it. `via_relay = 1` with `relay_id` NULL means
  "the ticket's own" on a notification and "the default" in the outbox.
- **Send every notification through the SMTP relays** (`relaysOnly`):
  whatever mailbox a notification names, it goes through the group's relay,
  else the default; mailboxes only read. **Only while a relay can send**
  (`relaysOnlyInForce`): with every relay off or broken the mailboxes send
  again, and the relays page says so - a silent service desk is worse. It
  also sends sign-in codes through the default relay, like "Send sign-in
  codes through the default relay" (`useForCodes`). Both switches are
  refused without a default relay that can send.
- A relay switched off sends nothing: a notification pinned to it is
  skipped (as one with no mailbox); a group's relay that is off falls back to
  the default. Deleting the last relay moves every relay notification back
  to the mailboxes and turns both switches off.
- STARTTLS, implicit TLS, or **none** for an internal relay on port 25 -
  and then **never with a password**: refused on the page and again in
  `sendOverSmtp`. The password is sealed; blank keeps it.
- **The single relay from before** lived in the settings document
  (`smtpRelay`). `adoptLegacyRelay()` at start-up turns it into the first
  row, sealed password copied as it is, and clears the document's copy; the
  document keeps only `useForCodes` and `relaysOnly`.
- `relayAsMailbox(row)` dresses a relay as a send-only mailbox for the
  outbox and the transport factory, which is also how the tests' fake
  transport sees it.

### Mailboxes: as many as you like, one default

The first version allowed one per technician group plus one with no group,
which with no groups set up reads as a limit of one. It is now unlimited: a
mailbox may handle a group's tickets, and one is marked the default. The first
mailbox becomes the default on its own, and deleting the default hands it to
the oldest survivor - a service desk that silently stops sending is the worst
outcome here.

`setTransportFactory()` is the seam. Neither real transport can be reached
from a test, so everything above it is covered by a fake that records what it
was asked to send.

### SMTP is spoken directly; IMAP is not

`smtp.ts` is an SMTP client written against the protocol, with **no
dependency**. Sending one message is a dozen commands, and a client library
would be thousands of lines of somebody else's code in a project whose short
dependency list is its main defence. Verified end to end against
`smtp.seznam.cz:465`.

What it covers, and deliberately does not: one recipient, an HTML body,
images the body points at with `cid:`, implicit TLS or STARTTLS, AUTH LOGIN
or PLAIN. **No downloadable attachments, no multiple recipients, no
delivery-status notifications.** If those are wanted, that is
the point at which a library earns its place.

Three things it would be wrong without:

- **Headers are ASCII.** A Czech or French subject has to be an RFC 2047
  encoded word (`=?UTF-8?B?...?=`) or it arrives as mojibake - the first
  thing anybody notices about a new mail integration.
- **The body is base64.** One long line of HTML would otherwise break the
  998-character line limit, and UTF-8 would be at the mercy of the server.
- **Every read has a timeout.** A server that accepts the connection and then
  says nothing would hold the send queue open forever.

### IMAP is not hand-rolled, and that is the point

`imap.ts` uses **imapflow** for the protocol and **mailparser** for the
message. The asymmetry with SMTP is deliberate and worth keeping straight:

- **SMTP sending** is a dozen commands and one message shape, so writing it
  costs less than the dependency.
- **IMAP reading** is a large protocol returning MIME - nested parts, a
  transfer encoding and a charset per part, RFC 2047 headers. Hand-rolling it
  would be more code than the rest of the mail feature, and getting MIME
  subtly wrong produces a quietly corrupted ticket rather than a loud error.
  That is the worst kind of bug to own.

Two things the implementation has to get right:

1. **One connection per poll, not per message.** The poller fetches, acts on
   each message, then acknowledges it. A connection per acknowledgement would
   mean twenty-five logins to read twenty-five messages, so `MailTransport`
   has an optional `dispose()` that `pollMailbox` calls in a `finally`.
2. **Nothing is marked Seen until its ticket exists.** Same rule as Graph: a
   crash between reading and storing means the message is read again rather
   than lost.

A message with no Message-ID gets one built from its UID. Malformed, but they
exist; de-duplication keeps working and it simply cannot be threaded against.

---

## House style - keep it consistent

Reported as "New template button is different colour and style than new
category. We need to have unified styling across the system." It was: one
page had a filled primary button in sentence case, the next had three plain
buttons in Title Case. **Check this list before adding a control.**

### Buttons

| Class | For | How many per screen |
| --- | --- | --- |
| `btn btn--primary` | The one action the page exists for | **One** |
| `btn` | Secondary actions beside it | Any |
| `btn btn--quiet` | Cancel, dismiss, "show me something else" | Any |
| `btn btn--danger` | Deletes and removals | Any |
| `btn btn--small` | Inside a table row or a dialog's footer | Any |

- A **create** button is `btn btn--primary` and carries a leading
  `<span aria-hidden="true">+</span>`. All four list pages (templates,
  categories, groups, users) do this; a fifth must too.
- **Sentence case everywhere.** "New sub category", not "New Sub Category".
  The same goes for dialog titles, legends and option text.
- A dialog's primary button repeats the action ("Create group", "Add task"),
  never "OK" or "Submit".
- Row actions in a table are `btn btn--quiet btn--small`, with the
  destructive one `btn--danger` as well.

### Form controls

- Checkboxes and radios are **drawn**: `appearance: none`, a rounded box or
  circle, and the brand as the fill when ticked (the tick is a data: SVG, as
  the select chevron is). `accent-color: var(--brand)` stays for a browser
  that ignores `appearance: none`, which then shows its own control rather
  than an empty square.
  **This reverses the old rule** ("never `--accent`: a page of ticked boxes
  in the brand red reads as a page of warnings"), and only because the brand
  is no longer crimson - it is the indigo of every primary control here, so
  a ticked box in it reads as a ticked box. Asked for 16 Oct 2026.
- A select's first option is the prompt ("Not sure", "Choose a category"), so
  it needs no line of help underneath saying the same thing.
- Guidance for a typed field is its `placeholder`, not a `<p class="hint">`.
  Keep a hint only for what the control cannot say itself - attachment limits,
  an empty catalogue, a security warning.


### Explanations go in an ⓘ, not under the control

A paragraph of help under every setting reads as a page of warnings, and the
explanation is wanted the first time and never again. `views/partials/info.ejs`
is the component; `text` for plain wording, or the markup written out in full
when it carries a `<code>` or a link.

Three things in it that look fussy and are not:

- **The focusable element wraps both parts**, so the bubble opens on hover
  *and* on keyboard focus. A tooltip only a mouse can reach is one half the
  readers cannot read.
- **It is hidden with `opacity`, never `display: none` or `visibility`.**
  Those take it out of the accessibility tree as well as off the screen;
  opacity leaves it readable by a screen reader at all times.
- **It regains pointer events when shown**, so a long explanation can be moved
  onto and read instead of vanishing on the way.

`.field` is a grid, so a label and its mark are wrapped in `.label-row` -
two siblings would otherwise be two rows and the mark would sit underneath.

**What stays on the page**, because hiding it is how somebody makes the
mistake it was there to prevent: a limit (attachment sizes, accepted types),
a security warning, an empty state, and the reason an action was refused.

### A row of buttons needs its wrappers flattened

Some buttons are wrapped in a form to carry a CSRF token. In a flex row
the **form** is then the item: it stretches to the row height while the
button inside keeps its own, and the form's own margin lifts it - so an
`<a class="btn">` and a `<button class="btn">` beside it do not line up.
Reported twice, on a toolbar and on the Tickets page head. `.toolbar` and
`.page-head__actions` therefore centre their items and zero the margins
of any `form`, `.inline` or `.inline-form` inside them. **A new button
row needs the same two lines.**

### Small things reported on 15 and 16 Oct 2026

Each of these was a screenshot with a sentence under it. They are listed
together because each is one rule, and the rule is what matters next time.

- **A link is underlined on hover and focus, not at rest.** It was the
  browser's default, so every component that did not want one turned it off
  and the ones nobody had reached read as underlined text in a card. **In
  flowing text the underline stays** (`.prose a`, `.portal-prose a`): there
  a link has to be findable without its colour.
- **No heavy left bar anywhere.** A 3-4px coloured edge marked a message, an
  internal note, an attachment, a widget's mode, an announcement, a locked
  value and the current settings link; several on a page read as a page of
  warnings. What each said is said by its background, its badge or the word
  in its row. Two are kept because they are structure: the timeline's
  hairline and the category tree's indent guide.
- **An address is in the page font**, never monospaced: a reader reads it as
  a word rather than inspecting it character by character.
- **A value in a `.details` list carries the weight** (560), so it is told
  apart from its label.
- **Limits go in the ⓘ.** The attachment limits and the accepted types are
  in the mark beside "Attach files"; the credentials warning stays on the
  page, because hiding it is how somebody makes the mistake it prevents.
  (This narrows the older rule that a limit always stays visible.)
- **Delete sits at the far end of the triage row, behind a dialog**, and the
  Danger-zone card is gone: a card halfway down a long ticket is one
  everybody scrolls past, and it kept a Reason box on screen for a thing
  almost nobody does. Disabling and removing an account ask first the same
  way; **enabling does not**, because it takes nothing away.
- **The break-glass page shows only what is true of it.** Role, technician
  groups, user groups, profile and activity are not drawn for it: five cards
  that only said "not this account" are worse than no cards.
- **The sidebar is New ticket, Tickets, Dashboard**, in the order they are
  used, and the ticket stub is New ticket while the tray is the queue.
  "Pinned" is sentence case like every other heading, and Manage is a real
  button - as plain text nobody could tell it was one.
- **A control row needs `align-items: center`** when a word sits beside a
  button, and a lone `<a class="btn">` inside a `.card.stack` (a grid)
  stretches across the card unless it is in an `.actions` row.
- **Two buttons that do different things are the same size**, and say which
  is which by colour: Disable is quiet because one press undoes it, Remove
  is red because nothing undoes it.

### Punctuation: no em dashes

**Use a plain hyphen `-`, never `—` or `&mdash;`.** Asked for directly, and
it applies to the UI, the source comments and these documents alike. 203 of
them were replaced in one pass; do not reintroduce one.


### A refusal belongs beside the control, not at the top

`flash(req, type, message, where)` takes a **place**. Without one the message
is a banner at the top, which is right for "Saved" and wrong for "that file is
not what it says it is": a refusal at the top of a long ticket makes the
reader work out which of the things they just did went wrong. The banner skips
anything with a `where`, and the view renders it itself.

Used by the attachment form (`where: 'attachments'`) and the triage form
(`where: 'update'`). This is the same lesson as trap 6 and `attempt()`, one
level further in: not only must a refusal avoid becoming an error page, it has
to land next to what caused it.

### A POST must come back where it left

Every builder action is its own POST and redirect, so without a fragment the
browser lands at the top of a long page - reported as "when I change something
in the template creation, or add a new field I am taken to the top of the
page".

So a redirect names where it came from:

| Action | Lands on |
| --- | --- |
| Move, place, configure a field | `#row-<key>` |
| Take a field off, delete a question | `#the-form` |
| Anything about tasks | `#tasks` |

**The anchor is `row-<key>`, never `field-<key>`.** The latter is the dialog's
id, and landing on it would re-open the dialog through its `:target` rule.
Anything given an id for this also needs `scroll-margin-top`, or it arrives
flush against the top of the viewport with no context above it.

**Closing a dialog must not go to `#` either** - `#` is the top of the page.
A dialog opened from deep in a page closes (backdrop, ×, Cancel) to the
anchor it was opened from: `#row-<key>` in the builder (palette chips carry
`row-<key>` too - a field is in one place or the other), `#node-<id>` in the
category tree, `#the-form` / `#tasks` for the builder's own dialogs. Only a
dialog opened from the toolbar at the top may close to `#top`.

### Text on a page

Reported as "can you remove all the unnecessary comments like this from the
system?", about a paragraph on the templates list explaining what a template
is. **Do not explain the page to the person who opened it.**

Delete on sight:

- **Definitions.** "A technician group is a team a ticket can be routed to…"
  on the groups page. They came there to manage groups.
- **Instructions for a visible control.** "Drag a field from the palette to
  add it, drag a row to move it" - above a palette and some draggable rows.
- **Design rationale.** "The catalogue starts empty on purpose - the
  classification your organisation uses is yours to decide." That belongs
  here, not on the screen.
- **A restatement of the field above it.** "A category can hold as many
  subcategories as you need", under a category picker.

Keep, in one sentence:

- Anything that **prevents a mistake** the screen otherwise invites, and
  only if the owner has not asked for it to go. On 22 Oct 2026 the owner
  removed "Roles are set here and nowhere else", "Membership grants nothing
  on its own", the user groups and mailbox explanations, the font licence
  line and the directory-roles paragraph as overexplanation: **when in
  doubt, leave it out**.
- **Facts a control cannot show** - attachment limits and accepted types, "no
  categories have been set up yet".
- **Why an action is refused**.

A default template **may be switched off** (22 Oct 2026); New ticket then
opens the first working template (`defaultTemplate`). The seeded incident
form is **Default Incident request** (migration 69 renamed an untouched
"Default request").
- An empty state says **what to press**, not why the page is empty.

Two older rules, same spirit:

- The page head carries "Last changed …" or nothing. It used to say "Using the
  values from the environment", which described a deployment detail rather
  than anything about the screen.
- Say a warning **once**. The credentials warning was under both the
  description and the attachments, which is how a warning stops being read.

---

## Everything is in the UI

All under **Settings** (one nav link for admins): Integrations (Entra ID -
Authentication and Provisioning), Users (Local users, Entra ID), Groups,
Ticket templates, Mail (incl. Approval page), Customisation (Appearance,
Attachments, Requester portal), Audit trail. Old URLs 308-redirect, whole
subtrees.

### Users are two tabs, and local sign-in can be switched off

- **Local users** lists password accounts; **Entra ID** lists directory
  ones and cannot be opened until Entra is connected (SSO configured or SCIM
  on). The hidden mail account is in neither. `listUsers({ kind })` filters
  in SQL.
- **CSV import** (`services/local-import.ts`): a template to download,
  columns email, display_name, role, password. The sheet is checked whole
  and **one bad row imports nobody**; an existing address is skipped, so a
  re-upload is harmless; the template's example.com rows are refused so they
  cannot be imported by accident. Comma or semicolon - Excel writes
  semicolons in most of Europe. Generated passwords are shown once on the
  result page (rendered, never put in the session) and must be changed.
- **Disable sign-in with local accounts** hides the form on /login and
  refuses POST /auth/local. Refused unless Entra sign-in is configured *and*
  an active Entra account is already an administrator - otherwise it would
  lock every administrator out. **`FORCE_LOCAL_SIGNIN=true`** in the
  environment turns it back on without touching the stored choice: the way
  back in if Entra later breaks.
- On /login, email and password are the default, open on the page;
  Microsoft is offered underneath once configured.

### The break-glass account has a tab; sign-in codes have two switches

Users has three tabs: Local users, Identity providers, **Break-glass
account**. `listUsers({ kind: 'local' })` leaves `admin@local` out; its page
is `/admin/settings/users/break-glass` (`/users/<its id>` redirects there,
and every action on it returns there through `userUrl()`).

**Sign in with a code sent by email** (`auth/sign-in-codes.ts`, migration 31
`local_signin_codes`) replaces the password, it is not added to it:

- One switch for local users (Local users tab), with a user group that keeps
  passwords; a **separate** switch on the break-glass tab, off by default -
  a mailbox outage must not lock out the account that exists for outages.
  The local-user switch never covers break-glass.
- Refused without a mailbox, and for break-glass while its address is
  `@local` (`cannotEnableCodes`). `FORCE_LOCAL_SIGNIN=true` puts
  break-glass back on its password without changing the stored choice.
- Six digits, stored as a hash, 5 minutes, 5 tries, single use, at most one
  mail a minute per account. The sign-in page reads the same for an unknown
  address and sends nothing. A code account posting a password is sent back
  to /login - checked **before** the password, so no lockout counts.
- **Signing in is two steps, as Apple does it**: `/login` asks for the
  address only (`POST /auth/local/identify`); a code account is sent its code
  and goes to `/login/code`, everybody else to `/login/password` - **an
  address with no account too**, so step one does not reveal who has one. A
  refused password is said on the password page, not an error page. The
  pending address sits in the pre-auth session (`signinEmail` / `otpEmail`);
  "Use a different address" (`/login?change=1`) starts over with it filled in.
  `POST /auth/local` still accepts email and password together.

### Dashboards: shown to requesters, fed by technicians

Settings - Dashboards (`services/dashboards.ts`, `routes/dashboards-admin.ts`,
migration 32). Two tabs: **User dashboards** and **Locations**.

- A dashboard is a **built-in row** (`dashboards`, id a readable slug such
  as `technician-availability`), off until switched on. On, it shows above
  My tickets **in the standard look only**, and wherever a custom portal
  writes `{{dashboard:<id>}}` - never both, so it is not drawn twice. Off,
  the variable renders nothing. `partProblems` refuses an id that is not a
  dashboard; approval pages cannot use it.
- It is drawn **before** `composePortal` (`dashboardsForPortal`), because
  composing is synchronous and drawing reads the database.
- **Standard design or the administrator's HTML** with its own variables
  (`{{title}}`, `{{date}}`, `{{today}}`, `{{week}}`, counts). Same refusals
  as portal parts: no script, `on*=`, or inline style. The preview is a
  framed page (`allowOwnFrames` + `allowFramingBySelf`), as a requester in
  no user group sees it.

**Four kinds** (migration 39): Technician availability, **My tickets**
(the reader's own counts and latest five - only their own), **Announcements**
(notices with a severity and a from-until; with nothing current the
dashboard shows nothing at all) and **Service desk at a glance** (open,
raised today, median resolution over 30 days - nobody named). Each kind has
its own design variables (`VARIABLES_BY_KIND`); `designProblems(html, kind)`
refuses another kind's.

**An administrator can set it for them** on their page under Settings -
Users (somebody off sick is the person least likely to log in and say so),
audited as `availability.*`. Both pages mount the same router
(`routes/availability.ts`).

**Technician availability**: a technician (agent, or admin in a technician
group, break-glass included) sets a **usual week** and **dated entries** on
their profile page, shown only while the dashboard is on. The newest dated
entry covering a day wins over the week. Days are counted in the Locale
time zone.

- **Statuses** not ticked under "Statuses shown by name" read only
  Available / Not available. Sick day is unticked by default - why somebody
  is away is not every requester's business.
- **Locations** are shown to everyone or to listed user groups; a reader
  who may not see one sees the status without it. Staff see all.

### Automation: HTTP steps, connections, and the editor

Settings - Advanced - Automation (`routes/automation-admin.ts`): the list,
and the editor - a **diagram drawn on the server** as inline SVG (dashed =
still needs settings), a short list of the **Trigger** and its actions, and
**each step's settings in a popup** (`#edit-<id>`, a :target dialog; with
the canvas script it opens in place). A box in the diagram opens its popup;
adding an action lands in the new action's popup.

**One output may lead to several actions** (a trigger with three actions).
`connect()` adds a wire rather than replacing one; the popup's ticked
targets go through `setTargets()`, which keeps the wiring order. The engine
walks **depth first, in wiring order** - everything after one action runs
before the next action of the same trigger - still capped at MAX_STEPS.

**Right-click on the canvas** (the script): on an empty spot, add an action
there (posting x/y); on a step, add one after it (for an If, on its Yes or No
branch), edit it, or remove it. The menu is server-drawn markup, every item a
form post.

**The canvas** (`public/js/automation-canvas.js`, the third approved script):
drag a box to move it, drag from an output dot onto another box to wire
it. Each gesture is a form post (`/nodes/:id/move`, `/nodes/:id/connect`)
and a reload - no client state, no fetch, the server re-checks everything
(nothing may lead into the trigger). Positions are the stored `x`/`y`;
while boxes still overlap (graphs built before the canvas) the diagram lays
them out in columns itself, and the **first drag fixes every box where it
was drawn** (`setPositions`) so nothing jumps. **Arrange automatically**
re-lays the columns. A new step is placed beside what it follows.

**Automations that call out run in the background** (`onEvent` in
`services/automation.ts`): an API's timeout and retries must not hold up
the requester raising the ticket. Ones that only change the ticket still
run at once, so the page the requester lands on shows what they did.
`settleAutomations()` waits for the background ones - the tests use it, and
shutdown calls it before closing the database.

**Send HTTP request / Send authenticated HTTP request**
(`services/automation-http.ts`): method, address, query parameters,
headers, body (JSON, form, text), timeout (1-30 s), output name, on failure
stop/continue.

- **Variables** `{{ticket.reference}}`, `{{ticket.title}}`... and the output
  of an earlier step `{{name.status|ok|body|error}}`, `{{name.json.a.b}}`,
  `{{name.header.x}}`. Each is **encoded for where it lands**: URL-encoded in
  the address and query, JSON-escaped in a JSON body, newlines stripped in a
  header. The **host may not contain a variable** - ticket text must never
  choose where a request goes. Add a comment and If can read the same values
  (If has "A value from an earlier step").
- **Authorization and Cookie headers are refused** in both steps:
  credentials belong in a connection, not in a graph that is shown and
  audited.
- **The transport** (`services/http-client.ts`, no dependency): https only;
  private, loopback, link-local and metadata addresses refused **at the
  socket's own DNS lookup**, so DNS rebinding cannot get past the check;
  redirects not followed; 1 MB answer cap; timeout over the whole
  exchange. "Allow HTTP steps to call the private network" (off, audited)
  lifts the address rule and permits plain http to private addresses only.
- **The log never holds the query string, headers, body or token** - only
  method, origin and path, status and time.
- A step **re-checks its settings when it runs**, because an enabled
  automation can still be edited.
- **Save and test** in the step's popup (`testHttpStep`): saves, then sends the
  request once, now, with an **invented sample ticket** - a test must not send
  a real requester's ticket to another system - no retries, and empty values
  for earlier steps. The answer (status, type, first 1,500 characters) is
  shown once in the popup (`session.httpTest`); audited without the body.
- **Retries** (0-3): on a network failure, 429 or 5xx, never on another
  4xx or on our own refusal; 1, 2, 4 seconds, or the server's
  `Retry-After` capped at 30 s. The log says how many it took.

**Connections** (Settings - Advanced - Connections,
`services/automation-connections.ts`, migration 33): OAuth 2.0 client
credentials. The secret is sealed with secret-box, never shown again, blank
on edit keeps it, and is never put back into a refused form. Client auth in
the body or as HTTP Basic (RFC 6749 encoding); optional scope and audience.
**Three types** (migration 36, `auth_type`): OAuth 2.0 client credentials,
an **API key** in a header of the administrator's choosing with an optional
prefix ("Bearer ", "Token "), and **Basic**. The dialog shows only the chosen
type's fields (the radio-sibling technique); each type's inputs have their
own names, because hidden panels still post. `authHeader()` is the one place
a request's credential is built; only OAuth retries a 401 with a fresh one.

**Access tokens live in memory only**, reused until a minute before expiry,
one request shared by concurrent steps; a 401 from the API drops the token
and retries once. Token errors repeat only the OAuth `error` code, never
its description (which can echo input). **Test** fetches a fresh token. A
connection in use cannot be removed.

### The approval page is a kind of portal

Settings - Mail - Approval page uses the **same list, editor and preview as
the requester portal**: `portal_themes.kind` (migration 21) is
`'requester'` or `'approval'`, `makePortalAdminRouter(config)` is mounted
twice, and the default flag is unique per kind. An approval design is a
layout with `{{content}}` (the request and its form) plus CSS; it has its
own variables (`{{ticket_reference}}`, `{{ticket_title}}`,
`{{requester_name}}`, `{{approver_email}}`) and cannot use the requester
ones, nor be assigned to groups. Its preview is a **sample request**
(`/:id/sample`), with the form `inert` - a real one would be somebody
else's to answer.

### SLA: targets per priority, in business time

Settings - Ticket templates - Other settings - SLA (Reference prefixes is the
other sub-tab). `services/sla.ts`. **Off by default**: a target nobody chose
would mark tickets breached for no agreed reason.

- **Nothing is stored per ticket.** Due = created_at + target in business
  minutes; "responded" = the first public comment or status change by
  someone other than the requester (`firstResponseAt`), **never one marked
  `automatic`** - an automation acts as a real account, so its run is wrapped
  in `asAutomatic()` (events.ts) and comments and events written inside carry
  `automatic = 1` (migration 56; a ticket closing by its tasks too). An
  automatic close still resolves. "resolved" =
  resolved_at, else closed_at. So old tickets read sensibly and a changed
  target re-reads everything.
- **Business time is time-zone aware without a library**: `Intl` gives the
  offset, `zoned()` asks twice so a DST change is right. Tests cover Friday
  evening -> Monday and the October clock change.
- Shown to **staff only**: both clocks on the ticket, and a badge in the
  queue only when at risk (last 20%) or breached.
- **Pause on hold** (a switch): the business time a ticket spent On-hold,
  from its status history (`holdPeriods`), is added to the **resolution**
  target, and while it waits the clock reads **Paused**. The response clock
  is not paused - answering is what putting a ticket on hold involves.
- **Public holidays**: `2026-12-24` that day, `12-25` every year; days off
  for every clock. Note `localDate()`'s month is **0-based**, like Date's.
- **Notify the group manager** (checkbox): `sla-alerts.ts`, a sweep every
  15 minutes. `sla_notifications` (ticket, clock) is written **before** the
  mail is queued, so each breach is told once. Notification
  `ticket.sla.breached`, audience `manager`, placeholders `{{slaClock}}`
  and `{{slaDue}}`. Nothing is queued without a mailbox - a test that
  expects mail must create one.

### Technician groups have rules too

`services/technician-rules.ts`, migration 34: the user-group rule model
(attribute, comparison, value; any rule matching is enough) for technician
groups. **A rule only ever adds active agents and administrators** - a queue
is no place for a plain user. Membership rows carry `source`: hand-picked
ones stay whatever the rules say (and every hand-written membership write
touches only `'manual'` rows); rule ones are recomputed on sign-in, on a
profile edit and on a **role change** (promotion can bring somebody in).

### API keys start automations; they are not an API

Settings - Advanced - API keys (`services/api-keys.ts`, migration 41). A key
starts an automation whose trigger is **An HTTP request is received** and
names that key: `POST /hooks/automations/:id`, `Authorization: Bearer
hd_...`, a JSON body with `"ticket": "INC-000123"`. The body reads as
`{{request.json.x}}` in later steps (it is a `StepOutput` named `request`).

- **The secret is shown once**, on the page the create renders - never put
  in the session or a redirect. Only its sha256 is stored.
- **A key runs only the steps ticked on it** (`allowed_actions`, JSON).
  Checked when the automation is switched on (`keyProblem`), before a
  request runs anything (403), and per step during the run - so a key
  narrowed afterwards stops at once.
- **Refusals don't tell a prober anything**: a missing key, a wrong one and
  an automation that does not exist are all the same 401.
- Mounted beside SCIM, ahead of sessions and CSRF, with its own JSON parser
  (64 KB), its own rate limit and JSON errors.
- The trigger's key field shows only while that trigger is chosen:
  `option:checked` inside `:has()` (`.only-http`) - a select's chosen
  option is matchable, so no script.

### Changing tickets with an API key: POST and PATCH /api/v1

Asked for 18 Oct 2026: the API keys could start an automation or read, and
nothing else, so every change from another system needed an automation
built first. `routes/api-write.ts` now takes the same actions directly:

- `POST /tickets` (from a template by name; requester by email, a stranger
  on the hidden account; priority, group, assignee optional),
  `PATCH /tickets/:ref` (status, priority, group, assignee - any of them),
  `POST /tickets/:ref/comments`, `POST /tickets/:ref/notifications`,
  `POST /templates`, `POST /notifications`.
- **The permissions are the automation steps' own ticks** (KEY_ACTIONS), one
  per change sent: a key that may comment cannot close.
- **Done as the key's author**, who must still be an active administrator or
  technician (403 otherwise), and audited `api.*`.
- **The pages' rules hold**: approval awaited or a task open blocks closing
  (409), On hold needs a `note`, cancel and resolve notes follow Settings,
  an assignee must be active staff, a group must exist. `updateTicket`
  checks none of the last three itself, so the router does.
- Mounted **before** the read router, which refuses a key without Read
  tickets whatever the method; the write router passes every GET on.
- The examples (`WRITE_EXAMPLES`, `apiWriteGuide`) are generated in all nine
  languages by `apiSnippet`, which takes the method.

### Mail queue: urgent first, one sender

`flushOutbox()` is single-flight: a call while a pass runs asks for another
pass rather than starting a second sender, which would send rows twice.
`mail_outbox.urgent` (migration 42) puts a sign-in code ahead of any
backlog, and `sendSoon()` sends it now instead of waiting for the 30 s timer
- the code expires in 5 minutes. Throughput is 25 per pass, one at a time;
Microsoft 365 itself allows about 30 messages a minute per mailbox.

### Conditional access for password accounts

Settings - Users - Other settings (`auth/conditional-access.ts`, asked for
16 Oct 2026). Three decisions and a fourth list:

- **Addresses sign-in is allowed from**, as CIDR ranges (IPv4 and IPv6).
  Empty means anywhere, which is what every service desk starts as.
- **Elsewhere, ask for a code by email** rather than refuse - the answer for
  somebody working from home on a desk that is otherwise office-only.
- **A code for every password account**, wherever they are.
- **The break-glass account's own list**, which the ranges above never apply
  to. Empty: anywhere, as before.

What it has to get right, and does:

1. **Password accounts only.** A directory account is its identity
   provider's to gate, and it has conditional access of its own; a second
   answer here would live where nobody would look for it.
2. **Checked after the password**, so a refusal says nothing a wrong
   password would not have said - and **before the must-change step**,
   because a temporary password is still a password. That order was wrong
   at first: must-change came first, so a temporary password went straight
   to "choose a password" and got a session with the address rule never
   applied. **Found by the owner testing it**, which is the kind of hole a
   test suite does not find on its own.
3. **The second step is a step, not a message.** `mfaUserId` sits in the
   pre-auth session; there is no session until the code is right, and
   `mfaMustChange` carries the password-change state through it so the two
   are asked for in turn.
4. **A code account is exempt from a second code, never from the address
   rule** (`codeSignInAllowed`). The code answers "who"; the ranges answer
   "from where".
5. **An address that cannot be read is not a refusal.** With no client
   address - a misconfigured proxy - the rule cannot be applied, and locking
   everybody out because of a header is worse than not applying it.
6. **`FORCE_LOCAL_SIGNIN=true` ignores the break-glass list**, which is the
   documented way back in when the allowed network is the thing that broke.
   The page says so, because that is the one sentence that prevents the
   lockout this feature can cause.
7. **The same parser validates and applies** (`parseRange`), so the page and
   the gate cannot disagree; a bad line is refused where it was typed.
8. **The page no longer says which address the service desk reads.** It
   did (reported 16 Oct 2026: ranges typed from a public address while the
   server saw `::1`), and the owner asked for the line to go (21 Oct 2026).
   A browser on localhost still arrives as the loopback address.

### Custom roles (21 Oct 2026)

`auth/permissions.ts`, migration 65 (`roles`, `users.role_id`), Settings -
Users - Roles. A role is a name and ticked permissions (PERMISSIONS: ticket
work and deleting, Reports, the directory, each Settings section,
automations, API keys). **Everybody keeps a base role** in `users.role`,
which every older check reads: a role with "Work on tickets as a
technician" makes its people agents, any other makes them users, none an
administrator. The ticks are checked through `can()` where each thing is:
the Settings entrance (`routes/admin.ts`, by the path's first part),
Reports, deleting a ticket, the directory, the sidebar and Settings list.
Built-ins keep what they had (admin everything, agent ticket work and
Reports). **Only an administrator** opens Roles, gives anybody a role, or
creates or imports anything but a user - somebody with Users cannot raise
anybody, themselves included. Roles are cached in memory like settings().
Part 2 (same day): **See every ticket** (without it, `ticketScope()` limits
listTickets, ticketCounts and `canSeeTicket()` to the person's groups'
tickets and their own; anything else is a 404), **Change tickets** (update
and Assign to me; without it the panel reads only), **Internal notes**
(`seesInternal()`: listComments, listAttachments, the download, the reply
box's tab). The built-in agent has all three, as before.

**The security review (same day)** closed three ways round the ticks:

- **An administrator's account is changed only by an administrator.**
  `load()` in users-admin.ts refuses any POST about an administrator (or
  break-glass) from anybody else: with Users alone, a password set or an
  address changed there was that administrator's account.
- **How everybody signs in stays an administrator's**: break-glass, local
  sign-in, sign-in codes and conditional access (`permissionForSettingsPath`).
  The path is **lower-cased first** - Express routes ignore case, so
  `/users/ROLES` reached the Roles page while the gate read "users".
- **An API key never does more than its author's role** (api-read.ts,
  api-write.ts): the author must still be an active administrator or
  technician (reads too, now), `canSeeTicket` and `ticketScope` limit it,
  internal notes and files need `seesInternal` as well as the key's tick,
  changes need `tickets.edit`, templates `settings.templates`,
  notifications `settings.mail`.

Still by design, and worth knowing: **Build automations** and **Groups** are
powers over every ticket (an automation acts on any ticket; a group's
members see its tickets), so give them as you would administration.

**Permission levels** (22 Oct 2026). A permission with `levels` (every
Settings section, automations, API keys, assets, internal notes) is chosen
as None / Read only / Read and write - three radios, so the two can never
both be set - in a role form grouped under chevrons. **Read and write is
the key itself** (so a role from before keeps its meaning), read only is
`<key>:read` (`READ`); `clean()` drops a read-only grant beside its
read-and-write one. `can()` is read and write; `canRead()` is either.

- Settings (`routes/admin.ts`): a GET needs `canRead`, anything else `can`;
  a section seen read only is drawn inside a disabled `<fieldset>`
  (`settingsReadOnly`, `_layout.ejs`), so every control is off without a
  script, and the gate refuses a post anyway.
- Assets: read only opens the list and pages (`canEditAssets` hides the
  ways to change them); a post is a 403.
- Internal notes: read only sees them (`seesInternal`); writing one, or an
  internal file, needs read and write (`writesInternal`).
- Look-only and one-action permissions (Reports, People directory, Delete
  tickets, See every ticket) stay a single tick box, by the owner's choice.

### An authenticator app after the password (21 Oct 2026)

`auth/authenticator.ts`, migration 64 (`user_authenticators`), the same as
the customer portal's src/mfa.ts: RFC 6238 (SHA-1, 30 s, six digits), the
secret sealed with secret-box, the last step kept so **a code works once**
(only the sign-in whose update moved it wins - reading it back let two
racing with one code both in),
ten recovery codes stored as hashes. Set up on /profile (password accounts
only; an identity provider's account has its own second step, a code
account already has one). At sign-in it comes after the password and the
address rule, **instead of** conditional access's emailed code (one second
step, never two), and before the must-change step. Five wrong codes and the
password is asked again. Turning it off needs a current code; an
administrator removes it from the person's page (lost phone and codes).
The QR code is an SVG drawn on the server by `uqr`, no script.

### The sign-in code is one field, and was three attempts

`.code-entry`: one input, centred, with wide tracking. It used to draw six
boxes behind the input and space the digits to land in them - which needs
the box pitch and the glyph advance to be the same length, and on a phone
they were not. **Reported three times**: measured in rem, then in ch, then
with the field trimmed to the boxes, and each fix held on a desktop and
failed on the phone. The cause found last was a second rule further down
the stylesheet that shrank the boxes on a narrow container and left the
letter spacing alone, so only a phone broke.

The boxes are gone. One field has nothing to line up with, so it cannot
drift; paste, autofill and `autocomplete="one-time-code"` keep working,
which is what the single input was always for. **If boxes are ever wanted
again, draw them from the same length that advances the text** - and
expect to test it on a phone, because a desktop will not show the bug.

### Dashboards can be copied

**New dashboard** on Settings - Dashboards copies a built-in kind
(`COPYABLE_KINDS`) with its design, switched off, with a slug id for
`{{dashboard:<id>}}`. What makes a copy different: Technician availability -
its technician groups; Service desk at a glance - which technician groups'
tickets it counts (`serviceDeskGroups`, empty is all); Announcements - its
own notices (`announcements.dashboard_id`, migration 44; deleting the copy
deletes them); My tickets - only its design. Built-ins
(`BUILT_IN_DASHBOARDS`) cannot be deleted.

**Any dashboard can be renamed** (the Name card on its page,
`renameDashboard`, audited `dashboard.renamed`). Only the name changes - it is
the title requesters see; the id stays, because a portal wrote
`{{dashboard:<id>}}`. A name another dashboard has is refused on the page.

The availability list includes the **break-glass admin when it is in a
technician group**. It used to be excluded outright, which looked like a bug
to the person who had just put it in a group.

### Single sign-on: a form that redirects off-site needs form-action

"Sign in with ..." posts to /auth/login, which redirects to the identity
provider. **Chrome applies `form-action` to that redirect**, so under
`form-action 'self'` every SSO button silently did nothing - found while
testing the generic provider; it affected Entra, Google and Okta alike. The
sign-in page now adds each configured provider's authorization origin
(`authorizationOrigins()` + `allowFormActionTo()`), and the connections
page does the same for "Sign in" on a person-OAuth connection. Every other
page keeps `'self'`. A test asserts the header.

### Generic OpenID Connect

Settings - Integrations - OpenID Connect (provider key `generic`, settings
`genericOidc`): any provider with a discovery document - Keycloak, ADFS,
Authentik, Ping... Same code path as the others. Its own checks: the
discovery document must name the **configured issuer** (a typed URL is not
ours to trust), an email the provider calls unverified is refused (no claim,
as ADFS sends, is accepted), optional allowed email domains. The button
reads "Sign in with <name>". Local sign-in can be disabled once an
administrator signed in through it.

**Internal addresses are refused** (security review, 21 Oct 2026,
`refuseInternal` in oidc.ts): for the generic provider and Okta, every
address the server will fetch - the discovery document, token, keys,
userinfo - is looked up first and refused when it is private (10.x,
192.168.x, localhost...), unless "Allow addresses on the internal network"
(`genericOidc.allowPrivateNetwork`) is on, for a Keycloak or ADFS inside
the company. Checked at discovery, so a later DNS change is not caught;
an address that does not resolve is left to the fetch. SAML is still not built - see HANDOFF.

### Connections: five types

OAuth 2.0 (app), **OAuth 2.0 (person)**, API key, Basic, **Client
certificate**. Migration 45 rebuilt the table to widen the CHECK.

- **Client certificate (mTLS)**: PEM certificate (public, shown with subject
  and expiry) and private key + passphrase (sealed). `certificateProblem()`
  refuses an expired certificate or a key that does not belong to it.
  `credentialsFor()` returns `tls` instead of a header; `sendHttp` passes
  it to node:https.
- **OAuth as a person**: authorization code with PKCE. "Sign in" stores
  state and verifier in the session (10 minutes); the callback
  (`/admin/settings/advanced/connections/oauth/callback`) checks the state
  and keeps the **refresh token, sealed**, plus who signed in. Access tokens
  come from the refresh token; a rotated one replaces it. No refresh token
  is refused (it would die in an hour). Changing where it signs in forgets
  the sign-in.

### Automations: Create a ticket, values from the request, examples

- **Create a ticket** (`create_ticket`): raised from a template like a mail
  rule's ticket (`raiseFromRule`, with the template's tasks); requester from
  an address (may be `{{request.json.email}}`; a stranger gets a ticket,
  never an account), else the run's ticket's requester. **Later steps act on
  the new ticket.** A run may therefore start with no ticket (an HTTP request
  without "ticket"); a step that needs one stops it, and the endpoint answers
  400 saying so.
- **Set status / Set priority** can read their value from the request or an
  earlier step (`status: 'variable'`); stored value or label, any case;
  anything else stops the run rather than guessing.
- **If - Template it was raised from.**
- **An API key may be limited to templates** (`api_keys.template_ids`,
  migration 46): a ticket from another template answers 404, as if absent,
  and Create a ticket may use only those.
- **SLA is breached** trigger: `announceSlaBreaches` (every 15 minutes),
  once per ticket and clock (`sla_breaches`, migration 43); a breach first
  seen more than a day late is recorded quietly, so switching it on does not
  fire for every old ticket.
- **Worked examples**, created once (`seed_markers`) and switched off:
  `ensureExampleAutomations`. The HTTP ones need an API key chosen.

### The custom-field library

Settings - Ticket templates - Custom fields (`services/custom-fields.ts`,
migration 47). Placing one on a template **copies** it with `libraryId`, so
forms, validation and answers need nothing new. Editing the library entry
rewrites every copy's label, type and choices in one transaction, keeping
each template's mode, width and placeholder; deleting detaches the copies
(they stay on their forms). The builder's "Add a custom field" can also save
to the library.

### Reading tickets: GET /api/v1

`routes/api-read.ts`. An API key with **Read tickets** (`read_tickets` in
`allowed_actions`) may GET one ticket (`/tickets/:ref`, everything incl.
SLA, tasks and file names), all of them a page at a time, or a filtered page (`/tickets?status=&type=&assignee=&template=&search=&createdSince=&
priority=&requester=&group=&updatedSince=&tasks=include&limit=&offset=`),
and its comments (`/tickets/:ref/comments`; internal notes only with
`read_internal`, and the answer says which). A key limited to templates
reads only their tickets - anything else is a 404 like a missing ticket.
Read-only, nothing is changed; mounted beside /hooks with the same limiter.
The API keys page documents it with the same language tabs.

### The automation diagram: fit, zoom, live wires, names

- **Fit by default**: the SVG has its drawn width and `max-width: 100%`, so
  it shrinks to the window and never grows past its size. **Zoom** (- / Fit
  / +, Ctrl + wheel) is the canvas script's: it sets the SVG's width and the
  box scrolls; the zoom is kept per automation in sessionStorage so the
  reload after a move does not reset it. Positions are read through
  getScreenCTM, so drag and the right-click menu work at any zoom.
- **Wires follow a dragged box live**: the script redraws the wires into and
  out of it, and its Yes/No labels, with `curve()` - the same shape
  `wirePath()` draws on the server. Keep the two in step (the script
  hard-codes BOX_H 58).
- **Dot to dot.** Every step but the trigger has one input dot on its left;
  every wire ends there (they used to spread along the edge). A wire into a
  box to its left does not loop: out right, along a channel between the
  boxes (or under both when they overlap vertically), in from the left.
- **Removing one wire**: each wire has a wide invisible twin
  (`.automation-diagram__wire-hit`, carries from, pin, to); clicking or
  right-clicking it opens the canvas menu with "Remove this connection",
  which posts `/:id/disconnect` (`disconnect()` removes that wire only).
  Without the script, the step's popup ticks do the same.
- **The wheel zooms** over the diagram, towards the pointer (it was
  Ctrl + wheel); the page scrolls with the wheel anywhere else. The window
  is at least min(55vh, 34rem) and at most 85vh tall. A dragged box is
  moved to the end of its group (drawn on top) once it really moves - not
  on press, which would break a plain click.
- **The drawing grows while a box is dragged** (`grow()` in the script):
  the SVG is only as big as its boxes, so a box dragged past its edge was
  clipped until the reload - reported with a video. The window also scrolls
  when the pointer nears its edge, and a box cannot go above or left of 0.
  Zoom reads the size from the viewBox each time, so it survives the growth.
- Several wires into one box enter at separate points; Yes/No labels sit by
  their dots. A box names what it means: "Template is Default request",
  never an id (`summary()` resolves templates, groups, user groups,
  connections and labels; short field words, since a box holds ~34
  characters).

### Automations that create templates and notifications

Two steps that need no ticket: **Create a ticket template**
(`create_template`, `createTemplateFrom` in templates.ts) and **Create a
notification** (`create_notification`, a custom notification through
`createCustomNotification` with the wording supplied). Both can be allowed on
an API key, and both say what to do when the name is taken: **leave that one
and go on** (default - another system sending the same thing twice is
harmless) or **stop the run**.

- A template is a copy of **Based on** (form, defaults, routing - never its
  tasks) or the standard five fields; its kind is fixed or read from the
  request (never Task: a task template needs a parent). It is **not offered
  to requesters** unless the step's "Offer it" is ticked - something another
  system made is checked by a person first.
- A notification's subject and body keep **its own placeholders**
  (`{{reference}}`, `{{title}}`... filled at send); only dotted automation
  variables (`{{request.json.x}}`, `{{ticket.x}}`) are filled at creation
  (`fillOwnVariables`), and only those are checked for unknown names.
- **A second set of examples** (`LATER_EXAMPLES`, seed marker
  `example_automations_2`) is added once to databases that already had the
  first: "another system adds a ticket template and its notification".
- The automation list has a **bin per row**, a link to a `:target`
  confirmation (`#delete-<id>`, closes to `#row-<id>`). `bin-button.ejs`
  takes `href` for that.

### Files sent to an automation

An "Attach the files from the request" step (`attach_files`, and a box on
the API key) stores what the request carried, through the same store as an
emailed file (`storeIncomingAttachments`: type from the bytes, size and
per-ticket limits, duplicates once, refusals in an internal note). Two ways
in: JSON `"files": [{"name", "content": base64}]`, or multipart/form-data
(Postman form-data). **The key is checked before the body is read** - the
body limits are large (40 MB JSON, 20 files), so only a key holder can make
the server read one. Later steps see each file as name and size, never its
bytes.

### The technician's and manager's dashboard

`/dashboard` (`services/work-dashboard.ts`), for **every technician and
administrator** (it once needed a technician group, so an administrator in
none never saw it - reported). **My work**: four figures over "my desk" (my
groups' tickets and mine; an administrator in no group, every ticket): Open
with its 24 h change, Raised in 24 h against the 24 h before, **SLA met**
(30 days - `buildReport()`'s own figure, so it always agrees with Reports;
imported dynamically, since reports.ts imports this file) and At risk.
Assigned to me with each **clock in words** (`slaOf()`: "Responds in 1 h
12 m", "Due Fri 12:00", "Paused - on hold", "9 d overdue", "Met by 3 h").
**Activity** merges ticket events, people joining my groups (at most two
lines) and automation runs (at most three; an administrator's all, anybody
else's on tickets in scope), with my clocks at risk or breached on top.
Then unassigned in my groups, my groups' counts. **Manager**: the groups a person manages (an
administrator: all), filtered by a GET select - "All my groups" by default,
and a group they do not manage is ignored - with counts, workload per
technician, at risk or breached, and waiting longest. A manager in no group
of their own lands on Manager. A requester gets a 404.

### A popup shown by :target is closed by changing the fragment

The builder and automation scripts open and close popups with a class, in
place. A popup can also be open because the **address** names it - a new
action arrives as `#edit-<id>`, a link may carry `#field-<key>`. Removing
the class does not close that one, and `history.replaceState` does not make
a browser re-check `:target` either - Cancel, the cross and Escape did
nothing. Both scripts now `location.replace()` to where the close link
points and restore the scroll position.

**Two classes, two jobs.** `.dialog--open` is the server's reopen after a
refused save, and app.css hides it as soon as the address names anything else
(that is how its close links work). A popup a script opens uses
`.dialog--shown`, which that rule does not touch. Using `.dialog--open` for
both made every popup on the automation page invisible once the address was
`#diagram` (after a move) - "the buttons lock until I leave and come back".

### API key examples in eight languages

`services/api-examples.ts`: each example's request written in cURL, Postman (the settings to fill in),
PowerShell, Python, JavaScript, C#, Java, Go and PHP, generated from one body.
**One language bar** sets every example (radios before the bar and the list,
CSS shows the matching `.api-snippet--<lang>`). The key is always read from
the `HELPDESK_KEY` environment variable, never shown as a place to paste it.

**Hidden radios must not sit directly in a grid.** `.card.stack` is a grid,
and an absolutely positioned child of a grid is placed at the grid's top - so
clicking a tab focused a radio up there and the page jumped to it. They live
in `.api-lang-switch`, a plain block, which keeps them by the bar.

### The Requester field, and a phone number

A built-in field `requester` (view only, nothing posted): shows who is
raising the ticket, with the details ticked in its gear (`details`: email,
phone, department, job title, office; default email and phone). The ticket
page shows the same details of the requester to staff when its template has
the field. `requesterDetails()` is the one place both read.

`users.phone` (migration 48): from SCIM `phoneNumbers` (work, else primary,
else first), the CSV import, or an administrator under Users. A rule
attribute. **The CSV template now carries every attribute** (phone,
department, job title, office, extension attributes 1-3); an empty cell is
left empty, and a sheet may carry any subset of columns.

### Private custom images

`custom_images.is_private` (migration 49): /images/<id> answers only a
signed-in person; anybody else gets the same 404 as a missing image, and it
is cached `private`. Emails are unaffected (the bytes travel as
`cid:image-<id>`). Not for anything seen before signing in.

### Every script and stylesheet is versioned

`assetVersion()` hashes **every file** in public/css and public/js. It used
to list three by hand and missed automation-canvas.js, so a fixed canvas
stayed cached for a week and looked unfixed.

The canvas itself: a move captures the pointer only once it really moves
(capturing on press sent a plain click to the svg, so a box's link never
opened), and a release anywhere - the window, a lost capture, Escape, blur -
ends the drag (a missed release left the box half-dragged and swallowed its
clicks until a refresh).

### Small things that changed how pages look

- "(set by this template)" / "Set by this template." are gone from the
  builder and the ticket form; the approval explanation is an ⓘ.
- A ticket raised on behalf of somebody reads "<raiser> raised this for
  <requester>" at the top.
- The portal editor's preview has **Computer / Phone** (390px), the
  radio-sibling technique. The standard look is already responsive; a
  custom portal adapts with @media rules in its CSS.

- The ⓘ mark is a **mask over the text colour**, not a letter i in a circle
  (which never sat in the middle). The "i" stays in the markup.
- `input[type=url|tel|date|time|datetime-local]` share the text-input style;
  url was missing, so every address field was unstyled.
- **Remove in a row is the bin, at the right** (`td.row-actions` is
  right-aligned). Danger-zone buttons that say what they remove ("Remove this
  group") keep their words.
- **Appearance - Font**: `FONTS` in branding.ts, emitted as `--font` in the
  theme stylesheet; installed fonts only (font-src is 'self'). Helvetica
  falls back to Arial on Windows.
- **Mail tabs**: Mailboxes, Other settings (General, Notifications, Approval
  page, SMTP relays), Advanced settings. The addresses did not move.

### Technician groups have managers - several

`technician_group_managers` (migration 57; one manager per group was
`technician_groups.manager_id`, migration 24 - now vestigial, kept as the
first manager). Each an active agent or admin, not necessarily a member.
`groupManagers()`, `setGroupManagers()` (`setGroupManager()` remains for one
or none). Managing gives the group in Reports and the Manager dashboard
(`managedGroups`), its SLA alerts (audience `manager`: every manager) and
the deletion email (`manager_or_admins`). Added and removed one at a time
on the group page, found by a live search of **eight at most** (`mq`) -
never a dropdown of every technician (asked for 15 Oct 2026). Lists of
names are read in one query per page (`withManagerNames`), never with
`group_concat`, which PostgreSQL does not have.

### Templates have a tab per ticket type, and a starter each

Service request, Incident, Change request, Task, Change task (beside All).
Task and Change task list *task templates*, told apart by their parent's
type - the same rule as `prefixFor()`. `ensureStarterTemplates()` runs at
start-up **once ever** (`seed_markers`, migration 25), so a deleted starter
stays deleted; a kind that already has a template gets none. The starters
are created *after* the default, and never take the default flag.

### Users: filters, user groups, extension attributes

- Users can be filtered by role, technician group and user group (in SQL,
  each condition pushed with its parameter); the table shows user groups.
- `users.extension_attribute_1..3` (migration 23) are rule attributes for
  dynamic user groups. SCIM reads `extensionAttributeN` at the top level or
  under **any** `urn:` extension schema, since Entra lets the tenant name it.

### Custom images

Settings - Customisation - Custom images (`services/custom-images.ts`).
Same checks and storage as the logo; served publicly at `/images/<id>`.
Each offers two snippets because a browser and a mail client differ: a web
`<img src="/images/<id>">`, and `cid:image-<id>` for notifications, which
`inline-images.ts` resolves at send time like `cid:logo` (PNG/JPEG/GIF,
100 KB). Rows are collapsed `<details>` with search.

### The 2026 design: a sidebar shell

Signed in, and not on a custom portal or a framed preview, every page sits
in **the shell** (`partials/header.ejs` opens it, `footer.ejs` closes it -
**on the same test**, `shell`, so keep the two in step): a sidebar
(Dashboard, Tickets, New ticket; for administrators Automation, Groups,
Users, Settings; colour mode and the person at the bottom) and a search bar
above the page (a GET to `/tickets?q=`). Signed out, the plain masthead.

- **No script.** On a narrow screen the sidebar is hidden until the address
  is `#sidebar` (the menu button) and closes to `#top` - the dialogs'
  :target technique.
- **Only the theme's variables.** The design layer at the end of app.css
  mixes everything from `--brand` and `--surface` with `color-mix()`:
  `--grad` (primary buttons, the current sidebar item), `--tint-a..f`
  (pastel cards, redefined for dark mode). Appearance colours and dark mode
  therefore keep working; never hard-code the indigo.
- **Defaults** are electric indigo `#635bff` on midnight navy `#101828`,
  font Inter when installed. `adoptNewDefaultColours()` moves a helpdesk
  still on the old untouched red (`#a3182f` / `#1d1d1b`) once at start-up
  (seed marker `branding_2026`); chosen colours are left alone.
- **Icons** are `partials/icon.ejs` (inline SVG by name), **ticket status
  pills** have a dot and capitals, the **dashboard** (`/dashboard`, My
  work) is greeting, four pastel figures, Assigned to me as cards, an
  Activity feed (`recentActivity()`: the latest `ticket_events` on my and
  my groups' tickets), Unassigned, My groups. A ticket's **SLA clocks** are
  two cards: time **to go** (or overdue) and when it is due.
- "New ticket" is in the sidebar and on the pages that need it, not in the
  top bar as well - asked for directly.
- **The sidebar folds to icons** (21 Oct 2026, "like Outlook"): the button
  beside the brand posts to `/sidebar`, a cookie (`helpdesk_sidebar`,
  middleware/theme.ts, like the colour mode) remembers it, and the shell
  gets `shell--compact`. Folded, each link's name is its `title`, the
  count a badge on the icon; unfolding is the same button. Wide screens
  only - under 900px the sidebar slides in and out as before.


### Linen and petrol (18 Oct 2026)

The last layer of app.css redefines the 2026 tokens: one 6px radius
(`--radius-lg` 8px), `--grad` is the brand itself (no blend), no glow and
no shadow. The defaults are petrol `#1a5d74` on ink `#16181d`, font Inter
(`system`); light mode's page is linen (`LINEN` in branding.ts) under white
cards, dark mode a near-black (#171D20) with a trace of the brand.
`adoptNewDefaultColours()` moves an untouched navy or indigo helpdesk once
(seed marker `branding_2026_petrol`). Quick colours: Petrol, Forest, Ochre,
Plum. Without an uploaded logo the mark is logo A, a CSS mask (`--mark`)
filled with the brand. The portal's `branding/entra` holds the same logo
for Entra and as every new helpdesk's starting logo and favicon.

### The Activity feed is chosen, and automation runs are the administrator's

**Migration 60** (`users.activity_kinds`). The feed on /dashboard carries
four sorts of line - tickets, service-level clocks, people joining a group,
automation runs - and each person keeps the ones they want, from the pen
beside the heading. Empty means everything they may see, which is what it
was before anybody chose.

- **Automation lines are for administrators only.** An automation is an
  administrator's machinery, and a technician reading "Automation stopped"
  can do nothing with it (asked for 16 Oct 2026).
- `activityChoice()` narrows whatever is stored **to the kinds that reader
  may see**, so posting the value is no way to keep a kind that is not
  theirs - the display and the rule are the same function.
- Everything ticked is stored as empty rather than as a list of four, so a
  later version that adds a kind gives it to them too.

### Last runs, across every automation

`/admin/settings/advanced/automation/runs`: the newest fifty runs with the
automation, the ticket, the outcome and how many steps it got through.
Each automation's own page already showed its own twenty, which answers
"what did this one do" and not "what has been running" - the question
somebody asks when a ticket moved and nobody moved it. Mounted **before
/:id**, which would otherwise read "runs" as an automation id.

### A dashboard can be a widget

A personal board (/boards) can show one of the dashboards from Settings -
Dashboards, drawn by `renderDashboard` with the board's owner as the
reader: a widget stores **which** dashboard, never what it said, so a
dashboard switched off or redesigned is reflected at once and nobody is
shown more than that dashboard would show them. A dashboard that is off, or
one that has been deleted, says so rather than drawing nothing - silence on
your own board reads as a bug.

### Automations shared with technician groups is designed, not built

[docs/automation-sharing-brief.md](docs/automation-sharing-brief.md):
read/edit access per technician group, a sidebar link that follows it, and
one rule worth knowing before it is built - **choosing a connection or an
API key in a step stays an administrator's decision even at edit**, because
a connection holds a credential and a technician could otherwise point a
request carrying the service desk's token at an endpoint of their choosing.

### Signed out there is nothing around the card

Every signed-out page is a sign-in page and carries the service desk's mark
in its own card (partials/signin-mark.ejs), so the masthead above it
repeated the logo and ruled a line across an otherwise empty window - "a
relict of the past". The colour-mode control went with it on the same
afternoon: left behind, it was one mark floating in a corner with nothing to
belong to (both 16 Oct 2026). It is in the sidebar, signed in, and nowhere
else - a chosen theme still reaches the sign-in page, only the control is
absent. Tests assert no `colour-mode` and no `class="topbar"` on /login and
/login/forgot.

The control wears a **palette**, not the half-filled circle, which read as a
contrast or accessibility setting rather than a choice of colours.

### The filter bar is one type size, and a label never leaves its control

Two reports on 16 Oct 2026, one after the other.

- It had labels at 0.82rem beside controls at the page size, above a table
  at 0.9rem - three sizes in a hand's width, and the controls the largest
  text on a page whose point is the rows under them. `.filters` sets its own
  size and everything in it inherits, with tighter padding on the controls:
  a form is filled in once, a filter bar is read past.
- Then "Search" sat at the end of one row with its box at the start of the
  next. **A wrapping flex row of loose labels and controls always does
  this** - the same fault the narrow-width grid was built to fix, one level
  up - so each pair is wrapped in a `.filters__field`, which is the item
  that wraps. All six views that use the bar were rewrapped; **a new filter
  needs the span too.** At a narrow width the pair becomes the row, label
  above control.

### A portal starts in the service desk's own colours

A portal still does not read Customisation - Appearance - its CSS is the
whole of its design, which is what stops it depending on a page its author
does not control. But every new one started on the same hard-coded navy, so
a service desk with a chosen palette got a preview in somebody else's
colours and read it as the preview being broken (reported 16 Oct 2026).

- `starterCss()` / `starterApprovalCss()` are **functions** now, and
  `starterColours()` writes the current brand, ink and mode colours into
  the `:root` block at the moment the portal is made. From then on they are
  the administrator's; changing Appearance leaves the portal alone, and
  **Start again from the current design** is the deliberate way to move one.
- `STARTER_LAYOUT` is **the sidebar shell**, not a masthead with nav pills:
  the starter is supposed to look like this service desk, and it still
  looked like the pre-2026 one. In the editor's narrow frame the shell
  collapses to a bar above the page, which is the same @media rule a phone
  gets - the full-screen preview shows the sidebar.

### The dashboard remembers its SLA figure

Reported as slow to load. Measured against a copy of the demo database (353
tickets): `myWork()` took ~270 ms, of which **`buildReport()` was ~160 ms**.
It builds the whole 30-day report for one number, deliberately, so the
figure always agrees with Reports.

That decision is kept. Two things changed around it:

- **The independent queries run together** (`Promise.all`) instead of one
  after another. On SQLite the driver is synchronous so this changes little;
  on PostgreSQL each one is a round trip.
- **The rate is remembered for five minutes per person** (`slaRateFor`,
  `forgetSlaRates()` to clear it). A rate over thirty days does not move
  between two loads of a page.

First load ~250 ms, every load after it **1 ms**. Per process, like
`settings()`: at several instances each has its own, which is correct but no
cheaper.
### Reports

`/reports` (`services/reports.ts`, `routes/reports.ts`, sidebar "Reports"):
a group's figures over a period - raised, resolved, closed, cancelled,
reopened, open now; response and resolution targets met or breached; median
first response and resolution; day by day (SVG with plain attributes - the
policy allows no inline style); by priority and type; and per technician.
CSV at `/reports/export.csv` (formula-safe cells, audited `report.exported`).
**Every figure opens its tickets** (`/reports/tickets`, `reportTickets()`),
through the same `reportScope()` as the page and downloads, with the previous
period, backlog by age and `METRIC_DEFINITIONS`. The audit, the definitions,
what cannot be reported yet and the roadmap are in [REPORTING.md](REPORTING.md).

- **Who sees which groups**: an administrator all; a manager the groups they
  manage; a technician the groups they are in. **The per-technician table
  only when every group in the report is one the reader manages** (or an
  administrator) - a technician gets the group's figures, not a league table.
- Computed on demand like the SLA clocks; top-level tickets only (a task is
  part of its ticket); the SLA and timing figures read at most `REPORT_CAP`
  tickets raised in the period and say so. "Cancelled" and "reopened" come
  from `ticket_events`. A period is at most a year.
- The two date fields show only while "Between dates" is chosen (`:has()`).
- **The download is a styled Excel workbook** (`/reports/export.xlsx`,
  `reportWorkbook()`): Summary, By company, Priority and type, Day by day,
  Technicians, and **Tickets** only when "Ticket details" is ticked - each
  ticket with its requester, who raised it (on behalf of), company, assignee,
  dates and SLA results. The page itself never lists them, so it stays light.
  `src/lib/xlsx.ts` writes the .xlsx with no dependency (Office Open XML in a
  zip from node:zlib, real numbers, dates and percentages, the header filled
  in the brand colour, frozen, filterable); checked by opening it in Excel.
  The CSV route remains for scripts.
- **By company** (the requester's `users.company`): a filter that narrows
  the whole report to one customer, and a table of companies side by side
  (top 25, the rest summed) - for a managed service provider.
- **Speed**: the SLA facts (first response, status changes) are loaded for
  all tickets in two queries per 500, and `offsetMinutes()` in sla.ts keeps
  one Intl.DateTimeFormat per zone plus a quarter-hour offset cache -
  building a formatter per call made a 90-day report take 1.2 s (now ~40 ms),
  and every SLA clock in the app was paying the same.


### Fonts: six, shipped, and nothing else may be named

The owner asked for a licence audit (15 Oct 2026) with one instruction:
nothing that could be sued over, anywhere, including a requester portal an
administrator writes the CSS for.

**What the audit found.** No font file was shipped or fetched: `font-src`
was already `'self'`, there was no `@font-face` and no Google Fonts link, so
nothing was being distributed and nothing needed a licence. The exposure was
only in what was **named** in CSS - Helvetica, Arial, Segoe UI, Verdana,
Trebuchet, Georgia, Consolas, SF Mono, Cascadia Code - all proprietary, all
merely asked of the reader's own machine. Naming a family is not use of the
font software, so this was not an infringement; it was removed because the
owner wants no judgement call left in the codebase.

**What it now is.** Six families, **served from `/assets/fonts`**:
Inter (the default), DM Sans, IBM Plex Sans, Lato, Montserrat and Playfair
Display. All six are SIL Open Font License 1.1, which permits commercial use,
bundling and serving provided the files are not sold alone and the notice
travels with them.

- `ALLOWED_FONTS` in `services/branding.ts` is the list. `FONTS` is the
  picker built from it; `FONT_KEYWORDS` is what else a stack may contain
  (the CSS generics, which name no font software).
- `fontProblems(css)` refuses `@font-face`, `@import` and any family off the
  list. **It runs on a requester portal's CSS on save** (`partProblems`), so
  an administrator cannot introduce one. `style-src 'self'` and `font-src
  'self'` already blocked it at runtime, which means it would otherwise have
  been stored and then silently done nothing.
- `scripts/get-fonts.cjs` downloads them: latin and latin-ext only
  (latin-ext is what carries Czech), 14 files, 480 KB, each family's
  `OFL.txt` beside its woff2, and `public/fonts/NOTICES.md` recording
  family, licence, source and checksum. Re-run it rather than editing
  `public/css/fonts.css`, which is generated.
- `public/css/fonts.css` is linked **before** `app.css` in both
  `header.ejs` and `error.ejs`, and like every stylesheet it carries `?v=`
  (trap 8).

**Why six rather than the fourteen first approved**: each is bytes on the
first page load, and six already covers a neutral interface face, a
geometric one, a technical one, a warm one, a wide one and a serif.

**Why shipping them matters.** Before, the picker barely did anything: a
machine without Montserrat installed fell back to the system font, so every
sample looked identical - reported as "why do these fonts look kinda
similar?". The test for this is metrics, not eyes: the same string renders
at six different widths.

### The font is set on its own form

Appearance has a **Font** card posting to `/customization/font`, separate
from the colour form. It used to be a field of that form, so a helpdesk
whose stored text colour the contrast rule refuses could not change its font
either: the save checked everything and refused everything. Reported, fixed,
and there is a test that writes an unreadable colour straight to settings
and then saves a font.
### Appearance: quick colours

Settings - Customisation - Appearance has five colour dots above the form
(`QUICK_COLOURS`, POST `/customization/colour`): one click sets the brand
colour only. The sidebar matches the storefront mockup (dark labels, a count
of open tickets on Tickets - `sidebarTicketCount`, the avatar in the search
bar), and the current link keeps its gradient on hover. **The work is at the
top** (Dashboard, Tickets, New ticket, Reports); **every way into Settings**
(Automation, Groups, Users, Settings) sits apart at the bottom, above colour
mode, behind a rule - asked for directly.

### Names: first, last, company, and a display name format

`users.first_name`, `last_name`, `company`, `display_name_source` (migration
51). Settings - Users - **Other settings** holds the format
(`settings().people.displayNameFormat`, `services/display-names.ts`), such as
`[First] [Last] - ([Company])`: variables in square brackets, anything else
kept as typed.

- **`display_name` stays the one column everything reads**; it is *built*.
  `display_name_source` is the name as the directory, SCIM or the person gave
  it. `applyDisplayName()` runs after every write of a person's names
  (`setProfileAttributes`, `upsertUserFromDirectory`, sign-in, SCIM create
  and update, `createLocalAccount`); saving the format runs
  `applyAllDisplayNames()`. **A new writer of names must call it too.**
- **Empty pieces tidy away** (`tidy()`): empty brackets, dangling or doubled
  separators. **Nobody with neither a first nor a last name is formatted**:
  they keep the source name - "- (Contoso)" is not a name.
- **SCIM reads its own name back** (`toScimUser` uses the source and the
  stored first and last name), or Entra would see a change every cycle. It
  reads `name.givenName`/`familyName` and the enterprise extension's
  `organization` (Entra's default mapping of companyName), also in PATCH.
  OIDC reads `given_name`/`family_name` when released.
- Only a **password account's** display name is typed (user page); a
  directory one's comes from the directory.
- The CSV import has `first_name`, `last_name`, `company`; with no
  display_name the first and last name make one.
- Notification placeholders `{{requesterFirstName}}`, `{{requesterLastName}}`,
  `{{requesterCompany}}`, `{{assigneeFirstName}}`, `{{assigneeLastName}}`;
  rule attributes Company, First name, Last name.

### My dashboards and pins

`/boards` (`services/boards.ts`, `routes/boards.ts`, migration 52): a
technician's or administrator's own dashboards and sidebar pins. Requesters
get a 404; somebody else's dashboard or pin is "not found".

- **A dashboard** is widgets in JSON (`user_boards.widgets`): Figure (a
  count), Ticket list, Report figure, Chart, Activity. Edited in place
  (`?edit=1`): add through a :target dialog whose fields follow the chosen
  kind with `:has()`, ▲▼ to move, the gear to change, the bin to remove. Half
  or full width.
- **A widget reads with its owner's permissions** - listTickets() with the
  owner as viewer, buildReport() for report and chart widgets - and stores
  filters, never results.
- **Pins** (`user_pins`): a dashboard (pinned when created; renaming or
  removing it follows), or the ticket list or a report with its filters,
  through "Pin to sidebar" (`partials/pin-button.ejs`). `pinHrefProblem()`
  allows only `/tickets`, `/reports`, `/boards`, `/dashboard` paths - a
  form can post anything, and the add redirects back to it. 20 pins, 20
  dashboards, 24 widgets at most. Renamed, re-iconed, reordered and unpinned
  on `/boards`.
- The sidebar's **Pinned** section sits between the work and the settings
  links; `workDashboardLink()` loads the pins and `currentUrl` to mark the
  current one (Tickets and Reports are then not marked).

**Sharing** (migration 53, `board_shares`): Share makes a link
`/boards/import/<token>` - 32 random bytes, **only its sha256 stored**, shown
once on the page the share renders (never in a redirect or the session),
14 days, one live link per dashboard (sharing again stops the old one),
Stop sharing. Opening it, or pasting it under Import, shows a preview; "Add
to my dashboards" makes the importer **their own copy**. Nothing but the
layout travels - the copy reads with the importer's permissions - and every
failure (expired, stopped, mistyped) is the same 404. Staff only; audited
`board.shared`, `board.share_stopped`, `board.imported`.

### The text colour cannot hide the text

Appearance's "Text and surface colour" is the colour of every word on white.
A light one made the whole application invisible (reported, with pink and
white). Saving refuses one under 4.5:1 on white, and `readableInk()`
darkens a stored one to 7:1 when the theme is drawn, so an old setting
recovers by itself.

### Demonstration data

`npm run demo:seed` builds `data/demo.sqlite` (`scripts/demo-data.ts`), `npm
run dev:demo` runs it on port 3001 (launch entry `helpdesk-demo`). Never the
owner's own database: the script refuses any file not called demo*.sqlite,
and a database already seeded (marker `demo_data`). Five companies, five
groups with managers, SLA on, 75 days of tickets with some breaches. The
technicians sign in with the local seed password; the script prints them.

### One gear, one dropdown

`partials/icon-gear.ejs` is the only gear (the old filled one drew its rim
and hole as overlapping contours and smudged). Every `<select>` uses
`appearance: none` with a data: chevron; the opened list follows the theme
through `color-scheme`.

### A custom portal does not use Appearance

Portal pages skip `/branding/theme.css`; a portal is its own CSS on top of
app.css defaults, and new portals start with a `:root` colour block.

### Locale: one time zone, one date format

Settings - Customisation - Locale (`settings().locale`). `formatDateTime` /
`formatDate` in lib/format.ts follow it everywhere, including notification
placeholders. **SLA counts in the Locale time zone** (the SLA page shows it
and links here; `sla.timeZone` in the stored document is vestigial). The
picker is Windows-style grouped regions (`lib/time-zones.ts`), each standing
for one IANA zone, with the standard offset computed from the zone rules; a
zone not in the list is kept as its own entry so saving never changes it.

### Stylesheet edits need a server restart

`app.locals.assetVersion` is hashed once at start-up, and `tsx watch` only
restarts on source it imports - so a CSS-only change keeps the old `?v=`
and browsers keep the week-cached copy. Restart the server after editing
`app.css`.

Roles, group membership, templates, branding, attachment limits and the SCIM
token are all set here - **not** in environment variables. The environment only
seeds initial values.

### Assets (21 Oct 2026)

`services/assets.ts`, migration 67; the plan is in the owner's
`.claude/plans/partitioned-booping-falcon.md` (five steps: pages, CSV
import, assigned / unassigned mail, automations, .docx documents).

- **The pages are `/inventory`, not `/assets`**: `/assets` is where the
  stylesheets and scripts are served (express.static), and it answered
  `/assets` with a 301. Settings - Assets is `/admin/settings/assets`.
- **A column's `key` never changes** (`asset_columns.key`, e.g.
  `SerialNumber`): it is the variable a notification or document writes.
  The label, the format, on/off and the order are the administrator's.
  Ten are built in; a built-in one is switched off, never removed.
- **Assigned to is a person** (format `person`, fixed), stored in
  `assets.assigned_to` rather than among the values, so a deleted account
  leaves the asset unassigned. Typed as an email address.
- **Values are one JSON document** (`assets.field_values`, in
  JSON_COLUMNS) keyed by column; a switched-off column's values stay, so
  switching it back on brings them back. Search is a LIKE over that
  document and the assignee; sorting by a column goes through
  `sqlJsonText`, whitelisted against the columns.
- **Every change is a line of history** (`asset_events`), and status or
  assignee changes are announced to `onAssetChange` listeners - what the
  notifications and automations (later steps) hang off.
- Permissions: `assets.manage` (the built-in technician has it) for the
  pages, `settings.assets` for Settings - Assets.
- **CSV import** (`services/asset-import.ts`, `/inventory/import`): the
  template is the columns switched on now, plus Status; a header names a
  column by label or key. Checked whole, one bad row imports nothing; a
  serial number already here (or twice in the sheet) is skipped and listed.
- **Assigned / taken back** (`services/asset-notify.ts`): built-in
  notifications `asset.assigned` and `asset.unassigned`, audience `person`,
  sent by `notifyPerson()` from an `onAssetChange` listener that
  `createApp()` registers.
- **Variables** are one list (`services/asset-variables.ts`) for the
  notifications, the automations and the documents: every column by key,
  FirstName, LastName, FullName, Email, Department, JobTitle, Manager,
  Company (the asset's, else the person's), Status, AssetLink, Today. In a
  notification or document `{{Model}}`; in an automation `{{asset.Model}}`.
  Letters only: the notification renderer reads `\w+`.
- **Automations** (step 4): triggers `asset.created`,
  `asset.status.changed` (optional `toStatus`), `asset.assigned`; steps
  `asset_email`, `asset_comment`, `asset_status`. A run gets `assetId`; an
  asset step needs an asset, a ticket step a ticket, and the editor offers
  only the kind that fits (plus If and HTTP). An asset run is inside
  `assetRunning` (AsyncLocalStorage), so the status it sets starts nothing.
- **Documents** (step 5, `services/asset-documents.ts`, migration 68):
  a .docx under Settings - Assets - Documents, checked on upload (every
  `{{...}}`, read across Word's runs; what is not a variable is listed).
  `lib/docx.ts` fills a paragraph's text across runs - Word splits
  `{{FirstName}}` wherever it likes - writing into the run the variable
  starts in. `lib/unzip.ts` reads it, `zipFiles()` writes it back.
  **PDF needs LibreOffice**: `SOFFICE_PATH` (lib/pdf-convert.ts); unset or
  failing, the .docx is sent and the run log says so. Every copy sent is
  kept on the asset (`asset_files` kind 'generated') and attached through
  `mail_outbox.asset_file_ids`, read at send.
- **The list has the Excel-like headers** (`partials/col-head.ejs`): each
  shown column and Status, filtered in SQL through `columnExprs()` in
  assets.ts - `sqlJsonText` over `field_values` for a value, `a.status_id`,
  `a.assigned_to` - and counted per header by `assetColumnValues`.
- `data-no-search` on a select now also keeps `select-search.js` off the
  page (middleware/select-search.ts): eleven triggers would otherwise have
  given the automations list a script.

---

## Not built, on purpose

- **Azure Communication Services** - mail goes through a mailbox the
  organisation already owns, not a second service to pay for and secure.
- **A JSON API for the pages** - they stay server-rendered, which is what
  keeps the CSP tight. The machine API is separate and behind API keys:
  `POST /hooks/automations/:id` starts an automation, `GET /api/v1` reads,
  and `POST`/`PATCH /api/v1` changes tickets, templates and notifications
  (above).
- **Attachment virus scanning** - type verification is not malware detection.
- **Group provisioning over SCIM** - group membership grants nothing here, so
  there is nothing to provision into. Leave it off in the Entra mappings.

---

## Working style that has worked here

- Drive the real HTTP surface to check behaviour, not just unit tests. The
  scratch flows caught the orphaned-ticket bug and the stale-ETag bug that
  tests alone missed.
- After a bulk rewrite, **query the database to confirm** rather than trusting
  a passing status code.
- When a test fails, decide whether the test or the code is wrong before
  changing either. Several "failures" here were correct behaviour and a stale
  assertion - and at least one was the reverse.

### Sign in: the address as a chip, and Forgot password

The sign-in pages share `.signin-card` (compact, centred; the old
`.wrap--narrow` card was 720px wide). Step two shows the address as a chip
with a **Change** button (still a readonly input, so password managers see
the account) and the password field slides in under it (`signin-reveal`,
CSS only, off under `prefers-reduced-motion`). Never animate with
`clip-path` there: it clipped the focus ring - reported as "not aligned".

**Forgot password?** (`auth/password-reset.ts`, migration 55
`password_resets`): always on the password page. With a mailbox or relay it
mails a link `/login/reset/<token>` - 32 random bytes, only the sha256
kept, 30 minutes, once, a newer one replaces an older, one mail a minute per
account; the page reads the same for every address. **Never for the
break-glass account** or a code account; without any way to send mail the
page says to ask the service desk. Setting the password clears any lockout.

### Light and dark mode are set, not reversed

Appearance - "Light and dark mode": **which modes are offered** (`branding.
colourModes`: both, light only, dark only - one only forces `data-theme`
and hides the switch, `themeLocked`) and, behind a chevron each, **a mode's
own background, card and text colours** (`branding.light` / `.dark`, empty
= worked out). The dark theme used to be the ink colour turned into the
background, so any text colour reshaped it and every quick colour had the
same navy dark mode - both reported. **`modePalettes()` is the one place a
mode's colours are worked out** (the stylesheet and the Appearance pickers
both read it): light - white cards, the page a faint wash of the brand, the
ink as text; dark - cards a near-black carrying 12% of the brand, the page a
shade darker, near-white text. The ink ("Text colour") is light mode's text
only. `readableText()` keeps text at 7:1 on its card whatever is set, and
the save refuses text under 4.5:1 on its own card colour.

### The break-glass password never reaches the log in production

A production helpdesk with no seed password writes the generated break-glass
password to `BREAK_GLASS_FILE` (`break-glass-password.txt` in the data
folder, the uploads folder's parent - `/home/data` on Azure), mode 600, and
the log only names the file: App Service keeps logs where more people can
read them. `setLocalPassword` deletes the file when that account's password
changes. Outside production it is still printed once, as before.

**Branding is mounted before the session** (`app.ts`): the theme, logo and
favicon are on every page and must not read the session store (a database
round trip on PostgreSQL) or set a cookie. Nothing in `routes/branding.ts`
may read `req.session` or `res.locals`.

### Tickets: an SLA filter, and one layout per row

Staff, while SLA is on: **SLA** - at risk or breached, breached, at risk, on
track (`slaMatches()` in sla.ts, the Reports rules: breached is either target
missed, late or running past it). Clocks are not stored, so `listTickets`
reads the other filters in SQL, then the clocks of at most `SLA_FILTER_CAP`
(2,000) newest matches in bulk (`loadSlaFacts`, shared with Reports), and
pages the result. The row badge follows the same rule. Titles and names are
one line with an ellipsis (whole text in `title`), the comment count sits
beside the title, the SLA badge under the status.

Rows needing attention are **tinted** (`ticket-row--breached` / `--at_risk`,
with a bar on the left) and carry a short flag beside the status, so nothing
wraps. A requester's or assignee's name opens their page under Users for an
administrator; for a technician a requester's name opens their tickets.

### Excel-like column headers (21 Oct 2026)

Every list's header sorts and filters like Excel's AutoFilter:
`src/lib/column-filters.ts` and `views/partials/col-head.ejs` (on the ticket
queue, Users, the audit trail, Reports' ticket lists, People, templates,
automations, notifications). **A new table uses them.**

- **In the address**: `cf_<column>=<value>`, once per ticked value; values in
  one column are ORed, columns ANDed. Links, paging and the filter bars keep
  them (`keep-columns.ejs`), and `clear-columns.ejs` above the list drops
  them - there even when the filters leave nothing and no table is drawn.
- **The SQL is a whitelist** per table (`TICKET_FILTER_COLUMNS`,
  `USER_FILTER_COLUMNS`, `DRILL_COLUMNS`...); values are bound. A blank value
  means an empty cell ("Unassigned", "None").
- **A menu's values are counted over what the other filters leave**
  (`withoutColumn`), at most `MAX_VALUES`, so ticking a second value in the
  same column stays possible.
- **Short lists held whole** use `filterRows`, `sortRows` and `rowMenus`, or
  `listView` for all three. The Settings lists rendered from several places
  (API keys, connections, custom fields, automation runs, mailboxes) get
  theirs at render time from `routes/column-lists.ts` - **add a new whole
  list there**, naming its view, rows and cells. The group lists read every
  match and page in memory. A list whose order is a setting (mail rules,
  asset columns, the catalogue) is left unsorted on purpose.
- **No script**: a `<details>` whose panel is `position: fixed` with no
  offsets (so a table's scroll box does not clip it), and whose summary
  covers the page while open (a click elsewhere closes it). More than 8
  values bring select-search.js's list search, the approved script - so a
  list page may now be served `script-src 'self'`.
- **The opening tag is written raw** in the partial: the i18n rewriter takes
  a conditional `scope="col"` between tags for text and escapes it.
- Sealed columns (department, job title, office, phone) cannot be filtered
  in SQL; People filters by company only.

### The ticket table: sortable, and one SLA treatment

A UX pass over the queue (the owner's brief, 15 Oct 2026, kept in
`docs/ticket-table-brief.md`). What is worth knowing afterwards:

- **Sorting is a whitelist, not a column name.** `SORTABLE` in
  `services/tickets.ts` maps each sortable column to its SQL, because that
  text goes into an ORDER BY where a placeholder cannot stand. Priority
  ranks by severity (sorted as text it reads high, low, normal, urgent);
  reference sorts by `seq`, the global counter, so it reads as oldest
  first rather than interleaving the per-type numbers; `seq` also breaks
  every tie, so paging is stable. Unassigned sorts last either way.
- **The SLA path sorts the same way.** The clocks are not in SQL, so that
  path reads candidates, filters them by clock and pages the result - which
  means the candidate query has to carry the same ORDER BY (and the two
  user joins the name columns need), or sorting would only apply to the
  tickets that were already on the page.
- **Headers are links**, each carrying every current filter plus its own
  column, so sorting never drops a filter and the address is shareable. The
  `<th>` carries `aria-sort`; the caret is drawn only for the column in use.
  No script.
- **One treatment for a breach, not three.** A breached row carried a red
  tint, a red left bar and a red flag beside a green status badge. It keeps
  the **bar** (what makes it findable when scanning) and the **flag** (what
  says which, in words - never colour alone). The status badge is left
  alone: it answers a different question.
- **The person is the name, with the company under it.** A display name may
  fold the company in ("Tomas Dvorak - (Contoso)"), which truncates in the
  middle of the company and buries the name - reported. The row now selects
  `first_name`, `last_name` and `company` and shows the name on one line,
  the company quietly under it.
- **Links in the table take the text colour** and show themselves on hover
  and focus. A column of coloured underlined references is unreadable.
- Headers are **sentence case** everywhere (`.table thead th`), not just
  here: two header styles in one application would be worse than either.

### A long file name is shortened in the middle

An uploaded name can be a hundred random characters, and shown whole it
wrapped over three lines and pushed the rest of the ticket down - reported.
`shortFileName()` in `lib/format.ts` cuts the **middle**, not the end: the
extension is the part a reader scans for. The whole name stays in the
element's `title`, and the CSS keeps it to one line whatever arrives.
### Settings - Tickets, and Other settings as one page

The section is called **Tickets**, not Ticket templates (asked for 15 Oct
2026): it holds the forms, the catalogue, the categories, the custom fields
and the rules about tickets, and only one of those is a template. The slug
is still `templates`, so every address and every test is unchanged.

**Other settings is one page with a chevron per decision** - Reference
prefixes, Service levels, Status notes, Delete closed tickets - instead of
four sub-tabs. Three things follow:

- `otherView()` supplies every panel on every render, and each POST
  re-renders that same view with `openPanel` set, so a refused save reopens
  its own panel with what was typed (trap 6) and leaves the others alone.
- The old sub-tab addresses still work: `GET /other/sla` and
  `/other/status-notes` 308 to `/other#sla` and `/other#status-notes`. Only
  the GETs - every POST keeps its own address, so a form already open in
  somebody's browser still saves.
- `last-change.ts` has one line for the page now, listing every action
  decided on it; a second line would show "last changed" from whichever
  panel happened to match.

### Deleting closed tickets after a while

Settings - Tickets - Other settings - **Delete closed tickets**
(`tickets.deleteClosedAfterDays`, 0 is off and is the default).
`deleteOldClosedTickets()` in `services/tickets.ts` runs hourly beside
`autoCloseResolved`, and it is a **real delete** - `deleteTicket()`, cascade
and attachment files included - for the same reason deleting one by hand is:
a ticket behind a "deleted" column is still a ticket a query that forgets
the column will show.

Three things it has to get right, and does:

1. **Top-level tickets only** (`parent_id IS NULL`). A task goes with its
   parent through the cascade; deleting a task that closed months ago from
   under a ticket that is still open would take a piece out of an open
   ticket.
2. **By `closed_at`, not `updated_at`.** A comment on a closed ticket must
   not buy it another year, and a ticket reopened and closed again counts
   from the second time.
3. **The audit entry is written before the row goes**, and names the
   reference and title - afterwards there is nothing left to describe.

### The service catalogue

Settings - Tickets - **Service catalogue** (`services/service-catalogue.ts`,
`routes/service-catalogue-admin.ts`, `tickets.catalogue` in the settings
document). On, **New ticket opens a page of tiles** instead of the default
form; a tile is a link carrying `?template=`, so choosing one lands back on
`/tickets/new` and falls through to the form - which is also why a link
somebody saved to a form still opens that form.

- **A tile is a template, plus how it reads**: its own label, description
  and icon, each optional. Empty means the template's own name and summary,
  so renaming a template renames its tile.
- **Order is the only position.** There are no coordinates: tiles flow into
  the grid in order, so a tile whose form somebody may not raise is left out
  for them and the rest close the gap. A grid of fixed cells would leave a
  hole that advertises a service to the one person who cannot have it.
- **Access is the template's own** (`templatesVisibleTo`), never a second
  rule that could disagree with the form itself.
- **The grid is set** (`columns` 1-5, `rows` 1-10): columns × rows is a
  page, and the requester's page has Previous and Next under it.
- **The editor is the grid.** It draws what a requester sees, with each
  tile's tools under it and a **+ in every empty cell** that adds a tile
  *there* (`?add=<cell>` opens the one Add dialog with that position). One
  dialog, not one per cell - a dialog each made the page 900 KB.
- **Never an inline style.** The column count is a class
  (`.catalogue-preview--cols-N`): the policy is `style-src 'self'`, so a
  `style="--catalogue-columns: 5"` attribute is dropped and the grid kept
  the stylesheet's three columns - reported, and worth remembering for any
  other value a view wants to pass to CSS.
- The icons are a fixed list (`CATALOGUE_ICONS`, drawn by
  `partials/icon.ejs`), because a form can post anything and the icon is
  rendered as markup.

### Remove and anonymise: the right to erasure

A person's page under Settings - Users offers **Remove account** and
**Remove and anonymise** (`services/erasure.ts`, asked for 15 Oct 2026).
The first is what it always was: an account with tickets is disabled rather
than deleted, so the history survives - and with it the person's name and
address, which is exactly what somebody who has left and asked to be
forgotten does not want.

The second deletes the account and files everything it left behind under one
hidden placeholder:

- **One placeholder for everybody** (`Anonymous`). One per erased person
  would be a pseudonym, which still tells two ex-colleagues apart.
- **What is repointed**: the three columns that would otherwise refuse the
  delete (requester, comment author, who uploaded a file) and the three that
  would quietly go empty (assignee, who raised it on their behalf, who an
  event was by). Nulling those would say the ticket was unassigned or raised
  by nobody, which is not what happened.
- **The audit entry names no name** - only the id and how much moved.
  Writing it into the audit trail would undo the erasure in the one table
  nobody deletes from.
- **It does not rewrite words people typed**, and the dialog says so.
- **Neither placeholder can be signed in to.** `isReservedAccount()` in
  `services/users.ts` covers this one and the hidden mail account: both are
  left out of every listing, and `setUserStatus` refuses to enable either -
  enabling one is the only way either could ever become a way in (asked for
  directly).

### A temporary password, and the third sign-in step

Three ways somebody gets a password they must replace: an administrator
resets one, the CSV import generates one, or an administrator presses
**Send temporary password** on their page. All three set `mustChange`.

- **Send temporary password** (`POST /:id/password/send`) mails a generated
  password through the built-in notification **Your temporary password**
  (`account.temporary_password`, audience `person`, placeholders
  `{{personName}} {{email}} {{password}} {{signInUrl}} {{appName}}`) - the
  first built-in that is not about a ticket, sent by `notifyPerson()` in
  outbox.ts rather than `notifyTicket`. **The password changes only if the
  mail was queued**: a reset that was never delivered locks somebody out of
  an account that worked a moment ago. Never for break-glass, whose whole
  purpose is to work when mail does not.
- **The CSV import can mail each generated password** ("Email each person
  their temporary password"), never one typed into the sheet, and the result
  page says which were sent.
- **A password that must change is not a way in.** Signing in with one now
  stops at `/login/new-password` - a third step with two boxes and the rules
  box - and the session is established only once the new password is set
  (`mustChangeUserId` in the pre-auth session; asked for 15 Oct 2026, "you
  should not be even let into the system"). It used to sign the person in
  and send them to their profile, which meant a temporary password reached
  the whole service desk until somebody got round to changing it.

**The default password policy is eight characters with an upper-case letter,
a lower-case one, a digit and a symbol** (`DEFAULT_PASSWORD_POLICY`). It was
length alone, which reads as no policy at all on the page that shows it. The
production floor (12) still applies on top.

### One person, read only: /people/:id

`routes/people.ts`. A name in the queue used to open the administrator's
account page, and for a technician nothing at all - so a name was a dead end
for everybody but an administrator (reported 15 Oct 2026). `/people/:id` is
the page *about the person*: their details, their groups, what they have
raised and what is assigned to them.

- **Staff only.** A requester gets the same 404 as a name that does not
  exist, so the page never says who has an account here.
- **Nothing is settable**; an administrator gets "Open in Users" to the
  account page, which is where roles, groups and passwords live.
- **Tickets are read with the reader's own permissions** (`listTickets` with
  the viewer), so a technician sees what they could have found in the queue.
- `listTickets` gained an `assigneeId` filter for it.

### Several groups at once on the Manager dashboard

`managerView` takes a list, `?group=` repeats, and nothing chosen means all
of them. The control is an ordinary `<select multiple>` - a list box without
a script, which still submits with the Show button beside it - and
select-search turns it into the same dropdown as everywhere else when the
script runs: a button that looks like a closed select, and the panel ticking
as many as you like (`data-multi`, `addMultiSearch()`). The middleware had to
learn that `multiple` with `data-multi` wants the script, or the page would
never be served it.

### The people directory, and who may search it

`/people` is the directory, `/people/:id` one person (routes/people.ts).
The two have **different gates**, and the difference is the whole design:

- **A person's page is open to staff** (`canSeePerson`). A technician
  already reads that name, and its tickets, in the queue - putting the page
  behind a switch would turn a name they can read into a 404.
- **The directory is a switch each** (`canUseDirectory`; Settings - Users -
  Other settings): technicians off, requesters off, and an administrator
  always, since they read every account under Settings anyway. Searching is
  what publishes a staff list, and that is an organisation's decision.
- **Own company only** narrows a search to the searcher's own company, for
  a service desk serving several. An administrator is not narrowed.
- A requester allowed to look somebody up sees **how to reach them and
  nothing else** - no ticket lists, no groups.
- Refusals are **404, not 403**: a refusal would say the directory is here
  and closed, which is as much as a reader needs to go looking.
- The sidebar link follows `canUseDirectory` (`res.locals.canUseDirectory`,
  set beside `showWorkDashboard`).

### The portal editor: no tabs, a starter in the current design

Three reports (docs/portal-editor-brief.md), two answered:

- **The Customisation tabs do not follow you into a portal.** Inside one
  editor the way out is All portals; the parts row (Layout, CSS, Home...)
  is the editor's own and stays. The **list** page keeps the Customisation
  tabs - that page *is* a tab.
- **The starter is the 2026 design** (`STARTER_LAYOUT`, `STARTER_HOME`,
  `STARTER_CSS`): a card bar on a soft page rather than a header with a
  coloured rule. It changes nothing for a portal that exists - a portal is
  the administrator's design and nothing rewrites one silently - so
  **"Start again from the current design"** on the editor is the deliberate
  way to move one. It replaces the layout, the CSS and Home, keeps the
  other pages, and is audited (`portal.design_reset`).
- **Dashboards are listed in the editor**, each linking to its design under
  Settings - Dashboards, with a column saying whether this portal writes
  `{{dashboard:<id>}}`, and carrying `?from=<portal>` so the dashboard
  page offers the way back. **A portal does not own that markup**, and that
  is the decision: two places that can define the same thing is the trap
  this codebase avoids everywhere else, so the cost is one journey out of
  the editor and the answer is to make the journey painless. `from` is a
  portal id, never a path - a path there would be an open redirect waiting
  to be found.

### The queue at a narrow width

The last of the table brief. Column widths are hints rather than a fixed
layout - `table-layout: fixed` would cut a short title as readily as a long
one - so the fixed-vocabulary columns get what their longest word needs and
the **title takes the slack**, because it is the only column anybody reads
to decide what a row is.

Under 56rem **Type and Updated are dropped**: Type repeats what the
reference prefix says, and Updated is the sort order rather than something
read per row. The table still scrolls inside its box (the page itself never
scrolls sideways).

**The filter bar becomes a two-column grid under 48rem.** As a flex row it
wrapped into pairs that did not belong together - "Show [All tickets] Team"
on one line, "[Any] Type" on the next - which is what a wrapping row of
labels and controls always does; every label in the first column and its
control in the second keeps a pair on one line.

### The search bar searches what it says it does

`/search` (routes/search.ts). The bar above every page said "Search
tickets, people, references..." and searched tickets, so two thirds of its
own promise went nowhere.

- **A reference goes straight to its ticket.** Typing INC-000123 means
  "open that", not "show me a page with one row on it", and it is the one
  search whose answer is certain. `ticketFor()` (routes/hooks.ts) resolves
  it, in any case and with stray spaces.
- **Only when the reader may open that ticket.** Otherwise it falls through
  to the ordinary search, which finds nothing - so the jump never reveals
  that a ticket exists.
- **Each section is read with the reader's own permissions**:
  `listTickets` with the viewer, and people only when the directory is open
  to them. A requester searching sees their own tickets, as the bar always
  gave them.
- **A few of each, then the way to the rest.** The page is for finding one
  thing; /tickets and /people are where many are paged through.

### A password change ends the other sessions

Changing a password is how somebody answers "it may be known" - a laptop
left signed in, a password written down - and leaving those sessions alive
answers nothing.

- **On the profile page**, every session but the one in hand
  (`destroyOthersForUser`): signing somebody out of the browser they just
  used would read as the change having failed. The flash says how it went.
- **On a reset link**, every session (`destroyForUser`): somebody who has
  forgotten their password is the person least able to say whether one of
  those sessions is theirs.
- An administrator resetting somebody's password already ended them all.

### One mark on every sign-in page

`partials/signin-mark.ejs`: the service desk's logo when one is uploaded,
the plain shape when not. There are eight sign-in pages - the address, the
password, the code, Forgot password, the reset, Create an account, its
confirmation and Choose a password - and only the first showed the logo, so
somebody who had just seen their own branding watched it vanish on the step
that asks for the password. Reported 16 Oct 2026; a new sign-in page uses
the partial.

### A default template per ticket type

**Migration 59.** There was one default for the whole service desk, which
answers "what does New ticket open" and does not answer "what does a
requester get when they press Incident" - asked for 16 Oct 2026, and what
the service catalogue's filter buttons raise.

- The partial unique index moved from `(is_default) WHERE is_default = 1`
  to `(type) WHERE is_default = 1`: one per type, still enforced by the
  database.
- `defaultTemplate(type?)`: with a type, that type's default; without one,
  **the service request** - the front door - falling back to whichever
  template is marked, which is what a desk that only ever had one still
  has. Everything that called it with no argument is unchanged.
- `setDefaultTemplate` clears and sets **within that type**, in one
  transaction; in the other order the index rejects the write.
- `ensureTypeDefaults()` runs at start-up after the starters and **only
  ever adds**: a type with a default keeps it, a type with no usable
  template is left alone, and the oldest usable template of a type is the
  one adopted - on a desk that has been running a while, the first one made
  is the one people have been using.
- The seeded *Default request* is an **incident** (it always was), so on a
  fresh database that is the incident's default and the service request's
  comes from the starters. Worth knowing before writing a test that assumes
  otherwise - one did.

### Tiles have a place, not just an order

A tile carries a **cell** - its absolute position across the catalogue, so
its page is `cell / perPage` and its column `cell % columns`. It was an
ordered list filling from the top left, which meant a tile could not be put
in the middle of a row or on a page of its own (asked for 16 Oct 2026).

Two rules make both of the owner's requirements true at once:

- **A gap the administrator left stays a gap.** That is what placing a tile
  somewhere means, and the requester's grid draws each tile in its own
  column (a class per column - an inline style is dropped by the policy).
- **A gap left by permissions closes up.** The cells the administrator
  *used* are the layout, and a reader's visible tiles fill those cells in
  order - so a form somebody may not raise does not leave a hole
  advertising it ("all the buttons are moved in that case").

Three more things that follow:

- **The editor always draws one page past the last tile**, so a second page
  is somewhere to put a tile rather than something to earn.
- **The grid is never wider than the columns in use**: three tiles in a
  five-column grid take three columns, not three fifths of the page.
- **A tile says who its form is offered to.** A template restricted to a
  user group is simply absent for everybody else, which reads as a tile that
  went missing - reported as "4 tiles but only 3 in New ticket", and it was
  four tiles and one restricted form. The tile now says "Only Test", which
  is the only place that answer could live.

### A list to pick one of is five rows and a search box

"Raise the ticket from" in a mail rule showed five templates with the rest
behind a fold, which answers "there are more" and not "where is the one I
want" (asked for 16 Oct 2026).

- One list now, **five rows tall and scrolled** (`.pick-list--five`), with a
  search box above it once there are more than five.
- **Five at a time is a scroll, not pages.** Inside a `:target` popup a page
  would be a round trip that closes it, and a capped list with a search does
  what paging was being asked for.
- select-search.js's list search learned **radios** as well as tick boxes,
  and `data-search-from` lets a list ask for the box sooner than eight - a
  list of templates is worth searching at five, a list of user groups is
  not.

### The sub-tabs look like the rest of 2026

A grey strip of square pills with a dot in front of the current one was the
last thing on a settings page still wearing the pre-2026 look (reported
16 Oct 2026). They are round pills on a tinted ground now, and the current
one carries `--grad` like the sidebar's current item, so the two agree. The
dot went with it: it was there so the current tab did not rely on colour
alone, and the gradient, the weight and `aria-current="page"` all say it
more plainly. A second row (`.subtabs--secondary`) stays quieter - outlined
pills rather than a filled strip - so two levels are still told apart.

### The service catalogue's filter buttons

`tickets.catalogue.filters`, off by default: a catalogue of six tiles needs
no filtering and the buttons would be three more things to read.

- On, the buttons are **the kinds the tiles actually offer** - never one
  that would empty the page - plus All, and each is a link, so a filtered
  catalogue is an address somebody can keep.
- **New ticket appears with them**, raising the chosen kind's default
  template (hence the per-type defaults above) or the service desk's own
  when no kind is chosen. It is not there without the buttons: nothing
  would say what "new ticket" meant beyond the tiles themselves.
- A `?kind=` nobody offers is **ignored, not refused** - it is an address
  somebody can type - and paging keeps the chosen kind.

### A transparent logo keeps its transparency

An uploaded logo sat on a white plate so a dark wordmark stayed legible
against the dark topbar. A logo made *for* a dark background arrives with a
transparent ground, and a white rectangle behind it is exactly what its
author avoided - reported 16 Oct 2026.

- `hasTransparency(bytes, contentType)` in branding.ts reads the file's own
  header: a PNG's IHDR colour type (4 or 6) or a `tRNS` chunk, a WebP's
  VP8X alpha flag, and SVG as transparent because vector artwork has no
  ground unless it draws one. **Anything not understood is opaque**, which
  keeps the plate: getting it wrong that way costs a rectangle, the other
  way loses the logo.
- The flag is stored on the asset (`transparent`), and the **theme
  stylesheet** carries it as `--logo-plate` and `--logo-plate-pad`. Every
  plate - the masthead, the sign-in card, the Appearance preview, a
  portal's starter CSS - reads the variable with white as its default, so a
  page rendered before the stylesheet arrives looks as it always did.
- An asset uploaded before this existed has no flag, which reads as false
  and keeps its plate. Re-uploading the same file is how it is re-examined.

### Custom languages: generated catalogue, rewritten views

**Migration 61** (`languages`, `language_groups`, `users.language`). The
design is in [docs/custom-language-brief.md](docs/custom-language-brief.md);
what was built differs from it in one place, for the better.

The requirement that decided everything: **a new feature must appear in the
translator's document by itself**. So:

- **The catalogue is generated** from the views - `npm run strings` writes
  `src/i18n/strings.json` (1,337 strings in 2,187 places) - and
  `tests/languages.test.ts` fails when it is stale. A check, not a promise.
- **The views are rewritten in memory**, on the way into the template engine
  (`src/i18n/engine.ts`), not by hand and not by a mechanical commit. The
  brief expected two hundred rewritten files; `rewrite()` does the same job
  at compile time, so a view's diff is still a view's diff. EJS reads an
  `include()` itself, which is what `includer` is for - without it every
  partial would compile untranslated.
- **With no language enabled `t()` returns its argument**, so a rewritten
  template renders byte-for-byte what it did before. That makes the whole
  existing suite a test of the rewriter, which is the only way a change this
  wide could be made safely.
- **A string is keyed by its own text** (a hash), not by its position, so
  "Save" is one row in the document and one translation rather than forty.

What is deliberately left in English, and why:

- **A sentence broken by a value or by inline markup** - "Showing
  `<%= n %>` tickets", "Tickets from `<strong>...`" - because the halves are
  not sentences and a translation cannot move the value to where the grammar
  needs it.
- **Anything holding an HTML entity** (`&#9733; Default`): `<%= %>` escapes
  what it prints, so passing it through `t()` printed "&#9733; Default" in
  full. Reported, and the fix is to decline the string.
- **Everything an administrator wrote**: a template name, a portal page, a
  category, a ticket. It is their text, in whatever language they chose -
  **except a notification**, which gets a set of rows per language (below).
- **Everything an administrator wrote**: a template name, a portal page, a
  category, a ticket. It is their text, in whatever language they chose.
  Notifications are the exception the brief describes (a set of rows per
  language), and that is **not built** either.

**The text that is not a text node** was reported missing on 16 Oct 2026
(a Czech page with an English sidebar and settings list), and is covered two
ways, both of which keep the catalogue generated:

- **Constants** - the settings sections and their lines, the words for a
  status, a priority and a type - come from `src/i18n/code-strings.ts`,
  which **derives** its entries from the constants themselves. A section
  added next year is in the document without anybody editing that file.
- **A literal built inside an EJS tag**, as each sidebar label is, is found
  by its `t('...')` call (`callsIn()` in extract.ts). So the way to make
  such a string translatable is to wrap it where it is written, and nothing
  has to be listed anywhere. `link()` itself does **not** translate: that
  would catch a pinned dashboard's name, which is the person's own text.

**One row per English string, with every context it appears in.** "Open" the
status and "Open" the button are one row - that is what keeps a 1,300-row
document translatable and a word translated once - so the context column
names up to three of the places it is used and the prompt tells the
translator to choose a word that reads correctly in each.

Which language a reader gets (`src/i18n/resolve.ts`), first answer wins:
their own choice on their profile, a user group that is given the language
(a group **kept out** of it wins, being the narrower statement), their email
domain, their browser when `locale.followBrowser` allows it, English. A
missing translation renders the English, always.

**A set of notifications per language** (migration 63): `mail_notifications`
gained a `language` column and its unique index moved to (event, language).

- The rows are **created when the language's tab is first opened**
  (`seedNotificationsFor`), copied from the English ones and owned from
  then on: editing one never reaches the English wording, and the English
  wording never reaches back. A service desk that never translates its mail
  never carries the rows.
- **The fallback is per row, not per string.** A language with no row for
  an event is sent the English one, whole: a notification is the one place
  where half a translation reads worse than none, because the reader cannot
  tell which half is missing.
- **Each recipient gets their own language**, decided per address
  (`wordingFor` in outbox.ts), because a notification goes to a group as
  often as to one person. An address with no account here is English - a
  stranger who wrote in has told us nothing about what they read.
- Deleting a language deletes its rows; the English ones are untouched.

Two practical notes:

- **A write reloads the cache**, it does not empty it. An emptied cache
  answers "no languages at all" to whatever reads it next, which is a page in
  English for no reason anybody could see.
- `languages.strings` and `.domains` are JSON columns, so they are in
  `JSON_COLUMNS` - without that, `row.strings[id]` reads a character out of
  a string and every translation silently misses.

### Text from code is translated where it is shown (21 Oct 2026)

**Scope, the owner's call**: everything a requester or a technician sees.
Settings (admin only), the audit trail and the time zone names stay
English. Measured, not guessed: a pseudo-language whose every translation
is `‹English›`, every page rendered as a technician, a requester and a
visitor, and whatever visible text has no marks is untranslated - 214 such
pieces before, a few dozen after, all of them data (template names, the app
name, initials).

Four mechanisms, each so that a word written later is translated without
anybody remembering to:

- **`i18n/localise.ts`**, installed by the language middleware for a
  language other than English only (an English page is byte-for-byte what it
  was). At render it translates every `*Labels` object a route passes
  (`statusLabels`, `typeLabels`...), `title`, a form's `errors` and the
  flash messages, and wraps every `*Label()` helper on `app.locals` and the
  date helpers (month names, "5 minutes ago").
- **`i18n/code-scan.ts`** puts code's own text in the catalogue: a
  single-quoted sentence (capital, two words, ends `.?!`, not SQL), a
  `flash(req, '...', '...')`, a router's `title: '...'`, and `t('...')` /
  `tx('...', [...])` calls. `*-admin.ts`, `routes/settings.ts`, SCIM, the
  API, automations and portal design are left out (Settings, or JSON).
- **`i18n/current.ts`**: `words()` / `wordsWith()` give code the reader's
  `t` for the length of the request (AsyncLocalStorage, like a database
  transaction), so a service that draws HTML - the requester dashboards in
  `services/dashboards.ts`, the clocks in `services/work-dashboard.ts` -
  writes `t('Raised today')`. Outside a request: English.
- **`tx('Up to {0} files', [n])`** in a view: a sentence with values as
  plain text, for an attribute or the ⓘ, which escape what they get.
  `tr()` is the HTML one. The ⓘ translates its own `text`; the extractor
  reads a literal `text:` from `include('.../info', ...)`.

Lists of words in code (availability statuses, weekdays, widget kinds,
report definitions, built-in field labels and placeholders, built-in
dashboard names...) are added to `code-strings.ts`, derived from the
constant, and the view prints `t(x.label)`.

**`t` is a ticket in some views** (`function dashTicket(t)` in
work-dashboard.ejs, `forEach(function (t)` in reports-tickets.ejs): inside
those, write `locals.t(...)` / `locals.tx(...)`. The catalogue finds them
just the same.

### The earlier brief, for the parts not yet built

[docs/custom-language-brief.md](docs/custom-language-brief.md) is the
design: a markdown catalogue of every string with its context and a prompt
to hand to an AI, imported back, scoped by group, email domain, browser or
the person's own choice, with a set of notification rows per language.

The part worth knowing before touching it: **the markdown has to be
generated, not maintained**, because the owner's last requirement is that
any new feature appears in it automatically. That makes the extractor - a
script that walks the views and keys every string by its own text - the
first thing to build, and the view rewrite it implies the largest part of
the work. Do not start it by hand-keying strings.

### Groups from both sides

A person's page under Users sets their **user groups** too
(`setUserGroupsForUser`): ticked ones joined by hand, unticked left; a
membership a rule made is shown ticked and locked - the rule would put it
back. Technician groups were already there, for agents and administrators.

### Password policy

Users - Other settings - **Password policy** (a chevron;
`settings().localAccounts.passwordPolicy`): minimum length (8-64, never
below the deployment floor `MIN_PASSWORD_LENGTH`, 12 in production -
`minPasswordLength()`), upper case, lower case, digit, symbol, **Don't allow
common phrases** (stored as `notEmail`: the person's email name, first and
last name, display name, company, and the service desk's name -
`commonPhrases()`, fed by `personOf(user)`), and expiry in days (0 never;
an older password is changed at the next sign-in via `mustChange`, never
for break-glass). Defaults change nothing. Every place a password is set
calls `passwordProblems(password, person)`; `generatePassword()` mixes in
one character of each kind so it always passes. `passwordPolicyText()` is
the hint beside a password box.

### People may change their own details

Users - Other settings (a chevron): which of company, department, job title,
office and phone a person may change on their profile
(`settings().people.selfEdit`, `SELF_EDIT_FIELDS`; off by default). The
profile's "Your details" card offers only those, and `setOwnDetails()`
writes only those, whatever is posted; the display name is rebuilt and group
rules re-run. A directory-synced account is told its directory may replace
the change.

### Registration: "Create an account", confirmed by email

Users - Other settings - **Let people create their own account** (a chevron;
`settings().localAccounts.registration`: on, and optional email domains;
off by default; refused without a mailbox or relay). The sign-in page then
links to `/register`: first name, last name, email, password (the policy
applies). **Nothing exists until the address is confirmed**
(`auth/registration.ts`, migration 58 `registrations`): the form keeps the
names and the password **hash**, and mails `/register/confirm/<token>`
(sha256 kept, 24 hours, once, one per address, one mail a minute). The link
shows a button - a POST, so a mail scanner following links activates
nothing - which creates a plain **user** password account
(`createLocalAccount` with `passwordHash`). The form answers the same for an
address that already has an account, and sends it nothing.
