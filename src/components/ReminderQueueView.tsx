import { useMemo, useState } from 'react';
import { Send, RefreshCw, ArrowUpRight, CheckCircle2, Clock, AlertCircle } from 'lucide-react';
import type { ReminderChannel, ReminderStage, TaxClient } from '../types/tax';
import { determineWorkflowStage, dispatchReminder, draftReminderApi } from '../lib/taxService';
import { logActivity } from '../lib/auditService';
import { JobStatusText } from './StatusIndicator';

interface ReminderQueueViewProps {
  clients: TaxClient[];
  highlightedClientId?: string | null;
  onSelectClient: (clientId: string) => void;
}

export function ReminderQueueView({
  clients,
  highlightedClientId,
  onSelectClient,
}: ReminderQueueViewProps) {
  const [stageFilter, setStageFilter] = useState<'All' | ReminderStage>('All');
  const [channel, setChannel] = useState<ReminderChannel>('Email');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const enriched = useMemo(() => {
    return clients.map((client) => ({
      client,
      workflow: determineWorkflowStage(client),
    }));
  }, [clients]);

  const counts = useMemo(() => {
    const initial = enriched.filter((e) => e.workflow.stage === 'Initial Outreach').length;
    const escalated = enriched.filter(
      (e) => e.workflow.stage === '7-Day Follow-up' && e.workflow.isEscalated
    ).length;
    const missingAlert = enriched.filter((e) => e.workflow.stage === 'Missing Doc Alert').length;
    const ready = enriched.filter((e) => e.workflow.stage === 'Ready for Tax Prep').length;
    return { initial, escalated, missingAlert, ready };
  }, [enriched]);

  const visibleRows = useMemo(() => {
    return enriched.filter((row) => {
      if (highlightedClientId && row.client.clientId === highlightedClientId) return true;
      if (stageFilter !== 'All' && row.workflow.stage !== stageFilter) return false;
      return true;
    });
  }, [enriched, stageFilter, highlightedClientId]);

  const actionableOverdue = useMemo(() => {
    return enriched.filter(
      (e) =>
        e.workflow.stage === 'Initial Outreach' ||
        e.workflow.isEscalated ||
        e.workflow.stage === 'Missing Doc Alert'
    );
  }, [enriched]);

  const handleRefreshDraft = async (client: TaxClient) => {
    const wf = determineWorkflowStage(client);
    setDraftingId(client.clientId);
    setStatusNotice(null);
    try {
      const res = await draftReminderApi(client, wf.stage, wf.daysSinceReminder);
      setDraftOverrides((prev) => ({
        ...prev,
        [client.clientId]: channel === 'WhatsApp' ? res.whatsappBody : res.emailBody,
      }));
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Failed to draft reminder.');
    } finally {
      setDraftingId(null);
    }
  };

  const handleSendOne = async (client: TaxClient) => {
    const wf = determineWorkflowStage(client);
    const msg = draftOverrides[client.clientId] || client.latestReminderDraft;
    if (!msg.trim()) return;
    setSendingId(client.clientId);
    setStatusNotice(null);
    try {
      await dispatchReminder(client, wf.stage, channel, msg);
      void logActivity({
        pageVisited: 'Follow-Up Queue',
        actionTaken: 'DISPATCH_REMINDER',
        details: `Dispatched "${wf.stage}" reminder via ${channel} to ${client.name} (${client.clientId}, ${client.email}).`,
      });
      setStatusNotice(`Dispatched ${wf.stage} via ${channel} to ${client.name} (${client.clientId}).`);
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Failed to dispatch reminder.');
    } finally {
      setSendingId(null);
    }
  };

  const handleBatchDispatch = async () => {
    if (actionableOverdue.length === 0) return;
    setBatchRunning(true);
    setStatusNotice(null);
    let sent = 0;
    const dispatchedIds: string[] = [];
    try {
      for (const item of actionableOverdue) {
        const msg = draftOverrides[item.client.clientId] || item.client.latestReminderDraft;
        if (msg.trim()) {
          await dispatchReminder(item.client, item.workflow.stage, channel, msg);
          sent += 1;
          dispatchedIds.push(item.client.clientId);
        }
      }
      if (sent > 0) {
        void logActivity({
          pageVisited: 'Follow-Up Queue',
          actionTaken: 'DISPATCH_REMINDER',
          details: `Batch dispatched ${sent} ${channel} follow-up reminder${sent === 1 ? '' : 's'} for clients: ${dispatchedIds.join(', ')}.`,
        });
      }
      setStatusNotice(
        `Batch workflow complete: dispatched ${sent} itemized ${channel} follow-up${sent === 1 ? '' : 's'}.`
      );
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Batch reminder run encountered an error.');
    } finally {
      setBatchRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Workflow Stage Overview */}
      <section className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Stage 1 · Initial Outreach</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {counts.initial}
          </p>
          <p className="mt-1 text-xs text-slate-500">No Book In · Not yet invited</p>
        </div>
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Stage 2 · 7-Day Escalation</p>
          <p className="mt-2 text-2xl font-semibold text-red-700 font-mono tabular-nums">
            {counts.escalated}
          </p>
          <p className="mt-1 text-xs text-slate-500">No response after 7+ days</p>
        </div>
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Stage 4 · Missing Doc Alert</p>
          <p className="mt-2 text-2xl font-semibold text-amber-700 font-mono tabular-nums">
            {counts.missingAlert}
          </p>
          <p className="mt-1 text-xs text-slate-500">Itemized follow-ups pending</p>
        </div>
        <div className="p-5">
          <p className="text-xs font-medium text-slate-500">Stage 5 · Ready for Tax Prep</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-700 font-mono tabular-nums">
            {counts.ready}
          </p>
          <p className="mt-1 text-xs text-slate-500">All required files verified</p>
        </div>
      </section>

      {statusNotice && (
        <div className="px-4 py-3 bg-teal-50 border border-teal-200 rounded-xl text-sm text-teal-900 flex items-center justify-between gap-4">
          <span>{statusNotice}</span>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="text-xs font-medium text-teal-700 hover:text-teal-950 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center p-1 bg-slate-100 rounded-lg overflow-x-auto max-w-full">
              {(
                [
                  'All',
                  'Initial Outreach',
                  '7-Day Follow-up',
                  'Missing Doc Alert',
                  'Ready for Tax Prep',
                ] as const
              ).map((stage) => (
                <button
                  key={stage}
                  type="button"
                  onClick={() => setStageFilter(stage)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    stageFilter === stage
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {stage}
                </button>
              ))}
            </div>

            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as ReminderChannel)}
              aria-label="Dispatch channel"
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
            >
              <option value="Email">Channel: Email</option>
              <option value="WhatsApp">Channel: WhatsApp</option>
              <option value="Portal">Channel: Portal Notice</option>
            </select>
          </div>

          <button
            type="button"
            disabled={batchRunning || actionableOverdue.length === 0}
            onClick={handleBatchDispatch}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>
              {batchRunning
                ? 'Dispatching Batch...'
                : `Run Automated Follow-Up (${actionableOverdue.length})`}
            </span>
          </button>
        </div>

        {visibleRows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            No clients currently fall into this workflow stage.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {visibleRows.map(({ client, workflow }) => {
              const currentDraft = draftOverrides[client.clientId] ?? client.latestReminderDraft;
              const missingList = client.requiredDocuments
                .filter((d) => d.status !== 'Verified')
                .map((d) => d.docType);

              return (
                <div
                  key={client.clientId}
                  className={`p-5 space-y-3 ${
                    highlightedClientId === client.clientId ? 'bg-teal-50/30' : ''
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono text-xs font-semibold text-slate-900">
                        {client.clientId}
                      </span>
                      <span className="text-sm font-semibold text-slate-900">{client.name}</span>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <JobStatusText status={client.jobStatus} />
                    </div>

                    <div className="flex items-center gap-3 text-xs">
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          workflow.isEscalated
                            ? 'text-red-700'
                            : workflow.stage === 'Ready for Tax Prep'
                              ? 'text-emerald-700'
                              : 'text-slate-700'
                        }`}
                      >
                        {workflow.isEscalated ? (
                          <AlertCircle className="w-3.5 h-3.5" />
                        ) : workflow.stage === 'Ready for Tax Prep' ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : (
                          <Clock className="w-3.5 h-3.5" />
                        )}
                        <span>{workflow.stage}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => onSelectClient(client.clientId)}
                        className="inline-flex items-center gap-1 text-teal-800 hover:text-teal-950 font-medium cursor-pointer"
                      >
                        <span>Open File</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-slate-500">
                    {client.email}
                    {client.phone ? ` · ${client.phone}` : ''}
                    {' · '}
                    {missingList.length > 0
                      ? `Missing: ${missingList.join(', ')}`
                      : 'All required documents verified'}
                  </p>

                  <textarea
                    rows={2}
                    value={currentDraft}
                    onChange={(e) =>
                      setDraftOverrides((prev) => ({
                        ...prev,
                        [client.clientId]: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-xs text-slate-800 bg-slate-50/70 border border-slate-200 rounded-lg focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-slate-400 font-mono tabular-nums">
                      {client.lastReminderSent
                        ? `Last sent ${workflow.daysSinceReminder === 0 ? 'today' : `${workflow.daysSinceReminder}d ago`} · ${client.reminderCount} total`
                        : 'Never reminded'}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={draftingId === client.clientId}
                        onClick={() => handleRefreshDraft(client)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors cursor-pointer"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${
                            draftingId === client.clientId ? 'animate-spin' : ''
                          }`}
                        />
                        <span>AI Redraft</span>
                      </button>
                      <button
                        type="button"
                        disabled={sendingId === client.clientId || !currentDraft.trim()}
                        onClick={() => handleSendOne(client)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 rounded-md hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>
                          {sendingId === client.clientId
                            ? 'Sending...'
                            : `Dispatch ${channel}`}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
