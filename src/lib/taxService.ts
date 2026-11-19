import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  BOOTSTRAPPED_ADMIN_EMAIL,
  db,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  BLUEPRINT_LIMITS,
  type DocumentVerificationRecord,
  type FilingCategory,
  type JobStatus,
  type ReminderChannel,
  type ReminderDraftResponse,
  type ReminderLogRecord,
  type ReminderStage,
  type RequiredDocumentItem,
  type TaxClient,
  type VerificationApiResponse,
} from '../types/tax';

function clampString(value: string, maxLen: number): string {
  return value.trim().slice(0, maxLen);
}

export function sanitizeClientId(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, BLUEPRINT_LIMITS.CLIENT_ID_MAX);
  return cleaned.length >= BLUEPRINT_LIMITS.CLIENT_ID_MIN
    ? cleaned
    : `TAX-2026-${Math.floor(100 + Math.random() * 900)}`;
}

export function computeJobStatusFromChecklist(
  docs: RequiredDocumentItem[]
): JobStatus {
  if (docs.length === 0) return 'No Book In';
  const verifiedCount = docs.filter((d) => d.status === 'Verified').length;
  const uploadedCount = docs.filter(
    (d) => d.status === 'Verified' || d.status === 'Invalid' || Boolean(d.fileName)
  ).length;
  if (uploadedCount === 0) return 'No Book In';
  if (verifiedCount === docs.length) return 'Book In Can Start';
  return 'Pending Document';
}

