# AGENTS.md - start here

For any coding agent picking up this project. This file says **how to work
here** and **where everything is written down**. It does not repeat the two
documents that hold the detail:

| File | What it holds | Read it |
| --- | --- | --- |
| [CLAUDE.md](CLAUDE.md) | Every deliberate decision and every trap, by feature. The rules of the codebase. | Before changing anything; search it for the feature you touch. |
| [HANDOFF.md](HANDOFF.md) | How to run it, where each feature lives, the numbered list of what was built (section 5), what is still open (section 6). | First, end to end. |
| [docs/MANUAL.md](docs/MANUAL.md) | The administrator's manual: first run, sign-in, provisioning, mail, templates, every setting. | To learn what a feature does from the outside. |
| [AZURE-DEPLOYMENT.md](AZURE-DEPLOYMENT.md) | Running one helpdesk on Azure: PostgreSQL, Key Vault, the web app, deploying, the first administrator. | Before any Azure or GitHub Actions work. |
| [HETZNER-DEPLOYMENT.md](HETZNER-DEPLOYMENT.md) | A plan (not built) for hosting customers' helpdesks on Hetzner: Terraform, GHCR images, GitOps customers.yml, Litestream. | If hosting cost on Azure becomes the question. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production: why SQLite cannot go on Azure Files, what moving to SQL Server touches. | Before any deployment talk. |

State on 12 Oct 2026: **871 tests passing, 0 vulnerabilities**, migrations up
to 49. A working local proof of concept.

---

## 0. Repositories

- This repository: https://github.com/servideskly/servideskly
  (public, source-available under PolyForm Shield 1.0.0). Branch `main` is where work lands; branch `production`
  is the released version, moved forward along `main` by the maintainer's
  release process. The only workflow here is **CI** (push to main, pull
  requests): deploying and operating hosted helpdesks happens in the
  maintainer's private repository, so its logs - app names, resource groups,
  Azure identifiers - never become public.
- The maintainer's hosting portal (which orders, builds and hosts helpdesks
  on Azure) is a **separate, private** project. It deploys this code
  unmodified and points each helpdesk's "Source code" link here.
- Azure sign-in from Actions is OpenID Connect: repository variables
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
- **Never act on the maintainer's live Azure resources unannounced**, and
  never handle a secret's value.
- **Public repository**: never commit an environment's identifiers
  (tenant, subscription or client ids, vault names), personal addresses, or
  anything from `.env`. Examples use placeholders.
- Commit author: the maintainer's GitHub noreply address (set per repository).
- **Two databases**: SQLite by default, PostgreSQL when `DATABASE_URL` is
  set - see CLAUDE.md "SQLite or PostgreSQL". After adding a migration, give
  it a `pg` variant (or regenerate `src/db/pg-schema.ts`); CI's PostgreSQL
  job runs every test there too.

## 1. Run, check, preview

```bash
npm install
npm run dev        # http://localhost:3000/login - the owner's own server
npm run verify     # typecheck (src and tests) + all tests + npm audit
npm run build      # tsc to dist/, for npm start
```

Seeded accounts (test values, local only): `admin@local` (break-glass
administrator) and `user@local`, both password `1234`. Sign-in is two steps:
the address, then the password.

Preview servers are in `.claude/launch.json`:

- **helpdesk-preview** (port 3100) runs against the owner's **real**
  database. Look, never create test data there.
- **helpdesk-scratch** (port 3102) has its own database in the session
  scratchpad. Use it for anything that writes. Its sessions are lost on
  restart, so sign in again after each restart.

**A stylesheet or script change needs a server restart**: the `?v=` asset
hash is computed once at start-up and `/assets` is cached for seven days.
After a change, restart the preview, and tell the owner to restart their
`npm run dev` (they also test on a phone through ngrok against it).

## 2. How the owner wants the work done

These came from the owner directly. Follow them without being asked again.

- **Do all the requested changes first, then check once at the end.** One
  `npm run verify` and one short browser pass covering everything - not a
  check after every item. Usage limits are a real constraint.
- **No em dashes anywhere** - UI text, source comments, documents. A plain
  hyphen `-`.
- **No JavaScript without the owner's approval.** Five exceptions exist,
  listed in CLAUDE.md's table (form-builder, copy, automation-canvas, portal
  scripts, select-search). A feature that seems to need another script:
  design it without (`:target` dialogs, radio-sibling and `:has()` tricks,
  a GET form), or ask. Scripts never use `fetch`; they submit forms.
- **Do not explain the page to the person reading it.** No definitions,
  no instructions for visible controls. Explanations go in an ⓘ
  (`partials/info.ejs`). Keep only limits, warnings, empty states and
  reasons for a refusal.
