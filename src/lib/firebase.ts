import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore, type Unsubscribe } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'chwong0529@gmail.com';

const app = initializeApp(firebaseConfig);

// CRITICAL: Connect to the provisioned Enterprise Firestore database ID
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const activeFirestoreListeners = new Set<Unsubscribe>();

export function trackFirestoreListener(unsubscribe: Unsubscribe): Unsubscribe {
  const safeUnsub: Unsubscribe = () => {
    if (activeFirestoreListeners.has(safeUnsub)) {
      activeFirestoreListeners.delete(safeUnsub);
      try {
        unsubscribe();
      } catch {
        // Ignore already-detached listener errors
      }
    }
  };
  activeFirestoreListeners.add(safeUnsub);
  return safeUnsub;
}

export function unsubscribeAllFirestoreListeners(): void {
  const listeners = Array.from(activeFirestoreListeners);
  activeFirestoreListeners.clear();
  for (const unsub of listeners) {
    try {
      unsub();
    } catch {
      // Ignore teardown errors
    }
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();
