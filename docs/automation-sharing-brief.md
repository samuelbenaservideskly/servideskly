# Automations shared with technician groups

Asked for by the owner on 16 Oct 2026, alongside the Activity feed's pen:

> automations should be scopable to specific technician groups, with read /
> edit access. So when technician click automation on the left side it will
> be taken to that page and it should show the shared automations

**Designed, not built.** This is a permission model, and the three things it
touches - who sees the sidebar link, what the list contains, and what a
request may do - are the kind of thing that is cheap to get right once and
expensive to unpick.

---

## What exists today

- `/admin/settings/advanced/automation` lives under the settings router,
  which is **administrators only** (`requireAdmin()` in `admin.ts`). A
  technician has no sidebar link and a 403 if they type the address.
- An automation is a row in `automations` with a `graph` (nodes and edges)
  and `created_by`. Nothing says who else may read it.
- Its steps can set a status, write a comment, call an HTTP endpoint with a
  stored credential, raise a ticket, create a template or a notification -
  so "edit" is a far larger permission than "read".

## The model

A table, one row per group that an automation is shared with:

```sql
CREATE TABLE automation_group_access (
  automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  group_id      TEXT NOT NULL REFERENCES technician_groups (id) ON DELETE CASCADE,
  access        TEXT NOT NULL CHECK (access IN ('read', 'edit')),
  added_at      TEXT NOT NULL,
  PRIMARY KEY (automation_id, group_id)
);
```

One row per pair, so a group has one level per automation - "read and edit"
is not two rows, it is `edit`. The same shape as
`portal_group_assignments` and `smtp_relay_groups`, for the same reason: a
group follows exactly one of them.

`automationAccess(user, automation)` returns `'none' | 'read' | 'edit'`:

1. An administrator: `edit`, always. They can reach every setting anyway.
2. Otherwise the highest level any of their technician groups has.
3. Nobody else: `none` - including the person who created it, unless a
   group of theirs is on the list. Creation is not ownership here; a
   service desk is a team.

## What each level may do

| | read | edit |
| --- | --- | --- |
| See it in the list, open the diagram, read each step's settings | yes | yes |
| See its last runs | yes | yes |
| Switch it on or off | no | yes |
| Move, add, remove, rewire a step | no | yes |
| Choose a **connection** or an **API key** in a step | no | **no** |

That last row is the one to argue about, and the answer is no: a connection
holds a credential and an API key is a credential. A technician with edit
could otherwise point a request at an endpoint of their choosing carrying
the service desk's token. Editing a step that *uses* one is fine; choosing
which one is an administrator's decision. `stepProblems()` already refuses
a step whose settings are incomplete, and this is one more refusal in the
same place.

## Where it shows

- **The sidebar**: Automation appears for a technician when
  `automationsVisibleTo(user)` is not empty - the same shape as the People
  link following `canUseDirectory`.
- **The list** shows only what they may see, with a quiet "Read only" pill
  on the ones they cannot change.
- **The editor** is the same page; every form that changes something is
  simply absent at `read`, and the POST behind it refuses - the page is a
  display hint and a browser can post anything (CLAUDE.md's rule for the
  template builder, which this follows).
- **The automation list page** is still under `/admin/settings/...` for an
  administrator. For a technician it needs an address that is not under
  `/admin`, because that whole subtree is administrator-only: `/automations`,
  mounted like `/people`, with the same page behind it.

## What to decide before building

1. **Does a technician's edit need an audit entry that says which group gave
   them the right?** Recommendation: yes - the audit trail answers "who
   could have done this", and group membership changes over time.
2. **May a technician create an automation?** Recommendation: no, not at
   first. Creating one is choosing a trigger, and a trigger decides when
   somebody else's tickets move.
3. **Do SLA-breach and HTTP triggers stay administrator-only?** An HTTP
   trigger names an API key, so by the table above a technician cannot
   configure one. Recommendation: they may read it, not edit it.

## Checks

The permission function wants a test per row of that table, and the editor
wants one test per form that it is absent **and** refused at `read` - the
pair, not just the page, is the rule this codebase keeps.
