import { useSyncExternalStore } from "react";
import type { CardView, Target, TargetSpec } from "@magic-trims/core";

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

/** Choix des cibles d'un sort qu'on lance : on clique sur des cartes ou des joueurs. */
export interface Targeting {
  sourceName: string;
  sourceId: string;
  specs: TargetSpec[];
  chosen: Target[];
  resolve: (targets: Target[] | null) => void;
}

/** Choix des modes d'un sort qu'on lance (« Choose two — » avec des cibles). */
export interface ModesRequest {
  title: string;
  labels: string[];
  min: number;
  max: number;
  resolve: (modes: number[] | null) => void;
}

/** Carte agrandie près du curseur, avec la position de la carte survolée. */
export interface Zoom {
  card: CardView;
  rect: { left: number; top: number; right: number; bottom: number };
}

/** Délai avant le zoom, proche de celui de l'infobulle de Windows. */
export const ZOOM_DELAY_MS = 500;

interface UiState {
  preview: CardView | null;
  zoom: Zoom | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  prompt: PromptRequest | null;
  targeting: Targeting | null;
  modes: ModesRequest | null;
}

let state: UiState = { preview: null, zoom: null, menu: null, prompt: null, targeting: null, modes: null };
let zoomTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const ui = {
  setPreview: (preview: CardView | null) => set({ preview }),
  /** Affiche la carte agrandie si le curseur reste dessus. */
  hoverCard(card: CardView, element: HTMLElement) {
    ui.cancelZoom();
    zoomTimer = setTimeout(() => {
      zoomTimer = null;
      if (state.menu || !element.isConnected) return;
      const r = element.getBoundingClientRect();
      set({ zoom: { card, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } } });
    }, ZOOM_DELAY_MS);
  },
  cancelZoom() {
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = null;
    if (state.zoom) set({ zoom: null });
  },
  openMenu: (x: number, y: number, items: MenuItem[]) => {
    ui.cancelZoom();
    set({ menu: { x, y, items } });
  },
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
  /** Demande les modes d'un sort modal. `null` si le joueur annule. */
  chooseModes(title: string, labels: string[], min: number, max: number): Promise<number[] | null> {
    state.modes?.resolve(null);
    return new Promise((resolve) => set({ modes: { title, labels, min, max, resolve } }));
  },
  closeModes(modes: number[] | null) {
    state.modes?.resolve(modes);
    set({ modes: null });
  },
  /** Demande les cibles d'un sort, une par une. `null` si le joueur annule. */
  chooseTargets(sourceName: string, sourceId: string, specs: TargetSpec[]): Promise<Target[] | null> {
    state.targeting?.resolve(null);
    return new Promise((resolve) => set({ targeting: { sourceName, sourceId, specs, chosen: [], resolve } }));
  },
  pickTarget(target: Target) {
    const t = state.targeting;
    if (!t) return;
    const chosen = [...t.chosen, target];
    if (chosen.length >= t.specs.length) {
      set({ targeting: null });
      t.resolve(chosen);
    } else set({ targeting: { ...t, chosen } });
  },
  /** « up to one target » : ne pas choisir les cibles restantes. */
  skipTargets() {
    const t = state.targeting;
    if (!t) return;
    set({ targeting: null });
    t.resolve(t.chosen);
  },
  cancelTargeting() {
    state.targeting?.resolve(null);
    set({ targeting: null });
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
