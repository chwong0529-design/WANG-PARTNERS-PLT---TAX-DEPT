import type { Timestamp } from 'firebase/firestore';

export type UserRole = 'administrator' | 'manager' | 'user';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  assignedClientId?: string | null;
  twoFactorEnabled: boolean;
  twoFactorLocked: boolean;
  twoFactorApprovedUntil?: Timestamp | null;
  createdAt: Timestamp | null;
}

export type TwoFactorRequestType =
  | 'DISABLE_2FA'
  | 'RESET_2FA_SECRET'
  | 'CHANGE_2FA_METHOD';

export type TwoFactorRequestStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'COMPLETED';

export interface TwoFactorChangeRequest {
  id: string;
  requesterUid: string;
  requesterEmail: string;
  requesterRole: UserRole;
  requestType: TwoFactorRequestType;
  reason: string;
  status: TwoFactorRequestStatus;
  createdAt: Timestamp | null;
  reviewedByUid?: string | null;
  reviewedByEmail?: string | null;
  reviewedAt?: Timestamp | null;
}

export interface SystemSecuritySettings {
  require2faForAdminAndManager: boolean;
  updatedByUid?: string | null;
  updatedByEmail?: string | null;
  updatedAt?: Timestamp | null;
}

export interface AppConfigSettings {
  activeTaxYear: number;
  reminderIntervalDays: number;
  defaultTemplates: Record<FilingCategory, string[]>;
  updatedByUid?: string | null;
  updatedByEmail?: string | null;
  updatedAt?: Timestamp | null;
}

export type GovernanceChangeCategory =
  | 'CLIENT_DB_CHANGE'
  | 'APP_CONFIG_CHANGE'
  | 'ROLE_ELEVATION'
  | 'TWO_FACTOR_CHANGE';

export type GovernanceTargetCollection = 'clients' | 'system_settings' | 'users';
export type GovernanceOperation = 'CREATE' | 'UPDATE' | 'DELETE';
export type GovernanceRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface GovernanceChangeRequest {
  id?: string;
  category: GovernanceChangeCategory;
  targetCollection: GovernanceTargetCollection;
  targetDocId: string;
  targetLabel: string;
  operation: GovernanceOperation;
  proposedPayload: Record<string, unknown>;
  previousSummary?: string | null;
  reason: string;
  requestedByUid: string;
  requestedByEmail: string;
  requestedByRole: UserRole;
  status: GovernanceRequestStatus;
  createdAt: Timestamp | null;
  reviewedByUid?: string | null;
  reviewedByEmail?: string | null;
  reviewedAt?: Timestamp | null;
  reviewNote?: string | null;
}

export interface TwoFactorSetupResponse {
  qrCodeDataUrl: string;
  issuer: string;
  accountName: string;
  digits: number;
  periodSeconds: number;
}

export type JobStatus = 'No Book In' | 'Pending Document' | 'Book In Can Start';

export type DocumentStatus = 'Verified' | 'Needs Review' | 'Missing' | 'Invalid';

export type AnalyzeDocumentCategory =
  | 'EA Form / Employment Income'
  | 'EPF / KWSP Statement'
  | 'CP58 Commission Statement'
  | 'Medical Receipt'
  | 'Lifestyle / Tech Receipt'
  | 'Insurance / Takaful Statement'
  | 'Zakat / Approved Donation Receipt'
  | 'Dividend / Bank Interest Voucher'
  | 'Unrecognized / Blurry';

export type FilingCategory =
  | 'Form BE (Salaried)'
  | 'Form B (Business / Commission)'
  | 'Form M (Non-Resident)';

export type ReminderStage =
  | 'Initial Outreach'
  | '7-Day Follow-up'
  | 'Missing Doc Alert'
  | 'Ready for Tax Prep';

export type ReminderChannel = 'Email' | 'WhatsApp' | 'Portal';

export interface RequiredDocumentItem {
  docType: string;
  status: DocumentStatus;
  fileName: string | null;
  fileUrl: string | null;
  extractedAmount: number | null;
  taxYearValid: boolean | null;
  notes: string;
  documentCategory?: string | null;
  isLegible?: boolean | null;
  merchantOrIssuer?: string | null;
  receiptDate?: string | null;
  detectedTaxYear?: number | null;
  taxReliefCategory?: string | null;
}

