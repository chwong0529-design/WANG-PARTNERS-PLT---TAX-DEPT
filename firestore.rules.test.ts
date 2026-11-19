/**
 * Security Rules Specification Verification Suite (Dirty Dozen Payloads)
 * Maps each adversarial payload from security_spec.md to the exact rule gate
 * enforced in firestore.rules.
 */

export interface AdversarialTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  actor: {
    uid: string;
    email: string;
    email_verified: boolean;
  };
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
  enforcingGate: string;
}

export const DIRTY_DOZEN_TESTS: AdversarialTestCase[] = [
  {
    id: 1,
    name: 'Unverified Email Spoofing',
    operation: 'list',
    path: '/clients',
    actor: { uid: 'spoof-1', email: 'chwong0529@gmail.com', email_verified: false },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'isVerifiedUser() requires request.auth.token.email_verified == true',
  },
  {
    id: 2,
    name: 'Cross-Client PII Read',
    operation: 'get',
    path: '/clients/TAX-2026-089',
    actor: { uid: 'client-b', email: 'other@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'isClientOwner(existing()) || isAdmin()',
  },
  {
    id: 3,
    name: 'Unfiltered Collection Scrape',
    operation: 'list',
    path: '/clients',
    actor: { uid: 'client-b', email: 'other@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'allow list checks existing().ownerUid == request.auth.uid || existing().email == request.auth.token.email',
  },
  {
    id: 4,
    name: 'Shadow Field Injection',
    operation: 'update',
    path: '/clients/TAX-2026-089',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { isAdmin: true, jobStatus: 'Book In Can Start' },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'isValidClientDoc(incoming()) enforces data.keys().hasOnly(...) and affectedKeys().hasOnly(...)',
  },
  {
    id: 5,
    name: 'Unauthorized Field Mutation by Client',
    operation: 'update',
    path: '/clients/TAX-2026-089',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { reminderCount: 0, taxYear: 2020 },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'affectedKeys().hasOnly([requiredDocuments, jobStatus, latestReminderDraft, updatedAt])',
  },
  {
    id: 6,
    name: 'Locked Engagement Tampering',
    operation: 'update',
    path: '/clients/TAX-2026-089',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { jobStatus: 'Pending Document' },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'existing().isLocked == false && incoming().isLocked == false',
  },
  {
    id: 7,
    name: 'Timestamp Forgery',
    operation: 'create',
    path: '/clients/TAX-2026-999',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { createdAt: '2020-01-01T00:00:00Z' },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'incoming().createdAt == request.time && incoming().updatedAt == request.time',
  },
  {
    id: 8,
    name: 'ID Poisoning / Resource Exhaustion',
    operation: 'create',
    path: '/clients/bad$id with spaces',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'isValidId(clientId) enforces ^[a-zA-Z0-9_\\-]+$ and size <= 128',
  },
  {
    id: 9,
    name: 'Array Overflow (Denial of Wallet)',
    operation: 'update',
    path: '/clients/TAX-2026-089',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { requiredDocuments: Array.from({ length: 25 }, (_, i) => ({ docType: `Doc ${i}` })) },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'data.requiredDocuments.size() <= 20',
  },
  {
    id: 10,
    name: 'Orphaned Subcollection Write',
    operation: 'create',
    path: '/clients/NON_EXISTENT_ID/verifications/v1',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'exists(/databases/$(database)/documents/clients/$(clientId))',
  },
  {
    id: 11,
    name: 'Reminder Forgery by Client',
    operation: 'create',
    path: '/clients/TAX-2026-089/reminders/r1',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { stage: 'Initial Outreach', channel: 'Email', message: 'Forged' },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: 'reminders create requires isAdmin()',
  },
  {
    id: 12,
    name: 'Self-Admin Promotion',
    operation: 'create',
    path: '/admins/client-a',
    actor: { uid: 'client-a', email: 'ahmad@example.com', email_verified: true },
    payload: { uid: 'client-a', email: 'ahmad@example.com', displayName: 'Attacker' },
    expectedResult: 'PERMISSION_DENIED',
    enforcingGate: '/admins/{uid} write strictly requires isAdmin()',
  },
];