export function getDaysSince(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.now() - ts.toMillis();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function determineWorkflowStage(client: TaxClient): {
  stage: ReminderStage;
  isEscalated: boolean;
  daysSinceReminder: number | null;
  summary: string;
} {
  const days = getDaysSince(client.lastReminderSent);
  if (client.jobStatus === 'Book In Can Start') {
    return {
      stage: 'Ready for Tax Prep',
      isEscalated: false,
      daysSinceReminder: days,
      summary: 'Checklist complete — ready for LHDN computation.',
    };
  }
  if (client.jobStatus === 'Pending Document') {
    const missingCount = client.requiredDocuments.filter((d) => d.status !== 'Verified').length;
    return {
      stage: 'Missing Doc Alert',
      isEscalated: days !== null && days >= 7,
      daysSinceReminder: days,
      summary: `${missingCount} required document${missingCount === 1 ? '' : 's'} still pending verification.`,
    };
  }
  // No Book In
  if (client.reminderCount === 0 || !client.lastReminderSent) {
    return {
      stage: 'Initial Outreach',
      isEscalated: false,
      daysSinceReminder: null,
      summary: 'Awaiting initial tax season invitation with client checklist.',
    };
  }
  const escalated = (days ?? 0) >= 7;
  return {
    stage: '7-Day Follow-up',
    isEscalated: escalated,
    daysSinceReminder: days,
    summary: escalated
      ? `No uploads after ${days} days — overdue for 7-day follow-up.`
      : `Invited ${days} day${days === 1 ? '' : 's'} ago — awaiting first upload.`,
  };
}

export async function checkIsAdmin(uid: string, email: string | null): Promise<boolean> {
  if (email && email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()) {
    return true;
  }
  const path = `admins/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'admins', uid));
    return snap.exists();
  } catch {
    return false;
  }
}

export function subscribeToClients(
  isAdmin: boolean,
  uid: string,
  email: string,
  onData: (clients: TaxClient[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const clientsRef = collection(db, 'clients');
  const q = isAdmin
    ? query(clientsRef, orderBy('updatedAt', 'desc'))
    : query(clientsRef, where('email', '==', email.toLowerCase()));

  return onSnapshot(
    q,
    (snapshot) => {
      const list: TaxClient[] = snapshot.docs.map((d) => d.data() as TaxClient);
      list.sort((a, b) => {
        const aMs = a.updatedAt?.toMillis?.() ?? 0;
        const bMs = b.updatedAt?.toMillis?.() ?? 0;
        return bMs - aMs;
      });
      onData(list);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'clients');
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
}

export function subscribeToClientHistory(
  clientId: string,
  isAdmin: boolean,
  email: string,
  onVerifications: (items: DocumentVerificationRecord[]) => void,
  onReminders: (items: ReminderLogRecord[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const verifPath = `clients/${clientId}/verifications`;
  const remPath = `clients/${clientId}/reminders`;

  const verifQuery = isAdmin
    ? query(collection(db, verifPath), orderBy('createdAt', 'desc'))
    : query(collection(db, verifPath), where('clientEmail', '==', email.toLowerCase()));

  const remQuery = isAdmin
    ? query(collection(db, remPath), orderBy('createdAt', 'desc'))
    : query(collection(db, remPath), where('clientEmail', '==', email.toLowerCase()));

  const unsubVerif = onSnapshot(
    verifQuery,
    (snap) => {
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<DocumentVerificationRecord, 'id'>),
      }));
      items.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      onVerifications(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, verifPath);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );

  const unsubRem = onSnapshot(
    remQuery,
    (snap) => {
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ReminderLogRecord, 'id'>),
      }));
      items.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      onReminders(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, remPath);
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );

  return () => {
    unsubVerif();
    unsubRem();
  };
}

export interface CreateClientInput {
  clientId: string;
  name: string;
  email: string;
  phone: string;
  taxYear: number;
  filingCategory: FilingCategory;
  docTypes: string[];
}

export async function createTaxClient(input: CreateClientInput): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to create a tax file.');

  const clientId = sanitizeClientId(input.clientId);
  const path = `clients/${clientId}`;
  const requiredDocuments: RequiredDocumentItem[] = input.docTypes
    .map((t) => clampString(t, 120))
    .filter(Boolean)
    .slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS)
    .map((docType) => ({
      docType,
      status: 'Missing',
      fileName: null,
      fileUrl: null,
      extractedAmount: null,
      taxYearValid: null,
      notes: '',
    }));

  const normalizedEmail = clampString(input.email.toLowerCase(), BLUEPRINT_LIMITS.EMAIL_MAX);
  const taxYear = Math.min(
    BLUEPRINT_LIMITS.TAX_YEAR_MAX,
    Math.max(BLUEPRINT_LIMITS.TAX_YEAR_MIN, Math.round(input.taxYear))
  );

  const payload = {
    clientId,
    ownerUid: user.uid,
    name: clampString(input.name, BLUEPRINT_LIMITS.NAME_MAX),
    email: normalizedEmail,
    phone: clampString(input.phone, BLUEPRINT_LIMITS.PHONE_MAX),
    taxYear,
    filingCategory: input.filingCategory,
    jobStatus: 'No Book In' as JobStatus,
    isLocked: false,
    reminderCount: 0,
    lastReminderSent: null,
    latestReminderDraft: clampString(
      `Dear ${clampString(input.name, 80)}, your YA ${taxYear} personal tax portal (${clientId}) is now open. Please upload your required documents: ${requiredDocuments.map((d) => d.docType).join(', ')}.`,
      BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX
    ),
    requiredDocuments,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'clients', clientId), payload);
    return clientId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function seedSamplePortfolio(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');

  const now = Date.now();
  const daysAgo = (d: number) => Timestamp.fromMillis(now - d * 24 * 60 * 60 * 1000);

  const samples = [
    {
      clientId: 'TAX-2026-089',
      ownerUid: user.uid,
      name: 'Ahmad Razak bin Ismail',
      email: 'ahmad.razak@example.my',
      phone: '+60123456789',
      taxYear: 2026,
      filingCategory: 'Form BE (Salaried)' as FilingCategory,
      jobStatus: 'Pending Document' as JobStatus,
      isLocked: false,
      reminderCount: 1,
      lastReminderSent: daysAgo(3),
      latestReminderDraft:
        'Dear Ahmad Razak, thank you for uploading your EA Form and Bank Interest / Dividend Statement for YA 2026. To proceed with your LHDN filing, we are still missing your EPF / KWSP Statement and Medical & Lifestyle Receipts. Please upload them via your CukaiDesk portal at your earliest convenience.',
      requiredDocuments: [
        {
          docType: 'EA Form / Employment Income',
          status: 'Verified',
          fileName: 'EA_Form_2026_AhmadRazak.pdf',
          fileUrl: 'portal://TAX-2026-089/EA_Form_2026_AhmadRazak.pdf',
          extractedAmount: 118400,
          taxYearValid: true,
          notes: 'Verified YA 2026 Form C.P.8A from Petronas Digital Sdn Bhd. Gross income RM 118,400.',
        },
        {
          docType: 'EPF / KWSP Statement',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'Medical & Lifestyle Receipts',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'Bank Interest / Dividend Statement',
          status: 'Verified',
          fileName: 'Maybank_Dividend_2026.pdf',
          fileUrl: 'portal://TAX-2026-089/Maybank_Dividend_2026.pdf',
          extractedAmount: 4250,
          taxYearValid: true,
          notes: 'Verified YA 2026 unit trust & fixed deposit summary.',
        },
      ],
    },
    {
      clientId: 'TAX-2026-092',
      ownerUid: user.uid,
      name: 'Tan Mei Ling',
      email: 'meiling.tan@example.my',
      phone: '+60167824410',
      taxYear: 2026,
      filingCategory: 'Form B (Business / Commission)' as FilingCategory,
      jobStatus: 'No Book In' as JobStatus,
      isLocked: false,
      reminderCount: 1,
      lastReminderSent: daysAgo(9),
      latestReminderDraft:
        'Dear Ms. Tan Mei Ling, this is a gentle 7-day follow-up regarding your YA 2026 personal tax submission (TAX-2026-092). We have not yet received any documents. Please sign in to upload your CP58 Commission Statement, EA Form, EPF Statement, and relief receipts so we can book in your file.',
      requiredDocuments: [
        {
          docType: 'CP58 Commission Statement',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'EPF / KWSP Statement',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'Medical & Lifestyle Receipts',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'Insurance Statement',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
      ],
    },
    {
      clientId: 'TAX-2026-095',
      ownerUid: user.uid,
      name: 'Suresh a/l Subramaniam',
      email: 'suresh.nair@example.my',
      phone: '+60193328871',
      taxYear: 2026,
      filingCategory: 'Form BE (Salaried)' as FilingCategory,
      jobStatus: 'Book In Can Start' as JobStatus,
      isLocked: false,
      reminderCount: 1,
      lastReminderSent: daysAgo(1),
      latestReminderDraft:
        'Dear Mr. Suresh, all required YA 2026 personal tax documents have been received and verified. Your file (TAX-2026-095) is now marked Book In Can Start and assigned to our tax preparer for LHDN computation.',
      requiredDocuments: [
        {
          docType: 'EA Form / Employment Income',
          status: 'Verified',
          fileName: 'EA_2026_Suresh.pdf',
          fileUrl: 'portal://TAX-2026-095/EA_2026_Suresh.pdf',
          extractedAmount: 164500,
          taxYearValid: true,
          notes: 'Verified YA 2026 Form C.P.8A. PCB deducted RM 18,920.',
        },
        {
          docType: 'EPF / KWSP Statement',
          status: 'Verified',
          fileName: 'KWSP_Annual_2026.pdf',
          fileUrl: 'portal://TAX-2026-095/KWSP_Annual_2026.pdf',
          extractedAmount: 18095,
          taxYearValid: true,
          notes: 'Verified i-Akaun 2026 statutory contribution (RM 4,000 relief cap applies).',
        },
        {
          docType: 'Medical & Lifestyle Receipts',
          status: 'Verified',
          fileName: 'Pantai_Medical_2026.jpg',
          fileUrl: 'portal://TAX-2026-095/Pantai_Medical_2026.jpg',
          extractedAmount: 3150,
          taxYearValid: true,
          notes: 'Verified full medical check-up & lifestyle receipts dated 2026.',
        },
      ],
    },
    {
      clientId: 'TAX-2026-101',
      ownerUid: user.uid,
      name: 'Nurul Huda binti Hassan',
      email: 'nurul.huda@example.my',
      phone: '+60132198765',
      taxYear: 2026,
      filingCategory: 'Form BE (Salaried)' as FilingCategory,
      jobStatus: 'No Book In' as JobStatus,
      isLocked: false,
      reminderCount: 0,
      lastReminderSent: null,
      latestReminderDraft:
        'Dear Cik Nurul Huda, YA 2026 personal tax season is now open. Please log in to CukaiDesk to upload your EA Form, EPF / KWSP Statement, and Zakat / Approved Donation Receipt.',
      requiredDocuments: [
        {
          docType: 'EA Form / Employment Income',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'EPF / KWSP Statement',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
        {
          docType: 'Zakat / Approved Donation Receipt',
          status: 'Missing',
          fileName: null,
          fileUrl: null,
          extractedAmount: null,
          taxYearValid: null,
          notes: '',
        },
      ],
    },
  ];

  const batch = writeBatch(db);
  for (const sample of samples) {
    batch.set(doc(db, 'clients', sample.clientId), {
      ...sample,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'clients');
  }
}

export async function applyAiVerificationResult(
  client: TaxClient,
  verification: VerificationApiResponse
): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');

  const updatedChecklist: RequiredDocumentItem[] = client.requiredDocuments.map((item) => {
    const matched = verification.detectedDocuments.find((det) => {
      if (
        det.matchedChecklistDocType &&
        det.matchedChecklistDocType.toLowerCase().trim() === item.docType.toLowerCase().trim()
      ) {
        return true;
      }
      const cat = det.documentCategory.toLowerCase();
      const target = item.docType.toLowerCase();
      return (
        cat === target ||
        (target.includes('ea form') && (cat.includes('ea form') || cat.includes('employment'))) ||
        (target.includes('epf') && (cat.includes('epf') || cat.includes('kwsp'))) ||
        (target.includes('cp58') && cat.includes('cp58')) ||
        (target.includes('medical') && (cat.includes('medical') || cat.includes('lifestyle'))) ||
        (target.includes('zakat') && (cat.includes('zakat') || cat.includes('donation'))) ||
        (target.includes('dividend') && (cat.includes('dividend') || cat.includes('interest'))) ||
        (target.includes('insurance') && cat.includes('insurance')) ||
        (target.includes('pcb') && cat.includes('pcb'))
      );
    });

    if (!matched) {
      return item;
    }

    return {
      docType: item.docType,
      status: matched.taxYearValid ? 'Verified' : 'Invalid',
      fileName: clampString(matched.fileName, 140),
      fileUrl: `portal://${client.clientId}/${clampString(matched.fileName, 100)}`,
      extractedAmount:
        typeof matched.extractedAmount === 'number' && !Number.isNaN(matched.extractedAmount)
          ? matched.extractedAmount
          : item.extractedAmount,
      taxYearValid: matched.taxYearValid,
      notes: clampString(
        matched.notes ||
          (matched.taxYearValid
            ? `Verified by Gemini 2.5 Flash (${matched.documentCategory}).`
            : `Tax year mismatch or unreadable document flagged by AI.`),
        320
      ),
    };
  });

  const computedStatus = computeJobStatusFromChecklist(updatedChecklist);
  const finalStatus: JobStatus =
    computedStatus === 'Book In Can Start' && verification.missingDocuments.length === 0
      ? 'Book In Can Start'
      : computedStatus;

  const verificationId = `ver_${Date.now()}`;
  const batch = writeBatch(db);

  batch.update(doc(db, 'clients', client.clientId), {
    requiredDocuments: updatedChecklist.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
    jobStatus: finalStatus,
    latestReminderDraft: clampString(
      verification.automatedReminderDraft || client.latestReminderDraft,
      BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX
    ),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, `clients/${client.clientId}/verifications`, verificationId), {
    clientId: client.clientId,
    clientOwnerUid: client.ownerUid,
    clientEmail: client.email,
    submittedByUid: user.uid,
    recommendedJobStatus: verification.recommendedJobStatus,
    automatedReminderDraft: clampString(
      verification.automatedReminderDraft || '',
      BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX
    ),
    detectedDocuments: verification.detectedDocuments.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
    missingDocuments: verification.missingDocuments
      .map((m) => clampString(String(m), 160))
      .slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `clients/${client.clientId}`);
  }
}

