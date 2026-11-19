import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Upload,
  FileText,
  Sparkles,
  Check,
  X,
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
} from 'lucide-react';
import {
  ALL_STANDARD_DOC_TYPES,
  BLUEPRINT_LIMITS,
  MALAYSIA_DOC_GUIDANCE,
  type DocumentStatus,
  type DocumentVerificationRecord,
  type ReminderChannel,
  type ReminderLogRecord,
  type TaxClient,
  type VerificationApiResponse,
} from '../types/tax';
import {
  applyAiVerificationResult,
  deleteTaxClient,
  determineWorkflowStage,
  dispatchReminder,
  draftReminderApi,
  generateSampleTaxDocumentFile,
  subscribeToClientHistory,
  toggleClientLock,
  updateClientChecklistItem,
  updateClientChecklistStructure,
  verifyTaxDocumentsApi,
  type SampleSpecimenKind,
} from '../lib/taxService';
import { DocumentStatusText, formatMyr, JobStatusText } from './StatusIndicator';

interface ClientDossierProps {
  client: TaxClient;
  isAdmin: boolean;
  portalMode: 'staff' | 'client';
  userEmail: string;
  onBack?: () => void;
  onTogglePortalPreview?: () => void;
  onDeleted?: () => void;
}

export function ClientDossier({
  client,
  isAdmin,
  portalMode,
  userEmail,
  onBack,
  onTogglePortalPreview,
  onDeleted,
}: ClientDossierProps) {
  const isStaffView = isAdmin && portalMode === 'staff';
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [lastAiResult, setLastAiResult] = useState<VerificationApiResponse | null>(null);

  const [verifications, setVerifications] = useState<DocumentVerificationRecord[]>([]);
  const [reminders, setReminders] = useState<ReminderLogRecord[]>([]);

  // Staff checklist management
  const [newDocName, setNewDocName] = useState('');
  const [addingDoc, setAddingDoc] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reminder composer state (Staff)
  const workflow = determineWorkflowStage(client);
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
      isAdmin,
      userEmail,
      setVerifications,
      setReminders,
      (err) => {
        console.error('History subscription error:', err);
      }
    );
    return () => unsub();
  }, [client.clientId, isAdmin, userEmail]);

  const handleFilesSelected = (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter(
      (f) =>
        f.type.startsWith('image/') ||
        f.type === 'application/pdf' ||
        /\.(pdf|png|jpe?g|webp)$/i.test(f.name)
    );
    if (accepted.length === 0) {
      setVerifyError('Please select PDF, PNG, JPG, or WebP tax documents.');
      return;
    }
    setVerifyError(null);
    setStagedFiles((prev) => [...prev, ...accepted].slice(0, 10));
  };

  const handleAttachSample = async (kind: SampleSpecimenKind) => {
    setVerifyError(null);
    try {
      const sampleFile = await generateSampleTaxDocumentFile(kind, client.name, client.taxYear);
      setStagedFiles((prev) => [...prev, sampleFile].slice(0, 10));
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Could not create sample specimen.');
    }
  };

  const handleRunVerification = async () => {
    if (stagedFiles.length === 0) return;
    if (client.isLocked && !isStaffView) {
      setVerifyError('This tax file has been locked by your tax preparer for LHDN computation.');
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      const result = await verifyTaxDocumentsApi(client, stagedFiles);
      setLastAiResult(result);
      await applyAiVerificationResult(client, result);
      setStagedFiles([]);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Document verification failed.');
    } finally {
      setVerifying(false);
    }
  };

  const handleManualStatusChange = async (idx: number, status: DocumentStatus) => {
    await updateClientChecklistItem(client, idx, {
      status,
      taxYearValid: status === 'Verified' ? true : status === 'Invalid' ? false : null,
      notes:
        status === 'Verified'
          ? 'Manually verified by tax staff.'
          : status === 'Invalid'
            ? 'Flagged for re-upload by tax staff.'
            : '',
    });
  };

  const handleAddChecklistDoc = async (docType: string) => {
    const clean = docType.trim();
    if (!clean) return;
    if (client.requiredDocuments.length >= BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS) return;
    setAddingDoc(true);
    try {
      await updateClientChecklistStructure(client, [
        ...client.requiredDocuments,
        {
          docType: clean,
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
      ]);
      setNewDocName('');
    } finally {
      setAddingDoc(false);
    }
  };

  const handleRemoveChecklistDoc = async (idx: number) => {
    const next = client.requiredDocuments.filter((_, i) => i !== idx);
    await updateClientChecklistStructure(client, next);
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
    await deleteTaxClient(client.clientId);
    onDeleted?.();
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

            <p className="text-xs text-slate-500">
              {client.email}
              {client.phone ? ` · ${client.phone}` : ''}
              {' · '}
              <span className="font-mono tabular-nums text-slate-700">
                {verifiedCount} of {totalCount} required documents verified
              </span>
              {totalExtractedMyr > 0 && (
                <>
                  {' · '}
                  <span className="font-mono tabular-nums text-slate-700">
                    Extracted totals: {formatMyr(totalExtractedMyr)}
                  </span>
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {isAdmin && onTogglePortalPreview && (
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
                  onClick={() => toggleClientLock(client, !client.isLocked)}
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
            )}
          </div>
        </div>

        {/* Client Portal Preview Notice */}
        {portalMode === 'client' && isAdmin && (
          <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-teal-800 flex items-center justify-between gap-4">
            <span>
              Viewing the simplified taxpayer upload portal for {client.name}. Uploads here run live Gemini 2.5 Flash verification and update Firestore immediately.
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
                return (
                  <div
                    key={`${docItem.docType}-${idx}`}
                    className="px-5 py-4 flex flex-col sm:flex-row sm:items-start justify-between gap-4"
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm font-medium text-slate-900">
                          {docItem.docType}
                        </span>
                        <DocumentStatusText status={docItem.status} />
                      </div>

                      {docItem.fileName ? (
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
                          {docItem.taxYearValid === false && (
                            <>
                              <span className="text-slate-300" aria-hidden="true">·</span>
                              <span className="text-amber-700 font-sans font-medium">
                                Wrong tax year detected
                              </span>
                            </>
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
                        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200/80 rounded-md px-3 py-1.5 mt-1.5">
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

          {/* AI Multimodal Document Upload & Gemini 2.5 Flash Verification Engine */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Upload &amp; Verify Tax Documents
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Attach PDFs or scanned photos. Gemini 2.5 Flash classifies each form, verifies YA {client.taxYear}, and updates your checklist automatically.
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
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    if (e.dataTransfer.files) handleFilesSelected(e.dataTransfer.files);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
                    dragging
                      ? 'border-teal-600 bg-teal-50/40'
                      : 'border-slate-300 hover:border-slate-400 bg-slate-50/50'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".pdf,image/png,image/jpeg,image/webp"
                    onChange={(e) => {
                      if (e.target.files) handleFilesSelected(e.target.files);
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                  <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2.5" />
                  <p className="text-sm font-medium text-slate-800">
                    Drop tax PDFs or receipt scans here, or click to browse
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Supports EA Form, EPF/KWSP Statement, CP58, Zakat, Medical &amp; Dividend Vouchers (PDF, PNG, JPG · up to 10 files)
                  </p>
                </div>

                {/* Quick Specimen Attachment for Live Multimodal Testing */}
                <div className="pt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                  <span className="text-slate-500 font-medium">
                    Test with sample Malaysia forms:
                  </span>
                  {(
                    [
                      ['ea_2026', `EA Form YA ${client.taxYear}`],
                      ['epf_2026', `EPF/KWSP ${client.taxYear}`],
                      ['medical_2026', `Medical Receipt ${client.taxYear}`],
                      ['cp58_2026', `CP58 ${client.taxYear}`],
                      ['zakat_2026', `Zakat Receipt ${client.taxYear}`],
                      ['ea_wrong_year_2024', 'Old 2024 EA Form (Mismatch Test)'],
                    ] as Array<[SampleSpecimenKind, string]>
                  ).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => handleAttachSample(kind)}
                      className="text-teal-700 hover:text-teal-950 underline underline-offset-2 cursor-pointer"
                    >
                      + {label}
                    </button>
                  ))}
                </div>

                {/* Staged Files List */}
                {stagedFiles.length > 0 && (
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                    {stagedFiles.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-4 h-4 text-teal-700 shrink-0" />
                          <span className="font-medium text-slate-800 truncate">{file.name}</span>
                          <span className="text-slate-400 font-mono tabular-nums shrink-0">
                            {(file.size / 1024).toFixed(0)} KB
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setStagedFiles((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="p-1 text-slate-400 hover:text-red-700 cursor-pointer"
                          aria-label={`Remove ${file.name}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    <div className="px-3.5 py-3 bg-slate-50 flex items-center justify-between gap-4">
                      <span className="text-xs text-slate-600">
                        {stagedFiles.length} file{stagedFiles.length === 1 ? '' : 's'} ready for Gemini 2.5 Flash verification
                      </span>
                      <button
                        type="button"
                        onClick={handleRunVerification}
                        disabled={verifying}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {verifying ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Inspecting Documents...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>Run AI Document Verification</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {verifyError && (
                  <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{verifyError}</span>
                  </div>
                )}

                {/* Latest Gemini Structured Verification Output */}
                {lastAiResult && (
                  <div className="border border-teal-200 bg-teal-50/40 rounded-xl p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <FileCheck className="w-4 h-4 text-teal-700" />
                        <span>Latest AI Verification Summary</span>
                      </div>
                      <JobStatusText status={lastAiResult.recommendedJobStatus} />
                    </div>

                    <div className="divide-y divide-teal-200/60 border-t border-b border-teal-200/60">
                      {lastAiResult.detectedDocuments.map((det, i) => (
                        <div key={`${det.fileName}-${i}`} className="py-2.5 text-xs space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono font-medium text-slate-900">
                              {det.fileName}
                            </span>
                            <span
                              className={
                                det.taxYearValid
                                  ? 'font-medium text-emerald-700'
                                  : 'font-medium text-amber-700'
                              }
                            >
                              {det.taxYearValid
                                ? `YA ${client.taxYear} Verified`
                                : `Tax Year Mismatch / Invalid`}
                            </span>
                          </div>
                          <div className="text-slate-700 flex flex-wrap items-center gap-2">
                            <span>Detected: {det.documentCategory}</span>
                            {typeof det.extractedAmount === 'number' && det.extractedAmount > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono font-medium tabular-nums">
                                  {formatMyr(det.extractedAmount)}
                                </span>
                              </>
                            )}
                          </div>
                          {det.notes && <p className="text-slate-600">{det.notes}</p>}
                        </div>
                      ))}
                    </div>

                    {lastAiResult.missingDocuments.length > 0 ? (
                      <div className="text-xs text-slate-700">
                        <span className="font-semibold text-slate-900">Still missing: </span>
                        <span>{lastAiResult.missingDocuments.join(', ')}</span>
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
    </div>
  );
}
