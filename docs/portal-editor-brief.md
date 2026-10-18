# Requester portal editor: three reports

Reported by the owner on 15 Oct 2026. **Queued; not started.** The screenshot
that came with them was the New ticket part of a portal called `test`.

---

## 1. The Customisation tabs should not follow you into a portal

Inside a portal, the page still shows the Customisation tab row - Appearance,
Attachments, Requester portal, Custom images, Locale - above the portal's own
header. Once you are editing one portal, the only way out should be **All
portals**, which is already there as a back link.

**Where**: `views/admin/settings/portal-edit.ejs`, line 3:

```
<%- include(tabsPartial, { tab: tabKey }) %>
```

`tabsPartial` is `_customization-tabs.ejs` for a requester portal and
`_mail-tabs.ejs` for the approval page. The **list** page
(`views/admin/settings/portal.ejs`) includes the same partial and **should
keep it** - that page is a tab of Customisation. Only the editor should drop
it.

Check both kinds when changing it: the approval editor has the same shape, and
the same argument applies to the Mail tabs there.

Watch for: the settings shell (`_layout.ejs`) needs its locals whatever the
tabs do - trap 5 in CLAUDE.md.

---

## 2. Not everything customisable is offered

A portal today has these parts (`PORTAL_PARTS` / `PORTAL_PAGES` in
`src/services/portal.ts`): Layout, CSS, Home, My tickets, New ticket, Ticket,
Profile, Sign-in, Sign-in password, Sign-in code, and JavaScript when it is
switched on.

**Missing, as reported: the dashboard, and widgets.** Today a dashboard is
designed under **Settings - Dashboards** (its own standard-or-custom HTML per
dashboard) and a portal can only *embed* one with `{{dashboard:<id>}}`. So a
portal author cannot see or change what a requester's dashboard looks like
from the place they are designing the portal.

This needs a decision from the owner before any code:

- **(a) A Dashboard part in the portal editor** - the portal owns the markup,
  and Settings - Dashboards keeps only which dashboards exist and their data.
  Clean for the author, but two places could then define the same thing.
- **(b) Leave the design in Settings - Dashboards** and add a link, plus a
  list in the portal editor of the dashboards this portal embeds, so they are
  at least discoverable from here.
- **(c) Both**: the dashboard keeps its own design, and the portal may
  override it with a part of its own.

Whichever is chosen, the variable checks (`partProblems`, `designProblems`,
`VARIABLES_BY_KIND`) must cover the new part, and a dashboard id that is not a
dashboard must stay refused.

---

## 3. The preview does not reflect everything, and a new portal previews the
old design

Two separate things, reported together:

**The starter is the pre-2026 design.** `STARTER_LAYOUT`, `STARTER_HOME` and
`STARTER_CSS` in `services/portal.ts` are a header-with-nav design from before
the 2026 sidebar shell. Their colours were moved to the new indigo on
15 Oct 2026, but the markup and the layout were not - so a portal created
today still *starts* looking like the old product. Rewriting the three
starters to the current design is the fix, and it changes nothing for a portal
that already exists.

**An existing portal keeps its own CSS, by design.** That is not a bug:
a portal is the administrator's design and the application must not rewrite
it. If the owner wants existing portals moved to the new look, that is a
deliberate migration of somebody's work and should be offered as an action
("start again from the current design"), never done silently.

**Which settings the preview does not reflect** needs pinning down before
anything is changed - list them first, then fix. Known by design:

- A custom portal does **not** use Appearance colours or the font
  (CLAUDE.md "A custom portal does not use Appearance"); it is its own CSS on
  top of app.css. If the owner expects Appearance to show through, that is a
  change of decision, not a bug.
- The preview is a real page in a sandboxed frame and shows **what is saved**,
  not what is typed. There is no live preview on purpose - it would need a
  script, which is the exception this project refuses by default.

So the work is: enumerate what the owner expects to see in the preview, decide
which of those are deliberate decisions, and fix only the rest.

---

## Checks

`npm run verify` (typecheck, tests, audit). The portal tests are
`tests/portal.test.ts`, `tests/portal-scripts.test.ts` and
`tests/approval-page.test.ts`. Restart the server after touching
`public/css` or `public/js` - the asset version is hashed at start-up.
