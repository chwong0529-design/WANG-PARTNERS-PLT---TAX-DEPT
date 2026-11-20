import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  trackFirestoreListener,
} from './firebase';
import { logActivity } from './auditService';
import {
  MALAYSIA_DOC_PRESETS,
  type AppConfigSettings,
  type FilingCategory,
  type GovernanceChangeCategory,
  type GovernanceChangeRequest,
  type GovernanceOperation,
  type GovernanceTargetCollection,
  type UserProfile,
  type UserRole,
} from '../types/tax';

export const DEFAULT_APP_CONFIG: AppConfigSettings = {
  activeTaxYear: 2026,
  reminderIntervalDays: 7,
  defaultTemplates: {
    'Form BE (Salaried)': [...MALAYSIA_DOC_PRESETS['Form BE (Salaried)']],
    'Form B (Business / Commission)': [...MALAYSIA_DOC_PRESETS['Form B (Business / Commission)']],
    'Form M (Non-Resident)': [...MALAYSIA_DOC_PRESETS['Form M (Non-Resident)']],
  },
  updatedByUid: null,
  updatedByEmail: null,
  updatedAt: null,
};

function clampStr(value: string, maxLen: number): string {
  return value.trim().slice(0, maxLen);
}

/**
 * Removes undefined values recursively so Firestore writes never fail on unsupported undefined fields.
 */
function sanitizePayloadForFirestore(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      clean[key] = value.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizePayloadForFirestore(item as Record<string, unknown>)
          : item === undefined
            ? null
            : item
      );
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      typeof (value as { toMillis?: unknown }).toMillis !== 'function'
    ) {
      clean[key] = sanitizePayloadForFirestore(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export interface SubmitGovernanceRequestParams {
  category: GovernanceChangeCategory;
  targetCollection: GovernanceTargetCollection;
  targetDocId: string;
  targetLabel: string;
  operation: GovernanceOperation;
  proposedPayload: Record<string, unknown>;
  previousSummary?: string | null;
  reason: string;
  requestedByRole: UserRole;
  pageVisited?: string;
}

export async function submitGovernanceChangeRequest(
  params: SubmitGovernanceRequestParams
): Promise<string> {
  const user = auth.currentUser;
  if (!user || !user.email) {
    throw new Error('You must be signed in to submit a governance change request.');
  }

  const trimmedReason = clampStr(params.reason, 600);
  if (trimmedReason.length < 10) {
    throw new Error('Please provide a justification of at least 10 characters.');
  }

  const sanitizedPayload = sanitizePayloadForFirestore(params.proposedPayload);

  try {
    const docRef = await addDoc(collection(db, 'change_requests'), {
      category: params.category,
      targetCollection: params.targetCollection,
      targetDocId: clampStr(params.targetDocId, 128),
      targetLabel: clampStr(params.targetLabel, 200) || params.targetDocId,
      operation: params.operation,
      proposedPayload: sanitizedPayload,
      previousSummary: params.previousSummary
        ? clampStr(params.previousSummary, 1000)
        : null,
      reason: trimmedReason,
      requestedByUid: user.uid,
      requestedByEmail: user.email.toLowerCase().trim(),
      requestedByRole: params.requestedByRole,
      status: 'PENDING',
      createdAt: serverTimestamp(),
      reviewedByUid: null,
      reviewedByEmail: null,
      reviewedAt: null,
      reviewNote: null,
    });

    await logActivity({
      pageVisited: params.pageVisited || 'Danger Zone',
      actionTaken: 'SUBMIT_GOVERNANCE_CHANGE',
      details: `Submitted ${params.category} (${params.operation}) request (${docRef.id}) for ${params.targetCollection}/${params.targetDocId} (${params.targetLabel}). Reason: ${trimmedReason}`,
    });

    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'change_requests');
  }
}

export function subscribeToMyGovernanceRequests(
  uid: string,
  onData: (requests: GovernanceChangeRequest[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'change_requests'),
    where('requestedByUid', '==', uid)
  );
  const unsub = onSnapshot(
    q,
    (snap) => {
      const rows: GovernanceChangeRequest[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<GovernanceChangeRequest, 'id'>),
      }));
      rows.sort(
        (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
      );
      onData(rows);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'change_requests');
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
  return trackFirestoreListener(unsub);
}

export function subscribeToAllGovernanceRequests(
  onData: (requests: GovernanceChangeRequest[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, 'change_requests'),
    orderBy('createdAt', 'desc')
  );
  const unsub = onSnapshot(
    q,
    (snap) => {
      const rows: GovernanceChangeRequest[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<GovernanceChangeRequest, 'id'>),
      }));
      onData(rows);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'change_requests');
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );
  return trackFirestoreListener(unsub);
}

