import { useEffect, useMemo, useState } from 'react';
import {
  ShieldAlert,
  Lock,
  Unlock,
  CheckCircle2,
  XCircle,
  KeyRound,
  QrCode,
  Trash2,
  AlertTriangle,
  Clock,
  ShieldCheck,
  Loader2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type {
  GovernanceChangeRequest,
  SystemSecuritySettings,
  TaxClient,
  TwoFactorChangeRequest,
  TwoFactorRequestType,
  TwoFactorSetupResponse,
  UserProfile,
} from '../types/tax';
import {
  completeTwoFactorUpdate,
  createTwoFactorChangeRequest,
  purgeClientRecord,
  reviewTwoFactorChangeRequest,
  setupTwoFactorApi,
  subscribeToAllTwoFactorRequests,
  subscribeToMyTwoFactorRequests,
  subscribeToSecuritySettings,
  updateMandatoryTwoFactorPolicy,
  verifyTwoFactorApi,
} from '../lib/taxService';
import {
  approveAndApplyGovernanceRequest,
  rejectGovernanceRequest,
  subscribeToAllGovernanceRequests,
  subscribeToMyGovernanceRequests,
} from '../lib/governanceService';
import { formatMytTimestamp, logActivity } from '../lib/auditService';

interface DangerZoneViewProps {
  userProfile: UserProfile;
  clients: TaxClient[];
  onClientPurged?: (clientId: string) => void;
}

type ApprovalTab =
  | 'ALL_PENDING'
  | 'CLIENT_DB_CHANGE'
  | 'APP_CONFIG_CHANGE'
  | 'ROLE_ELEVATION'
  | 'TWO_FACTOR_CHANGE';

const REQUEST_TYPE_LABELS: Record<TwoFactorRequestType, string> = {
  DISABLE_2FA: 'Disable Two-Factor Authentication',
  RESET_2FA_SECRET: 'Reset / Bind Authenticator Secret (TOTP)',
  CHANGE_2FA_METHOD: 'Change 2FA Authenticator Method',
};

const TWO_FA_STATUS_STYLES: Record<
  TwoFactorChangeRequest['status'],
  { label: string; className: string }
> = {
  PENDING: { label: 'Pending Admin Review', className: 'text-amber-700' },
  APPROVED: { label: 'Approved · Unlocked', className: 'text-teal-800' },
  REJECTED: { label: 'Rejected', className: 'text-red-700' },
  COMPLETED: { label: 'Completed · Re-Locked', className: 'text-slate-600' },
};

const GOV_CATEGORY_LABELS: Record<GovernanceChangeRequest['category'], string> = {
  CLIENT_DB_CHANGE: 'Client DB Change',
  APP_CONFIG_CHANGE: 'App Config Change',
  ROLE_ELEVATION: 'Admin/Manager Role Request',
  TWO_FACTOR_CHANGE: '2FA Request',
};

const GOV_STATUS_STYLES: Record<
  GovernanceChangeRequest['status'],
  { label: string; className: string }
> = {
  PENDING: { label: 'PENDING', className: 'text-amber-700' },
  APPROVED: { label: 'APPROVED', className: 'text-teal-800' },
  REJECTED: { label: 'REJECTED', className: 'text-red-700' },
};

export function DangerZoneView({
  userProfile,
  clients,
  onClientPurged,
}: DangerZoneViewProps) {
  const isAdmin = userProfile.role === 'administrator';

  // Unified Governance Approval Center state
  const [activeTab, setActiveTab] = useState<ApprovalTab>('ALL_PENDING');
  const [governanceRequests, setGovernanceRequests] = useState<GovernanceChangeRequest[]>([]);
  const [governanceLoading, setGovernanceLoading] = useState(true);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [expandedPayloads, setExpandedPayloads] = useState<Record<string, boolean>>({});
  const [processingGovId, setProcessingGovId] = useState<string | null>(null);

  // Section A: User's own 2FA requests & setup workflow
  const [my2faRequests, setMy2faRequests] = useState<TwoFactorChangeRequest[]>([]);
  const [my2faLoading, setMy2faLoading] = useState(true);
  const [requestType, setRequestType] = useState<TwoFactorRequestType>('RESET_2FA_SECRET');
  const [reason, setReason] = useState('');
  const [submittingRequest, setSubmittingRequest] = useState(false);

  // Active TOTP bind/reset or disable workflow (only when unlocked by admin approval)
  const [qrSetup, setQrSetup] = useState<TwoFactorSetupResponse | null>(null);
  const [generatingQr, setGeneratingQr] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [completing2fa, setCompleting2fa] = useState(false);

  // Admin 2FA requests (included in Unified Approval Center)
  const [all2faRequests, setAll2faRequests] = useState<TwoFactorChangeRequest[]>([]);
  const [admin2faLoading, setAdmin2faLoading] = useState(isAdmin);
  const [reviewing2faId, setReviewing2faId] = useState<string | null>(null);

  // Section C: Global Mandatory 2FA Policy + Permanent Client Record Purge
  const [securitySettings, setSecuritySettings] = useState<SystemSecuritySettings>({
    require2faForAdminAndManager: false,
    updatedByUid: null,
    updatedByEmail: null,
    updatedAt: null,
  });
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [selectedPurgeClientId, setSelectedPurgeClientId] = useState<string>('');
  const [purgeConfirmInput, setPurgeConfirmInput] = useState('');
  const [purgingClient, setPurgingClient] = useState(false);

  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);

  // Subscribe to Unified Governance Requests (`change_requests`)
  useEffect(() => {
    setGovernanceLoading(true);
    const unsub = isAdmin
      ? subscribeToAllGovernanceRequests(
          (rows) => {
            setGovernanceRequests(rows);
            setGovernanceLoading(false);
          },
          (err) => {
            setGovernanceLoading(false);
            setFeedback({
              tone: 'error',
              message: err.message || 'Unable to load governance change requests.',
            });
          }
        )
      : subscribeToMyGovernanceRequests(
          userProfile.uid,
          (rows) => {
            setGovernanceRequests(rows);
            setGovernanceLoading(false);
          },
          (err) => {
            setGovernanceLoading(false);
            setFeedback({
              tone: 'error',
              message: err.message || 'Unable to load your submitted change requests.',
            });
          }
        );
    return () => unsub();
  }, [isAdmin, userProfile.uid]);

  // Subscribe to current user's 2FA requests
  useEffect(() => {
    setMy2faLoading(true);
    const unsub = subscribeToMyTwoFactorRequests(
      userProfile.uid,
      (rows) => {
        setMy2faRequests(rows);
        setMy2faLoading(false);
      },
      (err) => {
        setMy2faLoading(false);
        setFeedback({
          tone: 'error',
          message: err.message || 'Unable to load your 2FA change requests.',
        });
      }
    );
    return () => unsub();
  }, [userProfile.uid]);

  // Subscribe to global security policy settings
  useEffect(() => {
    const unsub = subscribeToSecuritySettings(
      (settings) => setSecuritySettings(settings),
      (err) => console.error('Failed to load security policy:', err)
    );
    return () => unsub();
  }, []);

  // Subscribe to all 2FA requests when administrator
  useEffect(() => {
    if (!isAdmin) {
      setAdmin2faLoading(false);
      setAll2faRequests([]);
      return;
    }
    setAdmin2faLoading(true);
    const unsub = subscribeToAllTwoFactorRequests(
      (rows) => {
        setAll2faRequests(rows);
        setAdmin2faLoading(false);
      },
      (err) => {
        setAdmin2faLoading(false);
        setFeedback({
          tone: 'error',
          message: err.message || 'Unable to load the 2FA approval queue.',
        });
      }
    );
    return () => unsub();
  }, [isAdmin]);

  // Tab counts & filtered collections
  const visible2faSource = isAdmin ? all2faRequests : my2faRequests;

  const pendingCounts = useMemo(() => {
    const clientDb = governanceRequests.filter(
      (r) => r.status === 'PENDING' && r.category === 'CLIENT_DB_CHANGE'
    ).length;
    const appConfig = governanceRequests.filter(
      (r) => r.status === 'PENDING' && r.category === 'APP_CONFIG_CHANGE'
    ).length;
    const roleElev = governanceRequests.filter(
      (r) => r.status === 'PENDING' && r.category === 'ROLE_ELEVATION'
    ).length;
    const twoFaGov = governanceRequests.filter(
      (r) => r.status === 'PENDING' && r.category === 'TWO_FACTOR_CHANGE'
    ).length;
    const twoFaDirect = visible2faSource.filter((r) => r.status === 'PENDING').length;
    const twoFa = twoFaGov + twoFaDirect;
    return {
      ALL_PENDING: clientDb + appConfig + roleElev + twoFa,
      CLIENT_DB_CHANGE: clientDb,
      APP_CONFIG_CHANGE: appConfig,
      ROLE_ELEVATION: roleElev,
      TWO_FACTOR_CHANGE: twoFa,
    };
  }, [governanceRequests, visible2faSource]);

  const filteredGovernancePending = useMemo(() => {
    return governanceRequests.filter((r) => {
      if (r.status !== 'PENDING') return false;
      if (activeTab === 'ALL_PENDING') return true;
      return r.category === activeTab;
    });
  }, [governanceRequests, activeTab]);

  const filteredGovernanceHistory = useMemo(() => {
    return governanceRequests.filter((r) => {
      if (isAdmin && r.status === 'PENDING') return false;
      if (activeTab === 'ALL_PENDING') return true;
      return r.category === activeTab;
    });
  }, [governanceRequests, activeTab, isAdmin]);

  const filtered2faPending = useMemo(() => {
    if (activeTab !== 'ALL_PENDING' && activeTab !== 'TWO_FACTOR_CHANGE') return [];
    return visible2faSource.filter((r) => r.status === 'PENDING');
  }, [visible2faSource, activeTab]);

  const filtered2faHistory = useMemo(() => {
    if (activeTab !== 'ALL_PENDING' && activeTab !== 'TWO_FACTOR_CHANGE') return [];
    return visible2faSource.filter((r) => (isAdmin ? r.status !== 'PENDING' : true));
  }, [visible2faSource, activeTab, isAdmin]);

  const activeApproved2faRequest = useMemo(
    () => my2faRequests.find((r) => r.status === 'APPROVED') ?? null,
    [my2faRequests]
  );

  const hasPending2faRequest = useMemo(
    () => my2faRequests.some((r) => r.status === 'PENDING'),
    [my2faRequests]
  );

  const is2faUnlockedForChange =
    userProfile.twoFactorLocked === false && Boolean(activeApproved2faRequest);

  const selectedPurgeClient = useMemo(
    () => clients.find((c) => c.clientId === selectedPurgeClientId) ?? null,
    [clients, selectedPurgeClientId]
  );

  const isPurgeConfirmed = useMemo(() => {
    if (!selectedPurgeClient) return false;
    const typed = purgeConfirmInput.trim();
    return (
      typed === selectedPurgeClient.name.trim() ||
      typed === selectedPurgeClient.clientId.trim()
    );
  }, [selectedPurgeClient, purgeConfirmInput]);

  const twoFactorStatusLabel = (() => {
    if (userProfile.twoFactorEnabled && userProfile.twoFactorLocked !== false) {
      return 'Enabled & Locked';
    }
    if (userProfile.twoFactorEnabled && userProfile.twoFactorLocked === false) {
      return 'Enabled · Unlocked for Single Change';
    }
    if (!userProfile.twoFactorEnabled && userProfile.twoFactorLocked === false) {
      return 'Not Configured · Unlocked for Setup';
    }
    return 'Not Configured';
  })();

  const handleApproveGovernance = async (req: GovernanceChangeRequest) => {
    if (!isAdmin || !req.id) return;
    setFeedback(null);
    setProcessingGovId(req.id);
    try {
      await approveAndApplyGovernanceRequest(req, reviewNotes[req.id]);
      setReviewNotes((prev) => {
        const next = { ...prev };
        delete next[req.id!];
        return next;
      });
      setFeedback({
        tone: 'success',
        message: `Approved & applied ${GOV_CATEGORY_LABELS[req.category]} (${req.operation}) for ${req.targetLabel}.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to approve and apply governance request.',
      });
    } finally {
      setProcessingGovId(null);
    }
  };

  const handleRejectGovernance = async (req: GovernanceChangeRequest) => {
    if (!isAdmin || !req.id) return;
    setFeedback(null);
    setProcessingGovId(req.id);
    try {
      await rejectGovernanceRequest(req, reviewNotes[req.id]);
      setReviewNotes((prev) => {
        const next = { ...prev };
        delete next[req.id!];
        return next;
      });
      setFeedback({
        tone: 'success',
        message: `Rejected ${GOV_CATEGORY_LABELS[req.category]} request for ${req.targetLabel}.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to reject governance request.',
      });
    } finally {
      setProcessingGovId(null);
    }
  };

  const handleSubmit2faRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const trimmedReason = reason.trim();
    if (trimmedReason.length < 5) {
      setFeedback({
        tone: 'error',
        message: 'Please provide a clear business or security reason (at least 5 characters).',
      });
      return;
    }

    setSubmittingRequest(true);
    try {
      const requestId = await createTwoFactorChangeRequest({
        requestType,
        reason: trimmedReason,
        requesterRole: userProfile.role,
      });

      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'REQUEST_2FA_CHANGE',
        details: `Submitted ${requestType} approval request (${requestId}). Reason: ${trimmedReason}`,
      });

      setReason('');
      setFeedback({
        tone: 'success',
        message:
          'Your 2FA change request has been queued for System Administrator approval.',
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to submit 2FA change request.',
      });
    } finally {
      setSubmittingRequest(false);
    }
  };

  const handleGenerateQr = async () => {
    if (!is2faUnlockedForChange) return;
    setFeedback(null);
    setGeneratingQr(true);
    try {
      const result = await setupTwoFactorApi(userProfile.uid, userProfile.email);
      setQrSetup(result);
      setTotpCode('');
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to generate authenticator QR code.',
      });
    } finally {
      setGeneratingQr(false);
    }
  };

  const handleVerifyAndCompleteTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeApproved2faRequest || !is2faUnlockedForChange) return;
    setFeedback(null);
    setCompleting2fa(true);

    try {
      await verifyTwoFactorApi(userProfile.uid, totpCode.trim(), 'bind');
      await completeTwoFactorUpdate({
        uid: userProfile.uid,
        requestId: activeApproved2faRequest.id,
        twoFactorEnabled: true,
      });

      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'COMPLETE_2FA_CHANGE',
        details: `Completed approved ${activeApproved2faRequest.requestType} request (${activeApproved2faRequest.id}); authenticator TOTP verified and 2FA immediately re-locked.`,
      });

      setQrSetup(null);
      setTotpCode('');
      setFeedback({
        tone: 'success',
        message:
          'Authenticator verified. Two-Factor Authentication is now Enabled & Locked.',
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Invalid 6-digit code. Verification failed.',
      });
    } finally {
      setCompleting2fa(false);
    }
  };

  const handleCompleteDisable2fa = async () => {
    if (!activeApproved2faRequest || !is2faUnlockedForChange) return;
    setFeedback(null);
    setCompleting2fa(true);

    try {
      await verifyTwoFactorApi(userProfile.uid, '', 'clear');
      await completeTwoFactorUpdate({
        uid: userProfile.uid,
        requestId: activeApproved2faRequest.id,
        twoFactorEnabled: false,
      });

      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'COMPLETE_2FA_CHANGE',
        details: `Completed approved DISABLE_2FA request (${activeApproved2faRequest.id}); TOTP secret cleared and 2FA settings immediately re-locked.`,
      });

      setQrSetup(null);
      setTotpCode('');
      setFeedback({
        tone: 'success',
        message:
          'Two-Factor Authentication has been disabled and your 2FA security lock has been automatically re-engaged.',
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to complete 2FA disable action.',
      });
    } finally {
      setCompleting2fa(false);
    }
  };

  const handleAdmin2faReview = async (
    req: TwoFactorChangeRequest,
    decision: 'APPROVED' | 'REJECTED'
  ) => {
    if (!isAdmin) return;
    setFeedback(null);
    setReviewing2faId(req.id);
    try {
      await reviewTwoFactorChangeRequest(req, decision);
      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken:
          decision === 'APPROVED' ? 'APPROVE_2FA_CHANGE' : 'REJECT_2FA_CHANGE',
        details: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} ${req.requestType} request (${req.id}) for ${req.requesterEmail} (${req.requesterRole}).${
          decision === 'APPROVED'
            ? ' Unlocked user 2FA settings for a single change.'
            : ''
        }`,
      });

      setFeedback({
        tone: 'success',
        message:
          decision === 'APPROVED'
            ? `Approved ${req.requesterEmail}'s 2FA request and unlocked their 2FA controls for a single change.`
            : `Rejected ${req.requesterEmail}'s 2FA change request.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to process 2FA review decision.',
      });
    } finally {
      setReviewing2faId(null);
    }
  };

  const handleToggleMandatoryPolicy = async () => {
    if (!isAdmin || savingPolicy) return;
    const nextValue = !securitySettings.require2faForAdminAndManager;
    setFeedback(null);
    setSavingPolicy(true);
    try {
      await updateMandatoryTwoFactorPolicy(nextValue);
      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'UPDATE_SECURITY_POLICY',
        details: `Set Global Mandatory 2FA Policy for Administrator & Manager logins to ${nextValue ? 'ENABLED' : 'DISABLED'}.`,
      });
      setFeedback({
        tone: 'success',
        message: `Global Mandatory 2FA Policy for Administrators & Managers is now ${nextValue ? 'enabled' : 'disabled'}.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to update security policy.',
      });
    } finally {
      setSavingPolicy(false);
    }
  };

  const handlePurgeClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !selectedPurgeClient || !isPurgeConfirmed || purgingClient) return;

    setFeedback(null);
    setPurgingClient(true);
    const targetName = selectedPurgeClient.name;
    const targetId = selectedPurgeClient.clientId;
    const targetEmail = selectedPurgeClient.email;

    try {
      const { deletedVerifications, deletedReminders } = await purgeClientRecord(targetId);

      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'DANGER_DELETE_CLIENT',
        details: `Permanently purged client dossier ${targetId} (${targetName}, ${targetEmail}) along with ${deletedVerifications} verification log(s) and ${deletedReminders} reminder log(s). Immutable audit logs preserved.`,
      });

      setSelectedPurgeClientId('');
      setPurgeConfirmInput('');
      onClientPurged?.(targetId);
      setFeedback({
        tone: 'success',
        message: `Client record ${targetId} (${targetName}) has been permanently purged. Immutable audit trail records remain intact.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to purge client record.',
      });
    } finally {
      setPurgingClient(false);
    }
  };

  const APPROVAL_TABS: Array<{ id: ApprovalTab; label: string; count: number }> = [
    { id: 'ALL_PENDING', label: 'All Pending', count: pendingCounts.ALL_PENDING },
    { id: 'CLIENT_DB_CHANGE', label: 'Client DB Changes', count: pendingCounts.CLIENT_DB_CHANGE },
    { id: 'APP_CONFIG_CHANGE', label: 'App Changes', count: pendingCounts.APP_CONFIG_CHANGE },
    {
      id: 'ROLE_ELEVATION',
      label: 'Admin/Manager Role Requests',
      count: pendingCounts.ROLE_ELEVATION,
    },
    { id: 'TWO_FACTOR_CHANGE', label: '2FA Requests', count: pendingCounts.TWO_FACTOR_CHANGE },
  ];

  const isQueueLoading = governanceLoading || (isAdmin ? admin2faLoading : my2faLoading);
  const totalPendingInActiveTab =
    filteredGovernancePending.length + filtered2faPending.length;

  return (
    <div className="space-y-6">
      {/* Danger Zone Header Banner */}
      <section className="bg-white border border-red-200 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 tracking-tight">
                Danger Zone — Unified Governance &amp; Approval Center
              </h1>
              <p className="text-sm text-slate-600 mt-1 max-w-2xl leading-relaxed">
                System Administrator approval gates for all client database mutations, app
                configuration changes, elevated role assignments, and locked 2FA controls. Every
                decision is atomically applied and recorded in the immutable audit trail.
              </p>
            </div>
          </div>

          <div className="shrink-0 text-xs border border-slate-200 rounded-lg px-3.5 py-2.5 bg-slate-50">
            <div className="text-slate-500">Global Admin/Manager 2FA Policy</div>
            <div
              className={`font-semibold mt-0.5 ${
                securitySettings.require2faForAdminAndManager
                  ? 'text-teal-800'
                  : 'text-slate-700'
              }`}
            >
              {securitySettings.require2faForAdminAndManager
                ? 'Mandatory (Enforced)'
                : 'Optional (Standard)'}
            </div>
          </div>
        </div>
      </section>

      {feedback && (
        <div
          role="status"
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
            className="text-xs font-medium underline underline-offset-2 shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* =================================================================== */}
      {/* UNIFIED APPROVAL CENTER (Visible to all roles; Admin approves)      */}
      {/* =================================================================== */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-teal-700" />
                <span>
                  {isAdmin
                    ? 'System Administrator Approval Queue'
                    : 'Your Submitted Governance & Change Requests'}
                </span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {isAdmin
                  ? 'Review pending requests from change_requests and two_factor_requests. Clicking "Approve & Apply" executes the staged Firestore write atomically.'
                  : 'Track real-time System Administrator review status (PENDING, APPROVED, REJECTED) for all changes you have proposed.'}
              </p>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-700 tabular-nums whitespace-nowrap">
              {pendingCounts.ALL_PENDING} pending total
            </span>
          </div>

          {/* Filter Tabs */}
          <div
            className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
            role="tablist"
            aria-label="Filter governance requests"
          >
            {APPROVAL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`font-mono text-[11px] tabular-nums ${
                    tab.count > 0 ? 'font-semibold text-red-700' : 'text-slate-400'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {isQueueLoading ? (
            <div className="text-xs text-slate-500 py-6">Loading governance requests...</div>
          ) : isAdmin ? (
            /* ---------------- ADMINISTRATOR APPROVAL QUEUE ---------------- */
            <>
              {totalPendingInActiveTab === 0 ? (
                <div className="border border-dashed border-slate-200 rounded-lg px-6 py-10 text-center">
                  <CheckCircle2 className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-900">
                    No pending requests in this category
                  </p>
                  <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                    Real-time client DB mutations, app config proposals, role elevation requests,
                    and 2FA unlock requests awaiting System Administrator review will appear here.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Pending Unified Governance Requests (change_requests) */}
                  {filteredGovernancePending.map((req) => {
                    const id = req.id || '';
                    const isProcessing = processingGovId === id;
                    const isExpanded = Boolean(expandedPayloads[id]);
                    return (
                      <div
                        key={id}
                        className="border border-slate-200 rounded-xl p-5 bg-slate-50/40 space-y-3.5"
                      >
                        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-semibold text-red-700">
                                {GOV_CATEGORY_LABELS[req.category]}
                              </span>
                              <span className="text-slate-300" aria-hidden="true">·</span>
                              <span className="font-mono font-semibold text-slate-800">
                                {req.operation}
                              </span>
                              <span className="text-slate-300" aria-hidden="true">·</span>
                              <span className="font-mono text-slate-600">
                                {req.targetCollection}/{req.targetDocId}
                              </span>
                            </div>
                            <h3 className="text-sm font-semibold text-slate-900">
                              {req.targetLabel}
                            </h3>
                            <p className="text-xs text-slate-500">
                              Requested by{' '}
                              <span className="font-medium text-slate-800">
                                {req.requestedByEmail}
                              </span>{' '}
                              (<span className="capitalize">{req.requestedByRole}</span>) on{' '}
                              <span className="font-mono tabular-nums">
                                {formatMytTimestamp(req.createdAt)}
                              </span>
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => handleApproveGovernance(req)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer"
                            >
                              {isProcessing ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              )}
                              <span>Approve &amp; Apply</span>
                            </button>
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => handleRejectGovernance(req)}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors cursor-pointer"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>Reject</span>
                            </button>
                          </div>
                        </div>

                        {req.previousSummary && (
                          <div className="p-3 bg-white border border-slate-200 rounded-lg text-xs text-slate-700">
                            <span className="font-semibold text-slate-900">Proposed Change: </span>
                            <span>{req.previousSummary}</span>
                          </div>
                        )}

                        <div className="text-xs text-slate-700">
                          <span className="font-semibold text-slate-900">Justification: </span>
                          <span>{req.reason}</span>
                        </div>

                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedPayloads((prev) => ({ ...prev, [id]: !prev[id] }))
                            }
                            className="inline-flex items-center gap-1 text-xs font-medium text-teal-800 hover:text-teal-950 cursor-pointer"
                          >
                            {isExpanded ? (
                              <ChevronUp className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {isExpanded ? 'Hide Proposed Payload' : 'Inspect Proposed Payload'}
                            </span>
                          </button>

                          <input
                            type="text"
                            maxLength={500}
                            value={reviewNotes[id] || ''}
                            onChange={(e) =>
                              setReviewNotes((prev) => ({ ...prev, [id]: e.target.value }))
                            }
                            placeholder="Optional admin review note..."
                            className="sm:w-72 px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                          />
                        </div>

                        {isExpanded && (
                          <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto max-h-56">
                            {JSON.stringify(req.proposedPayload, null, 2)}
                          </pre>
                        )}
                      </div>
                    );
                  })}

                  {/* Pending 2FA Requests (two_factor_requests) */}
                  {filtered2faPending.map((req) => {
                    const isProcessing = reviewing2faId === req.id;
                    return (
                      <div
                        key={req.id}
                        className="border border-slate-200 rounded-xl p-5 bg-slate-50/40 space-y-3"
                      >
                        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-semibold text-red-700">2FA Request</span>
                              <span className="text-slate-300" aria-hidden="true">·</span>
                              <span className="font-mono font-semibold text-slate-800">
                                {req.requestType}
                              </span>
                            </div>
                            <h3 className="text-sm font-semibold text-slate-900">
                              {REQUEST_TYPE_LABELS[req.requestType]}
                            </h3>
                            <p className="text-xs text-slate-500">
                              Requested by{' '}
                              <span className="font-medium text-slate-800">
                                {req.requesterEmail}
                              </span>{' '}
                              (<span className="capitalize">{req.requesterRole}</span>) on{' '}
                              <span className="font-mono tabular-nums">
                                {formatMytTimestamp(req.createdAt)}
                              </span>
                            </p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => handleAdmin2faReview(req, 'APPROVED')}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Approve &amp; Unlock 2FA</span>
                            </button>
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => handleAdmin2faReview(req, 'REJECTED')}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors cursor-pointer"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>Reject</span>
                            </button>
                          </div>
                        </div>

                        <div className="text-xs text-slate-700">
                          <span className="font-semibold text-slate-900">Justification: </span>
                          <span>{req.reason}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Reviewed Governance History (Admin) */}
              {(filteredGovernanceHistory.length > 0 || filtered2faHistory.length > 0) && (
                <div className="pt-4 border-t border-slate-200 space-y-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Recent Reviewed Decisions (
                    {filteredGovernanceHistory.length + filtered2faHistory.length})
                  </h3>
                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                          <th className="py-2 pl-4 pr-3">Reviewed (MYT)</th>
                          <th className="py-2 px-3">Category</th>
                          <th className="py-2 px-3">Target</th>
                          <th className="py-2 px-3">Requester</th>
                          <th className="py-2 px-3">Status</th>
                          <th className="py-2 pl-3 pr-4">Reviewer · Note</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredGovernanceHistory.slice(0, 15).map((req) => {
                          const meta = GOV_STATUS_STYLES[req.status];
                          return (
                            <tr key={req.id} className="align-top">
                              <td className="py-2.5 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                                {formatMytTimestamp(req.reviewedAt ?? req.createdAt)}
                              </td>
                              <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap font-medium">
                                {GOV_CATEGORY_LABELS[req.category]} ({req.operation})
                              </td>
                              <td className="py-2.5 px-3 text-slate-900">
                                {req.targetLabel}
                              </td>
                              <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                                {req.requestedByEmail}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                <span className={`font-semibold ${meta.className}`}>
                                  {meta.label}
                                </span>
                              </td>
                              <td className="py-2.5 pl-3 pr-4 text-slate-600">
                                <div>{req.reviewedByEmail || '—'}</div>
                                {req.reviewNote && (
                                  <div className="text-slate-500 mt-0.5">{req.reviewNote}</div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {filtered2faHistory.slice(0, 10).map((req) => {
                          const meta = TWO_FA_STATUS_STYLES[req.status];
                          return (
                            <tr key={req.id} className="align-top">
                              <td className="py-2.5 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                                {formatMytTimestamp(req.reviewedAt ?? req.createdAt)}
                              </td>
                              <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap font-medium">
                                2FA Request
                              </td>
                              <td className="py-2.5 px-3 text-slate-900">
                                {REQUEST_TYPE_LABELS[req.requestType]}
                              </td>
                              <td className="py-2.5 px-3 text-slate-600 whitespace-nowrap">
                                {req.requesterEmail}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                <span className={`font-semibold ${meta.className}`}>
                                  {meta.label}
                                </span>
                              </td>
                              <td className="py-2.5 pl-3 pr-4 text-slate-600">
                                {req.reviewedByEmail || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ---------------- NON-ADMIN PERSONAL SUBMISSION TRACKER ---------------- */
            <>
              {filteredGovernanceHistory.length === 0 && filtered2faHistory.length === 0 ? (
                <div className="border border-dashed border-slate-200 rounded-lg px-6 py-10 text-center">
                  <Clock className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                  <p className="text-sm font-semibold text-slate-900">
                    No submitted requests in this category
                  </p>
                  <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                    Any client database edits, app configuration proposals, role elevation
                    requests, or 2FA change requests you submit will appear here with real-time
                    System Administrator review status.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2.5 pl-4 pr-3">Submitted (MYT)</th>
                        <th className="py-2.5 px-3">Category</th>
                        <th className="py-2.5 px-3">Target &amp; Summary</th>
                        <th className="py-2.5 px-3">Reason</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 pl-3 pr-4">Admin Review</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredGovernanceHistory.map((req) => {
                        const meta = GOV_STATUS_STYLES[req.status];
                        return (
                          <tr key={req.id} className="align-top">
                            <td className="py-3 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                              {formatMytTimestamp(req.createdAt)}
                            </td>
                            <td className="py-3 px-3 font-medium text-slate-800 whitespace-nowrap">
                              {GOV_CATEGORY_LABELS[req.category]} ({req.operation})
                            </td>
                            <td className="py-3 px-3 text-slate-800 max-w-xs">
                              <div className="font-semibold text-slate-900">{req.targetLabel}</div>
                              {req.previousSummary && (
                                <div className="text-slate-500 mt-0.5">{req.previousSummary}</div>
                              )}
                            </td>
                            <td className="py-3 px-3 text-slate-600 max-w-xs break-words">
                              {req.reason}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap">
                              <span className={`font-semibold ${meta.className}`}>
                                {meta.label}
                              </span>
                            </td>
                            <td className="py-3 pl-3 pr-4 text-slate-600">
                              {req.reviewedByEmail ? (
                                <>
                                  <div className="font-medium text-slate-800">
                                    {req.reviewedByEmail}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-400">
                                    {formatMytTimestamp(req.reviewedAt ?? null)}
                                  </div>
                                  {req.reviewNote && (
                                    <div className="text-slate-500 mt-0.5">{req.reviewNote}</div>
                                  )}
                                </>
                              ) : (
                                <span className="text-slate-400">Awaiting review</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {filtered2faHistory.map((req) => {
                        const meta = TWO_FA_STATUS_STYLES[req.status];
                        return (
                          <tr key={req.id} className="align-top">
                            <td className="py-3 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                              {formatMytTimestamp(req.createdAt)}
                            </td>
                            <td className="py-3 px-3 font-medium text-slate-800 whitespace-nowrap">
                              2FA Request
                            </td>
                            <td className="py-3 px-3 text-slate-900 font-semibold">
                              {REQUEST_TYPE_LABELS[req.requestType]}
                            </td>
                            <td className="py-3 px-3 text-slate-600 max-w-xs break-words">
                              {req.reason}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap">
                              <span className={`font-semibold ${meta.className}`}>
                                {meta.label}
                              </span>
                            </td>
                            <td className="py-3 pl-3 pr-4 text-slate-600">
                              {req.reviewedByEmail ? (
                                <>
                                  <div className="font-medium text-slate-800">
                                    {req.reviewedByEmail}
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-400">
                                    {formatMytTimestamp(req.reviewedAt ?? null)}
                                  </div>
                                </>
                              ) : (
                                <span className="text-slate-400">Awaiting review</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* =================================================================== */}
      {/* SECTION A — Two-Factor Authentication (2FA) Protection (All Roles)  */}
      {/* =================================================================== */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-slate-600" />
              <span>Two-Factor Authentication (2FA) Protection</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Account: <span className="font-mono text-slate-700">{userProfile.email}</span> ·
              Role: <span className="capitalize font-medium text-slate-700">{userProfile.role}</span>
            </p>
          </div>

          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold whitespace-nowrap bg-slate-50 border-slate-200 text-slate-800">
            {userProfile.twoFactorLocked !== false ? (
              <Lock className="w-3.5 h-3.5 text-red-600" />
            ) : (
              <Unlock className="w-3.5 h-3.5 text-teal-700" />
            )}
            <span>{twoFactorStatusLabel}</span>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div
            className={`p-4 rounded-lg border flex items-start gap-3 ${
              is2faUnlockedForChange
                ? 'bg-teal-50/70 border-teal-200 text-teal-950'
                : 'bg-slate-50 border-slate-200 text-slate-700'
            }`}
          >
            {is2faUnlockedForChange ? (
              <Unlock className="w-4 h-4 text-teal-700 mt-0.5 shrink-0" />
            ) : (
              <Lock className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
            )}
            <div className="text-xs leading-relaxed">
              {is2faUnlockedForChange && activeApproved2faRequest ? (
                <>
                  <p className="font-semibold text-teal-900">
                    Single-Use 2FA Change Window Active (Approved by{' '}
                    {activeApproved2faRequest.reviewedByEmail || 'System Administrator'})
                  </p>
                  <p className="mt-0.5 text-teal-800">
                    Approved action:{' '}
                    <span className="font-semibold">
                      {REQUEST_TYPE_LABELS[activeApproved2faRequest.requestType]}
                    </span>
                    . Once you complete this change, your 2FA security lock will immediately
                    re-engage automatically.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-slate-900">
                    2FA settings are locked by security policy and cannot be modified without
                    System Administrator approval.
                  </p>
                  <p className="mt-0.5 text-slate-600">
                    Direct 2FA enable, disable, secret reset, and method change controls remain
                    disabled until an administrator approves a formal change request below.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Locked / Unlocked 2FA Action Panel */}
            <div className="border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Authenticator Controls (RFC 6238 TOTP)
                </h3>
                <span className="text-xs font-mono text-slate-500">
                  {userProfile.twoFactorEnabled ? 'TOTP Bound' : 'No TOTP Bound'}
                </span>
              </div>

              {!is2faUnlockedForChange ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-600 leading-relaxed">
                    All 2FA modification actions are locked. Submit an approval request on the
                    right to request a single-use unlock window from a System Administrator.
                  </p>
                  <div className="flex flex-wrap gap-2.5 pt-1">
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-400 bg-slate-100 border border-slate-200 rounded-lg cursor-not-allowed"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                      <span>Configure / Reset TOTP Secret</span>
                    </button>
                    <button
                      type="button"
                      disabled
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-400 bg-slate-100 border border-slate-200 rounded-lg cursor-not-allowed"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>Disable 2FA</span>
                    </button>
                  </div>
                </div>
              ) : activeApproved2faRequest?.requestType === 'DISABLE_2FA' ? (
                <div className="space-y-4">
                  <p className="text-xs text-slate-700 leading-relaxed">
                    Your request to disable Two-Factor Authentication has been approved. Confirm
                    below to clear your server-side TOTP secret and immediately re-lock your 2FA
                    settings.
                  </p>
                  <button
                    type="button"
                    onClick={handleCompleteDisable2fa}
                    disabled={completing2fa}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {completing2fa ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ShieldAlert className="w-3.5 h-3.5" />
                    )}
                    <span>Confirm Disable 2FA &amp; Re-Lock Account</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-xs text-slate-700 leading-relaxed">
                    Generate a server-issued authenticator QR code (TOTP secrets never leave the
                    backend). Scan with Google Authenticator, Authy, or 1Password, then enter the
                    6-digit verification code to bind and re-lock.
                  </p>

                  {!qrSetup ? (
                    <button
                      type="button"
                      onClick={handleGenerateQr}
                      disabled={generatingQr}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      {generatingQr ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <QrCode className="w-3.5 h-3.5" />
                      )}
                      <span>Generate Authenticator QR Code</span>
                    </button>
                  ) : (
                    <form onSubmit={handleVerifyAndCompleteTotp} className="space-y-4">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
                        <img
                          src={qrSetup.qrCodeDataUrl}
                          alt="Two-Factor Authentication TOTP QR Code"
                          className="w-36 h-36 rounded-lg border border-slate-200 bg-white p-1.5 shrink-0"
                        />
                        <div className="space-y-1.5 text-xs text-slate-600">
                          <div className="font-semibold text-slate-900">
                            Scan with Authenticator App
                          </div>
                          <div>
                            Issuer: <span className="font-mono text-slate-800">{qrSetup.issuer}</span>
                          </div>
                          <div>
                            Account:{' '}
                            <span className="font-mono text-slate-800">{qrSetup.accountName}</span>
                          </div>
                          <div>
                            Standard: RFC 6238 ({qrSetup.digits}-digit, {qrSetup.periodSeconds}s
                            interval)
                          </div>
                          <button
                            type="button"
                            onClick={handleGenerateQr}
                            disabled={generatingQr}
                            className="text-teal-700 hover:text-teal-900 font-medium underline underline-offset-2 pt-1 cursor-pointer"
                          >
                            Regenerate QR code
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
                        <div className="flex-1">
                          <label
                            htmlFor="totp-code-input"
                            className="block text-xs font-medium text-slate-700 mb-1"
                          >
                            6-Digit Authenticator Code
                          </label>
                          <input
                            id="totp-code-input"
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            value={totpCode}
                            onChange={(e) =>
                              setTotpCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))
                            }
                            placeholder="000000"
                            required
                            className="w-full px-3 py-2 text-sm font-mono tracking-widest text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={completing2fa || totpCode.length !== 6}
                          className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors whitespace-nowrap cursor-pointer h-[38px]"
                        >
                          {completing2fa ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="w-3.5 h-3.5" />
                          )}
                          <span>Verify &amp; Re-Lock 2FA</span>
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </div>

            {/* Right: Request 2FA Change Approval Form */}
            <form
              onSubmit={handleSubmit2faRequest}
              className="border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Request 2FA Change Approval
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  Submit a formal request to unlock your 2FA controls for a single verified update.
                </p>
              </div>

              <div>
                <label
                  htmlFor="twofa-request-type"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Change Type
                </label>
                <select
                  id="twofa-request-type"
                  value={requestType}
                  onChange={(e) => setRequestType(e.target.value as TwoFactorRequestType)}
                  disabled={submittingRequest || hasPending2faRequest || is2faUnlockedForChange}
                  className="w-full px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 disabled:bg-slate-50 disabled:text-slate-400"
                >
                  <option value="RESET_2FA_SECRET">
                    Reset / Bind Authenticator Secret (TOTP)
                  </option>
                  <option value="CHANGE_2FA_METHOD">Change 2FA Authenticator Method</option>
                  <option value="DISABLE_2FA">Disable Two-Factor Authentication</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="twofa-request-reason"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Justification / Reason
                </label>
                <textarea
                  id="twofa-request-reason"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={submittingRequest || hasPending2faRequest || is2faUnlockedForChange}
                  placeholder="Explain why you need to configure, reset, or disable 2FA (e.g., new mobile device, initial TOTP binding)..."
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 disabled:bg-slate-50 disabled:text-slate-400 resize-none"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">
                  {hasPending2faRequest
                    ? 'You already have a pending request awaiting admin review.'
                    : is2faUnlockedForChange
                      ? 'Complete your active approved change first.'
                      : 'Logged permanently in Audit Trail.'}
                </span>
                <button
                  type="submit"
                  disabled={
                    submittingRequest ||
                    hasPending2faRequest ||
                    is2faUnlockedForChange ||
                    reason.trim().length < 5
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-45 transition-colors whitespace-nowrap cursor-pointer"
                >
                  {submittingRequest && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Request 2FA Change Approval</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      </section>

      {/* =================================================================== */}
      {/* CRITICAL SYSTEM ACTIONS (Administrator ONLY)                        */}
      {/* =================================================================== */}
      {isAdmin && (
        <section className="bg-white border border-red-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 bg-red-50/60 border-b border-red-200">
            <h2 className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              <span>Critical System Actions (Administrator Only)</span>
            </h2>
            <p className="text-xs text-red-800/80 mt-0.5">
              Organization-wide security enforcement and irreversible data purge operations.
              Immutable compliance audit logs can never be modified or deleted.
            </p>
          </div>

          <div className="divide-y divide-slate-200">
            {/* Global Mandatory 2FA Policy */}
            <div className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="space-y-1 max-w-2xl">
                <h3 className="text-sm font-semibold text-slate-900">
                  Global Mandatory 2FA Policy
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Require Two-Factor Authentication for all <span className="font-medium">Administrator</span>{' '}
                  and <span className="font-medium">Manager</span> accounts across CukaiDesk. Stored
                  in Firestore at <code className="font-mono text-slate-800">/system_settings/security</code>.
                </p>
                {securitySettings.updatedByEmail && (
                  <p className="text-[11px] text-slate-500">
                    Last updated by {securitySettings.updatedByEmail} on{' '}
                    <span className="font-mono">
                      {formatMytTimestamp(securitySettings.updatedAt ?? null)}
                    </span>
                  </p>
                )}
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={securitySettings.require2faForAdminAndManager}
                disabled={savingPolicy}
                onClick={handleToggleMandatoryPolicy}
                className={`inline-flex items-center gap-2.5 px-4 py-2.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                  securitySettings.require2faForAdminAndManager
                    ? 'bg-teal-700 border-teal-700 text-white hover:bg-teal-800'
                    : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
                }`}
              >
                {savingPolicy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                <span>
                  {securitySettings.require2faForAdminAndManager
                    ? 'Mandatory 2FA: Enabled (Click to Disable)'
                    : 'Mandatory 2FA: Disabled (Click to Enable)'}
                </span>
              </button>
            </div>

            {/* Permanent Client Record Purge */}
            <form onSubmit={handlePurgeClient} className="p-6 space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-red-900 flex items-center gap-1.5">
                  <Trash2 className="w-4 h-4 text-red-600" />
                  <span>Permanent Client Record Purge</span>
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
                  Permanently deletes a client dossier along with its nested document verification
                  and reminder history from Cloud Firestore. This action cannot be undone.
                  Compliance records in <code className="font-mono text-slate-800">audit_logs</code>{' '}
                  are strictly immutable and are never deleted.
                </p>
              </div>

              {clients.length === 0 ? (
                <div className="border border-dashed border-slate-200 rounded-lg px-5 py-6 text-center text-xs text-slate-500">
                  No client records exist in Cloud Firestore to purge.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                  <div>
                    <label
                      htmlFor="purge-client-select"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Select Client Dossier
                    </label>
                    <select
                      id="purge-client-select"
                      value={selectedPurgeClientId}
                      onChange={(e) => {
                        setSelectedPurgeClientId(e.target.value);
                        setPurgeConfirmInput('');
                      }}
                      className="w-full px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600/20 focus:border-red-600"
                    >
                      <option value="">-- Choose a client record --</option>
                      {clients.map((c) => (
                        <option key={c.clientId} value={c.clientId}>
                          {c.clientId} — {c.name} ({c.email})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="purge-confirm-input"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      {selectedPurgeClient ? (
                        <>
                          Type{' '}
                          <span className="font-mono font-semibold text-red-700">
                            {selectedPurgeClient.clientId}
                          </span>{' '}
                          or{' '}
                          <span className="font-semibold text-red-700">
                            {selectedPurgeClient.name}
                          </span>{' '}
                          to confirm
                        </>
                      ) : (
                        'Confirmation (select a client first)'
                      )}
                    </label>
                    <input
                      id="purge-confirm-input"
                      type="text"
                      value={purgeConfirmInput}
                      onChange={(e) => setPurgeConfirmInput(e.target.value)}
                      disabled={!selectedPurgeClient || purgingClient}
                      placeholder={
                        selectedPurgeClient
                          ? `Type "${selectedPurgeClient.clientId}" or "${selectedPurgeClient.name}"`
                          : 'Select a client above'
                      }
                      className="w-full px-3 py-2 text-xs text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600/20 focus:border-red-600 disabled:bg-slate-50"
                    />
                  </div>
                </div>
              )}

              {clients.length > 0 && (
                <div className="flex items-center justify-between gap-4 pt-1">
                  <span className="text-[11px] text-slate-500">
                    Writes an immutable <code className="font-mono">DANGER_DELETE_CLIENT</code>{' '}
                    entry to the Audit Trail.
                  </span>
                  <button
                    type="submit"
                    disabled={!isPurgeConfirmed || purgingClient}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {purgingClient ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    <span>Permanently Purge Client Record</span>
                  </button>
                </div>
              )}
            </form>
          </div>
        </section>
      )}
    </div>
  );
}
