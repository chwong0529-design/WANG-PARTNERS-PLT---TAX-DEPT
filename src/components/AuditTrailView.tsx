import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Download,
  ShieldAlert,
  ClipboardList,
  Calendar,
  X,
  Lock,
} from 'lucide-react';
import type { UserRole } from '../types/tax';
import {
  exportAuditLogsToCsv,
  formatMytTimestamp,
  getMytDateKey,
  logActivity,
  subscribeToAuditLogs,
  type AuditLogEntry,
} from '../lib/auditService';

interface AuditTrailViewProps {
  userRole: UserRole;
}

const ACTION_LABELS: Record<string, string> = {
  PAGE_VIEW: 'Page View',
  USER_SIGN_IN: 'User Sign-In',
  USER_SIGN_OUT: 'User Sign-Out',
  AUTO_LOGOUT_IDLE: 'Auto Logout (Idle)',
  CREATE_CLIENT: 'Create Client',
  UPLOAD_TAX_DOCUMENT: 'Upload Tax Document',
  AI_DOCUMENT_VERIFICATION: 'AI Document Verification',
  JOB_STATUS_CHANGE: 'Job Status Change',
  ASSIGN_DUTY: 'Duty Assignment',
  DISPATCH_REMINDER: 'Reminder Dispatched',
  UPDATE_USER_ROLE: 'User Role Update',
  DELETE_CLIENT: 'Delete Client',
  TOGGLE_FILE_LOCK: 'File Lock Toggle',
  EXPORT_AUDIT_LOG: 'Audit Log Export',
  REQUEST_2FA_CHANGE: '2FA Change Request',
  APPROVE_2FA_CHANGE: '2FA Change Approved',
  REJECT_2FA_CHANGE: '2FA Change Rejected',
  COMPLETE_2FA_CHANGE: '2FA Change Completed',
  UPDATE_SECURITY_POLICY: 'Security Policy Update',
  DANGER_DELETE_CLIENT: 'Permanent Client Purge',
};

function getActionTone(action: string): string {
  switch (action) {
    case 'DELETE_CLIENT':
    case 'DANGER_DELETE_CLIENT':
    case 'UPDATE_USER_ROLE':
    case 'REJECT_2FA_CHANGE':
      return 'text-red-700';
    case 'JOB_STATUS_CHANGE':
    case 'AI_DOCUMENT_VERIFICATION':
    case 'UPLOAD_TAX_DOCUMENT':
    case 'APPROVE_2FA_CHANGE':
    case 'COMPLETE_2FA_CHANGE':
      return 'text-teal-800';
    case 'DISPATCH_REMINDER':
    case 'ASSIGN_DUTY':
    case 'CREATE_CLIENT':
    case 'AUTO_LOGOUT_IDLE':
    case 'REQUEST_2FA_CHANGE':
    case 'UPDATE_SECURITY_POLICY':
      return 'text-amber-700';
    case 'EXPORT_AUDIT_LOG':
      return 'text-indigo-700';
    default:
      return 'text-slate-700';
  }
}

