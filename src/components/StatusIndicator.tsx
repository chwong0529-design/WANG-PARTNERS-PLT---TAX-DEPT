import { CheckCircle2, Clock, AlertCircle, XCircle } from 'lucide-react';
import type { DocumentStatus, JobStatus } from '../types/tax';

export function JobStatusText({ status }: { status: JobStatus }) {
  if (status === 'Book In Can Start') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 whitespace-nowrap">
        <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" aria-hidden="true" />
        <span>Book In Can Start</span>
      </span>
    );
  }
  if (status === 'Pending Document') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 whitespace-nowrap">
        <Clock className="w-4 h-4 shrink-0 text-amber-600" aria-hidden="true" />
        <span>Pending Document</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700 whitespace-nowrap">
      <AlertCircle className="w-4 h-4 shrink-0 text-red-600" aria-hidden="true" />
      <span>No Book In</span>
    </span>
  );
}

export function DocumentStatusText({ status }: { status: DocumentStatus }) {
  if (status === 'Verified') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
        <span>Verified</span>
      </span>
    );
  }
  if (status === 'Needs Review') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-600" aria-hidden="true" />
        <span>Needs Review</span>
      </span>
    );
  }
  if (status === 'Invalid') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        <XCircle className="w-3.5 h-3.5 shrink-0 text-amber-600" aria-hidden="true" />
        <span>Needs Re-upload</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 whitespace-nowrap">
      <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-600" aria-hidden="true" />
      <span>Missing</span>
    </span>
  );
}

export function formatMyr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  return `RM ${amount.toLocaleString('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
