import { useSyncExternalStore } from "react";
import {
  decodeJoinCode,
  GameClient,
  websocketUrl,
  type GameAction,
  type GameView,
  type LobbyState,
} from "@magic-trims/core";
import type { HostInfo } from "../../shared/api";
import { localizer } from "./localization";
import { storage } from "./storage";

export interface ChatLine {
  fromName: string;
  text: string;
  at: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: "error" | "info";
}

export interface SessionState {
  screen: "home" | "lobby" | "game";
  connecting: boolean;
  connected: boolean;
  playerId: string | null;
  isHost: boolean;
  lobby: LobbyState | null;
  view: GameView | null;
  host: HostInfo | null;
  chat: ChatLine[];
  toasts: Toast[];
}

const initial: SessionState = {
  screen: "home",
  connecting: false,
  connected: false,
  playerId: null,
  isHost: false,
  lobby: null,
  view: null,
  host: null,
  chat: [],
  toasts: [],
};

/**
 * État de l'appli partagé par tous les écrans : la connexion à la partie,
 * le salon, la vue de la partie, le chat et les messages d'erreur.
 */
class Session {
  state: SessionState = initial;
  client: GameClient | null = null;
  private listeners = new Set<() => void>();
  private toastSeq = 0;
  /** Vue reçue de l'hôte, avant traduction des cartes. */
  private rawView: GameView | null = null;

  constructor() {
    localizer.subscribe(() => {
      if (this.rawView) this.set({ view: localizer.apply(this.rawView) });
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  toast(text: string, kind: Toast["kind"] = "error") {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts, { id, text, kind }] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), 5000);
  }

  /** Héberge une partie : lance le serveur dans l'appli et s'y connecte. */
  async host(name: string, resume: boolean) {
    const api = window.magic;
    if (!api) return this.toast("L'hébergement n'est possible que dans l'appli Windows.");
    this.set({ connecting: true });
    try {
      const info = await api.startHost({ resume });
      this.set({ host: info });
      await this.join(websocketUrl("127.0.0.1", info.port), name, { hostKey: info.hostKey });
    } catch (err) {
      this.set({ connecting: false });
      this.toast(err instanceof Error ? err.message : String(err));
    }
  }

  /** Rejoint une partie avec un code ou une adresse. */
  async joinWithCode(name: string, code: string) {
    let url: string;
    try {
      const { host, port } = decodeJoinCode(code);
      url = websocketUrl(host, port);
    } catch (err) {
      return this.toast(err instanceof Error ? err.message : String(err));
    }
    storage.setLastCode(code);
    // On reprend sa place si on avait déjà rejoint cette partie.
    const last = storage.getSession();
    const token = last && last.url === url && !last.isHost ? last.token : undefined;
    await this.join(url, name, token ? { token } : {});
  }

  private async join(url: string, name: string, extra: { hostKey?: string; token?: string }) {
    this.client?.close();
    const client = new GameClient({ url, name, ...extra });
    this.client = client;
    this.rawView = null;
    this.set({ connecting: true, chat: [], view: null, lobby: null });

    client.on("welcome", (w) => {
      storage.setSession({ url, token: w.token, name, isHost: w.isHost });
      this.set({ connected: true, connecting: false, playerId: w.playerId, isHost: w.isHost });
    });
    client.on("lobby", (lobby) => {
      this.set({ lobby, screen: lobby.started ? (this.state.view ? "game" : this.state.screen) : "lobby" });
    });
    client.on("state", (view) => {
      this.rawView = view;
      this.set({ view: localizer.apply(view), screen: "game" });
    });
    client.on("chat", (c) => this.set({ chat: [...this.state.chat.slice(-199), c] }));
    client.on("error", (e) => {
      this.toast(e.message);
      if (e.fatal) this.leave();
    });
    client.on("disconnected", ({ willReconnect }) => {
      this.set({ connected: false });
      if (willReconnect) this.toast("Connexion perdue, reconnexion…", "info");
    });

    try {
      await client.connect();
    } catch (err) {
      if (this.client === client) {
        this.client = null;
        this.set({ connecting: false });
      }
      this.toast(err instanceof Error ? err.message : String(err));
    }
  }

  /** Heure de la dernière action envoyée par ce joueur (pour le son de priorité). */
  lastActAt = 0;

  /** Envoie une action ; affiche l'erreur si l'hôte la refuse. */
  async act(action: GameAction): Promise<boolean> {
    if (!this.client) return false;
    this.lastActAt = Date.now();
    const result = await this.client.act(action);
    if (!result.ok && result.error) this.toast(result.error);
    return result.ok;
  }

  leave() {
    this.client?.close();
    this.client = null;
    if (this.state.isHost) void window.magic?.stopHost();
    this.rawView = null;
    this.set({ ...initial, toasts: this.state.toasts });
  }
}

export const session = new Session();

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, () => session.state);
}
