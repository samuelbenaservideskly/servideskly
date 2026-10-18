# Ticket table: the UX brief

The owner's brief, kept verbatim in substance, for the pass over the ticket
list. **Queued on 15 Oct 2026; do not start it until the owner says so.**

Where the work is:

| Thing | File |
| --- | --- |
| The table itself | `views/tickets/index.ejs` |
| Row, badge and SLA styles | `public/css/app.css` (`.ticket-row`, `.pill`, `.badge`, `.table`) |
| What a row carries | `listTickets()` in `src/services/tickets.ts` |
| The SLA badge and its rules | `slaMatches()`, `slaOf()` in `src/services/sla.ts` |
| Filters and paging | `src/routes/tickets.ts` |

Design principle, in the owner's words: **prefer subtle, intentional
improvements over a dramatic redesign. The result should feel like a refined
enterprise SaaS application, not a completely different product.**

## 1. Headers

- Sentence case, not ALL CAPS: Reference, Title, Type, Status, Priority,
  Requester, Assignee, Updated.
- About 12-13px, medium weight (500-600).
- A subtle neutral secondary colour, not saturated blue.
- No excessive letter spacing.
- White or very light neutral background, subtle bottom border.
- Header alignment consistent with the column's content.

## 2. Typography and spacing

- A clear hierarchy between title, reference, metadata and status.
- Consistent row heights, padding and vertical alignment.
- Compact enough to show many tickets without feeling cramped.
- Subtle horizontal dividers rather than heavy borders.
- A subtle row-hover state.
- No unnecessary cards, shadows, gradients or decoration.

## 3. Status and priority

- Keep Open, In progress and On-hold visually distinct.
- Restrained, accessible badge colours; consistent padding, radius,
  typography and size.
- Readable without every badge dominating.
- Priority must stay distinct from status.
- Red used sparingly: urgent issues and SLA breaches.
- Status and priority must be distinguishable **without relying on colour
  alone**.

## 4. SLA breach styling

Today a breached ticket carries a red-tinted row, a red left border, a green
Open badge and a red Breached flag - four competing treatments.

- Keep the breach immediately recognisable.
- Use a subtle row tint **or** a left border, not both plus more.
- Keep the breach indicator visible and understandable.
- Keep the status badge independent of the SLA state.
- Breached tickets must still be easy to spot when scanning.

## 5. Links and titles

- Review the green underlined styling on references and titles.
- A consistent, accessible link treatment that fits the design system;
  consider neutral or brand colour with an underline on hover.
- Links must stay distinguishable from ordinary text.
- Keep clear hover and keyboard-focus states.

## 6. Requester and assignee

- Make truncated names such as `Tomas Dvorak - (Service ...)` easier to read.
- Lead with the person's name; team or company as secondary context.
- Preserve the current data and hierarchy.
- If truncation is needed, give access to the full value through a tooltip or
  an accessible alternative that works for mouse, keyboard and touch.
- Adjust column widths by content importance and available width.

## 7. Usability

**Inspect what exists first** - much of this is already built:

- Sortable headers with clear indicators (check what sorting exists today).
- Search and filters easy to find. Filtering by status, priority, assignee
  and SLA breach **already exists** (`?q=`, `?status=`, `?sla=` and others in
  `routes/tickets.ts`); do not duplicate it.
- Clickable references and titles easy to hit.
- Preserve pagination, comments and every existing interaction.
- Usable at narrow widths without breaking.
- **No duplicate controls, no unnecessary features.**

## 8. Accessibility

- Sufficient text and badge contrast.
- Visible keyboard-focus indicators.
- Semantic table markup and proper column headers.
- Never colour alone for important state.
- Accessible names and reasonable hit areas on interactive elements.
- Follow the patterns the application already uses (`partials/info.ejs`,
  `.sr-only`, `aria-current`, and so on).

## 9. Constraints

- Inspect the codebase, component structure, styling conventions and design
  system first; find the current table and its styles before changing
  anything.
- Reuse existing components, tokens and dependencies.
- **No new libraries** unless genuinely necessary - and in this project that
  means asking the owner.
- Do not change business logic, API contracts, ticket data, status semantics
  or permissions.
- Do not replace working functionality with mock data.
- Keep to the existing stack: server-rendered EJS, one stylesheet, and no new
  client script without the owner's approval (CLAUDE.md's table).
- No unrelated refactoring.

## 10. Expected result

A polished version of the existing table: sentence-case headers, a calmer and
more consistent hierarchy, tickets and statuses and priorities and breaches
easier to scan, long names handled gracefully, consistent spacing, typography,
borders and badges, and every existing behaviour preserved.

**Implement it, do not stop at recommendations.** Afterwards run
`npm run verify` (typecheck, tests, audit), fix anything the change broke, and
summarise the files modified, the improvements made and the checks run.
