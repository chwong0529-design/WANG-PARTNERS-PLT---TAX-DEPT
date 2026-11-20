import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Timestamp,
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
import type { UserProfile, UserRole } from '../types/tax';

export interface AuditLogEntry {
  id?: string;
  timestamp: Timestamp | null;
  userId: string;
  userEmail: string;
  userRole: UserRole;
  pageVisited: string;
  actionTaken: string;
  details: string;
}

export interface LogActivityParams {
  pageVisited: string;
  actionTaken: string;
  details: string;
}

const AUDIT_LIMITS = {
  PAGE_VISITED_MAX: 160,
  ACTION_TAKEN_MAX: 80,
  DETAILS_MAX: 1500,
  EMAIL_MAX: 160,
} as const;

let cachedAuditUser: { uid: string; email: string; role: UserRole } | null = null;

export function setAuditUserContext(profile: UserProfile | null): void {
  if (!profile) {
    cachedAuditUser = null;
    return;
  }
  cachedAuditUser = {
    uid: profile.uid,
    email: profile.email,
    role: profile.role,
  };
}

function clampAuditString(value: string, maxLen: number): string {
  return value.trim().slice(0, maxLen);
}

async function resolveCurrentUserRole(uid: string, email: string): Promise<UserRole> {
  if (cachedAuditUser && cachedAuditUser.uid === uid) {
    return cachedAuditUser.role;
  }
  if (email.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()) {
    return 'administrator';
  }
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      const role = (snap.data() as Partial<UserProfile>).role;
      if (role === 'administrator' || role === 'manager' || role === 'user') {
        cachedAuditUser = { uid, email, role };
        return role;
      }
    }
  } catch {
    // Non-blocking fallback
  }
  return 'user';
}

/**
 * Append an immutable audit log entry to the `audit_logs` collection.
 * Wrapped in try/catch so logging never blocks or crashes user workflows.
 * Intentionally append-only: no updateDoc or deleteDoc operations exist.
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser || !currentUser.uid || !currentUser.email) {
      return;
    }

    const userEmail = clampAuditString(currentUser.email, AUDIT_LIMITS.EMAIL_MAX);
    const userRole = await resolveCurrentUserRole(currentUser.uid, userEmail);
    const pageVisited =
      clampAuditString(params.pageVisited, AUDIT_LIMITS.PAGE_VISITED_MAX) || 'Unknown Page';
    const actionTaken =
      clampAuditString(params.actionTaken, AUDIT_LIMITS.ACTION_TAKEN_MAX) || 'USER_ACTION';
    const details = clampAuditString(params.details, AUDIT_LIMITS.DETAILS_MAX);

    await addDoc(collection(db, 'audit_logs'), {
      timestamp: serverTimestamp(),
      userId: currentUser.uid,
      userEmail,
      userRole,
      pageVisited,
      actionTaken,
      details,
    });
  } catch (err) {
    // Never interrupt or throw into user workflows on audit logging failures
    console.error('Audit log write failed:', err);
  }
}

/**
 * Real-time read-only subscription to immutable audit logs, ordered newest first.
 * Restricted by Firestore security rules to `administrator` and `manager` roles.
 */
export function subscribeToAuditLogs(
  onData: (entries: AuditLogEntry[]) => void,
  onError: (err: Error) => void,
  maxEntries = 500
): Unsubscribe {
  const q = query(
    collection(db, 'audit_logs'),
    orderBy('timestamp', 'desc'),
    limit(maxEntries)
  );

  const unsub = onSnapshot(
    q,
    (snapshot) => {
      const rows: AuditLogEntry[] = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<AuditLogEntry, 'id'>),
      }));
      onData(rows);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'audit_logs');
      } catch (wrapped) {
        onError(wrapped as Error);
      }
    }
  );

  return trackFirestoreListener(unsub);
}

const mytDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const mytDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kuala_Lumpur',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatMytTimestamp(ts: Timestamp | null | undefined): string {
  if (!ts || typeof ts.toDate !== 'function') {
    return 'Pending server time';
  }
  const parts = mytDateTimeFormatter.formatToParts(ts.toDate());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} MYT`;
}

export function getMytDateKey(ts: Timestamp | null | undefined): string | null {
  if (!ts || typeof ts.toDate !== 'function') {
    return null;
  }
  return mytDateFormatter.format(ts.toDate());
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

export function exportAuditLogsToCsv(entries: AuditLogEntry[]): string {
  const headers = [
    'Timestamp (MYT)',
    'User Email',
    'Role',
    'Page Visited',
    'Action Taken',
    'Details',
  ];

  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...entries.map((entry) =>
      [
        formatMytTimestamp(entry.timestamp),
        entry.userEmail || '',
        entry.userRole || '',
        entry.pageVisited || '',
        entry.actionTaken || '',
        entry.details || '',
      ]
        .map(escapeCsvCell)
        .join(',')
    ),
  ];

  const csvContent = `\uFEFF${lines.join('\r\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const dateStamp = mytDateFormatter.format(new Date());
  const fileName = `cukaidesk-audit-log-${dateStamp}.csv`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return fileName;
}
