import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs` (render stays pure: no Date.now() in render).
 * Used for "has the training started", deadlines and default form values.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
