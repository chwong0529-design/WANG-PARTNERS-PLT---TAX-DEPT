import { useEffect, useState } from 'react';
import {
  SlidersHorizontal,
  Lock,
  ShieldCheck,
  Plus,
  Trash2,
  Save,
  Send,
  Loader2,
} from 'lucide-react';
import {
  ALL_STANDARD_DOC_TYPES,
  BLUEPRINT_LIMITS,
  type AppConfigSettings,
  type FilingCategory,
  type SystemSecuritySettings,
  type UserProfile,
} from '../types/tax';
import {
  DEFAULT_APP_CONFIG,
  submitGovernanceChangeRequest,
  subscribeToAppConfig,
  updateAppConfigDirect,
} from '../lib/governanceService';
import {
  subscribeToSecuritySettings,
  updateMandatoryTwoFactorPolicy,
} from '../lib/taxService';
import { formatMytTimestamp, logActivity } from '../lib/auditService';
import { GovernanceReasonModal } from './GovernanceReasonModal';

interface AppSettingsViewProps {
  userProfile: UserProfile;
  onGovernanceSubmitted: (message: string) => void;
}

const FILING_CATEGORIES: FilingCategory[] = [
  'Form BE (Salaried)',
  'Form B (Business / Commission)',
  'Form M (Non-Resident)',
];

