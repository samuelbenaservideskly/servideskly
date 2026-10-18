# Reporting - audit, what was built, and what is next

Written against the MSP reporting brief (October 2026). It records what
the reporting module was, what is now true of it, how every figure is
counted, and what cannot be reported honestly until the data exists.

"Confirmed" means seen in the code or proven by a test. "Recommended" means
not built.

---

## 1. Audit: what existed

### Where reporting lives

| Surface | Code | What it shows | Who |
| --- | --- | --- | --- |
| Reports (`/reports`) | `services/reports.ts`, `routes/reports.ts`, `views/reports.ejs` | A period's figures for one or all of the reader's technician groups, by company | Staff in or managing a group; administrators |
| Excel / CSV download | `reportWorkbook()`, `reportCsv()` | The same figures; each ticket on request | Same as the page |
| Dashboard (`/dashboard`) | `services/work-dashboard.ts` | My work, and a manager view of the groups they manage | Every technician and administrator |
| My dashboards (`/boards`) | `services/boards.ts` | Widgets; the report ones call `buildReport()` | Staff |
| Ticket page | `services/sla.ts` | Both SLA clocks of one ticket | Staff |
| API (`GET /api/v1/tickets`) | `routes/api-read.ts` | Ticket records, not aggregates | API keys with Read tickets |

**Architecture.** Everything is computed on demand from live data. Nothing is
pre-aggregated or cached. Every surface asks `buildReport()`, which keeps
figures consistent and history re-readable, at the cost of work per request
(about 40 ms for 90 days of the demo data). The SLA clocks are worked out
from the ticket's own dates and events (`slaFromFacts`). Nothing about SLA is
stored per ticket.

### The data model, as it bears on reporting

| The brief asks about | In this application |
| --- | --- |
| Customers / organisations | `users.company`, free text on the requester. There is no customer entity. |
| Tenants | One helpdesk per customer database (the hosted model). Within a helpdesk, scoping is by technician group. |
| Contracts, billing, rates, revenue | **None.** |
| Time tracking / work logs | **None.** |
| Services, assets, CMDB | **None.** The nearest is the category tree (`ticket_categories`). |
| Problem records, root cause, major incident | **None.** There is a ticket type (incident, service request, change, task) and a priority. |
| Customer satisfaction | **None.** |
| Ticket source (mail, portal, API) | **Not stored per ticket.** It could be inferred from `mail_threads`, but it is not. |
| Waiting for customer or vendor | One On-hold status (`pending`), with a required reason in a comment. It does not say who is being waited for. |
| SLA policy | One calendar (days, hours, holidays, Locale time zone) and targets per priority. There are no per-contract or per-customer policies. |
| History | `ticket_events` records creation, every status, priority, assignee and group change (with actor), and comments. `audit_log` records administrative actions. |

### Problems confirmed in the code (before this work)

1. **There was no path from a figure to its tickets.** Every number was a
   dead end.
2. **Cancelled and reopened counted events, not tickets.** A ticket cancelled,
   restored and cancelled again counted twice.
3. **An administrator's "All groups" left out tickets routed to no group.**
   Unrouted tickets appeared in no report at all.
4. **There was no comparison** with any earlier period.
5. **"Open now" was the only backlog figure.** There was no backlog at the
   start or end of the period, no ageing, and no unassigned, on-hold or
   stale counts.
6. **Medians only**, in calendar time, while the SLA is measured in business
   time. There was no P90 and no average.
7. **No definitions** were visible anywhere.
8. **No index on the date columns reports filter by.** The only one was
   `(group_id, updated_at)`.

### Still true (found, deliberately not changed - decisions for the owner)