export interface TaxClient {
  clientId: string;
  ownerUid: string;
  name: string;
  email: string;
  phone: string;
  taxYear: number;
  filingCategory: FilingCategory;
  jobStatus: JobStatus;
  isLocked: boolean;
  reminderCount: number;
  lastReminderSent: Timestamp | null;
  latestReminderDraft: string;
  assignedTo?: {
    uid: string;
    name: string;
    email: string;
  } | null;
  requiredDocuments: RequiredDocumentItem[];
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface AnalyzeDocumentResult {
  fileName: string;
  documentCategory: AnalyzeDocumentCategory;
  isLegible: boolean;
  merchantOrIssuer: string;
  receiptDate: string;
  taxYear: number;
  taxYearMatches: boolean;
  totalAmountMYR: number;
  taxReliefCategory: string;
  confidenceNotes: string;
  matchedChecklistItem: string;
}

export interface DetectedDocumentResult {
  fileName: string;
  documentCategory: string;
  matchedChecklistDocType?: string;
  taxpayerName?: string;
  merchantOrIssuer?: string;
  receiptDate?: string;
  taxYear?: number;
  taxYearValid: boolean;
  isLegible?: boolean;
  extractedAmount?: number;
  taxReliefCategory?: string;
  notes?: string;
}

export interface VerificationApiResponse {
  detectedDocuments: DetectedDocumentResult[];
  missingDocuments: string[];
  recommendedJobStatus: JobStatus;
  automatedReminderDraft: string;
}

export interface DocumentVerificationRecord {
  id: string;
  clientId: string;
  clientOwnerUid: string;
  clientEmail: string;
  submittedByUid: string;
  recommendedJobStatus: JobStatus;
  automatedReminderDraft: string;
  detectedDocuments: DetectedDocumentResult[];
  missingDocuments: string[];
  createdAt: Timestamp | null;
}

export interface ReminderLogRecord {
  id: string;
  clientId: string;
  clientOwnerUid: string;
  clientEmail: string;
  sentByUid: string;
  stage: ReminderStage;
  channel: ReminderChannel;
  message: string;
  missingDocuments: string[];
  createdAt: Timestamp | null;
}

export interface ReminderDraftResponse {
  subject: string;
  emailBody: string;
  whatsappBody: string;
}

// Synchronized verbatim with firebase-blueprint.json and firestore.rules
export const BLUEPRINT_LIMITS = {
  CLIENT_ID_MIN: 3,
  CLIENT_ID_MAX: 64,
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  NAME_MAX: 120,
  EMAIL_MAX: 160,
  PHONE_MAX: 32,
  TAX_YEAR_MIN: 2020,
  TAX_YEAR_MAX: 2035,
  MAX_REQUIRED_DOCUMENTS: 20,
  REMINDER_DRAFT_MAX: 2500,
  MAX_REMINDER_COUNT: 100,
} as const;

export const MALAYSIA_DOC_PRESETS: Record<FilingCategory, string[]> = {
  'Form BE (Salaried)': [
    'EA Form / Employment Income',
    'EPF / KWSP Statement',
    'Medical & Lifestyle Receipts',
    'Bank Interest / Dividend Statement',
  ],
  'Form B (Business / Commission)': [
    'CP58 Commission Statement',
    'EA Form / Employment Income',
    'EPF / KWSP Statement',
    'Business Profit & Loss Summary',
    'Medical & Lifestyle Receipts',
    'Zakat / Approved Donation Receipt',
  ],
  'Form M (Non-Resident)': [
    'EA Form / Employment Income',
    'Passport Entry & Exit Travel Schedule',
    'PCB / Monthly Tax Deduction Statement',
  ],
};

export const MALAYSIA_DOC_GUIDANCE: Record<string, string> = {
  'EA Form / Employment Income':
    'Form C.P.8A issued by your Malaysian employer showing annual remuneration, BIK, and PCB deductions.',
  'EPF / KWSP Statement':
    'Annual i-Akaun KWSP contribution statement for LHDN retirement relief (up to RM4,000).',
  'Medical & Lifestyle Receipts':
    'Hospitalisation, full medical check-up, books, electronics, sports equipment, or SSPN receipts.',
  'Bank Interest / Dividend Statement':
    'Annual bank interest summaries, unit trust distribution vouchers, or dividend statements.',
  'CP58 Commission Statement':
    'Form CP58 issued to agents, dealers, and distributors for monetary and non-monetary incentives.',
  'Zakat / Approved Donation Receipt':
    'Official Pusat Pungutan Zakat (PPZ) or LHDN Section 44(6) tax-exempt donation receipts.',
  'Insurance Statement':
    'Annual life, education, and medical insurance premium statement issued by your insurer.',
  'PCB / Monthly Tax Deduction Statement':
    'Summary of Potongan Cukai Bulanan remitted to LHDN during the assessment year.',
  'Business Profit & Loss Summary':
    'Management accounts, invoices, and allowable business expense summary for sole proprietors.',
  'Passport Entry & Exit Travel Schedule':
    'Day-count residency verification log confirming Section 7 tax residency status.',
};

export const ALL_STANDARD_DOC_TYPES = Object.keys(MALAYSIA_DOC_GUIDANCE);