export async function updateClientChecklistItem(
  client: TaxClient,
  index: number,
  updates: Partial<RequiredDocumentItem>
): Promise<void> {
  const nextDocs = client.requiredDocuments.map((item, idx) =>
    idx === index ? { ...item, ...updates } : item
  );
  const nextStatus = computeJobStatusFromChecklist(nextDocs);
  const missingList = nextDocs.filter((d) => d.status !== 'Verified').map((d) => d.docType);

  const nextDraft =
    nextStatus === 'Book In Can Start'
      ? `Dear ${client.name}, all required documents for YA ${client.taxYear} (${client.clientId}) are verified. Your file is now marked Book In Can Start.`
      : nextStatus === 'Pending Document'
        ? `Dear ${client.name}, thank you for your recent submission for YA ${client.taxYear}. We are still missing: ${missingList.join(', ')}.`
        : `Dear ${client.name}, your YA ${client.taxYear} personal tax checklist (${client.clientId}) is ready for upload.`;

  const path = `clients/${client.clientId}`;
  try {
    await updateDoc(doc(db, 'clients', client.clientId), {
      requiredDocuments: nextDocs.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
      jobStatus: nextStatus,
      latestReminderDraft: clampString(nextDraft, BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateClientChecklistStructure(
  client: TaxClient,
  nextDocs: RequiredDocumentItem[]
): Promise<void> {
  const bounded = nextDocs.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS);
  const nextStatus = computeJobStatusFromChecklist(bounded);
  const path = `clients/${client.clientId}`;
  try {
    await updateDoc(doc(db, 'clients', client.clientId), {
      requiredDocuments: bounded,
      jobStatus: nextStatus,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function toggleClientLock(client: TaxClient, isLocked: boolean): Promise<void> {
  const path = `clients/${client.clientId}`;
  try {
    await updateDoc(doc(db, 'clients', client.clientId), {
      isLocked,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function dispatchReminder(
  client: TaxClient,
  stage: ReminderStage,
  channel: ReminderChannel,
  message: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');

  const missingDocuments = client.requiredDocuments
    .filter((d) => d.status !== 'Verified')
    .map((d) => clampString(d.docType, 120))
    .slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS);

  const reminderId = `rem_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const clampedMsg = clampString(message, BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX);
  const nextCount = Math.min(BLUEPRINT_LIMITS.MAX_REMINDER_COUNT, (client.reminderCount || 0) + 1);

  const batch = writeBatch(db);
  batch.set(doc(db, `clients/${client.clientId}/reminders`, reminderId), {
    clientId: client.clientId,
    clientOwnerUid: client.ownerUid,
    clientEmail: client.email,
    sentByUid: user.uid,
    stage,
    channel,
    message: clampedMsg,
    missingDocuments,
    createdAt: serverTimestamp(),
  });

  batch.update(doc(db, 'clients', client.clientId), {
    lastReminderSent: serverTimestamp(),
    reminderCount: nextCount,
    latestReminderDraft: clampedMsg,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `clients/${client.clientId}/reminders`);
  }
}

export async function deleteTaxClient(clientId: string): Promise<void> {
  const path = `clients/${clientId}`;
  try {
    await deleteDoc(doc(db, 'clients', clientId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ---------------------------------------------------------------------------
// Server-Side Gemini 2.5 Flash API Helpers
// ---------------------------------------------------------------------------
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function verifyTaxDocumentsApi(
  client: TaxClient,
  files: File[]
): Promise<VerificationApiResponse> {
  const encodedFiles = await Promise.all(
    files.map(async (f) => ({
      fileName: f.name,
      mimeType: f.type || 'image/png',
      data: await fileToBase64(f),
    }))
  );

  const response = await fetch('/api/verify-documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: client.name,
      clientId: client.clientId,
      taxYear: client.taxYear,
      filingCategory: client.filingCategory,
      requiredDocuments: client.requiredDocuments.map((d) => ({
        docType: d.docType,
        status: d.status,
        fileName: d.fileName,
      })),
      files: encodedFiles,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || 'Gemini verification request failed.');
  }
  return data as VerificationApiResponse;
}

export async function draftReminderApi(
  client: TaxClient,
  stage: ReminderStage,
  daysSinceLastReminder: number | null
): Promise<ReminderDraftResponse> {
  const missingDocuments = client.requiredDocuments
    .filter((d) => d.status !== 'Verified')
    .map((d) => d.docType);
  const verifiedDocuments = client.requiredDocuments
    .filter((d) => d.status === 'Verified')
    .map((d) => d.docType);

  const response = await fetch('/api/draft-reminder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientName: client.name,
      clientId: client.clientId,
      taxYear: client.taxYear,
      jobStatus: client.jobStatus,
      missingDocuments,
      verifiedDocuments,
      stage,
      daysSinceLastReminder,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to draft reminder.');
  }
  return data as ReminderDraftResponse;
}

// ---------------------------------------------------------------------------
// Realistic Malaysia Tax Specimen Generator (for instant multimodal testing)
// ---------------------------------------------------------------------------
export type SampleSpecimenKind =
  | 'ea_2026'
  | 'epf_2026'
  | 'medical_2026'
  | 'cp58_2026'
  | 'zakat_2026'
  | 'ea_wrong_year_2024';

export async function generateSampleTaxDocumentFile(
  kind: SampleSpecimenKind,
  taxpayerName: string,
  taxYear: number
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 1240;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported.');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle paper border
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 2;
  ctx.strokeRect(36, 36, canvas.width - 72, canvas.height - 72);

  const specs: Record<
    SampleSpecimenKind,
    {
      fileName: string;
      header: string;
      subHeader: string;
      yearLabel: string;
      issuer: string;
      rows: Array<[string, string]>;
      totalLabel: string;
      totalValue: string;
      footer: string;
    }
  > = {
    ea_2026: {
      fileName: `EA_Form_YA${taxYear}_${taxpayerName.split(' ')[0]}.png`,
      header: 'PENYATA SARAAN DARIPADA PENGGAJIAN (BORANG EA / C.P.8A)',
      subHeader: 'STATEMENT OF REMUNERATION FROM EMPLOYMENT — LHDN MALAYSIA',
      yearLabel: `BAGI TAHUN BERAKHIR 31 DISEMBER ${taxYear} (YEAR OF ASSESSMENT ${taxYear})`,
      issuer: 'PETRONAS DIGITAL SDN BHD (E 90441288-02)',
      rows: [
        ['Employee Full Name', taxpayerName.toUpperCase()],
        ['Income Tax No. (TIN)', 'IG 24891032080'],
        ['Gross Salary & Wages', 'RM 114,000.00'],
        ['Bonus & Allowances', 'RM 12,500.00'],
        ['Employee EPF / KWSP Contribution', 'RM 13,915.00'],
        ['Monthly Tax Deduction (PCB / MTD)', 'RM 11,420.00'],
      ],
      totalLabel: 'TOTAL GROSS EMPLOYMENT INCOME',
      totalValue: 'RM 126,500.00',
      footer: `Issued electronically under Income Tax Act 1967 for YA ${taxYear}.`,
    },
    epf_2026: {
      fileName: `KWSP_EPF_Statement_${taxYear}.png`,
      header: 'KUMPULAN WANG SIMPANAN PEKERJA (KWSP / EPF)',
      subHeader: 'ANNUAL MEMBER CONTRIBUTION STATEMENT (i-AKAUN)',
      yearLabel: `STATEMENT PERIOD: 01 JAN ${taxYear} – 31 DEC ${taxYear}`,
      issuer: 'EMPLOYEES PROVIDENT FUND MALAYSIA',
      rows: [
        ['Member Name', taxpayerName.toUpperCase()],
        ['EPF Member Number', '19482710'],
        ['Employee Statutory Contribution (Akaun Persaraan + Sejahtera)', 'RM 13,915.00'],
        ['Employer Statutory Contribution', 'RM 15,180.00'],
        ['Voluntary Self-Contribution (i-Saraan / Top-Up)', 'RM 1,500.00'],
        ['Dividend Credited (5.80%)', 'RM 9,420.50'],
      ],
      totalLabel: 'TOTAL EMPLOYEE CONTRIBUTION FOR LHDN TAX RELIEF',
      totalValue: 'RM 15,415.00',
      footer: `Computer-generated KWSP annual statement for Tax Year ${taxYear}.`,
    },
    medical_2026: {
      fileName: `Medical_Lifestyle_Receipt_${taxYear}.png`,
      header: 'GLENEAGLES HOSPITAL KUALA LUMPUR',
      subHeader: 'OFFICIAL TAX INVOICE & MEDICAL CHECK-UP RECEIPT',
      yearLabel: `RECEIPT DATE: 18 AUGUST ${taxYear} (TAX YEAR ${taxYear})`,
      issuer: 'PANTAI MEDICAL CENTRE SDN BHD (197201001234)',
      rows: [
        ['Patient / Taxpayer Name', taxpayerName.toUpperCase()],
        ['Receipt Reference', `GHKL-${taxYear}-88214`],
        ['Executive Full Medical Screening Package', 'RM 1,480.00'],
        ['Dental Examination & Scaling Treatment', 'RM 620.00'],
        ['Vaccination & Specialist Consultation', 'RM 750.00'],
      ],
      totalLabel: 'TOTAL AMOUNT PAID (MYR)',
      totalValue: 'RM 2,850.00',
      footer: `Qualifies for LHDN Medical Examination & Treatment Relief for YA ${taxYear}.`,
    },
    cp58_2026: {
      fileName: `CP58_Commission_Statement_${taxYear}.png`,
      header: 'PENYATA BAYARAN INSENTIF KEPADA EJEN / PENGEDAR (BORANG CP58)',
      subHeader: 'STATEMENT OF MONETARY & NON-MONETARY INCENTIVE PAYMENT — LHDN',
      yearLabel: `YEAR ENDED 31 DECEMBER ${taxYear} (YA ${taxYear})`,
      issuer: 'AIA BHD. — AGENCY COMPENSATION DIVISION',
      rows: [
        ['Recipient / Agent Name', taxpayerName.toUpperCase()],
        ['Agent Code', 'MY-KL-40291'],
        ['Total Monetary Commission Paid', 'RM 84,600.00'],
        ['Performance & Persistency Bonus', 'RM 14,200.00'],
        ['Non-Monetary Incentive Value', 'RM 3,500.00'],
      ],
      totalLabel: 'TOTAL CP58 INCENTIVES RECEIVED',
      totalValue: 'RM 102,300.00',
      footer: `Issued pursuant to Section 83A Income Tax Act 1967 for YA ${taxYear}.`,
    },
    zakat_2026: {
      fileName: `PPZ_Zakat_Receipt_${taxYear}.png`,
      header: 'PUSAT PUNGUTAN ZAKAT — MAIWP (PPZ-MAIWP)',
      subHeader: 'RESIT RASMI BAYARAN ZAKAT PENDAPATAN (OFFICIAL ZAKAT RECEIPT)',
      yearLabel: `TARIKH BAYARAN: 14 NOVEMBER ${taxYear} (YA ${taxYear})`,
      issuer: 'MAJLIS AGAMA ISLAM WILAYAH PERSEKUTUAN',
      rows: [
        ['Pembayar Zakat (Taxpayer)', taxpayerName.toUpperCase()],
        ['No. Resit Rasmi', `PPZ-${taxYear}-0091842`],
        ['Jenis Zakat', 'Zakat Pendapatan (Income Zakat)'],
        ['Kaedah Bayaran', 'FPX Online / Potongan Gaji'],
      ],
      totalLabel: 'JUMLAH ZAKAT DIBAYAR (TAX REBATE S.6A(3))',
      totalValue: 'RM 3,200.00',
      footer: `Resit ini sah untuk tuntutan rebat cukai LHDN Tahun Taksiran ${taxYear}.`,
    },
    ea_wrong_year_2024: {
      fileName: `EA_Form_OLD_2024_${taxpayerName.split(' ')[0]}.png`,
      header: 'PENYATA SARAAN DARIPADA PENGGAJIAN (BORANG EA / C.P.8A)',
      subHeader: 'STATEMENT OF REMUNERATION FROM EMPLOYMENT — LHDN MALAYSIA',
      yearLabel: 'BAGI TAHUN BERAKHIR 31 DISEMBER 2024 (YEAR OF ASSESSMENT 2024)',
      issuer: 'KUALA LUMPUR TECH VENTURES SDN BHD',
      rows: [
        ['Employee Full Name', taxpayerName.toUpperCase()],
        ['Assessment Year', '2024 (OUTDATED — NOT 2026)'],
        ['Gross Salary & Wages (2024)', 'RM 96,000.00'],
        ['Employee EPF Contribution (2024)', 'RM 10,560.00'],
      ],
      totalLabel: 'TOTAL GROSS EMPLOYMENT INCOME (YA 2024)',
      totalValue: 'RM 96,000.00',
      footer: 'Historical statement for Year of Assessment 2024.',
    },
  };

  const s = specs[kind];

  // Top header band
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(56, 56, canvas.width - 112, 118);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 21px sans-serif';
  ctx.fillText(s.header, 80, 102);

  ctx.fillStyle = '#CBD5E1';
  ctx.font = '15px sans-serif';
  ctx.fillText(s.subHeader, 80, 132);

  ctx.fillStyle = '#5EEAD4';
  ctx.font = 'bold 15px monospace';
  ctx.fillText(s.yearLabel, 80, 158);

  // Issuer line
  ctx.fillStyle = '#334155';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(`ISSUER: ${s.issuer}`, 80, 224);

  ctx.strokeStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.moveTo(80, 246);
  ctx.lineTo(canvas.width - 80, 246);
  ctx.stroke();

  // Key-value table
  let y = 295;
  for (const [label, value] of s.rows) {
    ctx.fillStyle = '#64748B';
    ctx.font = '16px sans-serif';
    ctx.fillText(label, 80, y);

    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(value, 80, y + 28);

    ctx.strokeStyle = '#F1F5F9';
    ctx.beginPath();
    ctx.moveTo(80, y + 48);
    ctx.lineTo(canvas.width - 80, y + 48);
    ctx.stroke();
    y += 86;
  }

  // Total summary box
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(80, y + 24, canvas.width - 160, 106);
  ctx.strokeStyle = '#0F766E';
  ctx.lineWidth = 2;
  ctx.strokeRect(80, y + 24, canvas.width - 160, 106);

  ctx.fillStyle = '#0F766E';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillText(s.totalLabel, 106, y + 60);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 34px monospace';
  ctx.fillText(s.totalValue, 106, y + 106);

  // Footer
  ctx.fillStyle = '#64748B';
  ctx.font = '14px sans-serif';
  ctx.fillText(s.footer, 80, canvas.height - 80);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Failed to generate specimen image'))), 'image/png');
  });

  return new File([blob], s.fileName, { type: 'image/png' });
}