- **Creating things happens in a dialog behind a `+ New ...` button**, one
  primary button per screen, sentence case, a dialog's button repeats the
  action. See CLAUDE.md "House style".
- **A refusal lands beside the control** that caused it, never as an error
  page (`attempt()`, `flash(..., where)`).
- **Remove is a bin icon** on the right of a row (`partials/bin-button.ejs`,
  `href` for a confirmation dialog).
- **Long lists are searched and paged in SQL** (groups, users); long
  dropdowns and tick-lists get the select-search box automatically.
- When the owner reports something "looks weird", reproduce it at the size
  they used (they often use a narrow window or a phone) before fixing.
- Answer the question asked; when a request is ambiguous and the choice is
  costly, ask one short question with options.

## 3. How to edit safely (these have cost time before)

- **Multi-line edits: write a small Node patch script** to the scratchpad
  (`fs.readFileSync`, assert each anchor occurs exactly once, replace,
  write). Never heredocs or `node -e` for source that contains backslashes,
  backticks or regexes - they have silently corrupted source here
  repeatedly (CLAUDE.md trap 2). Inside a patch script's template literal,
  a backslash in the target source must be written twice.
- **Check a file does not exist before creating it.** Tests were overwritten
  twice by a new file with an old name.
- **Never edit a shipped migration** (`src/db/migrations.ts`); append one.
  New boolean columns go in `BOOLEAN_COLUMNS`, JSON ones in `JSON_COLUMNS`.
- **SQL placeholders are positional `?`** - check argument order by hand.
- **`<%= %>` escapes, so it cannot build an attribute.** Write the
  attribute literally inside an `if`.
- **Every `/admin/settings/*` render goes through `settingsView()`**,
  including 400 branches.
- **Grep `public/css/app.css` before naming a class** - one stylesheet
  serves every page and a collision is silent.
- The folder is **not a git repository**: nothing can be reverted with git.
  Do not delete files you did not create; Claude Code's file history
  (`~/.claude/file-history/`) and the session transcript are the only undo.
- A failing test: decide whether the test or the code is wrong before
  changing either. When a deliberate change breaks an assertion (a page
  that now legitimately carries the select-search script, say), update the
  assertion to state the new rule, not just to pass.

## 4. Where things are

```
src/app.ts               middleware order (SCIM and /hooks before sessions)
src/server.ts            start-up order: migrations, seeds, sweeps
src/db/migrations.ts     forward-only migrations 1-49
src/settings/            one JSON settings row, cached; settings() is sync
src/middleware/          security headers, CSP helpers, select-search
src/routes/              one router per area; *-admin.ts are Settings pages
src/services/            the logic; automation.ts is the engine
views/                   EJS; views/admin/settings/* are Settings pages
public/css/app.css       the one stylesheet
public/js/               the approved scripts only
tests/                   node:test + supertest, one SQLite file per test file
```

HANDOFF.md section 4 maps every Settings page to its route, service and
view.

## 5. What was done most recently

HANDOFF.md section 5 lists everything built, numbered. The latest round
(items 40-46, 12 Oct 2026):

- Cancellation and resolution notes (Ticket templates - Other settings -
  Status notes); automation Set status has its own "Add a note".
- The requester's card on a ticket (click the name).
- Dashboards can be renamed (the id, and so the portal variable, stays).
- Automations create ticket templates and notifications; a sixth worked
  example; a bin per automation row.
- select-search.js (approved): search in dropdowns over 8 options and in
  long tick-lists; Kind then Form on New ticket.
- Local users change their own password on Profile.
- Error pages (404, 403, 429, 500, wrong approver) in one large-number
  layout.
- Group lists searched and paged in SQL.
- Automation canvas: wires run dot to dot (every step has an input dot);
  a wire into a box to the left goes round, never loops back through the
  boxes; click or right-click a wire to remove that connection; the wheel
  zooms over the diagram; the diagram window is taller; a dragged box is
  drawn on top.

## 6. Open questions waiting on the owner

HANDOFF.md section 6 is the list. In short: group manager powers, what "a
URL for custom fields" should mean, Entra in one step, LDAP sign-in, SAML
(only if a customer needs it), languages (deferred). Do not build these on
a guess.

## 7. Before saying "done"

1. `npm run verify` is all green, with the test count you expect.
2. `npm run build` passes.
3. One browser pass on **helpdesk-scratch** over everything changed, at the
   width the owner reported it.
4. CLAUDE.md has the decision and its reason; HANDOFF.md section 5 has a
   numbered item; the test counts in CLAUDE.md, HANDOFF.md and this file
   are updated.
5. Restart **helpdesk-preview**, and tell the owner to restart `npm run dev`
   if CSS or a script changed.
6. Report what changed in plain words, and say plainly what was not checked.