/**
 * Approves a PENDING GovernanceChangeRequest and atomically applies its proposedPayload
 * to the target collection/document (or deletes the target if operation === 'DELETE').
 * Writes an immutable APPROVE_GOVERNANCE_CHANGE audit log entry.
 */
export async function approveAndApplyGovernanceRequest(
  request: GovernanceChangeRequest,
  reviewNote?: string
): Promise<void> {
  const adminUser = auth.currentUser;
  if (!adminUser || !adminUser.email) {
    throw new Error('System Administrator authentication is required.');
  }
  if (!request.id) {
    throw new Error('Invalid governance request ID.');
  }

  const adminEmail = adminUser.email.toLowerCase().trim();
  const cleanNote = reviewNote && reviewNote.trim() ? clampStr(reviewNote, 500) : null;
  const reqRef = doc(db, 'change_requests', request.id);
  const targetRef = doc(db, request.targetCollection, request.targetDocId);

  try {
    const batch = writeBatch(db);

    if (request.operation === 'DELETE') {
      if (request.targetCollection === 'clients') {
        const verifSnaps = await getDocs(
          collection(db, `clients/${request.targetDocId}/verifications`)
        );
        const remSnaps = await getDocs(
          collection(db, `clients/${request.targetDocId}/reminders`)
        );
        for (const d of verifSnaps.docs) {
          batch.delete(d.ref);
        }
        for (const d of remSnaps.docs) {
          batch.delete(d.ref);
        }
      }
      batch.delete(targetRef);
    } else if (request.targetCollection === 'clients') {
      const payload = sanitizePayloadForFirestore(request.proposedPayload);
      if (request.operation === 'CREATE') {
        batch.set(targetRef, {
          ...payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.update(targetRef, {
          ...payload,
          updatedAt: serverTimestamp(),
        });
      }
    } else if (request.targetCollection === 'system_settings') {
      const payload = sanitizePayloadForFirestore(request.proposedPayload);
      if (request.targetDocId === 'security') {
        batch.set(targetRef, {
          require2faForAdminAndManager: Boolean(payload.require2faForAdminAndManager),
          updatedByUid: adminUser.uid,
          updatedByEmail: adminEmail,
          updatedAt: serverTimestamp(),
        });
      } else if (request.targetDocId === 'app_config') {
        const activeTaxYear = Math.min(
          2035,
          Math.max(2020, Math.round(Number(payload.activeTaxYear) || DEFAULT_APP_CONFIG.activeTaxYear))
        );
        const reminderIntervalDays = Math.min(
          60,
          Math.max(1, Math.round(Number(payload.reminderIntervalDays) || DEFAULT_APP_CONFIG.reminderIntervalDays))
        );
        const defaultTemplates =
          payload.defaultTemplates && typeof payload.defaultTemplates === 'object'
            ? (payload.defaultTemplates as Record<FilingCategory, string[]>)
            : DEFAULT_APP_CONFIG.defaultTemplates;
        batch.set(targetRef, {
          activeTaxYear,
          reminderIntervalDays,
          defaultTemplates,
          updatedByUid: adminUser.uid,
          updatedByEmail: adminEmail,
          updatedAt: serverTimestamp(),
        });
      }
    } else if (request.targetCollection === 'users') {
      const targetSnap = await getDoc(targetRef);
      const existingData = targetSnap.exists()
        ? (targetSnap.data() as Partial<UserProfile>)
        : {};
      const payload = sanitizePayloadForFirestore(request.proposedPayload);
      batch.update(targetRef, {
        twoFactorEnabled: Boolean(existingData.twoFactorEnabled),
        twoFactorLocked: existingData.twoFactorLocked !== false,
        twoFactorApprovedUntil: existingData.twoFactorApprovedUntil ?? null,
        ...payload,
      });
    }

    batch.update(reqRef, {
      status: 'APPROVED',
      reviewedByUid: adminUser.uid,
      reviewedByEmail: adminEmail,
      reviewedAt: serverTimestamp(),
      reviewNote: cleanNote,
    });

    await batch.commit();

    await logActivity({
      pageVisited: 'Danger Zone',
      actionTaken: 'APPROVE_GOVERNANCE_CHANGE',
      details: `Approved and applied ${request.category} (${request.operation}) request (${request.id}) on ${request.targetCollection}/${request.targetDocId} (${request.targetLabel}) requested by ${request.requestedByEmail}.${cleanNote ? ` Note: ${cleanNote}` : ''}`,
    });
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.WRITE,
      `change_requests/${request.id}`
    );
  }
}

export async function rejectGovernanceRequest(
  request: GovernanceChangeRequest,
  reviewNote?: string
): Promise<void> {
  const adminUser = auth.currentUser;
  if (!adminUser || !adminUser.email) {
    throw new Error('System Administrator authentication is required.');
  }
  if (!request.id) {
    throw new Error('Invalid governance request ID.');
  }

  const adminEmail = adminUser.email.toLowerCase().trim();
  const cleanNote = reviewNote && reviewNote.trim() ? clampStr(reviewNote, 500) : null;

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'change_requests', request.id), {
      status: 'REJECTED',
      reviewedByUid: adminUser.uid,
      reviewedByEmail: adminEmail,
      reviewedAt: serverTimestamp(),
      reviewNote: cleanNote,
    });
    await batch.commit();

    await logActivity({
      pageVisited: 'Danger Zone',
      actionTaken: 'REJECT_GOVERNANCE_CHANGE',
      details: `Rejected ${request.category} (${request.operation}) request (${request.id}) on ${request.targetCollection}/${request.targetDocId} (${request.targetLabel}) requested by ${request.requestedByEmail}.${cleanNote ? ` Note: ${cleanNote}` : ''}`,
    });
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.UPDATE,
      `change_requests/${request.id}`
    );
  }
}

