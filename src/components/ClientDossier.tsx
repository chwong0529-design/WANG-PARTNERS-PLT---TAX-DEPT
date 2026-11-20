import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Upload,
  FileText,
  Check,
  Lock,
  Unlock,
  Trash2,
  Send,
  Copy,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  Eye,
  AlertTriangle,
  CheckCircle2,
  FileCheck,
  UserCheck,
  Pencil,
  X,
} from 'lucide-react';
import {
  ALL_STANDARD_DOC_TYPES,
  BLUEPRINT_LIMITS,
  MALAYSIA_DOC_GUIDANCE,
  type AnalyzeDocumentResult,
  type DocumentStatus,
  type DocumentVerificationRecord,
  type FilingCategory,
  type JobStatus,
  type ReminderChannel,
  type ReminderLogRecord,
  type TaxClient,
  type UserProfile,
  type UserRole,
} from '../types/tax';
import {
  analyzeTaxDocumentApi,
  applyAnalyzedDocumentsResult,
  assignClientToStaff,
  computeJobStatusFromChecklist,
  deleteTaxClient,
  determineWorkflowStage,
  dispatchReminder,
  draftReminderApi,
  subscribeToClientHistory,
  toggleClientLock,
  updateClientChecklistItem,
  updateClientChecklistStructure,
  updateClientProfileDetails,
} from '../lib/taxService';
import { submitGovernanceChangeRequest } from '../lib/governanceService';
import { logActivity } from '../lib/auditService';
import { DocumentStatusText, formatMyr, JobStatusText } from './StatusIndicator';
import { GovernanceReasonModal } from './GovernanceReasonModal';

interface ClientDossierProps {
  client: TaxClient;
  userRole: UserRole;
  staffProfiles: UserProfile[];
  portalMode: 'staff' | 'client';
  userEmail: string;
  reminderIntervalDays?: number;
  onBack?: () => void;
  onTogglePortalPreview?: () => void;
  onDeleted?: () => void;
  onGovernanceSubmitted: (message: string) => void;
}

