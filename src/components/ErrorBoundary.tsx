import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { signOut } from 'firebase/auth';
import { auth } from '../lib/firebase';

interface State {
  hasError: boolean;
  message: string;
  isQuotaError: boolean;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '', isQuotaError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    const raw = error?.message || 'An unexpected application error occurred.';
    let parsedMessage = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === 'string') {
        parsedMessage = `${parsed.error}${parsed.path ? ` (${parsed.operationType} on ${parsed.path})` : ''}`;
      }
    } catch {
      // Keep raw error message
    }
    const isQuotaError = parsedMessage.toLowerCase().includes('quota exceeded');
    return { hasError: true, message: parsedMessage, isQuotaError };
  }

  componentDidCatch(error: Error) {
    console.error('CukaiDesk ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white border border-slate-200 rounded-xl p-8">
            <div className="flex items-center gap-3 text-red-700 mb-4">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h1 className="text-lg font-semibold text-slate-900">
                {this.state.isQuotaError
                  ? 'Firestore Daily Quota Reached'
                  : 'Something went wrong'}
              </h1>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed mb-6 break-words">
              {this.state.message}
            </p>
            {this.state.isQuotaError && (
              <p className="text-xs text-slate-500 mb-6">
                Free-tier daily Firestore quotas reset the following day. You can review quota details under the Spark plan Enterprise edition section in Firebase pricing.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Reload Application</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await signOut(auth);
                    window.location.reload();
                  } catch {
                    window.location.reload();
                  }
                }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
