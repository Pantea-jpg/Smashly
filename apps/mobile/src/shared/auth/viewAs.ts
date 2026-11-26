import type { ViewSession } from '@tw/contracts';
import { create } from 'zustand';

interface ViewAsState {
  /** Set while an admin views the app as a user. Memory only: it never survives a restart. */
  session: ViewSession | null;
  setSession: (session: ViewSession | null) => void;
}

export const useViewAsStore = create<ViewAsState>()((set) => ({
  session: null,
  setSession: (session) => set({ session }),
}));

/** False in View-as mode: screens hide every control that would change data. */
export function useCanMutate(): boolean {
  return useViewAsStore((s) => s.session === null);
}

export function useViewAsSession(): ViewSession | null {
  return useViewAsStore((s) => s.session);
}