export function AppSettingsView({
  userProfile,
  onGovernanceSubmitted,
}: AppSettingsViewProps) {
  const isAdmin = userProfile.role === 'administrator';

  const [liveConfig, setLiveConfig] = useState<AppConfigSettings>(DEFAULT_APP_CONFIG);
  const [liveSecurity, setLiveSecurity] = useState<SystemSecuritySettings>({
    require2faForAdminAndManager: false,
    updatedByUid: null,
    updatedByEmail: null,
    updatedAt: null,
  });

  // Editable draft state (admin edits directly; non-admin edits only in proposal mode)
  const [proposeMode, setProposeMode] = useState(false);
  const [draftYear, setDraftYear] = useState<number>(DEFAULT_APP_CONFIG.activeTaxYear);
  const [draftInterval, setDraftInterval] = useState<number>(
    DEFAULT_APP_CONFIG.reminderIntervalDays
  );
  const [draftTemplates, setDraftTemplates] = useState<Record<FilingCategory, string[]>>(
    DEFAULT_APP_CONFIG.defaultTemplates
  );
  const [draftRequire2fa, setDraftRequire2fa] = useState<boolean>(false);
  const [activeTemplateCategory, setActiveTemplateCategory] =
    useState<FilingCategory>('Form BE (Salaried)');
  const [newDocItem, setNewDocItem] = useState('');

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  const [pendingProposal, setPendingProposal] = useState<{
    targetDocId: 'app_config' | 'security';
    targetLabel: string;
    proposedPayload: Record<string, unknown>;
    previousSummary: string;
  } | null>(null);

  useEffect(() => {
    const unsubConfig = subscribeToAppConfig((cfg) => {
      setLiveConfig(cfg);
      setDraftYear(cfg.activeTaxYear);
      setDraftInterval(cfg.reminderIntervalDays);
      setDraftTemplates({
        'Form BE (Salaried)': [...cfg.defaultTemplates['Form BE (Salaried)']],
        'Form B (Business / Commission)': [
          ...cfg.defaultTemplates['Form B (Business / Commission)'],
        ],
        'Form M (Non-Resident)': [...cfg.defaultTemplates['Form M (Non-Resident)']],
      });
    });

    const unsubSec = subscribeToSecuritySettings((sec) => {
      setLiveSecurity(sec);
      setDraftRequire2fa(sec.require2faForAdminAndManager);
    });

    return () => {
      unsubConfig();
      unsubSec();
    };
  }, []);

  const canEditControls = isAdmin || proposeMode;

  const currentDocs = draftTemplates[activeTemplateCategory] || [];

  const handleAddTemplateDoc = (docName: string) => {
    const clean = docName.trim();
    if (!clean || !canEditControls) return;
    if (currentDocs.length >= BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS) return;
    if (currentDocs.some((d) => d.toLowerCase() === clean.toLowerCase())) return;
    setDraftTemplates((prev) => ({
      ...prev,
      [activeTemplateCategory]: [...prev[activeTemplateCategory], clean],
    }));
    setNewDocItem('');
  };

  const handleRemoveTemplateDoc = (idx: number) => {
    if (!canEditControls) return;
    setDraftTemplates((prev) => ({
      ...prev,
      [activeTemplateCategory]: prev[activeTemplateCategory].filter((_, i) => i !== idx),
    }));
  };

  const buildAppConfigSummary = () => {
    const changes: string[] = [];
    if (draftYear !== liveConfig.activeTaxYear) {
      changes.push(`Tax Year: YA ${liveConfig.activeTaxYear} -> YA ${draftYear}`);
    }
    if (draftInterval !== liveConfig.reminderIntervalDays) {
      changes.push(
        `Reminder Interval: ${liveConfig.reminderIntervalDays}d -> ${draftInterval}d`
      );
    }
    for (const cat of FILING_CATEGORIES) {
      const before = (liveConfig.defaultTemplates[cat] || []).join(', ');
      const after = (draftTemplates[cat] || []).join(', ');
      if (before !== after) {
        changes.push(
          `${cat} template (${liveConfig.defaultTemplates[cat]?.length || 0} -> ${draftTemplates[cat]?.length || 0} docs)`
        );
      }
    }
    return changes.length > 0
      ? changes.join(' | ')
      : `Confirm App Config (YA ${draftYear}, ${draftInterval}-day reminders)`;
  };

  const handleSaveOrProposeAppConfig = async () => {
    setFeedback(null);
    const payload = {
      activeTaxYear: draftYear,
      reminderIntervalDays: draftInterval,
      defaultTemplates: draftTemplates,
    };

    if (isAdmin) {
      setSaving(true);
      try {
        await updateAppConfigDirect(payload);
        setFeedback({
          tone: 'success',
          message: 'Firm application configuration saved to /system_settings/app_config.',
        });
      } catch (err) {
        setFeedback({
          tone: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to save app configuration.',
        });
      } finally {
        setSaving(false);
      }
    } else {
      setPendingProposal({
        targetDocId: 'app_config',
        targetLabel: 'App Configuration (/system_settings/app_config)',
        proposedPayload: payload,
        previousSummary: buildAppConfigSummary(),
      });
    }
  };

  const handleSaveOrProposeSecurity = async () => {
    setFeedback(null);
    const payload = {
      require2faForAdminAndManager: draftRequire2fa,
    };

    if (isAdmin) {
      setSaving(true);
      try {
        await updateMandatoryTwoFactorPolicy(draftRequire2fa);
        await logActivity({
          pageVisited: 'App Settings',
          actionTaken: 'UPDATE_SECURITY_POLICY',
          details: `Set Global Mandatory 2FA Policy for Administrator & Manager logins to ${draftRequire2fa ? 'ENABLED' : 'DISABLED'}.`,
        });
        setFeedback({
          tone: 'success',
          message: `Mandatory 2FA Policy updated to ${draftRequire2fa ? 'Enabled' : 'Disabled'}.`,
        });
      } catch (err) {
        setFeedback({
          tone: 'error',
          message:
            err instanceof Error ? err.message : 'Failed to update security settings.',
        });
      } finally {
        setSaving(false);
      }
    } else {
      setPendingProposal({
        targetDocId: 'security',
        targetLabel: 'Security Policy (/system_settings/security)',
        proposedPayload: payload,
        previousSummary: `Mandatory Admin/Manager 2FA: ${liveSecurity.require2faForAdminAndManager ? 'Enabled' : 'Disabled'} -> ${draftRequire2fa ? 'Enabled' : 'Disabled'}`,
      });
    }
  };

  const handleSubmitProposal = async (reason: string) => {
    if (!pendingProposal) return;
    setSaving(true);
    try {
      await submitGovernanceChangeRequest({
        category: 'APP_CONFIG_CHANGE',
        targetCollection: 'system_settings',
        targetDocId: pendingProposal.targetDocId,
        targetLabel: pendingProposal.targetLabel,
        operation: 'UPDATE',
        proposedPayload: pendingProposal.proposedPayload,
        previousSummary: pendingProposal.previousSummary,
        reason,
        requestedByRole: userProfile.role,
        pageVisited: 'App Settings',
      });
      setPendingProposal(null);
      setProposeMode(false);
      // Reset draft back to live active values (inactive until approved by admin)
      setDraftYear(liveConfig.activeTaxYear);
      setDraftInterval(liveConfig.reminderIntervalDays);
      setDraftTemplates({
        'Form BE (Salaried)': [...liveConfig.defaultTemplates['Form BE (Salaried)']],
        'Form B (Business / Commission)': [
          ...liveConfig.defaultTemplates['Form B (Business / Commission)'],
        ],
        'Form M (Non-Resident)': [...liveConfig.defaultTemplates['Form M (Non-Resident)']],
      });
      setDraftRequire2fa(liveSecurity.require2faForAdminAndManager);
      onGovernanceSubmitted(
        'Submitted to Danger Zone — awaiting System Administrator approval.'
      );
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to submit configuration change proposal.',
      });
    } finally {
      setSaving(false);
    }
  };

  const availableQuickAdds = ALL_STANDARD_DOC_TYPES.filter(
    (d) => !currentDocs.includes(d)
  );

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-5 h-5 text-slate-700" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 tracking-tight">
                App Configuration &amp; Tax Templates
              </h1>
              <p className="text-sm text-slate-600 mt-1 max-w-2xl leading-relaxed">
                Firm-wide defaults stored in Cloud Firestore (
                <code className="font-mono text-slate-800">/system_settings</code>). Controls
                Year of Assessment, automated follow-up intervals, default Malaysia LHDN document
                checklists, and mandatory 2FA security policy.
              </p>
            </div>
          </div>

          {!isAdmin && (
            <button
              type="button"
              onClick={() => {
                if (proposeMode) {
                  setProposeMode(false);
                  setDraftYear(liveConfig.activeTaxYear);
                  setDraftInterval(liveConfig.reminderIntervalDays);
                  setDraftTemplates({
                    'Form BE (Salaried)': [
                      ...liveConfig.defaultTemplates['Form BE (Salaried)'],
                    ],
                    'Form B (Business / Commission)': [
                      ...liveConfig.defaultTemplates['Form B (Business / Commission)'],
                    ],
                    'Form M (Non-Resident)': [
                      ...liveConfig.defaultTemplates['Form M (Non-Resident)'],
                    ],
                  });
                  setDraftRequire2fa(liveSecurity.require2faForAdminAndManager);
                } else {
                  setProposeMode(true);
                }
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                proposeMode
                  ? 'bg-slate-100 border-slate-300 text-slate-800 hover:bg-slate-200'
                  : 'bg-slate-900 border-slate-900 text-white hover:bg-slate-800'
              }`}
            >
              <Send className="w-3.5 h-3.5" />
              <span>{proposeMode ? 'Cancel Proposal Draft' : 'Propose Configuration Change'}</span>
            </button>
          )}
        </div>

        {!isAdmin && (
          <div className="mt-4 p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-2.5 text-xs text-slate-700">
            <Lock className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-900">
                Configuration controls are locked by System Administrator policy.
              </span>{' '}
              {proposeMode
                ? 'Draft mode active: adjust values below and submit your proposal to the Danger Zone approval queue. Changes remain inactive until approved by an Administrator.'
                : 'Click "Propose Configuration Change" to submit an APP_CONFIG_CHANGE request to the Danger Zone for System Administrator review.'}
            </div>
          </div>
        )}
      </section>

      {feedback && (
        <div
          className={`px-4 py-3 rounded-xl border text-sm flex items-center justify-between gap-4 ${
            feedback.tone === 'success'
              ? 'bg-teal-50 border-teal-200 text-teal-900'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs font-medium underline underline-offset-2 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Tax Season & Reminder Cadence */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Tax Assessment Year, Reminder Cadence &amp; Default Templates
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Document: <code className="font-mono">/system_settings/app_config</code>
              {liveConfig.updatedByEmail && (
                <>
                  {' · '}Last updated by {liveConfig.updatedByEmail} on{' '}
                  <span className="font-mono">
                    {formatMytTimestamp(liveConfig.updatedAt ?? null)}
                  </span>
                </>
              )}
            </p>
          </div>
          {!canEditControls && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500">
              <Lock className="w-3.5 h-3.5 text-red-600" />
              <span>Locked</span>
            </span>
          )}
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label
                htmlFor="config-tax-year"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Default Year of Assessment (YA)
              </label>
              <select
                id="config-tax-year"
                value={draftYear}
                disabled={!canEditControls}
                onChange={(e) => setDraftYear(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              >
                {[2027, 2026, 2025, 2024, 2023].map((yr) => (
                  <option key={yr} value={yr}>
                    YA {yr}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="config-reminder-days"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Automated Escalation Follow-Up Interval (Days)
              </label>
              <input
                id="config-reminder-days"
                type="number"
                min={1}
                max={60}
                value={draftInterval}
                disabled={!canEditControls}
                onChange={(e) => setDraftInterval(Math.max(1, Math.min(60, Number(e.target.value) || 7)))}
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
            </div>
          </div>

          {/* Default Required Document Templates */}
          <div className="pt-4 border-t border-slate-200 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-slate-900">
                  Default Required Document Templates by Filing Category
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Pre-populated checklist requirements when onboarding a new Malaysia personal tax client.
                </p>
              </div>

              <div className="inline-flex items-center p-1 bg-slate-100 rounded-lg">
                {FILING_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setActiveTemplateCategory(cat)}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      activeTemplateCategory === cat
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {cat.split(' ')[0]} {cat.split(' ')[1]}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50/40">
              {currentDocs.length === 0 ? (
                <div className="px-4 py-5 text-xs text-slate-500 text-center">
                  No default documents configured for {activeTemplateCategory}.
                </div>
              ) : (
                currentDocs.map((docName, idx) => (
                  <div
                    key={`${docName}-${idx}`}
                    className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-slate-800"
                  >
                    <span className="font-medium">{docName}</span>
                    {canEditControls && (
                      <button
                        type="button"
                        onClick={() => handleRemoveTemplateDoc(idx)}
                        className="p-1 text-slate-400 hover:text-red-700 rounded cursor-pointer"
                        aria-label={`Remove ${docName}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {canEditControls && (
              <div className="space-y-2.5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDocItem}
                    onChange={(e) => setNewDocItem(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddTemplateDoc(newDocItem);
                      }
                    }}
                    placeholder={`Add default document for ${activeTemplateCategory}...`}
                    className="flex-1 px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddTemplateDoc(newDocItem)}
                    disabled={!newDocItem.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add</span>
                  </button>
                </div>

                {availableQuickAdds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-slate-500">Quick add:</span>
                    {availableQuickAdds.slice(0, 5).map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => handleAddTemplateDoc(item)}
                        className="text-teal-700 hover:text-teal-900 underline underline-offset-2 cursor-pointer"
                      >
                        + {item}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {canEditControls && (
            <div className="pt-4 border-t border-slate-200 flex items-center justify-end">
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveOrProposeAppConfig}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : isAdmin ? (
                  <Save className="w-3.5 h-3.5" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                <span>
                  {isAdmin
                    ? 'Save App Configuration'
                    : 'Submit App Config Change for Approval'}
                </span>
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Global Security Settings (/system_settings/security) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-teal-700" />
              <span>Security Policy Settings</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Document: <code className="font-mono">/system_settings/security</code>
              {liveSecurity.updatedByEmail && (
                <>
                  {' · '}Last updated by {liveSecurity.updatedByEmail} on{' '}
                  <span className="font-mono">
                    {formatMytTimestamp(liveSecurity.updatedAt ?? null)}
                  </span>
                </>
              )}
            </p>
          </div>
          {!canEditControls && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500">
              <Lock className="w-3.5 h-3.5 text-red-600" />
              <span>Locked</span>
            </span>
          )}
        </div>

        <div className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <label
              htmlFor="settings-require-2fa"
              className="text-sm font-semibold text-slate-900 flex items-center gap-2.5 cursor-pointer"
            >
              <input
                id="settings-require-2fa"
                type="checkbox"
                checked={draftRequire2fa}
                disabled={!canEditControls}
                onChange={(e) => setDraftRequire2fa(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-600 disabled:opacity-60"
              />
              <span>Require Mandatory 2FA for All Administrator &amp; Manager Logins</span>
            </label>
            <p className="text-xs text-slate-600 leading-relaxed pl-6">
              Enforces firm-wide two-factor authentication governance across elevated staff accounts.
            </p>
          </div>

          {canEditControls && (
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveOrProposeSecurity}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : isAdmin ? (
                <Save className="w-3.5 h-3.5" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>
                {isAdmin
                  ? 'Save Security Policy'
                  : 'Submit Security Policy Proposal'}
              </span>
            </button>
          )}
        </div>
      </section>

      {pendingProposal && (
        <GovernanceReasonModal
          title="Submit App Configuration Proposal"
          description="App settings changes proposed by non-administrator users remain inactive until reviewed and applied by a System Administrator in the Danger Zone."
          targetLabel={pendingProposal.targetLabel}
          previousSummary={pendingProposal.previousSummary}
          confirmLabel="Submit to Danger Zone"
          submitting={saving}
          onCancel={() => setPendingProposal(null)}
          onConfirm={handleSubmitProposal}
        />
      )}
    </div>
  );
}
