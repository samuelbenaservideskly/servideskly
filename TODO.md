# TODO - what was done, what is next

For the next AI agent. Read this first, then [CLAUDE.md](CLAUDE.md) (decisions
and traps) and [HANDOFF.md](HANDOFF.md) (how to run it, where things live).
Written 16 Oct 2026, at the end of a long session.

> **Picking this up mid-queue?** [docs/NEXT.md](docs/NEXT.md) is the current
> hand-over: the owner's open reports in the order they were made, the two
> gaps left in the languages feature, and the encryption-at-rest question
> that wants a brief before any code. It is newer than the rest of this file.

## 18 Oct 2026 - done, and what is open

Helpdesk (development, promoted to production up to 26d9f89):
- Linen and petrol design layer (end of app.css), defaults petrol/Inter,
  quick colours Petrol/Forest/Ochre/Plum, logo A as the default mark.
- Inter preloaded, `font-display: optional` (no font flicker).
- /setup: eye on both boxes + rules box; "Confirm password" labels.
- Logo drawn at a fixed height (sidebar 2.25rem, sign-in 3rem).
- SCIM pairs with accounts that signed in through this tenant's Entra first
  (`scope()` in services/scim.ts); their object id is never overwritten.
- Settings search bar (services/settings-search.ts, /admin/settings/search).
- Write API: POST/PATCH /api/v1 (routes/api-write.ts), examples generated.

Portal (main, deployed): redesign, address check behind sign-in with rate
limits, "Order another helpdesk", styled dropdowns, done mark, robots.txt,
Entra branding set in branding/entra (custom.css too).

Open:
- The test helpdesk redeployed; SCIM pairing confirmed working (18 Oct).
- Portal home example now drawn as the helpdesk (done 18 Oct).
- Entra SCIM mapping: externalId should be objectId (tell the customer).

## State right now

- Branch `development` (helpdesk) and `main` (customer portal at
  `C:\Temp\Ticketing system - Customer portal`). **Nothing has been pushed or
  deployed.**
- `npm run verify`: **1,034 tests passing**, 0 vulnerabilities.
- Migrations up to **62** (custom languages; a mail rule may look at the
  subject and the message text), and
  `src/db/pg-schema.ts` has been regenerated, so the PostgreSQL baseline is
  59 as well. Everything else added this session lives in the settings
  document.
- The owner runs `npm run dev` on 3000; the demo is `npm run dev:demo` on
  3001. **CSS, scripts and migrations only take effect after a restart.**

## Done in this session (newest last)

Earlier half (fonts, the dashboard's SLA figure, the new-ticket picker, the
password rules box) is described in CLAUDE.md; the rest of this session:

- **Ticket table UX pass** (brief: docs/ticket-table-brief.md): sentence-case
  headers, sortable columns with aria-sort and no script, soft column
  separators, one SLA treatment, people shown as a name with the company
  under it. Long attachment names are shortened in the middle.
- **Settings - Ticket templates is now Settings - Tickets**, and its Other
  settings is **one page, a chevron per decision** (prefixes, service
  levels, status notes, deleting). The old sub-tab addresses 308 to it.
- **Delete closed tickets after N days** - a sweep beside auto-close, off by
  default, a real delete, audited before the row goes.
- **The service catalogue**: tiles mapped to templates, with icons, a grid
  the service desk sets (columns x rows), paging, a preview that *is* the
  editor with a + in every empty cell, and drag and drop
  (catalogue-grid.js, the seventh approved script). A tile whose form the
  reader may not raise is left out and the rest close the gap.
- **Remove and anonymise** (GDPR erasure): the account goes, its work stays
  under one hidden `Anonymous` placeholder. Neither placeholder account can
  be listed or enabled.
- **Temporary passwords**: Send temporary password on a person's page, the
  CSV import can mail each generated one, and a password that must change
  now stops the sign-in at a third step (`/login/new-password`) instead of
  letting somebody in. The default policy is 8 characters with upper, lower,
  digit and symbol.
- **/people/:id** - one person, read only, for every technician; the queue
  and the requester card link to it.
- **The Manager dashboard filters by several groups**, through the same
  dropdown (select-search learned `data-multi`).
- A long list of reported UI fixes, each recorded in CLAUDE.md under "Small
  things reported on 15 and 16 Oct 2026".

## Also done, after the first push

- **The queue at a narrow width** (the last of the table brief): column
  widths by what each column is worth, Type and Updated dropped under
  56rem, and the filter bar as a two-column grid under 48rem - as a flex
  row it wrapped into label/control pairs that did not belong together.
- **The portal editor**: no Customisation tabs inside a portal, a starter
  in the 2026 design, "Start again from the current design" for a portal
  that wants it, and the dashboards listed with a link to each design.
- **The people directory** at `/people`, with its three switches under
  Settings - Users - Other settings.

## And after that

- **The search bar searches what it says**: `/search` finds tickets and
  people, and a reference opens its ticket. Each section reads with the
  reader's own permissions.
- **A password change ends the other sessions** - every one but the browser
  in hand on the profile page, every one on a reset link.
- **One mark on every sign-in page** (`partials/signin-mark.ejs`): the logo
  stopped at step one, which read as a different site asking for the
  password.
- **The portal editor's dashboards link carries `?from=<portal>`**, so the
  dashboard design page offers the way back.

**The decision taken, and why**: a portal does **not** own its dashboard
markup (brief option b, not a or c). Two places able to define the same
thing is the trap this codebase avoids everywhere else; the cost is one
journey out of the editor, and the answer was to make the journey painless
rather than to duplicate the markup. Reverse it if the owner disagrees -
nothing built blocks a or c.

