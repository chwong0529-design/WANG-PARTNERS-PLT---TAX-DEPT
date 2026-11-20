import { Clock, LogOut, ShieldCheck } from 'lucide-react';

interface IdleWarningModalProps {
  showWarning: boolean;
  secondsRemaining: number;
  onStaySignedIn: () => void;
  onSignOutNow: () => void;
}

export function IdleWarningModal({
  showWarning,
  secondsRemaining,
  onStaySignedIn,
  onSignOutNow,
}: IdleWarningModalProps) {
  if (!showWarning) return null;

  const clampedSeconds = Math.max(0, Math.min(60, secondsRemaining));
  const progressPercent = (clampedSeconds / 60) * 100;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-warning-title"
      aria-describedby="idle-warning-description"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-sm">
        <div className="px-6 py-5 border-b border-slate-200 flex items-center gap-3">
          <Clock className="w-5 h-5 text-amber-600 shrink-0" aria-hidden="true" />
          <h2 id="idle-warning-title" className="text-base font-semibold text-slate-900">
            Session Expiring Due to Inactivity
          </h2>
        </div>

        <div className="p-6 space-y-5">
          <p
            id="idle-warning-description"
            className="text-sm text-slate-600 leading-relaxed"
          >
            Session Expiring Due to Inactivity — You will be automatically signed out in{' '}
            <span className="font-mono font-semibold text-slate-900 tabular-nums">
              {clampedSeconds}
            </span>{' '}
            {clampedSeconds === 1 ? 'second' : 'seconds'} to protect client tax records.
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Automatic sign-out countdown</span>
              <span className="font-mono font-semibold text-amber-700 tabular-nums">
                {clampedSeconds}s remaining
              </span>
            </div>
            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-600 transition-all duration-1000 ease-linear"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <div className="pt-2 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5">
            <button
              type="button"
              onClick={onSignOutNow}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out Now</span>
            </button>
            <button
              type="button"
              onClick={onStaySignedIn}
              autoFocus
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Stay Signed In</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
