import {
  addDoc,
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
  trackFirestoreListener,
} from './firebase';
import {
  BLUEPRINT_LIMITS,
  type AnalyzeDocumentResult,
  type DocumentVerificationRecord,
  type FilingCategory,
  type JobStatus,
  type ReminderChannel,
  type ReminderDraftResponse,
  type ReminderLogRecord,
  type ReminderStage,
  type RequiredDocumentItem,
  type SystemSecuritySettings,
  type TaxClient,
  type TwoFactorChangeRequest,
  type TwoFactorRequestType,
  type TwoFactorSetupResponse,
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
    (d) =>
      d.status === 'Verified' ||
      d.status === 'Needs Review' ||
      d.status === 'Invalid' ||
      Boolean(d.fileName)
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

export function determineWorkflowStage(
  client: TaxClient,
  reminderIntervalDays = 7
): {
  stage: ReminderStage;
  isEscalated: boolean;
  daysSinceReminder: number | null;
  summary: string;
} {
  const days = getDaysSince(client.lastReminderSent);
  const threshold = Math.max(1, reminderIntervalDays);
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
      isEscalated: days !== null && days >= threshold,
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
  const escalated = (days ?? 0) >= threshold;
  return {
    stage: '7-Day Follow-up',
    isEscalated: escalated,
    daysSinceReminder: days,
    summary: escalated
      ? `No uploads after ${days} days — overdue for ${threshold}-day follow-up.`
      : `Invited ${days} day${days === 1 ? '' : 's'} ago — awaiting first upload.`,
  };
}

function normalizeUserProfile(
  raw: Partial<UserProfile> & { uid?: string; email?: string },
  fallbackUid = ''
): UserProfile {
  const email = (raw.email || '').toLowerCase().trim();
  return {
    uid: raw.uid || fallbackUid,
    email,
    displayName: raw.displayName || email.split('@')[0] || 'Taxpayer',
    role: raw.role || 'user',
    assignedClientId: raw.assignedClientId ?? null,
    twoFactorEnabled: Boolean(raw.twoFactorEnabled),
    twoFactorLocked: raw.twoFactorLocked !== false,
    twoFactorApprovedUntil: raw.twoFactorApprovedUntil ?? null,
    createdAt: raw.createdAt ?? null,
  };
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      return normalizeUserProfile(snap.data() as Partial<UserProfile>, uid);
    }
    return null;
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return null;
  }
}

export function subscribeToUserProfile(
  uid: string,
  onData: (profile: UserProfile | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const unsub = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      if (snap.exists()) {
        onData(normalizeUserProfile(snap.data() as Partial<UserProfile>, uid));
      } else {
        onData(null);
      }
    },
    (error) => {
      if (onError) {
        try {
          handleFirestoreError(error, OperationType.GET, `users/${uid}`);
        } catch (wrapped) {
          onError(wrapped as Error);
        }
      }
    }
  );
  return trackFirestoreListener(unsub);
}