export function AuditTrailView({ userRole }: AuditTrailViewProps) {
  const isAuthorized = userRole === 'administrator' || userRole === 'manager';

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [emailSearch, setEmailSearch] = useState('');
  const [pageFilter, setPageFilter] = useState<string>('All');
  const [actionFilter, setActionFilter] = useState<string>('All');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthorized) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const unsub = subscribeToAuditLogs(
      (rows) => {
        setEntries(rows);
        setLoading(false);
      },
      (err) => {
        setError(err.message || 'Failed to load audit trail logs.');
        setLoading(false);
      }
    );
    return () => unsub();
  }, [isAuthorized]);

  const uniquePages = useMemo(() => {
    return Array.from(new Set(entries.map((e) => e.pageVisited).filter(Boolean))).sort();
  }, [entries]);

  const uniqueActions = useMemo(() => {
    return Array.from(new Set(entries.map((e) => e.actionTaken).filter(Boolean))).sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = emailSearch.trim().toLowerCase();
    return entries.filter((entry) => {
      if (pageFilter !== 'All' && entry.pageVisited !== pageFilter) return false;
      if (actionFilter !== 'All' && entry.actionTaken !== actionFilter) return false;

      if (q) {
        const matchesText =
          (entry.userEmail || '').toLowerCase().includes(q) ||
          (entry.details || '').toLowerCase().includes(q) ||
          (entry.pageVisited || '').toLowerCase().includes(q) ||
          (entry.actionTaken || '').toLowerCase().includes(q);
        if (!matchesText) return false;
      }

      if (startDate || endDate) {
        const mytDate = getMytDateKey(entry.timestamp);
        if (!mytDate) return false;
        if (startDate && mytDate < startDate) return false;
        if (endDate && mytDate > endDate) return false;
      }

      return true;
    });
  }, [entries, emailSearch, pageFilter, actionFilter, startDate, endDate]);

  const metrics = useMemo(() => {
    const uniqueUsers = new Set(entries.map((e) => e.userEmail).filter(Boolean)).size;
    const latestEntry = entries[0]?.timestamp ? formatMytTimestamp(entries[0].timestamp) : 'No activity yet';
    return {
      total: entries.length,
      filtered: filteredEntries.length,
      uniqueUsers,
      latestEntry,
    };
  }, [entries, filteredEntries.length]);

  const hasActiveFilters =
    Boolean(emailSearch.trim()) ||
    pageFilter !== 'All' ||
    actionFilter !== 'All' ||
    Boolean(startDate) ||
    Boolean(endDate);

  const handleClearFilters = () => {
    setEmailSearch('');
    setPageFilter('All');
    setActionFilter('All');
    setStartDate('');
    setEndDate('');
  };

  const handleDownloadCsv = () => {
    if (!isAuthorized) return;
    const fileName = exportAuditLogsToCsv(filteredEntries);
    const filterSummaryParts: string[] = [];
    if (emailSearch.trim()) filterSummaryParts.push(`query="${emailSearch.trim()}"`);
    if (pageFilter !== 'All') filterSummaryParts.push(`page="${pageFilter}"`);
    if (actionFilter !== 'All') filterSummaryParts.push(`action="${actionFilter}"`);
    if (startDate) filterSummaryParts.push(`from=${startDate}`);
    if (endDate) filterSummaryParts.push(`to=${endDate}`);

    const filterNote =
      filterSummaryParts.length > 0
        ? ` Filters: ${filterSummaryParts.join(', ')}.`
        : ' Filters: none (all visible records).';

    void logActivity({
      pageVisited: 'Audit Trail',
      actionTaken: 'EXPORT_AUDIT_LOG',
      details: `Exported ${filteredEntries.length} audit log record${filteredEntries.length === 1 ? '' : 's'} to ${fileName}.${filterNote}`,
    });

    setExportNotice(
      `Downloaded ${fileName} with ${filteredEntries.length} record${filteredEntries.length === 1 ? '' : 's'}.`
    );
  };

  if (!isAuthorized) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-12 text-center max-w-lg mx-auto my-12">
        <ShieldAlert className="w-8 h-8 text-red-600 mx-auto mb-3" />
        <h2 className="text-base font-semibold text-slate-900">Restricted Compliance View</h2>
        <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
          The immutable User Activity Log &amp; Audit Trail is accessible only to Administrator and Manager accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* KPI Metric Strip */}
      <section
        aria-label="Audit trail summary metrics"
        className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200"
      >
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Total Logged Events</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {metrics.total}
          </p>
          <p className="mt-1 text-xs text-slate-500">Append-only Firestore records</p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Matching Filter</p>
          <p className="mt-2 text-2xl font-semibold text-teal-800 font-mono tabular-nums">
            {metrics.filtered}
          </p>
          <p className="mt-1 text-xs text-slate-500">Included in CSV export</p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Active Users Logged</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {metrics.uniqueUsers}
          </p>
          <p className="mt-1 text-xs text-slate-500">Distinct authenticated emails</p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Latest Activity (MYT)</p>
          <p className="mt-2 text-sm font-semibold text-slate-900 font-mono tabular-nums leading-8 truncate">
            {metrics.latestEntry}
          </p>
          <p className="mt-1 text-xs text-slate-500 inline-flex items-center gap-1">
            <Lock className="w-3 h-3 text-slate-400" />
            <span>Immutable · No edits or deletes</span>
          </p>
        </div>
      </section>

      {exportNotice && (
        <div className="px-4 py-3 bg-teal-50 border border-teal-200 rounded-xl text-sm text-teal-900 flex items-center justify-between gap-4">
          <span>{exportNotice}</span>
          <button
            type="button"
            onClick={() => setExportNotice(null)}
            className="text-xs font-medium text-teal-700 hover:text-teal-950 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Main Audit Log Table Panel */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="px-5 py-4 border-b border-slate-200 space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                User Activity Log &amp; Audit Trail
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Immutable chronological record of user sessions, page visits, tax document verifications, status transitions, and administrative actions (Asia/Kuala_Lumpur MYT).
              </p>
            </div>

            <button
              type="button"
              onClick={handleDownloadCsv}
              disabled={loading || filteredEntries.length === 0}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Audit Log (CSV)</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={emailSearch}
                onChange={(e) => setEmailSearch(e.target.value)}
                placeholder="Filter by user email or details..."
                aria-label="Filter by user email or details"
                className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
            </div>

            <select
              value={pageFilter}
              onChange={(e) => setPageFilter(e.target.value)}
              aria-label="Filter by page visited"
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 max-w-[220px]"
            >
              <option value="All">All Pages Visited</option>
              {uniquePages.map((pg) => (
                <option key={pg} value={pg}>
                  {pg}
                </option>
              ))}
            </select>

            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              aria-label="Filter by action taken"
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
            >
              <option value="All">All Actions</option>
              {uniqueActions.map((act) => (
                <option key={act} value={act}>
                  {ACTION_LABELS[act] ? `${ACTION_LABELS[act]} (${act})` : act}
                </option>
              ))}
            </select>

            <div className="inline-flex items-center gap-1.5 text-xs text-slate-500">
              <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date (MYT)"
                className="px-2.5 py-1.5 text-xs font-mono text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
              <span aria-hidden="true">to</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="End date (MYT)"
                className="px-2.5 py-1.5 text-xs font-mono text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleClearFilters}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}
          </div>
        </div>

        {/* Loading State */}
        {loading ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3, 4, 5].map((row) => (
              <div
                key={row}
                className="px-5 py-4 flex items-center justify-between gap-6 animate-pulse"
              >
                <div className="h-4 w-36 bg-slate-200 rounded" />
                <div className="h-4 w-44 bg-slate-200 rounded" />
                <div className="h-4 w-24 bg-slate-200 rounded" />
                <div className="h-4 w-32 bg-slate-200 rounded" />
                <div className="h-4 w-64 bg-slate-200 rounded" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          /* Clean Empty State */
          <div className="px-6 py-16 text-center max-w-md mx-auto">
            <ClipboardList className="w-8 h-8 text-slate-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-slate-900">
              No audit log entries recorded yet
            </h3>
            <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
              User logins, page visits, client creations, document uploads, AI verifications, and status changes will appear here automatically in real time.
            </p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-slate-600">
              No audit events match your current filter criteria.
            </p>
            <button
              type="button"
              onClick={handleClearFilters}
              className="mt-3 text-xs font-medium text-teal-700 hover:text-teal-900 underline underline-offset-2 cursor-pointer"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          /* Immutable Read-Only Audit Data Table (Zero Edit / Delete Controls) */
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 pl-5 pr-4 whitespace-nowrap">Timestamp (MYT)</th>
                  <th className="py-3 px-4 whitespace-nowrap">User Email · Role</th>
                  <th className="py-3 px-4 whitespace-nowrap">Page Visited</th>
                  <th className="py-3 px-4 whitespace-nowrap">Action Taken</th>
                  <th className="py-3 pl-4 pr-5 whitespace-nowrap">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredEntries.map((entry, idx) => (
                  <tr
                    key={entry.id || `${entry.userId}-${idx}`}
                    className="hover:bg-slate-50/80 transition-colors align-top"
                  >
                    <td className="py-3.5 pl-5 pr-4 font-mono text-slate-700 whitespace-nowrap tabular-nums">
                      {formatMytTimestamp(entry.timestamp)}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className="font-medium text-slate-900">{entry.userEmail}</div>
                      <div className="text-slate-500 capitalize mt-0.5">{entry.userRole}</div>
                    </td>

                    <td className="py-3.5 px-4 text-slate-800 whitespace-nowrap font-medium">
                      {entry.pageVisited}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <div className={`font-semibold ${getActionTone(entry.actionTaken)}`}>
                        {ACTION_LABELS[entry.actionTaken] || entry.actionTaken}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                        {entry.actionTaken}
                      </div>
                    </td>

                    <td className="py-3.5 pl-4 pr-5 text-slate-600 leading-relaxed min-w-[260px] max-w-xl break-words">
                      {entry.details || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
