import { Router, type Request } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { auditRequest } from '../lib/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { PRIORITY_LABELS, TYPE_LABELS } from '../services/tickets.js';
import {
  AGE_BUCKETS, DRILL_METRICS, METRIC_DEFINITIONS, NO_CATEGORY, NO_COMPANY, PERIODS, REPORT_CAP,
  buildReport, isDrillMetric, readableHours, reportCsv, reportTickets, reportWorkbook, type ReportInput,
} from '../services/reports.js';
import { STATUS_LABELS } from '../services/tickets.js';
import { settings } from '../settings/index.js';
import { words, wordsWith } from '../i18n/current.js';
import { can } from '../auth/permissions.js';

/**
 * /reports - a group's figures over a period (services/reports.ts); the
 * tickets behind each figure (/reports/tickets); the same as Excel and CSV.
 * Staff who manage or belong to a technician group, and administrators;
 * anybody else gets a 404, as for the dashboard. Every one of them goes
 * through reportScope(), so a list or a download can never reach further
 * than the page.
 */
export const reportsRouter = Router();

reportsRouter.use(requireAuth());
// Open Reports (custom roles, 21 Oct 2026): a technician may by default; a
// custom role only when ticked. Not found rather than refused, as before.
reportsRouter.use((req, _res, next) => next(can(req.currentUser, 'reports.view') ? undefined : notFound()));

function inputFrom(req: Request): ReportInput {
  const q = req.query;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return { group: s(q.group) || 'all', period: s(q.period) || '30', from: s(q.from), to: s(q.to), company: s(q.company), details: q.details === '1' };
}

/** The report's own filters as a query string - for downloads, lists and back links. */
function reportQuery(r: { selected: string; period: { key: string }; company: string }, input: ReportInput, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    group: r.selected,
    period: r.period.key,
    ...(r.company ? { company: r.company } : {}),
    ...(r.period.key === 'custom' ? { from: input.from ?? '', to: input.to ?? '' } : {}),
    ...extra,
  }).toString();
}

reportsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // The page never lists the tickets: "Ticket details" is for the download.
    const input = inputFrom(req);
    const report = await buildReport(req.currentUser!, { ...input, details: false });
    // An administrator with no technician groups yet is told so, not sent a
    // 404 by the link in their own sidebar.
    if (!report && req.currentUser!.role === 'admin') {
      res.render('reports-empty', { title: 'Reports' });
      return;
    }
    if (!report) throw notFound();
    res.render('reports', {
      title: 'Reports',
      report,
      input,
      periods: PERIODS,
      cap: REPORT_CAP,
      readableHours,
      noCompany: NO_COMPANY,
      noCategory: NO_CATEGORY,
      definitions: METRIC_DEFINITIONS,
      timeZone: settings().locale.timeZone,
      priorityLabels: PRIORITY_LABELS,
      typeLabels: TYPE_LABELS,
      csvQuery: reportQuery(report, input, input.details ? { details: '1' } : {}),
      // The tickets behind a figure, with the report's own filters.
      drill: (metric: string, extra: Record<string, string> = {}) => '/reports/tickets?' + reportQuery(report, input, { metric, ...extra }),
      // The same report for one company: the rows of the company table link to it.
      companyLink: (key: string) => '/reports?' + reportQuery({ ...report, company: key }, input),
    });
  }),
);

/** The tickets that make up one figure, a page at a time. */
reportsRouter.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const input = inputFrom(req);
    const q = req.query;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const metric = s(q.metric);
    if (!isDrillMetric(metric)) throw notFound();
    const filter = { metric, priority: s(q.priority), type: s(q.type), category: s(q.category), bucket: s(q.bucket), page: Number(s(q.page)) || 1 };
    const list = await reportTickets(req.currentUser!, input, filter);
    if (!list) throw notFound();
    const own = { selected: list.selected, period: list.period, company: list.company };
    const keep = { metric, ...(filter.priority ? { priority: filter.priority } : {}), ...(filter.type ? { type: filter.type } : {}), ...(filter.category ? { category: filter.category } : {}), ...(filter.bucket ? { bucket: filter.bucket } : {}) };
    res.render('reports-tickets', {
      title: wordsWith()('{0} - Reports', [words()(list.title)]),
      list,
      noCompany: NO_COMPANY,
      cap: REPORT_CAP,
      statusLabels: STATUS_LABELS,
      priorityLabels: PRIORITY_LABELS,
      typeLabels: TYPE_LABELS,
      metrics: DRILL_METRICS,
      buckets: AGE_BUCKETS,
      backHref: '/reports?' + reportQuery(own, input),
      pageHref: (page: number) => '/reports/tickets?' + reportQuery(own, input, { ...keep, page: String(page) }),
    });
  }),
);


/** The report as a styled Excel workbook, with the tickets when "Ticket details" is ticked. */
reportsRouter.get(
  '/export.xlsx',
  asyncHandler(async (req, res) => {
    const input = inputFrom(req);
    const report = await buildReport(req.currentUser!, input);
    if (!report) throw notFound();
    auditRequest(req, { action: 'report.exported', targetType: 'report', detail: { groups: report.scopeNames, period: report.period.key, company: report.company, details: input.details, format: 'xlsx' } });
    const name = 'report-' + report.period.from.toISOString().slice(0, 10) + '-' + report.period.to.toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(reportWorkbook(report, { priority: PRIORITY_LABELS, type: TYPE_LABELS, status: STATUS_LABELS }, settings().branding.brandColour));
  }),
);

reportsRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const report = await buildReport(req.currentUser!, inputFrom(req));
    if (!report) throw notFound();
    auditRequest(req, { action: 'report.exported', targetType: 'report', detail: { groups: report.scopeNames, period: report.period.key } });
    const name = 'report-' + report.period.from.toISOString().slice(0, 10) + '-' + report.period.to.toISOString().slice(0, 10) + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send(reportCsv(report, { priority: PRIORITY_LABELS, type: TYPE_LABELS }));
  }),
);
