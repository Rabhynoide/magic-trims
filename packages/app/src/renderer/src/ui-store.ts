import { useSyncExternalStore } from "react";
import type { CardView } from "@magic-trims/core";

/** État d'interface local (aperçu de carte, menus, invites). */

export interface MenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export interface PromptRequest {
  title: string;
  kind: "number" | "text";
  initial: string;
  resolve: (value: string | null) => void;
}

interface UiState {
  preview: CardView | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  prompt: PromptRequest | null;
}

let state: UiState = { preview: null, menu: null, prompt: null };
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const ui = {
  setPreview: (preview: CardView | null) => set({ preview }),
  openMenu: (x: number, y: number, items: MenuItem[]) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  /** Remplace window.prompt (absent d'Electron). */
  ask(title: string, initial = "", kind: PromptRequest["kind"] = "text"): Promise<string | null> {
    return new Promise((resolve) => set({ prompt: { title, kind, initial, resolve } }));
  },
  async askNumber(title: string, initial = 1): Promise<number | null> {
    const value = await ui.ask(title, String(initial), "number");
    const n = value === null ? NaN : Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  },
  closePrompt: (value: string | null) => {
    state.prompt?.resolve(value);
    set({ prompt: null });
  },
};

export function useUi(): UiState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
