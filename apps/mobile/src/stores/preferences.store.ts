import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Language } from '@tw/i18n';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type AppearancePreference = 'system' | 'light' | 'dark';

interface PreferencesState {
  /** null = follow the device language (detected on launch). */
  language: Language | null;
  appearance: AppearancePreference;
  /** The member closed the "turn on notifications" card on Home. */
  pushPromptDismissed: boolean;
  setLanguage: (language: Language | null) => void;
  setAppearance: (appearance: AppearancePreference) => void;
  dismissPushPrompt: () => void;
}

interface PersistedV1 {
  language: Language | null;
  appearance: AppearancePreference;
  previewRole?: unknown;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      language: null,
      appearance: 'system',
      pushPromptDismissed: false,
      setLanguage: (language) => set({ language }),
      setAppearance: (appearance) => set({ appearance }),
      dismissPushPrompt: () => set({ pushPromptDismissed: true }),
    }),
    {
      name: 'tw.preferences.v1',
      // v2: the Phase 2 development role preview was removed (roles now come from the session).
      version: 2,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as PersistedV1;
        if (version < 2) {
          return { language: state.language ?? null, appearance: state.appearance ?? 'system' };
        }
        return state;
      },
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ language, appearance, pushPromptDismissed }) => ({
        language,
        appearance,
        pushPromptDismissed,
      }),
    },
  ),
);