export function subscribeToAppConfig(
  onData: (config: AppConfigSettings) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const unsub = onSnapshot(
    doc(db, 'system_settings', 'app_config'),
    (snap) => {
      if (snap.exists()) {
        const raw = snap.data() as Partial<AppConfigSettings>;
        onData({
          activeTaxYear:
            typeof raw.activeTaxYear === 'number'
              ? raw.activeTaxYear
              : DEFAULT_APP_CONFIG.activeTaxYear,
          reminderIntervalDays:
            typeof raw.reminderIntervalDays === 'number'
              ? raw.reminderIntervalDays
              : DEFAULT_APP_CONFIG.reminderIntervalDays,
          defaultTemplates: {
            'Form BE (Salaried)':
              raw.defaultTemplates?.['Form BE (Salaried)'] ||
              DEFAULT_APP_CONFIG.defaultTemplates['Form BE (Salaried)'],
            'Form B (Business / Commission)':
              raw.defaultTemplates?.['Form B (Business / Commission)'] ||
              DEFAULT_APP_CONFIG.defaultTemplates['Form B (Business / Commission)'],
            'Form M (Non-Resident)':
              raw.defaultTemplates?.['Form M (Non-Resident)'] ||
              DEFAULT_APP_CONFIG.defaultTemplates['Form M (Non-Resident)'],
          },
          updatedByUid: raw.updatedByUid ?? null,
          updatedByEmail: raw.updatedByEmail ?? null,
          updatedAt: raw.updatedAt ?? null,
        });
      } else {
        onData({ ...DEFAULT_APP_CONFIG });
      }
    },
    (error) => {
      if (onError) {
        try {
          handleFirestoreError(error, OperationType.GET, 'system_settings/app_config');
        } catch (wrapped) {
          onError(wrapped as Error);
        }
      }
    }
  );
  return trackFirestoreListener(unsub);
}

export async function updateAppConfigDirect(config: {
  activeTaxYear: number;
  reminderIntervalDays: number;
  defaultTemplates: Record<FilingCategory, string[]>;
}): Promise<void> {
  const adminUser = auth.currentUser;
  if (!adminUser || !adminUser.email) {
    throw new Error('System Administrator authentication is required.');
  }

  const activeTaxYear = Math.min(2035, Math.max(2020, Math.round(config.activeTaxYear)));
  const reminderIntervalDays = Math.min(
    60,
    Math.max(1, Math.round(config.reminderIntervalDays))
  );

  try {
    await setDoc(doc(db, 'system_settings', 'app_config'), {
      activeTaxYear,
      reminderIntervalDays,
      defaultTemplates: config.defaultTemplates,
      updatedByUid: adminUser.uid,
      updatedByEmail: adminUser.email.toLowerCase().trim(),
      updatedAt: serverTimestamp(),
    });

    await logActivity({
      pageVisited: 'App Settings',
      actionTaken: 'UPDATE_APP_CONFIG',
      details: `Updated firm app configuration: Active Tax Year = YA ${activeTaxYear}, Reminder Interval = ${reminderIntervalDays} days, updated default document templates.`,
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'system_settings/app_config');
  }
}
