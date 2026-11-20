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
} from 'lucide-react';
import type {
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
import { formatMytTimestamp, logActivity } from '../lib/auditService';

interface DangerZoneViewProps {
  userProfile: UserProfile;
  clients: TaxClient[];
  onClientPurged?: (clientId: string) => void;
}

const REQUEST_TYPE_LABELS: Record<TwoFactorRequestType, string> = {
  DISABLE_2FA: 'Disable Two-Factor Authentication',
  RESET_2FA_SECRET: 'Reset / Bind Authenticator Secret (TOTP)',
  CHANGE_2FA_METHOD: 'Change 2FA Authenticator Method',
};

const REQUEST_STATUS_STYLES: Record<
  TwoFactorChangeRequest['status'],
  { label: string; className: string }
> = {
  PENDING: { label: 'Pending Admin Review', className: 'text-amber-700' },
  APPROVED: { label: 'Approved · Unlocked', className: 'text-teal-800' },
  REJECTED: { label: 'Rejected', className: 'text-red-700' },
  COMPLETED: { label: 'Completed · Re-Locked', className: 'text-slate-600' },
};

export function DangerZoneView({
  userProfile,
  clients,
  onClientPurged,
}: DangerZoneViewProps) {
  const isAdmin = userProfile.role === 'administrator';

  // Section A: User's own 2FA requests & setup workflow
  const [myRequests, setMyRequests] = useState<TwoFactorChangeRequest[]>([]);
  const [myRequestsLoading, setMyRequestsLoading] = useState(true);
  const [requestType, setRequestType] = useState<TwoFactorRequestType>('RESET_2FA_SECRET');
  const [reason, setReason] = useState('');
  const [submittingRequest, setSubmittingRequest] = useState(false);

  // Active TOTP bind/reset or disable workflow (only when unlocked by admin approval)
  const [qrSetup, setQrSetup] = useState<TwoFactorSetupResponse | null>(null);
  const [generatingQr, setGeneratingQr] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [completing2fa, setCompleting2fa] = useState(false);

  // Section B: System Admin Approval Queue
  const [allRequests, setAllRequests] = useState<TwoFactorChangeRequest[]>([]);
  const [adminQueueLoading, setAdminQueueLoading] = useState(isAdmin);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

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

  // Subscribe to current user's 2FA requests
  useEffect(() => {
    setMyRequestsLoading(true);
    const unsub = subscribeToMyTwoFactorRequests(
      userProfile.uid,
      (rows) => {
        setMyRequests(rows);
        setMyRequestsLoading(false);
      },
      (err) => {
        setMyRequestsLoading(false);
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
      setAdminQueueLoading(false);
      setAllRequests([]);
      return;
    }
    setAdminQueueLoading(true);
    const unsub = subscribeToAllTwoFactorRequests(
      (rows) => {
        setAllRequests(rows);
        setAdminQueueLoading(false);
      },
      (err) => {
        setAdminQueueLoading(false);
        setFeedback({
          tone: 'error',
          message: err.message || 'Unable to load the 2FA approval queue.',
        });
      }
    );
    return () => unsub();
  }, [isAdmin]);

  const activeApprovedRequest = useMemo(
    () => myRequests.find((r) => r.status === 'APPROVED') ?? null,
    [myRequests]
  );

  const hasPendingRequest = useMemo(
    () => myRequests.some((r) => r.status === 'PENDING'),
    [myRequests]
  );

  const is2faUnlockedForChange =
    userProfile.twoFactorLocked === false && Boolean(activeApprovedRequest);

  const pendingAdminRequests = useMemo(
    () => allRequests.filter((r) => r.status === 'PENDING'),
    [allRequests]
  );

  const reviewedAdminRequests = useMemo(
    () => allRequests.filter((r) => r.status !== 'PENDING'),
    [allRequests]
  );

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
    if (!activeApprovedRequest || !is2faUnlockedForChange) return;
    setFeedback(null);
    setCompleting2fa(true);

    try {
      await verifyTwoFactorApi(userProfile.uid, totpCode.trim(), 'bind');
      await completeTwoFactorUpdate({
        uid: userProfile.uid,
        requestId: activeApprovedRequest.id,
        twoFactorEnabled: true,
      });

      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'COMPLETE_2FA_CHANGE',
        details: `Completed approved ${activeApprovedRequest.requestType} request (${activeApprovedRequest.id}); authenticator TOTP verified and 2FA immediately re-locked.`,
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
    if (!activeApprovedRequest || !is2faUnlockedForChange) return;
    setFeedback(null);
    setCompleting2fa(true);

    try {
      await verifyTwoFactorApi(userProfile.uid, '', 'clear');
      await completeTwoFactorUpdate({
        uid: userProfile.uid,
        requestId: activeApprovedRequest.id,
        twoFactorEnabled: false,
      });

      await logActivity({
        pageVisited: 'Danger Zone',
        actionTaken: 'COMPLETE_2FA_CHANGE',
        details: `Completed approved DISABLE_2FA request (${activeApprovedRequest.id}); TOTP secret cleared and 2FA settings immediately re-locked.`,
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

  const handleAdminReview = async (
    req: TwoFactorChangeRequest,
    decision: 'APPROVED' | 'REJECTED'
  ) => {
    if (!isAdmin) return;
    setFeedback(null);
    setReviewingId(req.id);
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
            ? `Approved ${req.requesterEmail}'s request and unlocked their 2FA controls for a single change.`
            : `Rejected ${req.requesterEmail}'s 2FA change request.`,
      });
    } catch (err) {
      setFeedback({
        tone: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to process 2FA review decision.',
      });
    } finally {
      setReviewingId(null);
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
                Danger Zone &amp; 2FA Governance
              </h1>
              <p className="text-sm text-slate-600 mt-1 max-w-2xl leading-relaxed">
                High-privilege security controls protected by dual-control System Administrator
                approval and immutable audit logging. All changes executed here are permanently
                recorded in the compliance audit trail.
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
      {/* SECTION A — Two-Factor Authentication (2FA) Protection (All Roles)  */}
      {/* =================================================================== */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-slate-600" />
              <span>Section A — Two-Factor Authentication (2FA) Protection</span>
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
          {/* Policy Lock Notice */}
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
              {is2faUnlockedForChange && activeApprovedRequest ? (
                <>
                  <p className="font-semibold text-teal-900">
                    Single-Use 2FA Change Window Active (Approved by{' '}
                    {activeApprovedRequest.reviewedByEmail || 'System Administrator'})
                  </p>
                  <p className="mt-0.5 text-teal-800">
                    Approved action:{' '}
                    <span className="font-semibold">
                      {REQUEST_TYPE_LABELS[activeApprovedRequest.requestType]}
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

          {/* 2FA Controls (Locked by default unless admin unlocked a single-use window) */}
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
              ) : activeApprovedRequest?.requestType === 'DISABLE_2FA' ? (
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
                  disabled={submittingRequest || hasPendingRequest || is2faUnlockedForChange}
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
                  disabled={submittingRequest || hasPendingRequest || is2faUnlockedForChange}
                  placeholder="Explain why you need to configure, reset, or disable 2FA (e.g., new mobile device, initial TOTP binding)..."
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 disabled:bg-slate-50 disabled:text-slate-400 resize-none"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">
                  {hasPendingRequest
                    ? 'You already have a pending request awaiting admin review.'
                    : is2faUnlockedForChange
                      ? 'Complete your active approved change first.'
                      : 'Logged permanently in Audit Trail.'}
                </span>
                <button
                  type="submit"
                  disabled={
                    submittingRequest ||
                    hasPendingRequest ||
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

          {/* Current User's Request History */}
          <div className="border-t border-slate-200 pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Your 2FA Change Request History
            </h3>

            {myRequestsLoading ? (
              <div className="text-xs text-slate-500 py-4">Loading your requests...</div>
            ) : myRequests.length === 0 ? (
              <div className="border border-dashed border-slate-200 rounded-lg px-5 py-6 text-center">
                <Clock className="w-5 h-5 text-slate-400 mx-auto mb-2" />
                <p className="text-xs font-medium text-slate-700">
                  No 2FA change requests submitted yet
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Any approval requests you submit will appear here with real-time review status.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                      <th className="py-2.5 pl-4 pr-3">Submitted (MYT)</th>
                      <th className="py-2.5 px-3">Request Type</th>
                      <th className="py-2.5 px-3">Reason</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 pl-3 pr-4">Reviewed By</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {myRequests.map((req) => {
                      const statusMeta = REQUEST_STATUS_STYLES[req.status];
                      return (
                        <tr key={req.id} className="align-top">
                          <td className="py-3 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                            {formatMytTimestamp(req.createdAt)}
                          </td>
                          <td className="py-3 px-3 font-medium text-slate-900 whitespace-nowrap">
                            {REQUEST_TYPE_LABELS[req.requestType]}
                          </td>
                          <td className="py-3 px-3 text-slate-600 max-w-md break-words">
                            {req.reason}
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            <span className={`font-semibold ${statusMeta.className}`}>
                              {statusMeta.label}
                            </span>
                          </td>
                          <td className="py-3 pl-3 pr-4 text-slate-600 whitespace-nowrap">
                            {req.reviewedByEmail ? (
                              <div>
                                <div className="font-medium text-slate-800">
                                  {req.reviewedByEmail}
                                </div>
                                <div className="font-mono text-[11px] text-slate-400">
                                  {formatMytTimestamp(req.reviewedAt ?? null)}
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* =================================================================== */}
      {/* SECTION B — System Admin 2FA Approval Queue (Administrator ONLY)    */}
      {/* =================================================================== */}
      {isAdmin && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-teal-700" />
                <span>Section B — System Admin 2FA Approval Queue</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Review pending user requests to unlock Two-Factor Authentication for a single
                authorized change.
              </p>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-700 tabular-nums">
              {pendingAdminRequests.length} pending
            </span>
          </div>

          <div className="p-6 space-y-5">
            {adminQueueLoading ? (
              <div className="text-xs text-slate-500 py-4">
                Loading 2FA approval queue...
              </div>
            ) : pendingAdminRequests.length === 0 ? (
              <div className="border border-dashed border-slate-200 rounded-lg px-6 py-10 text-center">
                <CheckCircle2 className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-slate-900">
                  No pending 2FA change requests
                </p>
                <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                  When any user, manager, or administrator submits a 2FA change request, it will
                  appear here in real time for your approval or rejection.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                      <th className="py-2.5 pl-4 pr-3">Requested (MYT)</th>
                      <th className="py-2.5 px-3">Requester</th>
                      <th className="py-2.5 px-3">Action Requested</th>
                      <th className="py-2.5 px-3">Justification</th>
                      <th className="py-2.5 pl-3 pr-4 text-right">Admin Decision</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pendingAdminRequests.map((req) => {
                      const isProcessing = reviewingId === req.id;
                      return (
                        <tr key={req.id} className="align-top">
                          <td className="py-3.5 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                            {formatMytTimestamp(req.createdAt)}
                          </td>
                          <td className="py-3.5 px-3 whitespace-nowrap">
                            <div className="font-medium text-slate-900">
                              {req.requesterEmail}
                            </div>
                            <div className="text-slate-500 capitalize mt-0.5">
                              {req.requesterRole}
                            </div>
                          </td>
                          <td className="py-3.5 px-3 whitespace-nowrap">
                            <div className="font-semibold text-slate-900">
                              {REQUEST_TYPE_LABELS[req.requestType]}
                            </div>
                            <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                              {req.requestType}
                            </div>
                          </td>
                          <td className="py-3.5 px-3 text-slate-600 max-w-md break-words leading-relaxed">
                            {req.reason}
                          </td>
                          <td className="py-3.5 pl-3 pr-4 whitespace-nowrap text-right">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={() => handleAdminReview(req, 'APPROVED')}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>Approve</span>
                              </button>
                              <button
                                type="button"
                                disabled={isProcessing}
                                onClick={() => handleAdminReview(req, 'REJECTED')}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors cursor-pointer"
                              >
                                <XCircle className="w-3.5 h-3.5" />
                                <span>Reject</span>
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

            {reviewedAdminRequests.length > 0 && (
              <div className="pt-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2.5">
                  Recent Governance Decisions ({reviewedAdminRequests.length})
                </h3>
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2 pl-4 pr-3">Reviewed (MYT)</th>
                        <th className="py-2 px-3">Requester</th>
                        <th className="py-2 px-3">Request Type</th>
                        <th className="py-2 px-3">Outcome</th>
                        <th className="py-2 pl-3 pr-4">Reviewer</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {reviewedAdminRequests.slice(0, 10).map((req) => {
                        const statusMeta = REQUEST_STATUS_STYLES[req.status];
                        return (
                          <tr key={req.id}>
                            <td className="py-2.5 pl-4 pr-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                              {formatMytTimestamp(req.reviewedAt ?? req.createdAt)}
                            </td>
                            <td className="py-2.5 px-3 text-slate-800 whitespace-nowrap">
                              {req.requesterEmail}
                            </td>
                            <td className="py-2.5 px-3 text-slate-700 whitespace-nowrap">
                              {REQUEST_TYPE_LABELS[req.requestType]}
                            </td>
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <span className={`font-semibold ${statusMeta.className}`}>
                                {statusMeta.label}
                              </span>
                            </td>
                            <td className="py-2.5 pl-3 pr-4 text-slate-600 whitespace-nowrap">
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
          </div>
        </section>
      )}

      {/* =================================================================== */}
      {/* SECTION C — Critical System Actions (Administrator ONLY)            */}
      {/* =================================================================== */}
      {isAdmin && (
        <section className="bg-white border border-red-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 bg-red-50/60 border-b border-red-200">
            <h2 className="text-sm font-semibold text-red-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600" />
              <span>Section C — Critical System Actions (Administrator Only)</span>
            </h2>
            <p className="text-xs text-red-800/80 mt-0.5">
              Organization-wide security enforcement and irreversible data purge operations.
              Immutable compliance audit logs can never be modified or deleted.
            </p>
          </div>

          <div className="divide-y divide-slate-200">
            {/* C1: Global Mandatory 2FA Policy */}
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

            {/* C2: Permanent Client Record Purge */}
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
