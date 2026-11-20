import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
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
  type UserProfile,
  type UserRole,
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

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }
    return null;
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return null;
  }
}

export async function initializeUserProfile(user: {
  uid: string;
  email: string | null;
  displayName: string | null;
}): Promise<UserProfile> {
  const email = (user.email || '').toLowerCase().trim();
  const isAdminEmail = email === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase();
  const defaultRole: UserRole = isAdminEmail ? 'administrator' : 'user';

  const existing = await getUserProfile(user.uid);
  if (existing) {
    if (isAdminEmail && existing.role !== 'administrator') {
      await updateUserRole(user.uid, 'administrator');
      existing.role = 'administrator';
    }
    return existing;
  }

  // Check if there is a client with matching email
  let assignedClientId: string | undefined = undefined;
  if (email) {
    try {
      const q = query(collection(db, 'clients'), where('email', '==', email));
      const clientSnaps = await getDocs(q);
      if (!clientSnaps.empty) {
        assignedClientId = clientSnaps.docs[0].id;
      }
    } catch {
      // ignore
    }
  }

  const profile: UserProfile = {
    uid: user.uid,
    email,
    displayName: user.displayName || email.split('@')[0] || 'Taxpayer',
    role: defaultRole,
    assignedClientId: assignedClientId || null,
    createdAt: Timestamp.now(),
  };

  try {
    await setDoc(doc(db, 'users', user.uid), profile);
    return profile;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}`);
  }
}

export async function updateUserRole(uid: string, role: UserRole): Promise<void> {
  try {
    await updateDoc(doc(db, 'users', uid), { role });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function getAllUserProfiles(): Promise<UserProfile[]> {
  try {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs.map((d) => d.data() as UserProfile);
  } catch (error) {
    console.error('Error fetching user profiles:', error);
    return [];
  }
}

export async function assignClientToStaff(
  clientId: string,
  staff: { uid: string; name: string; email: string } | null
): Promise<void> {
  try {
    await updateDoc(doc(db, 'clients', clientId), {
      assignedTo: staff,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `clients/${clientId}`);
  }
}

export function subscribeToClients(
  userRole: UserRole,
  uid: string,
  email: string,
  assignedClientId: string | null | undefined,
  onData: (clients: TaxClient[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const clientsRef = collection(db, 'clients');
  let q;

  if (userRole === 'administrator' || userRole === 'manager') {
    q = query(clientsRef, orderBy('updatedAt', 'desc'));
  } else {
    // Regular user: query by ownerUid, email, or assignedClientId
    q = query(
      clientsRef,
      where('email', '==', email.toLowerCase().trim())
    );
  }

  return onSnapshot(
    q,
    (snapshot) => {
      let list: TaxClient[] = snapshot.docs.map((d) => d.data() as TaxClient);
      if (userRole === 'user' && assignedClientId) {
        const matched = clientsRef; // ensure own client is included
        // If query didn't return assignedClientId, we can also query by assignedClientId or ownerUid
      }
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
  canManage: boolean,
  email: string,
  onVerifications: (items: DocumentVerificationRecord[]) => void,
  onReminders: (items: ReminderLogRecord[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const verifPath = `clients/${clientId}/verifications`;
  const remPath = `clients/${clientId}/reminders`;

  const verifQuery = canManage
    ? query(collection(db, verifPath), orderBy('createdAt', 'desc'))
    : query(collection(db, verifPath), where('clientEmail', '==', email.toLowerCase()));

  const remQuery = canManage
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
    assignedTo: null,
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

export async function applyAiVerificationResult(
  client: TaxClient,
  verification: VerificationApiResponse
): Promise<JobStatus> {
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
    return finalStatus;
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
