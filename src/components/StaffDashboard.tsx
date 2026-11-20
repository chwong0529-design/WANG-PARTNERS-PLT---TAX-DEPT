import { useMemo, useState } from 'react';
import {
  Search,
  Plus,
  Send,
  FolderOpen,
  ArrowUpRight,
  Lock,
  UserCheck,
} from 'lucide-react';
import type { JobStatus, TaxClient, UserProfile, UserRole } from '../types/tax';
import { assignClientToStaff, determineWorkflowStage } from '../lib/taxService';
import { submitGovernanceChangeRequest } from '../lib/governanceService';
import { logActivity } from '../lib/auditService';
import { JobStatusText } from './StatusIndicator';
import { GovernanceReasonModal } from './GovernanceReasonModal';

interface StaffDashboardProps {
  clients: TaxClient[];
  loading: boolean;
  userRole: UserRole;
  staffProfiles: UserProfile[];
  reminderIntervalDays?: number;
  onSelectClient: (clientId: string) => void;
  onOpenNewClient: () => void;
  onGoToReminders: (clientId?: string) => void;
  onGovernanceSubmitted: (message: string) => void;
}

type StatusFilter = 'All' | JobStatus;

export function StaffDashboard({
  clients,
  loading,
  userRole,
  staffProfiles,
  reminderIntervalDays = 7,
  onSelectClient,
  onOpenNewClient,
  onGoToReminders,
  onGovernanceSubmitted,
}: StaffDashboardProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [yearFilter, setYearFilter] = useState<string>('All');
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [pendingAssign, setPendingAssign] = useState<{
    client: TaxClient;
    nextStaff: { uid: string; name: string; email: string } | null;
    summary: string;
  } | null>(null);
  const [stagingError, setStagingError] = useState<string | null>(null);

  const years = useMemo(() => {
    const unique = Array.from(new Set(clients.map((c) => c.taxYear))).sort((a, b) => b - a);
    return unique;
  }, [clients]);

  const metrics = useMemo(() => {
    const total = clients.length;
    const noBookIn = clients.filter((c) => c.jobStatus === 'No Book In').length;
    const pendingDoc = clients.filter((c) => c.jobStatus === 'Pending Document').length;
    const ready = clients.filter((c) => c.jobStatus === 'Book In Can Start').length;
    const overdue = clients.filter(
      (c) => determineWorkflowStage(c, reminderIntervalDays).isEscalated
    ).length;
    return { total, noBookIn, pendingDoc, ready, overdue };
  }, [clients, reminderIntervalDays]);

  const filteredClients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return clients.filter((c) => {
      if (statusFilter !== 'All' && c.jobStatus !== statusFilter) return false;
      if (yearFilter !== 'All' && String(c.taxYear) !== yearFilter) return false;
      if (!q) return true;
      return (
        c.clientId.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.filingCategory.toLowerCase().includes(q) ||
        (c.assignedTo?.name || '').toLowerCase().includes(q)
      );
    });
  }, [clients, searchQuery, statusFilter, yearFilter]);

  const handleStaffAssignment = async (clientId: string, staffUid: string) => {
    const targetClient = clients.find((c) => c.clientId === clientId);
    if (!targetClient) return;

    const previousAssignee = targetClient.assignedTo?.email || 'Unassigned';
    const found = staffUid ? staffProfiles.find((p) => p.uid === staffUid) : null;
    const nextStaff = found
      ? { uid: found.uid, name: found.displayName, email: found.email }
      : null;

    if (userRole !== 'administrator') {
      setStagingError(null);
      setPendingAssign({
        client: targetClient,
        nextStaff,
        summary: `Assigned Staff: ${previousAssignee} -> ${nextStaff ? `${nextStaff.name} (${nextStaff.email})` : 'Unassigned'}`,
      });
      return;
    }

    setAssigningId(clientId);
    try {
      await assignClientToStaff(clientId, nextStaff);
      void logActivity({
        pageVisited: 'Staff Dashboard',
        actionTaken: 'ASSIGN_DUTY',
        details: nextStaff
          ? `Assigned client ${clientId} (${targetClient.name}) to ${nextStaff.name} (${nextStaff.email}) — previously ${previousAssignee}.`
          : `Unassigned client ${clientId} (${targetClient.name}) — previously assigned to ${previousAssignee}.`,
      });
    } catch (err) {
      console.error('Failed to assign staff:', err);
    } finally {
      setAssigningId(null);
    }
  };

  const handleConfirmStagedAssignment = async (reason: string) => {
    if (!pendingAssign) return;
    setAssigningId(pendingAssign.client.clientId);
    setStagingError(null);
    try {
      await submitGovernanceChangeRequest({
        category: 'CLIENT_DB_CHANGE',
        targetCollection: 'clients',
        targetDocId: pendingAssign.client.clientId,
        targetLabel: `${pendingAssign.client.clientId} — ${pendingAssign.client.name}`,
        operation: 'UPDATE',
        proposedPayload: { assignedTo: pendingAssign.nextStaff },
        previousSummary: pendingAssign.summary,
        reason,
        requestedByRole: userRole,
        pageVisited: 'Staff Dashboard',
      });
      setPendingAssign(null);
      onGovernanceSubmitted(
        'Submitted to Danger Zone — awaiting System Administrator approval.'
      );
    } catch (err) {
      setStagingError(
        err instanceof Error ? err.message : 'Failed to submit duty assignment request.'
      );
    } finally {
      setAssigningId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Metric Strip */}
      <section
        aria-label="Portfolio summary metrics"
        className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-200"
      >
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Active Tax Files</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {metrics.total}
          </p>
          <p className="mt-1 text-xs text-slate-500">All assessment years</p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">No Book In</p>
          <p className="mt-2 text-2xl font-semibold text-red-700 font-mono tabular-nums">
            {metrics.noBookIn}
          </p>
          <p className="mt-1 text-xs text-slate-500">0 documents uploaded</p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Pending Document</p>
          <p className="mt-2 text-2xl font-semibold text-amber-700 font-mono tabular-nums">
            {metrics.pendingDoc}
          </p>
          <p className="mt-1 text-xs text-slate-500">Partial checklist verified</p>
        </div>

        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Book In Can Start</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-700 font-mono tabular-nums">
            {metrics.ready}
          </p>
          <p className="mt-1 text-xs text-slate-500">Ready for tax computation</p>
        </div>

        <div className="p-5 col-span-2 lg:col-span-1">
          <p className="text-xs font-medium text-slate-500">Overdue Follow-Ups</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {metrics.overdue}
          </p>
          <p className="mt-1 text-xs text-slate-500">7+ days without response</p>
        </div>
      </section>

      {/* Main Client Table Panel */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {/* Toolbar */}
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search ID, taxpayer, staff..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
            </div>

            {/* Interactive Segmented Status Filter */}
            <div
              className="inline-flex items-center p-1 bg-slate-100 rounded-lg overflow-x-auto max-w-full"
              role="tablist"
              aria-label="Filter by job status"
            >
              {(['All', 'No Book In', 'Pending Document', 'Book In Can Start'] as StatusFilter[]).map(
                (tab) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={statusFilter === tab}
                    onClick={() => setStatusFilter(tab)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      statusFilter === tab
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab}
                  </button>
                )
              )}
            </div>

            {years.length > 0 && (
              <select
                value={yearFilter}
                onChange={(e) => setYearFilter(e.target.value)}
                aria-label="Filter by Year of Assessment"
                className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              >
                <option value="All">All Years</option>
                {years.map((y) => (
                  <option key={y} value={String(y)}>
                    YA {y}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenNewClient}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ New Client</span>
            </button>
          </div>
        </div>

        {/* Loading Skeleton */}
        {loading ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3, 4].map((row) => (
              <div key={row} className="px-5 py-4 flex items-center justify-between gap-6 animate-pulse">
                <div className="h-4 w-28 bg-slate-200 rounded" />
                <div className="h-4 w-48 bg-slate-200 rounded" />
                <div className="h-4 w-24 bg-slate-200 rounded" />
                <div className="h-4 w-32 bg-slate-200 rounded" />
                <div className="h-4 w-20 bg-slate-200 rounded" />
              </div>
            ))}
          </div>
        ) : clients.length === 0 ? (
          /* Empty State */
          <div className="px-6 py-16 text-center max-w-md mx-auto">
            <FolderOpen className="w-8 h-8 text-slate-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-slate-900">
              No clients added yet
            </h3>
            <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
              Click "+ New Client" to add your first taxpayer.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onOpenNewClient}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>+ New Client</span>
              </button>
            </div>
          </div>
        ) : filteredClients.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-slate-600">
              No client files match your current search or filter criteria.
            </p>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('All');
                setYearFilter('All');
              }}
              className="mt-3 text-xs font-medium text-teal-700 hover:text-teal-900 underline underline-offset-2 cursor-pointer"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          /* High-Density Data Grid */
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 pl-5 pr-4 whitespace-nowrap">Reference ID</th>
                  <th className="py-3 px-4 whitespace-nowrap">Taxpayer</th>
                  <th className="py-3 px-4 whitespace-nowrap">Category · YA</th>
                  <th className="py-3 px-4 whitespace-nowrap">Assigned Staff</th>
                  <th className="py-3 px-4 whitespace-nowrap">Job Status</th>
                  <th className="py-3 px-4 whitespace-nowrap">Follow-Up State</th>
                  <th className="py-3 pl-4 pr-5 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredClients.map((client) => {
                  const workflow = determineWorkflowStage(client, reminderIntervalDays);
                  const activeStaffList = staffProfiles.filter(
                    (p) => p.role === 'administrator' || p.role === 'manager'
                  );

                  return (
                    <tr
                      key={client.clientId}
                      onClick={() => onSelectClient(client.clientId)}
                      className="hover:bg-slate-50/90 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 pl-5 pr-4 font-mono text-xs font-medium text-slate-900 whitespace-nowrap tabular-nums">
                        <div className="flex items-center gap-1.5">
                          <span>{client.clientId}</span>
                          {client.isLocked && (
                            <Lock
                              className="w-3.5 h-3.5 text-slate-400"
                              aria-label="Locked for computation"
                            />
                          )}
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900 group-hover:text-teal-800 transition-colors">
                          {client.name}
                        </div>
                        <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                          <span>{client.email}</span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-xs text-slate-600 whitespace-nowrap">
                        <span>{client.filingCategory}</span>
                        <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">YA {client.taxYear}</span>
                      </td>

                      <td
                        className="py-3.5 px-4 whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <select
                          value={client.assignedTo?.uid || ''}
                          disabled={assigningId === client.clientId}
                          onChange={(e) => handleStaffAssignment(client.clientId, e.target.value)}
                          aria-label="Assign duty to staff"
                          className="px-2.5 py-1 text-xs font-medium bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 cursor-pointer"
                        >
                          <option value="">Unassigned</option>
                          {activeStaffList.map((st) => (
                            <option key={st.uid} value={st.uid}>
                              {st.displayName} ({st.role})
                            </option>
                          ))}
                        </select>
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <JobStatusText status={client.jobStatus} />
                      </td>

                      <td className="py-3.5 px-4 text-xs whitespace-nowrap">
                        <div
                          className={
                            workflow.isEscalated
                              ? 'font-medium text-red-700'
                              : 'text-slate-600'
                          }
                        >
                          {workflow.stage}
                        </div>
                        <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                          {client.lastReminderSent
                            ? `${workflow.daysSinceReminder === 0 ? 'Today' : `${workflow.daysSinceReminder}d ago`} · ${client.reminderCount} sent`
                            : 'No reminder sent'}
                        </div>
                      </td>

                      <td
                        className="py-3.5 pl-4 pr-5 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-2">
                          {client.jobStatus !== 'Book In Can Start' && (
                            <button
                              type="button"
                              onClick={() => onGoToReminders(client.clientId)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 hover:border-slate-300 transition-colors cursor-pointer"
                            >
                              <Send className="w-3 h-3" />
                              <span>Remind</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onSelectClient(client.clientId)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-teal-800 hover:text-teal-950 transition-colors cursor-pointer"
                          >
                            <span>Open</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pendingAssign && (
        <GovernanceReasonModal
          title="Administrator Approval Required: Duty Assignment"
          description="Reassigning client duties requires System Administrator approval. Provide a justification to stage this CLIENT_DB_CHANGE request in the Danger Zone."
          targetLabel={`${pendingAssign.client.clientId} — ${pendingAssign.client.name}`}
          previousSummary={pendingAssign.summary}
          confirmLabel="Submit to Danger Zone"
          submitting={assigningId === pendingAssign.client.clientId}
          error={stagingError}
          onCancel={() => {
            setPendingAssign(null);
            setStagingError(null);
          }}
          onConfirm={handleConfirmStagedAssignment}
        />
      )}
    </div>
  );
}