## And after that

- **A default template per ticket type** (migration 59), with
  `ensureTypeDefaults()` at start-up. "Raise an incident" now has an answer.
- **The service catalogue's filter buttons**: the kinds the tiles offer,
  each a keepable address, with a New ticket button raising that kind's
  default.
- **A transparent logo keeps its transparency** - read from the file's own
  header, carried to every plate as `--logo-plate`.
- **Custom languages are designed**:
  [docs/custom-language-brief.md](docs/custom-language-brief.md). Not
  started, and the one thing to know before starting is that the markdown
  must be *generated* from the views, because the owner's requirement is
  that a new feature appears in it automatically. Hand-keying strings is
  the wrong road.

## Then, in the same session

- **Tiles have a place**: a cell each, so one can sit anywhere - and a gap
  left on purpose stays while a gap left by permissions closes. The editor
  always draws one page past the last tile; the requester grid is never
  wider than the columns in use; and a tile says who its form is offered to,
  which is the answer to "4 tiles but only 3 in New ticket".
- **New ticket moved into the catalogue's filter row**, since it raises the
  kind those buttons select.
- **Sub-tabs, checkboxes and radios in the 2026 design.** The checkbox rule
  in CLAUDE.md is reversed and rewritten in place: the brand is the indigo
  now, not the crimson the old rule was written against.
- **A list to pick one of** (a mail rule's template) is five rows and a
  search box, not five rows and a fold.
- The language brief records the owner's three answers: `cs-CZ` tags, the
  administration pages translated too, and only built-in text translated -
  notifications getting a set per language.

## And then conditional access

- **Conditional access for password accounts** (Settings - Users - Other
  settings): CIDR ranges sign-in is allowed from, "elsewhere, ask for a code
  by email", "a code for every password account", and the break-glass
  account's own list of addresses. The second step is a real step - there is
  no session until the code is right.
- **The hole the owner found**: must-change was checked before the address
  rule, so a temporary password skipped the gate. The order is now identity,
  then place, then password.
- A code account is exempt from a *second* code, never from the address rule.
- **The code entry is measured in one unit** (`ch`), so the digits and the
  boxes cannot drift apart - reported twice on a phone.
- Small ones: the break-glass page no longer offers availability, and the
  availability status reads "Office" rather than "In the office".

## Then the dashboard and automation round

- **A dashboard can be a widget** on a personal board, drawn with the
  board owner's permissions.
- **Last runs** across every automation
  (`/admin/settings/advanced/automation/runs`), for "what has been
  running?".
- **The Activity feed is chosen** (migration 60): a pen beside the heading,
  four kinds, and automation runs for administrators only.
- **The sign-in code is one field.** The six drawn boxes cost three reports;
  the cause was a second rule that shrank the boxes on a narrow container
  and left the letter spacing alone. Nothing lines up now, so nothing can
  drift.
- The availability status reads "Office", and the break-glass page no
  longer asks for a usual week.

## Next, in order

1. **Automations shared with technician groups** -
   [docs/automation-sharing-brief.md](docs/automation-sharing-brief.md),
   designed and not started. Read/edit per group, a sidebar link that
   follows it, and the one rule to keep: **choosing a connection or an API
   key stays an administrator's decision even at edit.** Three questions at
   the end of the brief want the owner's answer first.
2. **Custom languages** - the brief above. The owner's three answers are
   recorded in it; the extractor comes first.
3. **Freeze SLA targets per ticket at creation** - the owner's decision is
   still pending; it reverses a recorded choice. REPORTING.md s.1.
4. **Scheduled reports**: weekly summary and daily SLA-risk mail to group
   managers. The queue, notifications and sweeps already exist.
5. **Faster pages on PostgreSQL** (HANDOFF item 14) and **attachments in
   Azure Blob Storage** (item 12).
6. Drop the vestigial columns: `tickets.category`,
   `technician_groups.sort_order` and `manager_id`, `sla.timeZone`.

Still waiting on the owner (HANDOFF s.6): group manager powers, a URL for
custom fields, Entra in one step, LDAP, SAML, languages.

## Working here - what has bitten

- **Never write source with shell heredocs or `node -e`** when the text has
  backslashes, backticks or quotes: they are silently eaten. Use the
  Write/Edit tools, or a `.cjs` patch file written with Write - and have it
  assert each anchor occurs **exactly once**, because a half-applied patch
  file is worse than none.
- **Check whether a file already exists before writing one.** Two files were
  overwritten this session (`services/catalogue.ts` and
  `routes/catalogue-admin.ts`, both the *category* catalogue) because the
  new feature wanted the same obvious name. `git checkout --` recovered
  them; the new ones are `service-catalogue*.ts`.
- **A view cannot pass a value to CSS in a `style` attribute**: the policy is
  `style-src 'self'`, so the browser drops it. Use a class.
- **Restart the server after editing `public/css` or `public/js`.** The asset
  version is hashed at start-up.
- When a test fails after a deliberate change, decide whether the test or the
  code is wrong. Sixteen tests this session encoded behaviour the owner had
  just asked to change (the four-tab Other settings, the weak default
  password policy, person links that only administrators had).
- No em dashes anywhere - plain hyphens.
- The project rule "no new scripts without the owner" stands. Two pages
  gained one this session because the owner asked directly; both are in
  CLAUDE.md's table with the date.