export function ClientDossier({
  client,
  userRole,
  staffProfiles,
  portalMode,
  userEmail,
  reminderIntervalDays = 7,
  onBack,
  onTogglePortalPreview,
  onDeleted,
  onGovernanceSubmitted,
}: ClientDossierProps) {
  const isAdmin = userRole === 'administrator';
  const isStaffView = (userRole === 'administrator' || userRole === 'manager') && portalMode === 'staff';
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [dragging, setDragging] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingProgress, setAnalyzingProgress] = useState<{
    currentFile: string;
    index: number;
    total: number;
  } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [latestAnalysisSummary, setLatestAnalysisSummary] = useState<{
    results: AnalyzeDocumentResult[];
    finalStatus: JobStatus;
    missingDocuments: string[];
  } | null>(null);

  const [verifications, setVerifications] = useState<DocumentVerificationRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderLogRecord[]>([]);

  // Staff checklist & profile management
  const [newDocName, setNewDocName] = useState('');
  const [addingDoc, setAddingDoc] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assigningStaff, setAssigningStaff] = useState(false);

  // Edit profile modal state
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [editName, setEditName] = useState(client.name);
  const [editEmail, setEditEmail] = useState(client.email);
  const [editPhone, setEditPhone] = useState(client.phone);
  const [editTaxYear, setEditTaxYear] = useState(client.taxYear);
  const [editCategory, setEditCategory] = useState<FilingCategory>(client.filingCategory);
  const [savingProfile, setSavingProfile] = useState(false);

  // Pending intercepted governance change for non-admin staff
  const [pendingClientChange, setPendingClientChange] = useState<{
    title: string;
    operation: 'UPDATE' | 'DELETE';
    proposedPayload: Record<string, unknown>;
    previousSummary: string;
  } | null>(null);
  const [submittingGovernance, setSubmittingGovernance] = useState(false);
  const [governanceError, setGovernanceError] = useState<string | null>(null);

  // Reminder composer state (Staff)
  const workflow = determineWorkflowStage(client, reminderIntervalDays);
  const [reminderChannel, setReminderChannel] = useState<ReminderChannel>('Email');
  const [reminderSubject, setReminderSubject] = useState(
    `Action Required: YA ${client.taxYear} Personal Tax Documents (${client.clientId})`
  );
  const [reminderText, setReminderText] = useState(client.latestReminderDraft || '');
  const [draftingReminder, setDraftingReminder] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [reminderFeedback, setReminderFeedback] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setReminderText(client.latestReminderDraft || '');
    setReminderSubject(
      client.jobStatus === 'Book In Can Start'
        ? `Confirmed: YA ${client.taxYear} Personal Tax Documents Complete (${client.clientId})`
        : `Action Required: YA ${client.taxYear} Personal Tax Documents (${client.clientId})`
    );
  }, [client.clientId, client.latestReminderDraft, client.jobStatus, client.taxYear]);

  useEffect(() => {
    const unsub = subscribeToClientHistory(
      client.clientId,
      userRole === 'administrator' || userRole === 'manager',
      userEmail,
      setVerifications,
      setReminders,
      (err) => {
        console.error('History subscription error:', err);
      }
    );
    return () => unsub();
  }, [client.clientId, userRole, userEmail]);

  const pageLabel =
    portalMode === 'client'
      ? `Client Portal (${client.clientId})`
      : `Client Dossier (${client.clientId})`;

  const analyzeUploadedFiles = async (filesToAnalyze: File[]) => {
    if (filesToAnalyze.length === 0) return;
    if (client.isLocked && !isStaffView) {
      setVerifyError('This tax file has been locked by your tax preparer for LHDN computation.');
      return;
    }

    setAnalyzing(true);
    setVerifyError(null);
    const previousStatus = client.jobStatus;
    const completedResults: AnalyzeDocumentResult[] = [];
    const failedMessages: string[] = [];

    try {
      for (let i = 0; i < filesToAnalyze.length; i += 1) {
        const file = filesToAnalyze[i];
        setAnalyzingProgress({
          currentFile: file.name,
          index: i + 1,
          total: filesToAnalyze.length,
        });

        try {
          const analysis = await analyzeTaxDocumentApi(client, file);
          completedResults.push(analysis);

          const outcome =
            analysis.isLegible && analysis.taxYearMatches ? 'Verified' : 'Needs Review';

          void logActivity({
            pageVisited: pageLabel,
            actionTaken: 'UPLOAD_TAX_DOCUMENT',
            details: `Uploaded "${analysis.fileName}" for ${client.clientId} (${client.name}) — Category: ${analysis.documentCategory}, Issuer: ${analysis.merchantOrIssuer || 'Unknown'}, Amount: ${formatMyr(analysis.totalAmountMYR)}, Relief: ${analysis.taxReliefCategory || 'N/A'}, YA ${analysis.taxYear || 'Unknown'} (${outcome}).`,
          });
        } catch (fileErr) {
          failedMessages.push(
            `${file.name}: ${fileErr instanceof Error ? fileErr.message : 'Analysis failed.'}`
          );
        }
      }

      if (completedResults.length > 0) {
        const { finalStatus, missingDocuments } = await applyAnalyzedDocumentsResult(
          client,
          completedResults
        );

        setLatestAnalysisSummary({
          results: completedResults,
          finalStatus,
          missingDocuments,
        });

        const missingSummary =
          missingDocuments.length === 0
            ? '0 missing documents'
            : `${missingDocuments.length} missing (${missingDocuments.join(', ')})`;

        void logActivity({
          pageVisited: pageLabel,
          actionTaken: 'AI_DOCUMENT_VERIFICATION',
          details: `Gemini analyzed ${completedResults.length} document${completedResults.length === 1 ? '' : 's'} for ${client.clientId}: ${missingSummary}. Computed job status: "${finalStatus}".`,
        });

        if (finalStatus !== previousStatus) {
          void logActivity({
            pageVisited: pageLabel,
            actionTaken: 'JOB_STATUS_CHANGE',
            details: `Client ${client.clientId} (${client.name}) job status changed from "${previousStatus}" to "${finalStatus}" after Gemini document analysis.`,
          });
        }
      }

      if (failedMessages.length > 0) {
        setVerifyError(failedMessages.join(' | '));
      }
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Document analysis failed.');
    } finally {
      setAnalyzing(false);
      setAnalyzingProgress(null);
    }
  };

  const handleFilesSelected = (incoming: FileList | File[]) => {
    const MAX_BYTES = 15 * 1024 * 1024;
    const rawList = Array.from(incoming).slice(0, 10);
    const validTypeFiles = rawList.filter(
      (f) =>
        f.type === 'application/pdf' ||
        f.type === 'image/jpeg' ||
        f.type === 'image/png' ||
        f.type === 'image/webp' ||
        /\.(pdf|png|jpe?g|webp)$/i.test(f.name)
    );
    if (validTypeFiles.length === 0) {
      setVerifyError('Please upload PDF, JPEG, PNG, or WebP receipts and tax documents.');
      return;
    }
    const oversized = validTypeFiles.find((f) => f.size > MAX_BYTES);
    if (oversized) {
      setVerifyError(`"${oversized.name}" exceeds the 15MB maximum file size.`);
      return;
    }
    setVerifyError(null);
    void analyzeUploadedFiles(validTypeFiles);
  };

  const handleManualStatusChange = async (idx: number, status: DocumentStatus) => {
    const targetDoc = client.requiredDocuments[idx];
    const previousStatus = client.jobStatus;
    const updates = {
      status,
      taxYearValid: status === 'Verified' ? true : status === 'Invalid' ? false : null,
      notes:
        status === 'Verified'
          ? 'Manually verified by tax staff.'
          : status === 'Invalid'
            ? 'Flagged for re-upload by tax staff.'
            : '',
    };
    const nextDocs = client.requiredDocuments.map((item, i) =>
      i === idx ? { ...item, ...updates } : item
    );
    const nextStatus = computeJobStatusFromChecklist(nextDocs);
    const missingList = nextDocs.filter((d) => d.status !== 'Verified').map((d) => d.docType);
    const nextDraft =
      nextStatus === 'Book In Can Start'
        ? `Dear ${client.name}, all required documents for YA ${client.taxYear} (${client.clientId}) are verified. Your file is now marked Book In Can Start.`
        : nextStatus === 'Pending Document'
          ? `Dear ${client.name}, thank you for your recent submission for YA ${client.taxYear}. We are still missing: ${missingList.join(', ')}.`
          : `Dear ${client.name}, your YA ${client.taxYear} personal tax checklist (${client.clientId}) is ready for upload.`;

    if (!isAdmin) {
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: Checklist & Status Change',
        operation: 'UPDATE',
        proposedPayload: {
          requiredDocuments: nextDocs.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
          jobStatus: nextStatus,
          latestReminderDraft: nextDraft,
        },
        previousSummary: `"${targetDoc?.docType || 'Document'}": ${targetDoc?.status || 'Missing'} -> ${status} | Job Status: ${previousStatus} -> ${nextStatus}`,
      });
      return;
    }

    await updateClientChecklistItem(client, idx, updates);

    void logActivity({
      pageVisited: pageLabel,
      actionTaken: 'JOB_STATUS_CHANGE',
      details: `Updated "${targetDoc?.docType || 'Document'}" to "${status}" for ${client.clientId}. Job status: "${previousStatus}" -> "${nextStatus}".`,
    });
  };

  const handleAddChecklistDoc = async (docType: string) => {
    const clean = docType.trim();
    if (!clean) return;
    if (client.requiredDocuments.length >= BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS) return;
    const previousStatus = client.jobStatus;
    const nextDocs = [
      ...client.requiredDocuments,
      {
        docType: clean,
        status: 'Missing' as const,
        fileName: null,
        fileUrl: null,
        extractedAmount: null,
        taxYearValid: null,
        notes: '',
      },
    ];
    const nextStatus = computeJobStatusFromChecklist(nextDocs);

    if (!isAdmin) {
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: Add Checklist Requirement',
        operation: 'UPDATE',
        proposedPayload: {
          requiredDocuments: nextDocs.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
          jobStatus: nextStatus,
        },
        previousSummary: `Add required document "${clean}" (${client.requiredDocuments.length} -> ${nextDocs.length} items) | Job Status: ${previousStatus} -> ${nextStatus}`,
      });
      setNewDocName('');
      return;
    }

    setAddingDoc(true);
    try {
      await updateClientChecklistStructure(client, nextDocs);
      setNewDocName('');
      if (nextStatus !== previousStatus) {
        void logActivity({
          pageVisited: pageLabel,
          actionTaken: 'JOB_STATUS_CHANGE',
          details: `Added checklist requirement "${clean}" to ${client.clientId}. Job status changed from "${previousStatus}" to "${nextStatus}".`,
        });
      }
    } finally {
      setAddingDoc(false);
    }
  };

  const handleRemoveChecklistDoc = async (idx: number) => {
    const removedDoc = client.requiredDocuments[idx]?.docType || 'Document';
    const previousStatus = client.jobStatus;
    const next = client.requiredDocuments.filter((_, i) => i !== idx);
    const nextStatus = computeJobStatusFromChecklist(next);

    if (!isAdmin) {
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: Remove Checklist Requirement',
        operation: 'UPDATE',
        proposedPayload: {
          requiredDocuments: next.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
          jobStatus: nextStatus,
        },
        previousSummary: `Remove required document "${removedDoc}" (${client.requiredDocuments.length} -> ${next.length} items) | Job Status: ${previousStatus} -> ${nextStatus}`,
      });
      return;
    }

    await updateClientChecklistStructure(client, next);
    if (nextStatus !== previousStatus) {
      void logActivity({
        pageVisited: pageLabel,
        actionTaken: 'JOB_STATUS_CHANGE',
        details: `Removed checklist requirement "${removedDoc}" from ${client.clientId}. Job status changed from "${previousStatus}" to "${nextStatus}".`,
      });
    }
  };

  const handleStaffAssignment = async (staffUid: string) => {
    const previousAssignee = client.assignedTo?.email || 'Unassigned';
    const found = staffUid ? staffProfiles.find((p) => p.uid === staffUid) : null;
    const nextStaff = found
      ? { uid: found.uid, name: found.displayName, email: found.email }
      : null;

    if (!isAdmin) {
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: Duty Assignment',
        operation: 'UPDATE',
        proposedPayload: { assignedTo: nextStaff },
        previousSummary: `Assigned Staff: ${previousAssignee} -> ${nextStaff ? `${nextStaff.name} (${nextStaff.email})` : 'Unassigned'}`,
      });
      return;
    }

    setAssigningStaff(true);
    try {
      await assignClientToStaff(client.clientId, nextStaff);
      void logActivity({
        pageVisited: pageLabel,
        actionTaken: 'ASSIGN_DUTY',
        details: nextStaff
          ? `Assigned client ${client.clientId} (${client.name}) to ${nextStaff.name} (${nextStaff.email}) — previously ${previousAssignee}.`
          : `Unassigned client ${client.clientId} (${client.name}) — previously assigned to ${previousAssignee}.`,
      });
    } catch (err) {
      console.error('Failed to assign staff:', err);
    } finally {
      setAssigningStaff(false);
    }
  };

  const handleToggleLock = async () => {
    const nextLocked = !client.isLocked;
    if (!isAdmin) {
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: File Lock Status',
        operation: 'UPDATE',
        proposedPayload: { isLocked: nextLocked },
        previousSummary: `File Lock: ${client.isLocked ? 'Locked' : 'Unlocked'} -> ${nextLocked ? 'Locked' : 'Unlocked'}`,
      });
      return;
    }

    await toggleClientLock(client, nextLocked);
    void logActivity({
      pageVisited: pageLabel,
      actionTaken: 'TOGGLE_FILE_LOCK',
      details: `${nextLocked ? 'Locked' : 'Unlocked'} tax file ${client.clientId} (${client.name}) for LHDN computation.`,
    });
  };

  const handleOpenEditProfile = () => {
    setEditName(client.name);
    setEditEmail(client.email);
    setEditPhone(client.phone);
    setEditTaxYear(client.taxYear);
    setEditCategory(client.filingCategory);
    setShowEditProfile(true);
  };

  const handleSubmitEditProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const updates = {
      name: editName.trim(),
      email: editEmail.trim().toLowerCase(),
      phone: editPhone.trim(),
      taxYear: editTaxYear,
      filingCategory: editCategory,
    };
    if (!updates.name || !updates.email) return;

    const diffs: string[] = [];
    if (updates.name !== client.name) diffs.push(`Name: "${client.name}" -> "${updates.name}"`);
    if (updates.email !== client.email) diffs.push(`Email: "${client.email}" -> "${updates.email}"`);
    if (updates.phone !== client.phone) diffs.push(`Phone: "${client.phone}" -> "${updates.phone}"`);
    if (updates.taxYear !== client.taxYear) diffs.push(`YA: ${client.taxYear} -> ${updates.taxYear}`);
    if (updates.filingCategory !== client.filingCategory) {
      diffs.push(`Category: ${client.filingCategory} -> ${updates.filingCategory}`);
    }

    if (!isAdmin) {
      setShowEditProfile(false);
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: Edit Client Profile',
        operation: 'UPDATE',
        proposedPayload: updates,
        previousSummary: diffs.length > 0 ? diffs.join(' | ') : 'Update client profile metadata',
      });
      return;
    }

    setSavingProfile(true);
    try {
      await updateClientProfileDetails(client.clientId, updates);
      void logActivity({
        pageVisited: pageLabel,
        actionTaken: 'UPDATE_CLIENT_PROFILE',
        details: `Updated profile for ${client.clientId}: ${diffs.join(' | ') || 'No field changes'}.`,
      });
      setShowEditProfile(false);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleGenerateAiReminder = async () => {
    setDraftingReminder(true);
    setReminderFeedback(null);
    try {
      const draft = await draftReminderApi(client, workflow.stage, workflow.daysSinceReminder);
      setReminderSubject(draft.subject);
      setReminderText(reminderChannel === 'WhatsApp' ? draft.whatsappBody : draft.emailBody);
      setReminderFeedback('Draft refreshed with Gemini 2.5 Flash.');
    } catch (err) {
      setReminderFeedback(err instanceof Error ? err.message : 'Failed to generate draft.');
    } finally {
      setDraftingReminder(false);
    }
  };

  const handleDispatchReminder = async () => {
    if (!reminderText.trim()) return;
    setSendingReminder(true);
    setReminderFeedback(null);
    try {
      await dispatchReminder(client, workflow.stage, reminderChannel, reminderText);
      void logActivity({
        pageVisited: pageLabel,
        actionTaken: 'DISPATCH_REMINDER',
        details: `Dispatched "${workflow.stage}" reminder via ${reminderChannel} to ${client.name} (${client.clientId}, ${client.email}).`,
      });
      setReminderFeedback(
        `Reminder logged (${reminderChannel}) and client reminder timestamp updated.`
      );
    } catch (err) {
      setReminderFeedback(err instanceof Error ? err.message : 'Failed to dispatch reminder.');
    } finally {
      setSendingReminder(false);
    }
  };

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard blocked in some iframe contexts
    }
  };

  const handleDelete = async () => {
    if (!isAdmin) {
      setGovernanceError(null);
      setPendingClientChange({
        title: 'Administrator Approval Required: Delete Client Record',
        operation: 'DELETE',
        proposedPayload: { clientId: client.clientId },
        previousSummary: `Permanently delete client dossier ${client.clientId} (${client.name}, ${client.email}) and nested history.`,
      });
      return;
    }
    await deleteTaxClient(client.clientId);
    void logActivity({
      pageVisited: pageLabel,
      actionTaken: 'DELETE_CLIENT',
      details: `Deleted client tax file ${client.clientId} (${client.name}, ${client.email}).`,
    });
    onDeleted?.();
  };

  const handleConfirmPendingClientChange = async (reason: string) => {
    if (!pendingClientChange) return;
    setSubmittingGovernance(true);
    setGovernanceError(null);
    try {
      await submitGovernanceChangeRequest({
        category: 'CLIENT_DB_CHANGE',
        targetCollection: 'clients',
        targetDocId: client.clientId,
        targetLabel: `${client.clientId} — ${client.name}`,
        operation: pendingClientChange.operation,
        proposedPayload: pendingClientChange.proposedPayload,
        previousSummary: pendingClientChange.previousSummary,
        reason,
        requestedByRole: userRole,
        pageVisited: pageLabel,
      });
      setPendingClientChange(null);
      onGovernanceSubmitted(
        'Submitted to Danger Zone — awaiting System Administrator approval.'
      );
    } catch (err) {
      setGovernanceError(
        err instanceof Error ? err.message : 'Failed to submit change request.'
      );
    } finally {
      setSubmittingGovernance(false);
    }
  };

  const verifiedCount = client.requiredDocuments.filter((d) => d.status === 'Verified').length;
  const totalCount = client.requiredDocuments.length;
  const missingDocs = client.requiredDocuments.filter((d) => d.status !== 'Verified');
  const totalExtractedMyr = client.requiredDocuments.reduce(
    (sum, d) => sum + (d.status === 'Verified' && typeof d.extractedAmount === 'number' ? d.extractedAmount : 0),
    0
  );

  const cleanPhone = client.phone.replace(/[^0-9]/g, '');
  const mailtoHref = `mailto:${encodeURIComponent(client.email)}?subject=${encodeURIComponent(reminderSubject)}&body=${encodeURIComponent(reminderText)}`;
  const whatsappHref = cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(reminderText)}`
    : null;
  const activeStaffList = staffProfiles.filter(
    (p) => p.role === 'administrator' || p.role === 'manager'
  );

  return (
    <div className="space-y-6">
      {/* Dossier Header Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              {isStaffView && onBack && (
                <>
                  <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 font-medium cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>All Clients</span>
                  </button>
                  <span aria-hidden="true">/</span>
                </>
              )}
              <span className="font-mono font-medium text-slate-700">{client.clientId}</span>
              <span aria-hidden="true">·</span>
              <span>{client.filingCategory}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">YA {client.taxYear}</span>
              {client.isLocked && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-slate-700 font-medium">
                    <Lock className="w-3 h-3" />
                    Locked for LHDN Prep
                  </span>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">
                {client.name}
              </h2>
              <JobStatusText status={client.jobStatus} />
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 pt-1">
              <span>
                {client.email}
                {client.phone ? ` · ${client.phone}` : ''}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-slate-700">
                {verifiedCount} of {totalCount} required documents verified
              </span>
              {totalExtractedMyr > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-700">
                    Extracted totals: {formatMyr(totalExtractedMyr)}
                  </span>
                </>
              )}
            </div>

            {isStaffView && (
              <div className="pt-2 flex items-center gap-2 text-xs">
                <span className="font-medium text-slate-700 flex items-center gap-1">
                  <UserCheck className="w-3.5 h-3.5 text-teal-700" />
                  <span>Assigned Staff:</span>
                </span>
                <select
                  value={client.assignedTo?.uid || ''}
                  disabled={assigningStaff}
                  onChange={(e) => handleStaffAssignment(e.target.value)}
                  className="px-2.5 py-1 text-xs font-medium bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 cursor-pointer"
                >
                  <option value="">Unassigned</option>
                  {activeStaffList.map((st) => (
                    <option key={st.uid} value={st.uid}>
                      {st.displayName} ({st.role})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {userRole !== 'user' && onTogglePortalPreview && (
              <button
                type="button"
                onClick={onTogglePortalPreview}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>
                  {portalMode === 'staff' ? 'Preview Client Portal' : 'Return to Staff View'}
                </span>
              </button>
            )}

            {isStaffView && (
              <>
                <button
                  type="button"
                  onClick={handleOpenEditProfile}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  <span>Edit Profile</span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleLock}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {client.isLocked ? (
                    <>
                      <Unlock className="w-3.5 h-3.5" />
                      <span>Unlock File</span>
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5" />
                      <span>Lock for Tax Prep</span>
                    </>
                  )}
                </button>

                {isAdmin ? (
                  <>
                    {!confirmDelete ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-700 bg-white border border-slate-200 rounded-lg hover:bg-red-50 hover:border-red-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-red-50 border border-red-200 rounded-lg text-xs">
                        <span className="text-red-800 font-medium">Confirm delete?</span>
                        <button
                          type="button"
                          onClick={handleDelete}
                          className="px-2 py-0.5 text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer"
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(false)}
                          className="px-2 py-0.5 text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 cursor-pointer"
                        >
                          No
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-700 bg-white border border-slate-200 rounded-lg hover:bg-red-50 hover:border-red-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Request Delete</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Client Portal Preview Notice */}
        {portalMode === 'client' && userRole !== 'user' && (
          <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-teal-800 flex items-center justify-between gap-4">
            <span>
              Viewing the simplified taxpayer upload portal for {client.name}. Uploads here run live Gemini 3.8 Flash document extraction and update Firestore immediately.
            </span>
          </div>
        )}
      </div>

      {/* Main 12-Col Workspace Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left 7 Columns: Checklist + AI Verification Uploader */}
        <div className="xl:col-span-7 space-y-6">
          {/* Required Document Checklist Table */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Required Document Checklist (YA {client.taxYear})
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {missingDocs.length === 0
                    ? 'Every required Malaysia LHDN document is verified. Ready for tax computation.'
                    : `${missingDocs.length} document${missingDocs.length === 1 ? '' : 's'} still outstanding before book-in can start.`}
                </p>
              </div>
              <span className="font-mono text-xs font-medium text-slate-700 tabular-nums whitespace-nowrap">
                {verifiedCount} / {totalCount} verified
              </span>
            </div>

            <div className="divide-y divide-slate-100">
              {client.requiredDocuments.map((docItem, idx) => {
                const guidance = MALAYSIA_DOC_GUIDANCE[docItem.docType];
                const hasExtractedMeta = Boolean(
                  docItem.documentCategory ||
                    docItem.merchantOrIssuer ||
                    docItem.receiptDate ||
                    docItem.detectedTaxYear ||
                    docItem.taxReliefCategory
                );

                return (
                  <div
                    key={`${docItem.docType}-${idx}`}
                    className="px-5 py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4"
                  >
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm font-medium text-slate-900">
                          {docItem.docType}
                        </span>
                        <DocumentStatusText status={docItem.status} />
                        {docItem.detectedTaxYear ? (
                          <span
                            className={`font-mono text-[11px] font-medium tabular-nums ${
                              docItem.taxYearValid === false
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            YA {docItem.detectedTaxYear}
                            {docItem.taxYearValid === false ? ' (Mismatch)' : ' (Matched)'}
                          </span>
                        ) : docItem.taxYearValid === false ? (
                          <span className="font-mono text-[11px] font-medium text-amber-700">
                            YA Mismatch
                          </span>
                        ) : null}
                      </div>

                      {docItem.fileName ? (
                        <div className="space-y-1">
                          <div className="text-xs text-slate-600 flex flex-wrap items-center gap-2 font-mono">
                            <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="truncate max-w-xs">{docItem.fileName}</span>
                            {docItem.extractedAmount !== null && (
                              <>
                                <span className="text-slate-300" aria-hidden="true">·</span>
                                <span className="font-semibold text-slate-900 tabular-nums">
                                  {formatMyr(docItem.extractedAmount)}
                                </span>
                              </>
                            )}
                          </div>

                          {hasExtractedMeta && (
                            <div className="text-xs text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1">
                              {docItem.documentCategory && (
                                <span className="font-medium text-slate-800">
                                  {docItem.documentCategory}
                                </span>
                              )}
                              {docItem.merchantOrIssuer && (
                                <>
                                  <span className="text-slate-300" aria-hidden="true">·</span>
                                  <span>Issuer: {docItem.merchantOrIssuer}</span>
                                </>
                              )}
                              {docItem.receiptDate && (
                                <>
                                  <span className="text-slate-300" aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">
                                    Date: {docItem.receiptDate}
                                  </span>
                                </>
                              )}
                              {docItem.taxReliefCategory && (
                                <>
                                  <span className="text-slate-300" aria-hidden="true">·</span>
                                  <span className="text-teal-800 font-medium">
                                    LHDN Relief: {docItem.taxReliefCategory}
                                  </span>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        guidance && (
                          <p className="text-xs text-slate-500 leading-relaxed max-w-xl">
                            {guidance}
                          </p>
                        )
                      )}

                      {docItem.notes && (
                        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200/80 rounded-md px-3 py-1.5 mt-1">
                          {docItem.notes}
                        </p>
                      )}
                    </div>

                    {isStaffView && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        {docItem.status !== 'Verified' ? (
                          <button
                            type="button"
                            onClick={() => handleManualStatusChange(idx, 'Verified')}
                            title="Mark as verified"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-800 bg-white border border-slate-200 rounded-md hover:bg-emerald-50 hover:border-emerald-200 transition-colors cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Verify</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleManualStatusChange(idx, 'Missing')}
                            title="Reset to missing"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors cursor-pointer"
                          >
                            <span>Reset</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveChecklistDoc(idx)}
                          title="Remove checklist requirement"
                          className="p-1.5 text-slate-400 hover:text-red-700 rounded-md hover:bg-slate-50 transition-colors cursor-pointer"
                          aria-label={`Remove ${docItem.docType}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Staff Quick-Add Document Requirement */}
            {isStaffView &&
              client.requiredDocuments.length < BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS && (
                <div className="px-5 py-3.5 bg-slate-50/70 border-t border-slate-200 flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={newDocName}
                    onChange={(e) => setNewDocName(e.target.value)}
                    list="standard-malaysia-tax-docs"
                    placeholder="Add required document (e.g. Zakat / Approved Donation Receipt)"
                    className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  />
                  <datalist id="standard-malaysia-tax-docs">
                    {ALL_STANDARD_DOC_TYPES.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    disabled={addingDoc || !newDocName.trim()}
                    onClick={() => handleAddChecklistDoc(newDocName)}
                    className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Requirement</span>
                  </button>
                </div>
              )}
          </section>

          {/* AI Multimodal Document Upload & Gemini 3.8 Flash Reader */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Upload &amp; Analyze Tax Documents
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Upload PDFs or receipt images (max 15MB). Gemini 3.8 Flash reads each document, extracts issuer, date, MYR amount, and LHDN relief category, verifies YA {client.taxYear}, and updates the checklist automatically.
                </p>
              </div>
            </div>

            {client.isLocked && !isStaffView ? (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-slate-500 shrink-0" />
                <span>
                  This file is locked for LHDN computation. Contact your tax preparer if you need to submit an amendment.
                </span>
              </div>
            ) : (
              <>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!analyzing) setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    if (!analyzing && e.dataTransfer.files) {
                      handleFilesSelected(e.dataTransfer.files);
                    }
                  }}
                  onClick={() => {
                    if (!analyzing) fileInputRef.current?.click();
                  }}
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                    analyzing
                      ? 'border-teal-400 bg-teal-50/40 cursor-wait'
                      : dragging
                        ? 'border-teal-600 bg-teal-50/40 cursor-pointer'
                        : 'border-slate-300 hover:border-slate-400 bg-slate-50/50 cursor-pointer'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    disabled={analyzing}
                    accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"
                    onChange={(e) => {
                      if (e.target.files) handleFilesSelected(e.target.files);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  {analyzing ? (
                    <div className="space-y-2">
                      <RefreshCw className="w-6 h-6 text-teal-700 mx-auto animate-spin" />
                      <p className="text-sm font-semibold text-teal-900">
                        Analyzing with Gemini 3.8 Flash...
                      </p>
                      {analyzingProgress && (
                        <p className="text-xs text-teal-800 font-mono">
                          Reading file {analyzingProgress.index} of {analyzingProgress.total}:{' '}
                          {analyzingProgress.currentFile}
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2.5" />
                      <p className="text-sm font-medium text-slate-800">
                        Drop tax PDFs or receipt scans here, or click to browse
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Auto-analyzes EA Form, EPF/KWSP, CP58, Medical, Lifestyle, Insurance, Zakat &amp; Dividend Vouchers (PDF, JPEG, PNG, WebP · max 15MB)
                      </p>
                    </>
                  )}
                </div>

                {verifyError && (
                  <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{verifyError}</span>
                  </div>
                )}

                {/* Latest Gemini Structured Extraction Output */}
                {latestAnalysisSummary && (
                  <div className="border border-teal-200 bg-teal-50/40 rounded-xl p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <FileCheck className="w-4 h-4 text-teal-700" />
                        <span>Latest Gemini Extraction Summary</span>
                      </div>
                      <JobStatusText status={latestAnalysisSummary.finalStatus} />
                    </div>

                    <div className="divide-y divide-teal-200/60 border-t border-b border-teal-200/60">
                      {latestAnalysisSummary.results.map((item, i) => {
                        const verified = item.isLegible && item.taxYearMatches;
                        return (
                          <div key={`${item.fileName}-${i}`} className="py-3 text-xs space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-mono font-medium text-slate-900">
                                {item.fileName}
                              </span>
                              <span
                                className={
                                  verified
                                    ? 'font-semibold text-emerald-700'
                                    : 'font-semibold text-amber-700'
                                }
                              >
                                {verified ? 'Verified' : 'Needs Review'}
                                {' · '}
                                {item.taxYear > 0
                                  ? `YA ${item.taxYear}${item.taxYearMatches ? '' : ' (Mismatch)'}`
                                  : 'YA Not Found'}
                              </span>
                            </div>

                            <div className="text-slate-700 flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-medium text-slate-900">
                                {item.documentCategory}
                              </span>
                              {item.merchantOrIssuer && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>Issuer: {item.merchantOrIssuer}</span>
                                </>
                              )}
                              {item.receiptDate && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums">
                                    {item.receiptDate}
                                  </span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                {formatMyr(item.totalAmountMYR)}
                              </span>
                              {item.taxReliefCategory && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-teal-800 font-medium">
                                    LHDN: {item.taxReliefCategory}
                                  </span>
                                </>
                              )}
                            </div>

                            {item.matchedChecklistItem ? (
                              <p className="text-slate-600">
                                Matched checklist item:{' '}
                                <span className="font-medium text-slate-900">
                                  {item.matchedChecklistItem}
                                </span>
                              </p>
                            ) : (
                              <p className="text-amber-700">
                                No matching item in this client&apos;s current required checklist.
                              </p>
                            )}

                            {item.confidenceNotes && (
                              <p className="text-slate-600">{item.confidenceNotes}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {latestAnalysisSummary.missingDocuments.length > 0 ? (
                      <div className="text-xs text-slate-700">
                        <span className="font-semibold text-slate-900">Still missing: </span>
                        <span>{latestAnalysisSummary.missingDocuments.join(', ')}</span>
                      </div>
                    ) : (
                      <div className="text-xs font-medium text-emerald-800 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        <span>
                          Zero missing documents remaining. Job status automatically updated to Book In Can Start.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        {/* Right 5 Columns: Automated Follow-Up Composer (Staff) + Real-Time History */}
        <div className="xl:col-span-5 space-y-6">
          {isStaffView && (
            <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Automated Reminder Composer
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Stage: <span className="font-medium text-slate-800">{workflow.stage}</span>
                    {' · '}
                    {workflow.summary}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleGenerateAiReminder}
                  disabled={draftingReminder}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-teal-800 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${draftingReminder ? 'animate-spin' : ''}`} />
                  <span>{draftingReminder ? 'Drafting...' : 'AI Redraft'}</span>
                </button>
              </div>

              {/* Channel Selector */}
              <div className="inline-flex items-center p-1 bg-slate-100 rounded-lg">
                {(['Email', 'WhatsApp', 'Portal'] as ReminderChannel[]).map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => setReminderChannel(ch)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      reminderChannel === ch
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {ch}
                  </button>
                ))}
              </div>

              {reminderChannel === 'Email' && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Email Subject
                  </label>
                  <input
                    type="text"
                    value={reminderSubject}
                    onChange={(e) => setReminderSubject(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Itemized Client Message
                </label>
                <textarea
                  rows={5}
                  value={reminderText}
                  onChange={(e) => setReminderText(e.target.value)}
                  maxLength={BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX}
                  className="w-full px-3 py-2 text-xs leading-relaxed bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                />
              </div>

              {reminderFeedback && (
                <p className="text-xs text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                  {reminderFeedback}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleDispatchReminder}
                  disabled={sendingReminder || !reminderText.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{sendingReminder ? 'Logging...' : `Log & Dispatch ${reminderChannel}`}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleCopy(reminderText, 'msg')}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedKey === 'msg' ? 'Copied' : 'Copy Text'}</span>
                </button>

                <a
                  href={mailtoHref}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  <Mail className="w-3.5 h-3.5" />
                  <span>Open Email</span>
                </a>

                {whatsappHref && (
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>WhatsApp</span>
                  </a>
                )}
              </div>
            </section>
          )}

          {/* Real-Time AI Verification Log */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                AI Verification History
              </h3>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {verifications.length} run{verifications.length === 1 ? '' : 's'}
              </span>
            </div>

            {verifications.length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-500">
                No AI document verification runs recorded yet for this client.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {verifications.map((v) => (
                  <div key={v.id} className="px-5 py-3.5 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <JobStatusText status={v.recommendedJobStatus} />
                      <span className="font-mono text-slate-400 tabular-nums">
                        {v.createdAt
                          ? v.createdAt.toDate().toLocaleString('en-MY', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : 'Just now'}
                      </span>
                    </div>
                    <p className="text-slate-600">
                      Detected {v.detectedDocuments.length} file
                      {v.detectedDocuments.length === 1 ? '' : 's'}
                      {' · '}
                      {v.missingDocuments.length === 0
                        ? '0 missing'
                        : `${v.missingDocuments.length} missing (${v.missingDocuments.join(', ')})`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Dispatched Reminder Log */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Reminder &amp; Outreach Log
              </h3>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {reminders.length} sent
              </span>
            </div>

            {reminders.length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-500">
                No reminders have been logged yet for {client.name}.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {reminders.map((r) => (
                  <div key={r.id} className="px-5 py-3.5 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">
                        {r.stage} · {r.channel}
                      </span>
                      <span className="font-mono text-slate-400 tabular-nums">
                        {r.createdAt
                          ? r.createdAt.toDate().toLocaleString('en-MY', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : 'Just now'}
                      </span>
                    </div>
                    <p className="text-slate-600 leading-relaxed whitespace-pre-line">
                      {r.message}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Edit Client Profile Modal */}
      {showEditProfile && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-profile-modal-title"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 id="edit-profile-modal-title" className="text-sm font-semibold text-slate-900">
                Edit Client Profile ({client.clientId})
              </h3>
              <button
                type="button"
                onClick={() => setShowEditProfile(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
                aria-label="Close edit profile modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSubmitEditProfile} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Taxpayer Full Name
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={BLUEPRINT_LIMITS.NAME_MAX}
                  required
                  className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    maxLength={BLUEPRINT_LIMITS.EMAIL_MAX}
                    required
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Phone / WhatsApp
                  </label>
                  <input
                    type="tel"
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Year of Assessment (YA)
                  </label>
                  <select
                    value={editTaxYear}
                    onChange={(e) => setEditTaxYear(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  >
                    {[2027, 2026, 2025, 2024, 2023].map((yr) => (
                      <option key={yr} value={yr}>
                        YA {yr}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Filing Category
                  </label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as FilingCategory)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
                  >
                    <option value="Form BE (Salaried)">Form BE (Salaried)</option>
                    <option value="Form B (Business / Commission)">
                      Form B (Business / Commission)
                    </option>
                    <option value="Form M (Non-Resident)">Form M (Non-Resident)</option>
                  </select>
                </div>
              </div>
              <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowEditProfile(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 cursor-pointer"
                >
                  {savingProfile
                    ? 'Saving...'
                    : isAdmin
                      ? 'Save Profile'
                      : 'Request Profile Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pendingClientChange && (
        <GovernanceReasonModal
          title={pendingClientChange.title}
          description="Client database modifications by non-administrator accounts require System Administrator approval. Provide a justification to stage this CLIENT_DB_CHANGE request in the Danger Zone."
          targetLabel={`${client.clientId} — ${client.name}`}
          previousSummary={pendingClientChange.previousSummary}
          confirmLabel="Submit to Danger Zone"
          submitting={submittingGovernance}
          error={governanceError}
          onCancel={() => {
            setPendingClientChange(null);
            setGovernanceError(null);
          }}
          onConfirm={handleConfirmPendingClientChange}
        />
      )}
    </div>
  );
}