- ~~An automation's public comment or status change counted as the first
  response.~~ **Fixed 15 Oct 2026** (owner's decision): what an automation
  writes, and a ticket closing itself, is marked `automatic` (migration 56,
  `asAutomatic()`) and is never a first response. Resolution is unchanged.
  Older automatic writes were marked once at start-up by their run
  (`markPastAutomationWrites()`), so past response figures fell where an
  automation had been the only "answer".
- **A changed SLA target re-reads history.** CLAUDE.md records this as
  deliberate ("a changed target re-reads everything"). The brief asks for
  the opposite: past reports must not change. Doing that means copying the
  targets onto each ticket when it is raised, as is already done for the
  reference prefix and the task rules. **Recommended**, but it reverses a
  recorded decision, so it is the owner's call.
- **The SLA uses the ticket's current priority**, not the priority at the time.
  A priority change rewrites that ticket's targets. The same fix covers it.
- **Resolution time is from creation to the latest resolution.** A reopened
  and re-resolved ticket counts once, at its latest resolution;
  `resolved_at` is cleared on reopen.
- **"Open at start/end" is reconstructed from dates.** A ticket reopened
  later may count as open at a moment it was resolved. Exact history would
  replay `ticket_events`. That is affordable, but not done.

---

## 2. What was built

All of it is in `services/reports.ts`, behind the same `reportScope()`, so the
page, the lists, the Excel and CSV downloads, the dashboard and the board
widgets cannot disagree.

- **Every figure opens its tickets** (`/reports/tickets?metric=...`, with the
  report's own group, company and period). Lists exist for raised, resolved,
  closed, cancelled, reopened, open now, unassigned, on hold, no change in 7
  days, any breach, response or resolution breached, and response or
  resolution met. They can be narrowed by priority, type, top-level category,
  company or age bucket, 50 to a page. The service-level lists run the same
  clocks over the same tickets as the figures. Each breach says **which
  target, when it was due, when it was met (or that it is still open), and
  how late in business time**. A test asserts that every list's count equals
  its figure.
- **Comparison with the previous period** of the same length and scope, on
  every headline figure and median. An arrow and words carry the change,
  never colour alone, and a percentage appears only when the previous value
  is not zero.
- **Backlog**: open at the start and at the end of the period. Open now by
  age (under a day, 1-7, 8-14, 15-30, over 30 days) and by priority, every
  cell a link. Also unassigned, on hold, and no change in 7 days.
- **Time to respond and resolve**: median, average and P90 in calendar time.
  While SLA is on, also the median in **business hours**.
- **Reopen rate**: tickets reopened / tickets resolved.
- **By category**: the top level of the category tree, raised and breached.
- **Unrouted tickets** are included in an administrator's All groups, and the
  page says so.
- **Definitions** (`METRIC_DEFINITIONS`) appear on the page ("How each figure
  is counted"), on every list, and on a **Definitions sheet** in the Excel
  download. The workbook also gained a previous-period column and **Backlog
  age** and **By category** sheets.
- **Print**: the page has a print stylesheet that hides the sidebar,
  filters and buttons, and keeps cards whole. The browser's Print / Save as
  PDF gives a usable document. It is not a designed PDF; see the roadmap.
- **Indexes** (migration 54): `tickets (group_id, created_at)`,
  `tickets (group_id, resolved_at)` and `ticket_events (field, created_at)`.
- A **Clear** button on the filters, and a sentence above the technician
  table: the counts are workload, not a score.

## 3. Reporting inventory

| Report | Filters | Figures |
| --- | --- | --- |
| Reports page | Group (yours, or all), company, period (7/30/90 days, or between dates, up to a year), ticket details in the download | Raised, resolved, closed, cancelled, reopened (+ rate), open at start/end/now; response and resolution met/breached/running and rate; first response and resolution median/average/P90 (+ business median); day by day; backlog by age and priority; by priority, type, category, company; technicians (managers and administrators only); each with the previous period |
| Tickets behind a figure | The report's filters, plus priority, type, category, company, age | The tickets, with a breach's reason |
| Excel | The report's filters | Summary (with previous period), Backlog age, By category, By company, Priority and type, Day by day, Technicians, Tickets (on request), Definitions |
| CSV | The report's filters | The summary and breakdowns, for scripts |
| Dashboard | - | Open (24 h change), raised in 24 h, SLA met over 30 days (the report's figure), at risk; my tickets with their clocks; activity |

## 4. Metric definitions

The source of truth is `METRIC_DEFINITIONS` in `services/reports.ts`. The
page and the Definitions sheet print it. In short:

| Figure | Counted as | Time basis |
| --- | --- | --- |
| Raised | Top-level tickets created; cancelled included | Creation date |
| Resolved | Current `resolved_at` in the period; closing directly also resolves; reopened then re-resolved counts once | Resolution date |
| Closed | `closed_at` in the period | Closing date |
| Cancelled / Reopened | **Tickets** with such a status change in the period, each once | Event date |
| Open at start / end | Raised before, and not resolved, closed or cancelled by, that moment | The moment |
| Response / resolution met, breached, running | Tickets **raised in the period**, by clock state now; rate = met / (met + breached) | Creation cohort, business time |
| First response | First public comment or status change by anybody but the requester | Creation cohort |
| Resolution time | Creation to resolution (or closing) | Creation cohort |
| Age buckets | Time since creation, now; boundaries at 1, 7, 14, 30 days | Now |
| No change in 7 days | `updated_at` older than 7 days (any change counts) | Now |

Excluded everywhere: tasks (they are part of their ticket). Excluded from
SLA: cancelled tickets. Dates and days are in the Locale time zone.
Missing data: a figure with nothing to count shows "-", never 0% or a
guess.

## 5. Data dependencies (not built, and why)

| Brief section | Needs, which does not exist |
| --- | --- |
| Profitability, contracts, hours, margin (5) | Contracts (model, validity, currency, allowance), time entries (who, how long, billable), rates. **Nothing may be inferred from ticket counts.** |
| Logged hours, utilisation, capacity (6, 10) | Time entries. Availability exists (`availability_week`, `availability_entries`) and could give *available* days, but not hours worked. |
| CSAT (9) | A survey on resolution, with responses stored. |
| Services, assets, recurring incidents by asset (4.2, 8) | A service catalogue or CMDB. Categories are the stand-in. |
| Major incidents, root cause, problem records, changes causing incidents (8) | A major flag, problem records, and links between tickets. |
| Waiting for customer vs vendor (7.2) | On-hold reasons as a choice, not free text. |
| Ticket source (7.1) | A `source` column set at creation (mail, portal, API, automation). |
| Per-customer or per-contract SLA (3.2) | Policies keyed to a company or contract. Today there is one calendar. |
| Customer-facing reports (4.3) | A customer entity, and a permission for a requester to see their company's figures. **Not exposed at all today**: requesters get a 404 on every report route. |

## 6. Testing

`tests/reports-msp.test.ts` (11 tests) builds a group with known tickets:
answered in ten minutes, breached, met, cancelled twice, reopened twice,
older than the period, unrouted, and another group's. It asserts:

- the exact figures, including one cancelled and one reopened despite two
  events each;
- backlog at the start and end, the previous period, and the age bucket;
- **every list's count equals its figure** (13 figures);
- a breach's explanation;
- narrowing by priority, age and company;
- unrouted tickets for an administrator only;
- that a technician asking for another group's list gets their own groups;
- that requesters and unknown figures get a 404;
- that the page links and compares, and that the workbook carries
  Definitions and Backlog age.

P90, median and age-bucket boundaries are unit-tested. Business-time
arithmetic, DST and holidays were already covered by `tests/sla.test.ts`.
Full suite: 916 passing.

**Not covered**: very large datasets (the cap is `REPORT_CAP`, 3,000 tickets
per period for the SLA figures, and the page says when it applies), and
PostgreSQL timing.

## 7. Security and performance

- **Scope is enforced server-side** in `reportScope()`, which every route
  uses: the page, the lists, Excel and CSV. A group the reader may not see
  falls back to their own groups. A company not among their groups'
  companies is ignored. Ticket links still go through the ticket page's own
  `canViewTicket`.
- Per-technician figures appear only when the reader manages every group in
  the report.
- Exports are audited (`report.exported`). The lists are read-only and not
  audited.
- **Performance**: no N+1 queries. SLA facts are loaded in two queries per
  500 tickets. A full report is now about twice the old work, because the
  previous period is read too (a "light" report: totals, SLA, timing,
  backlog). There is no cache; at this scale none is needed.
- **Open concern**: the lists for the service-level figures recompute the
  clocks for the whole period on every page of the list. That is fine at
  thousands of tickets, and is what a cache would fix first.

## 8. Roadmap, by business value

1. ~~Automation responses do not stop the response clock~~ - done.
2. **Freeze SLA targets per ticket at creation** (owner's decision; reverses
   a recorded choice). After that, past reports never change.
3. **Scheduled reports**: a weekly summary and a daily SLA-risk mail to group
   managers. The mail queue, notifications and sweeps already exist.
4. **Customer entity, and a customer-facing service review** (a monthly page
   or PDF per company), with its own permission. The company report is
   already most of the content.
5. **Time entries** on tickets (minutes, billable flag). This unlocks hours,
   utilisation and, with contracts, profitability.
6. **Ticket source** column and **On-hold reasons** (customer, vendor,
   internal).
7. **Contracts** (retainer, hour bundle, T&M), with allowance and overage.
8. **CSAT** survey on resolution.
9. A designed **PDF** (server-side). It needs a rendering dependency, which
   this project avoids, so it is a decision rather than a task.
