import { FileCheck2, ShieldCheck, ArrowRight, BellRing, FolderKanban } from 'lucide-react';

interface SignInScreenProps {
  onSignIn: () => void;
  signingIn: boolean;
  error: string | null;
}

export function SignInScreen({ onSignIn, signingIn, error }: SignInScreenProps) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="w-full bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between gap-8">
        <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 font-display">
          CukaiDesk
        </span>
        <span className="text-xs text-slate-500 hidden sm:inline whitespace-nowrap">
          Malaysia Personal Tax · LHDN YA 2026 Document Tracking
        </span>
        <button
          type="button"
          onClick={onSignIn}
          disabled={signingIn}
          className="px-4 py-2 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {signingIn ? 'Signing in...' : 'Sign in with Google'}
        </button>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        <div className="lg:col-span-7 space-y-6">
          <p className="text-xs font-medium tracking-wide text-teal-700">
            Personal Tax Operations · Malaysia LHDN Compliance
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 leading-tight max-w-2xl">
            Collect, verify, and book in personal tax documents automatically.
          </h1>
          <p className="text-base text-slate-600 leading-relaxed max-w-xl">
            CukaiDesk pairs a taxpayer upload portal with Gemini 2.5 Flash multimodal document classification. Inspect EA Forms, EPF/KWSP statements, CP58 vouchers, and medical receipts the moment clients upload them—and trigger itemized missing-document follow-ups without manual chasing.
          </p>

          <div className="pt-2 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onSignIn}
              disabled={signingIn}
              className="inline-flex items-center gap-2.5 px-6 py-3 text-sm font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              <span>{signingIn ? 'Connecting to Google...' : 'Continue with Google Account'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <span className="text-xs text-slate-500">
              Firebase Authentication · Role-aware Staff &amp; Client Portal
            </span>
          </div>

          {error && (
            <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 max-w-xl">
              {error}
            </div>
          )}
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
          <div className="p-6 flex items-start gap-4">
            <FileCheck2 className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                01. Multimodal Document Verification
              </h2>
              <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                Gemini 2.5 Flash reads uploaded PDFs and scanned images, verifies the Year of Assessment, extracts MYR totals, and updates each required checklist line automatically.
              </p>
            </div>
          </div>

          <div className="p-6 flex items-start gap-4">
            <FolderKanban className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                02. Real-Time Job Status Transitions
              </h2>
              <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                Engagements move cleanly from <span className="font-medium text-red-700">No Book In</span> to <span className="font-medium text-amber-700">Pending Document</span> to <span className="font-medium text-emerald-700">Book In Can Start</span> as required items are verified.
              </p>
            </div>
          </div>

          <div className="p-6 flex items-start gap-4">
            <BellRing className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                03. Itemized Missing-Document Follow-Ups
              </h2>
              <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                Automatically flags 7-day non-responders and drafts tailored Email &amp; WhatsApp reminders listing only the exact documents still outstanding.
              </p>
            </div>
          </div>

          <div className="p-5 bg-slate-50/70 flex items-center gap-3 text-xs text-slate-600 rounded-b-xl">
            <ShieldCheck className="w-4 h-4 text-slate-500 shrink-0" />
            <span>
              Secured with Cloud Firestore strict per-client PII isolation and verified Google identities.
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
