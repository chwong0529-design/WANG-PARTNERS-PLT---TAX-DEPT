import { useCallback, useEffect, useRef, useState } from 'react';

export const IDLE_ACTIVITY_STORAGE_KEY = 'cukaidesk_last_activity';
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)
export const IDLE_WARNING_MS = 9 * 60 * 1000; // 9 minutes (540,000 ms)
const ACTIVITY_THROTTLE_MS = 5 * 1000; // At most once every 5 seconds

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
  'click',
];

function readStoredActivity(): number | null {
  try {
    const raw = window.localStorage.getItem(IDLE_ACTIVITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredActivity(timestamp = Date.now()): void {
  try {
    window.localStorage.setItem(IDLE_ACTIVITY_STORAGE_KEY, String(timestamp));
  } catch {
    // Ignore storage quota or private-mode restrictions
  }
}

export function clearStoredActivity(): void {
  try {
    window.localStorage.removeItem(IDLE_ACTIVITY_STORAGE_KEY);
  } catch {
    // Ignore storage restrictions
  }
}

export interface UseIdleLogoutOptions {
  enabled: boolean;
  onIdleTimeout: () => void | Promise<void>;
  idleTimeoutMs?: number;
  warningThresholdMs?: number;
}

export interface UseIdleLogoutReturn {
  showWarning: boolean;
  secondsRemaining: number;
  staySignedIn: () => void;
}

export function useIdleLogout({
  enabled,
  onIdleTimeout,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  warningThresholdMs = IDLE_WARNING_MS,
}: UseIdleLogoutOptions): UseIdleLogoutReturn {
  const [showWarning, setShowWarning] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(60);

  const onIdleTimeoutRef = useRef(onIdleTimeout);
  onIdleTimeoutRef.current = onIdleTimeout;

  const lastActivityRef = useRef<number>(Date.now());
  const lastThrottledWriteRef = useRef<number>(0);
  const showWarningRef = useRef<boolean>(false);
  const timeoutTriggeredRef = useRef<boolean>(false);

  const updateWarningState = useCallback((warning: boolean, seconds: number) => {
    showWarningRef.current = warning;
    setShowWarning(warning);
    setSecondsRemaining(seconds);
  }, []);

  const staySignedIn = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    lastThrottledWriteRef.current = now;
    timeoutTriggeredRef.current = false;
    writeStoredActivity(now);
    updateWarningState(false, Math.ceil((idleTimeoutMs - warningThresholdMs) / 1000));
  }, [idleTimeoutMs, warningThresholdMs, updateWarningState]);

  useEffect(() => {
    if (!enabled) {
      timeoutTriggeredRef.current = false;
      updateWarningState(false, Math.ceil((idleTimeoutMs - warningThresholdMs) / 1000));
      return;
    }

    timeoutTriggeredRef.current = false;

    // Preserve existing timestamp if present (catches sleeping/reopened tabs),
    // otherwise seed fresh activity timestamp now.
    const stored = readStoredActivity();
    if (stored !== null) {
      lastActivityRef.current = stored;
    } else {
      const now = Date.now();
      lastActivityRef.current = now;
      lastThrottledWriteRef.current = now;
      writeStoredActivity(now);
    }

    const evaluateIdleState = () => {
      if (timeoutTriggeredRef.current) return;

      const latestStored = readStoredActivity();
      if (latestStored !== null && latestStored > lastActivityRef.current) {
        lastActivityRef.current = latestStored;
      }

      const elapsed = Date.now() - lastActivityRef.current;

      if (elapsed >= idleTimeoutMs) {
        timeoutTriggeredRef.current = true;
        updateWarningState(false, 0);
        void onIdleTimeoutRef.current();
        return;
      }

      if (elapsed >= warningThresholdMs) {
        const remainingSeconds = Math.max(0, Math.ceil((idleTimeoutMs - elapsed) / 1000));
        updateWarningState(true, remainingSeconds);
        return;
      }

      if (showWarningRef.current) {
        updateWarningState(false, Math.ceil((idleTimeoutMs - warningThresholdMs) / 1000));
      }
    };

    const handleUserActivity = () => {
      // Once the warning modal is displayed, require explicit "Stay Signed In" click
      // (or activity synced from another tab via storage event) to dismiss it.
      if (showWarningRef.current || timeoutTriggeredRef.current) return;

      const now = Date.now();
      lastActivityRef.current = now;

      if (now - lastThrottledWriteRef.current >= ACTIVITY_THROTTLE_MS) {
        lastThrottledWriteRef.current = now;
        writeStoredActivity(now);
      }
    };

    const handleStorageEvent = (event: StorageEvent) => {
      if (event.key !== IDLE_ACTIVITY_STORAGE_KEY) return;
      if (!event.newValue) return;
      const parsed = Number(event.newValue);
      if (Number.isFinite(parsed) && parsed > lastActivityRef.current) {
        lastActivityRef.current = parsed;
        lastThrottledWriteRef.current = parsed;
        evaluateIdleState();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        evaluateIdleState();
      }
    };

    // Immediately verify elapsed idle time on mount (e.g., waking a sleeping laptop)
    evaluateIdleState();

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handleUserActivity, { passive: true });
    }
    window.addEventListener('storage', handleStorageEvent);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const intervalId = window.setInterval(evaluateIdleState, 1000);

    return () => {
      window.clearInterval(intervalId);
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handleUserActivity);
      }
      window.removeEventListener('storage', handleStorageEvent);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, idleTimeoutMs, warningThresholdMs, updateWarningState]);

  return {
    showWarning,
    secondsRemaining,
    staySignedIn,
  };
}
