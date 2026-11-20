import React, { useState } from 'react';
import { ShieldAlert, X, Loader2 } from 'lucide-react';

interface GovernanceReasonModalProps {
  title: string;
  description: string;
  targetLabel: string;
  previousSummary?: string;
  confirmLabel?: string;
  requireReason?: boolean;
  minReasonLength?: number;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export function GovernanceReasonModal({
  title,
  description,
  targetLabel,
  previousSummary,
  confirmLabel = 'Submit for Admin Approval',
  requireReason = true,
  minReasonLength = 10,
  submitting = false,
  error = null,
  onCancel,
  onConfirm,
}: GovernanceReasonModalProps) {
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const trimmedLength = reason.trim().length;
  const isValid = !requireReason || trimmedLength >= minReasonLength;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (requireReason && trimmedLength < minReasonLength) {
      setLocalError(
        `Please enter a justification of at least ${minReasonLength} characters.`
      );
      return;
    }
    await onConfirm(reason.trim());
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="governance-modal-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg overflow-hidden shadow-xl">
        <div className="px-5 py-4 border-b border-red-200 bg-red-50/70 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-600 shrink-0" />
            <h2 id="governance-modal-title" className="text-sm font-semibold text-red-950">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="p-1 text-red-800/70 hover:text-red-950 rounded-md cursor-pointer"
            aria-label="Close approval modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">{description}</p>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Target Record</span>
              <span className="font-semibold text-slate-900 font-mono">{targetLabel}</span>
            </div>
            {previousSummary && (
              <div className="pt-1.5 border-t border-slate-200/80 text-slate-700 leading-relaxed">
                <span className="font-medium text-slate-900">Change Summary: </span>
                <span>{previousSummary}</span>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="governance-reason-textarea"
                className="text-xs font-medium text-slate-700"
              >
                {requireReason
                  ? 'Mandatory Justification'
                  : 'Reason / Compliance Note (Optional)'}
              </label>
              {requireReason && (
                <span
                  className={`text-[11px] font-mono tabular-nums ${
                    isValid ? 'text-teal-700' : 'text-slate-400'
                  }`}
                >
                  {trimmedLength} / {minReasonLength} min chars
                </span>
              )}
            </div>
            <textarea
              id="governance-reason-textarea"
              rows={3}
              maxLength={600}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              placeholder="Explain why this change is required for the System Administrator review..."
              className="w-full px-3 py-2 text-xs text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600/20 focus:border-red-600 resize-none"
              autoFocus
            />
          </div>

          {(localError || error) && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
              {localError || error}
            </div>
          )}

          <div className="pt-2 border-t border-slate-200 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !isValid}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-45 transition-colors cursor-pointer"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{confirmLabel}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
