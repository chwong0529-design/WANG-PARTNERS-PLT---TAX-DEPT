import React, { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import {
  ALL_STANDARD_DOC_TYPES,
  BLUEPRINT_LIMITS,
  MALAYSIA_DOC_PRESETS,
  type FilingCategory,
} from '../types/tax';
import { createTaxClient, sanitizeClientId } from '../lib/taxService';
import { logActivity } from '../lib/auditService';

interface NewClientModalProps {
  defaultEmail?: string;
  defaultName?: string;
  lockEmailToUser?: boolean;
  existingIds: string[];
  onClose: () => void;
  onCreated: (clientId: string) => void;
}

export function NewClientModal({
  defaultEmail = '',
  defaultName = '',
  lockEmailToUser = false,
  existingIds,
  onClose,
  onCreated,
}: NewClientModalProps) {
  const suggestedNum = String(existingIds.length + 102).padStart(3, '0');
  const [clientId, setClientId] = useState(`TAX-2026-${suggestedNum}`);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState('+6012');
  const [taxYear, setTaxYear] = useState(2026);
  const [filingCategory, setFilingCategory] = useState<FilingCategory>('Form BE (Salaried)');
  const [docTypes, setDocTypes] = useState<string[]>([
    ...MALAYSIA_DOC_PRESETS['Form BE (Salaried)'],
  ]);
  const [customDoc, setCustomDoc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCategoryChange = (cat: FilingCategory) => {
    setFilingCategory(cat);
    setDocTypes([...MALAYSIA_DOC_PRESETS[cat]]);
  };

  const handleAddDoc = (docName: string) => {
    const trimmed = docName.trim();
    if (!trimmed) return;
    if (docTypes.length >= BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS) return;
    if (docTypes.some((d) => d.toLowerCase() === trimmed.toLowerCase())) return;
    setDocTypes((prev) => [...prev, trimmed]);
    setCustomDoc('');
  };

  const handleRemoveDoc = (idx: number) => {
    setDocTypes((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Taxpayer full name is required.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setError('A valid taxpayer email address is required.');
      return;
    }
    if (docTypes.length === 0) {
      setError('Include at least one required tax document.');
      return;
    }
    const cleanId = sanitizeClientId(clientId);
    if (existingIds.includes(cleanId)) {
      setError(`Client Reference ID ${cleanId} already exists. Please use a unique ID.`);
      return;
    }

    setSubmitting(true);
    try {
      const createdId = await createTaxClient({
        clientId: cleanId,
        name,
        email,
        phone,
        taxYear,
        filingCategory,
        docTypes,
      });
      void logActivity({
        pageVisited: 'New Client Modal',
        actionTaken: 'CREATE_CLIENT',
        details: `Created client ${createdId} (${name.trim()}, ${email.trim().toLowerCase()}, ${filingCategory}, YA ${taxYear}) with ${docTypes.length} required document${docTypes.length === 1 ? '' : 's'}.`,
      });
      onCreated(createdId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tax file.');
      setSubmitting(false);
    }
  };

  const availableQuickAdds = ALL_STANDARD_DOC_TYPES.filter(
    (d) => !docTypes.includes(d)
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-client-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 id="new-client-title" className="text-base font-semibold text-slate-900">
              {lockEmailToUser ? 'Open My YA 2026 Personal Tax File' : 'New Personal Tax Client File'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Configure taxpayer details and required Malaysia LHDN document checklist.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Client Reference ID
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                maxLength={BLUEPRINT_LIMITS.CLIENT_ID_MAX}
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
                placeholder="TAX-2026-102"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Year of Assessment (YA)
              </label>
              <select
                value={taxYear}
                onChange={(e) => setTaxYear(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
              >
                <option value={2026}>YA 2026</option>
                <option value={2025}>YA 2025</option>
                <option value={2024}>YA 2024</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Taxpayer Full Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={BLUEPRINT_LIMITS.NAME_MAX}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
                placeholder="e.g. Ahmad Razak bin Ismail"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Email Address (Portal Login Match)
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={lockEmailToUser}
                maxLength={BLUEPRINT_LIMITS.EMAIL_MAX}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
                placeholder="ahmad@example.my"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                WhatsApp / Mobile Number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
                placeholder="+60123456789"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                LHDN Filing Category
              </label>
              <select
                value={filingCategory}
                onChange={(e) => handleCategoryChange(e.target.value as FilingCategory)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
              >
                <option value="Form BE (Salaried)">Form BE (Salaried)</option>
                <option value="Form B (Business / Commission)">Form B (Business / Commission)</option>
                <option value="Form M (Non-Resident)">Form M (Non-Resident)</option>
              </select>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-800">
                Required Document Checklist ({docTypes.length} / {BLUEPRINT_LIMITS.MAX_REQUIRED_DOCUMENTS})
              </label>
              <span className="text-xs text-slate-500">
                Gemini 2.5 Flash verifies uploads against this list
              </span>
            </div>

            <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50/40 mb-3">
              {docTypes.map((docName, idx) => (
                <div
                  key={`${docName}-${idx}`}
                  className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-sm text-slate-800"
                >
                  <span>{docName}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveDoc(idx)}
                    className="p-1 text-slate-400 hover:text-red-700 rounded transition-colors cursor-pointer"
                    aria-label={`Remove ${docName}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={customDoc}
                onChange={(e) => setCustomDoc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddDoc(customDoc);
                  }
                }}
                placeholder="Add custom required document (e.g. Rental Income Schedule)"
                className="flex-1 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-700"
              />
              <button
                type="button"
                onClick={() => handleAddDoc(customDoc)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add Item
              </button>
            </div>

            {availableQuickAdds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">Quick add:</span>
                {availableQuickAdds.slice(0, 5).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => handleAddDoc(item)}
                    className="text-teal-700 hover:text-teal-900 underline underline-offset-2 cursor-pointer"
                  >
                    + {item}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              {submitting ? 'Creating File...' : 'Create Tax File'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