export async function initializeUserProfile(user: {
  uid: string;
  email: string | null;
  displayName: string | null;
}): Promise<UserProfile> {
  const email = (user.email || '').toLowerCase().trim();
  const isAdminEmail = email === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase();
  const defaultRole: UserRole = isAdminEmail ? 'administrator' : 'user';

  const existingSnap = await getDoc(doc(db, 'users', user.uid));
  if (existingSnap.exists()) {
    const rawData = existingSnap.data() as Partial<UserProfile>;
    const normalized = normalizeUserProfile(rawData, user.uid);

    // Backfill mandatory 2FA governance fields on legacy user documents
    if (!('twoFactorLocked' in rawData) || !('twoFactorEnabled' in rawData)) {
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          twoFactorEnabled: false,
          twoFactorLocked: true,
          twoFactorApprovedUntil: null,
        });
      } catch (err) {
        console.error('Failed to backfill 2FA governance fields:', err);
      }
    }

    if (isAdminEmail && normalized.role !== 'administrator') {
      await updateUserRole(user.uid, 'administrator');
      normalized.role = 'administrator';
    }
    return normalized;
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
    twoFactorEnabled: false,
    twoFactorLocked: true,
    twoFactorApprovedUntil: null,
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
    const userRef = doc(db, 'users', uid);
    const snap = await getDoc(userRef);
    const raw = snap.exists() ? (snap.data() as Partial<UserProfile>) : {};
    await updateDoc(userRef, {
      role,
      twoFactorEnabled: Boolean(raw.twoFactorEnabled),
      twoFactorLocked: raw.twoFactorLocked !== false,
      twoFactorApprovedUntil: raw.twoFactorApprovedUntil ?? null,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function getAllUserProfiles(): Promise<UserProfile[]> {
  try {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs.map((d) =>
      normalizeUserProfile(d.data() as Partial<UserProfile>, d.id)
    );
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

  const unsub = onSnapshot(
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

  return trackFirestoreListener(unsub);
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

  return trackFirestoreListener(() => {
    unsubVerif();
    unsubRem();
  });
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

export function buildCreateTaxClientPayload(
  input: CreateClientInput,
  ownerUid: string
): { clientId: string; payload: Record<string, unknown> } {
  const clientId = sanitizeClientId(input.clientId);
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

  const payload: Record<string, unknown> = {
    clientId,
    ownerUid,
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
  };

  return { clientId, payload };
}

export async function createTaxClient(input: CreateClientInput): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to create a tax file.');

  const { clientId, payload } = buildCreateTaxClientPayload(input, user.uid);
  const path = `clients/${clientId}`;

  try {
    await setDoc(doc(db, 'clients', clientId), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return clientId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateClientProfileDetails(
  clientId: string,
  updates: {
    name: string;
    email: string;
    phone: string;
    taxYear: number;
    filingCategory: FilingCategory;
  }
): Promise<void> {
  const path = `clients/${clientId}`;
  try {
    await updateDoc(doc(db, 'clients', clientId), {
      name: clampString(updates.name, BLUEPRINT_LIMITS.NAME_MAX),
      email: clampString(updates.email.toLowerCase(), BLUEPRINT_LIMITS.EMAIL_MAX),
      phone: clampString(updates.phone, BLUEPRINT_LIMITS.PHONE_MAX),
      taxYear: Math.min(
        BLUEPRINT_LIMITS.TAX_YEAR_MAX,
        Math.max(BLUEPRINT_LIMITS.TAX_YEAR_MIN, Math.round(updates.taxYear))
      ),
      filingCategory: updates.filingCategory,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
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

function matchesChecklistDocType(
  itemDocType: string,
  analysis: AnalyzeDocumentResult
): boolean {
  const target = itemDocType.toLowerCase().trim();
  const matchedItem = (analysis.matchedChecklistItem || '').toLowerCase().trim();
  if (matchedItem && matchedItem === target) {
    return true;
  }
  const cat = (analysis.documentCategory || '').toLowerCase().trim();
  if (!cat || cat === 'unrecognized / blurry') return false;
  if (cat === target) return true;
  if (target.includes('ea form') && (cat.includes('ea form') || cat.includes('employment'))) return true;
  if (target.includes('epf') && (cat.includes('epf') || cat.includes('kwsp'))) return true;
  if (target.includes('cp58') && cat.includes('cp58')) return true;
  if (target.includes('medical') && (cat.includes('medical') || cat.includes('lifestyle'))) return true;
  if (target.includes('lifestyle') && cat.includes('lifestyle')) return true;
  if (target.includes('zakat') && (cat.includes('zakat') || cat.includes('donation'))) return true;
  if (target.includes('dividend') && (cat.includes('dividend') || cat.includes('interest'))) return true;
  if (target.includes('insurance') && (cat.includes('insurance') || cat.includes('takaful'))) return true;
  if (target.includes('pcb') && cat.includes('pcb')) return true;
  return false;
}

export async function applyAnalyzedDocumentsResult(
  client: TaxClient,
  analyses: AnalyzeDocumentResult[]
): Promise<{
  finalStatus: JobStatus;
  missingDocuments: string[];
  matchedCount: number;
}> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');

  let matchedCount = 0;

  const updatedChecklist: RequiredDocumentItem[] = client.requiredDocuments.map((item) => {
    const matched = analyses.find((a) => matchesChecklistDocType(item.docType, a));
    if (!matched) {
      return item;
    }

    matchedCount += 1;
    const isVerified = matched.isLegible === true && matched.taxYearMatches === true;
    const nextStatus = isVerified ? 'Verified' : 'Needs Review';

    return {
      docType: item.docType,
      status: nextStatus,
      fileName: clampString(matched.fileName || 'uploaded-document', 140),
      fileUrl: `portal://${client.clientId}/${clampString(matched.fileName || 'document', 100)}`,
      extractedAmount:
        typeof matched.totalAmountMYR === 'number' && !Number.isNaN(matched.totalAmountMYR)
          ? matched.totalAmountMYR
          : null,
      taxYearValid: Boolean(matched.taxYearMatches),
      notes: clampString(
        matched.confidenceNotes ||
          (isVerified
            ? `Verified by Gemini (${matched.documentCategory}).`
            : 'Flagged for review — check legibility or Year of Assessment.'),
        320
      ),
      documentCategory: clampString(matched.documentCategory || '', 100) || null,
      isLegible: Boolean(matched.isLegible),
      merchantOrIssuer: clampString(matched.merchantOrIssuer || '', 140) || null,
      receiptDate: clampString(matched.receiptDate || '', 32) || null,
      detectedTaxYear:
        typeof matched.taxYear === 'number' && matched.taxYear > 0
          ? Math.round(matched.taxYear)
          : null,
      taxReliefCategory: clampString(matched.taxReliefCategory || '', 100) || null,
    };
  });

  const missingDocuments = updatedChecklist
    .filter((d) => d.status !== 'Verified')
    .map((d) => d.docType);

  const finalStatus = computeJobStatusFromChecklist(updatedChecklist);

  const nextDraft =
    finalStatus === 'Book In Can Start'
      ? `Dear ${client.name}, all required documents for YA ${client.taxYear} (${client.clientId}) have been verified. Your tax file is now marked Book In Can Start and queued for LHDN computation.`
      : finalStatus === 'Pending Document'
        ? `Dear ${client.name}, thank you for uploading your YA ${client.taxYear} tax document(s) (${client.clientId}). We are still awaiting verified copies of: ${missingDocuments.join(', ')}.`
        : `Dear ${client.name}, your YA ${client.taxYear} personal tax portal (${client.clientId}) is open. Please upload your required documents: ${missingDocuments.join(', ')}.`;

  const verificationId = `ver_${Date.now()}`;
  const batch = writeBatch(db);

  batch.update(doc(db, 'clients', client.clientId), {
    requiredDocuments: updatedChecklist.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
    jobStatus: finalStatus,
    latestReminderDraft: clampString(nextDraft, BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, `clients/${client.clientId}/verifications`, verificationId), {
    clientId: client.clientId,
    clientOwnerUid: client.ownerUid,
    clientEmail: client.email,
    submittedByUid: user.uid,
    recommendedJobStatus: finalStatus,
    automatedReminderDraft: clampString(nextDraft, BLUEPRINT_LIMITS.REMINDER_DRAFT_MAX),
    detectedDocuments: analyses.slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS).map((a) => ({
      fileName: clampString(a.fileName || 'uploaded-document', 140),
      documentCategory: clampString(a.documentCategory || 'Unrecognized / Blurry', 100),
      matchedChecklistDocType: clampString(a.matchedChecklistItem || '', 120),
      merchantOrIssuer: clampString(a.merchantOrIssuer || '', 140),
      receiptDate: clampString(a.receiptDate || '', 32),
      taxYear: typeof a.taxYear === 'number' ? Math.round(a.taxYear) : 0,
      taxYearValid: Boolean(a.taxYearMatches),
      isLegible: Boolean(a.isLegible),
      extractedAmount:
        typeof a.totalAmountMYR === 'number' && !Number.isNaN(a.totalAmountMYR)
          ? a.totalAmountMYR
          : 0,
      taxReliefCategory: clampString(a.taxReliefCategory || '', 100),
      notes: clampString(a.confidenceNotes || '', 320),
    })),
    missingDocuments: missingDocuments
      .map((m) => clampString(m, 160))
      .slice(0, BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    return { finalStatus, missingDocuments, matchedCount };
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

/**
 * Permanently purges a client record and its nested verifications/reminders subcollections.
 * Strictly NEVER touches the immutable audit_logs collection.
 */
export async function purgeClientRecord(clientId: string): Promise<{
  deletedVerifications: number;
  deletedReminders: number;
}> {
  const path = `clients/${clientId}`;
  try {
    const verifSnaps = await getDocs(collection(db, `clients/${clientId}/verifications`));
    const remSnaps = await getDocs(collection(db, `clients/${clientId}/reminders`));

    const allRefs = [
      ...verifSnaps.docs.map((d) => d.ref),
      ...remSnaps.docs.map((d) => d.ref),
      doc(db, 'clients', clientId),
    ];

    const chunkSize = 400;
    for (let i = 0; i < allRefs.length; i += chunkSize) {
      const batch = writeBatch(db);
      for (const ref of allRefs.slice(i, i + chunkSize)) {
        batch.delete(ref);
      }
      await batch.commit();
    }

    return {
      deletedVerifications: verifSnaps.size,
      deletedReminders: remSnaps.size,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ---------------------------------------------------------------------------
// Danger Zone: 2FA Governance & Global Security Policy
// ---------------------------------------------------------------------------
export async function createTwoFactorChangeRequest(params: {
  requestType: TwoFactorRequestType;
  reason: string;
  requesterRole: UserRole;
}): Promise<string> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('You must be signed in to submit a 2FA change request.');
  }

  const trimmedReason = clampString(params.reason, 500);
  if (trimmedReason.length < 5) {
    throw new Error('Please provide a clear justification (at least 5 characters).');
  }

  try {
    const ref = await addDoc(collection(db, 'two_factor_requests'), {
      requesterUid: user.uid,
      requesterEmail: user.email.toLowerCase().trim(),
      requesterRole: params.requesterRole,
      requestType: params.requestType,
      reason: trimmedReason,
      status: 'PENDING',
      createdAt: serverTimestamp(),
      reviewedByUid: null,
      reviewedByEmail: null,
      reviewedAt: null,
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'two_factor_requests');
  }
}

export function subscribeToMyTwoFactorRequests(
  uid: string,
  onData: (requests: TwoFactorChangeRequest[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'two_factor_requests'),
    where('requesterUid', '==', uid)
  );
  const unsub = onSnapshot(
    q,
    (snap) => {
      const items: TwoFactorChangeRequest[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<TwoFactorChangeRequest, 'id'>),
      }));
      items.sort(
        (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
      );
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'two_factor_requests');
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
  return trackFirestoreListener(unsub);
}

export function subscribeToAllTwoFactorRequests(
  onData: (requests: TwoFactorChangeRequest[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'two_factor_requests'),
    orderBy('createdAt', 'desc')
  );
  const unsub = onSnapshot(
    q,
    (snap) => {
      const items: TwoFactorChangeRequest[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<TwoFactorChangeRequest, 'id'>),
      }));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'two_factor_requests');
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
  return trackFirestoreListener(unsub);
}

export async function reviewTwoFactorChangeRequest(
  request: TwoFactorChangeRequest,
  decision: 'APPROVED' | 'REJECTED'
): Promise<void> {
  const adminUser = auth.currentUser;
  if (!adminUser || !adminUser.email) {
    throw new Error('Administrator authentication is required.');
  }

  try {
    const batch = writeBatch(db);
    const reqRef = doc(db, 'two_factor_requests', request.id);
    batch.update(reqRef, {
      status: decision,
      reviewedByUid: adminUser.uid,
      reviewedByEmail: adminUser.email.toLowerCase().trim(),
      reviewedAt: serverTimestamp(),
    });

    if (decision === 'APPROVED') {
      const targetUserRef = doc(db, 'users', request.requesterUid);
      const targetSnap = await getDoc(targetUserRef);
      const targetData = targetSnap.exists()
        ? (targetSnap.data() as Partial<UserProfile>)
        : {};
      const approvedUntil = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
      batch.update(targetUserRef, {
        twoFactorEnabled: Boolean(targetData.twoFactorEnabled),
        twoFactorLocked: false,
        twoFactorApprovedUntil: approvedUntil,
      });
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `two_factor_requests/${request.id}`
    );
  }
}

export async function completeTwoFactorUpdate(params: {
  uid: string;
  requestId: string;
  twoFactorEnabled: boolean;
}): Promise<void> {
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', params.uid), {
      twoFactorEnabled: params.twoFactorEnabled,
      twoFactorLocked: true,
      twoFactorApprovedUntil: null,
    });
    batch.update(doc(db, 'two_factor_requests', params.requestId), {
      status: 'COMPLETED',
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${params.uid}`);
  }
}

export function subscribeToSecuritySettings(
  onData: (settings: SystemSecuritySettings) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const unsub = onSnapshot(
    doc(db, 'system_settings', 'security'),
    (snap) => {
      if (snap.exists()) {
        const raw = snap.data() as Partial<SystemSecuritySettings>;
        onData({
          require2faForAdminAndManager: Boolean(raw.require2faForAdminAndManager),
          updatedByUid: raw.updatedByUid ?? null,
          updatedByEmail: raw.updatedByEmail ?? null,
          updatedAt: raw.updatedAt ?? null,
        });
      } else {
        onData({
          require2faForAdminAndManager: false,
          updatedByUid: null,
          updatedByEmail: null,
          updatedAt: null,
        });
      }
    },
    (error) => {
      if (onError) {
        try {
          handleFirestoreError(error, OperationType.GET, 'system_settings/security');
        } catch (wrapped) {
          onError(wrapped as Error);
        }
      }
    }
  );
  return trackFirestoreListener(unsub);
}

export async function updateMandatoryTwoFactorPolicy(
  require2faForAdminAndManager: boolean
): Promise<void> {
  const adminUser = auth.currentUser;
  if (!adminUser || !adminUser.email) {
    throw new Error('Administrator authentication is required.');
  }
  try {
    await setDoc(doc(db, 'system_settings', 'security'), {
      require2faForAdminAndManager,
      updatedByUid: adminUser.uid,
      updatedByEmail: adminUser.email.toLowerCase().trim(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'system_settings/security');
  }
}

export async function setupTwoFactorApi(
  uid: string,
  email: string
): Promise<TwoFactorSetupResponse> {
  const response = await fetch('/api/2fa/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, email }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || 'Failed to generate authenticator QR code.');
  }
  return data as TwoFactorSetupResponse;
}

export async function verifyTwoFactorApi(
  uid: string,
  code: string,
  action?: 'bind' | 'verify' | 'clear'
): Promise<{ valid: boolean; bound?: boolean; cleared?: boolean; error?: string }> {
  const response = await fetch('/api/2fa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, code, action }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || 'Authenticator verification failed.');
  }
  return data as { valid: boolean; bound?: boolean; cleared?: boolean; error?: string };
}

// ---------------------------------------------------------------------------
// Server-Side Gemini API Helpers
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

export async function analyzeTaxDocumentApi(
  client: TaxClient,
  file: File
): Promise<AnalyzeDocumentResult> {
  const formData = new FormData();
  formData.append('clientId', client.clientId);
  formData.append('taxYear', String(client.taxYear));
  formData.append(
    'requiredDocuments',
    JSON.stringify(client.requiredDocuments.map((d) => d.docType))
  );
  formData.append('file', file, file.name);

  const response = await fetch('/api/analyze-document', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `Failed to analyze ${file.name} with Gemini.`);
  }
  return {
    ...(data as AnalyzeDocumentResult),
    fileName: (data as Partial<AnalyzeDocumentResult>).fileName || file.name,
  };
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
