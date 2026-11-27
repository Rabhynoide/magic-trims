import { useCallback, useEffect, useState } from "react";
import type { SharedDeck } from "@magic-trims/core";
import type { CentralResult } from "../../shared/api";
import { session } from "./session";
import { storage, type CentralSettings, type SavedDeck } from "./storage";

/**
 * Groupe d'amis sur le serveur central facultatif : connexion et decks
 * partagés. Si le serveur est injoignable, seul l'onglet « Communauté »
 * l'indique ; le reste de l'appli fonctionne comme sans lui.
 */

export interface Community {
  settings: CentralSettings | null;
  status: "off" | "loading" | "ok" | "error";
  error?: string;
  decks: SharedDeck[];
  busy: boolean;
  refresh(): void;
  connect(url: string, code: string, name: string): Promise<boolean>;
  disconnect(): void;
  /** Partage (ou met à jour) un de mes decks. */
  share(deck: SavedDeck): Promise<void>;
  unshare(id: string): Promise<void>;
  /** Ce deck est-il partagé par moi ? */
  isSharedByMe(id: string): boolean;
  isMine(deck: SharedDeck): boolean;
}

function failure<T>(result: CentralResult<T>): string | null {
  return result.ok ? null : result.error;
}

export function useCommunity(): Community {
  const api = window.magic?.central;
  const [settings, setSettings] = useState<CentralSettings | null>(storage.getCentral());
  const [status, setStatus] = useState<Community["status"]>(settings ? "loading" : "off");
  const [error, setError] = useState<string>();
  const [decks, setDecks] = useState<SharedDeck[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!settings) {
      setStatus("off");
      setDecks([]);
      return;
    }
    if (!api) {
      setStatus("error");
      setError("le serveur central n'est accessible que dans l'appli Windows.");
      return;
    }
    setStatus("loading");
    void api.listDecks(settings).then((r) => {
      if (r.ok) {
        setDecks(r.value);
        setStatus("ok");
      } else {
        setError(r.error);
        setStatus("error");
      }
    });
  }, [api, settings]);

  useEffect(refresh, [refresh]);

  const connect = async (url: string, code: string, name: string) => {
    if (!api) {
      session.toast("Le serveur central n'est accessible que dans l'appli Windows.");
      return false;
    }
    setBusy(true);
    try {
      const r = await api.join(url, code, name);
      if (!r.ok) {
        session.toast(`Impossible de rejoindre le groupe : ${r.error}`);
        return false;
      }
      const next: CentralSettings = { url: r.value.url, token: r.value.token, member: r.value.member, group: r.value.group };
      storage.setCentral(next);
      setSettings(next);
      session.toast(`Tu as rejoint le groupe « ${r.value.group.name} ».`, "info");
      return true;
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    storage.setCentral(null);
    setSettings(null);
  };

  const share = async (deck: SavedDeck) => {
    if (!api || !settings) return;
    setBusy(true);
    const r = await api.shareDeck(settings, { id: deck.id, name: deck.name, text: deck.text, deck: deck.deck });
    setBusy(false);
    const err = failure(r);
    if (err) return session.toast(`Partage impossible : ${err}`);
    session.toast(`« ${deck.name} » est partagé avec le groupe.`, "info");
    refresh();
  };

  const unshare = async (id: string) => {
    if (!api || !settings) return;
    setBusy(true);
    const r = await api.unshareDeck(settings, id);
    setBusy(false);
    const err = failure(r);
    if (err) return session.toast(`Retrait impossible : ${err}`);
    refresh();
  };

  const isMine = (deck: SharedDeck) => deck.owner.id === settings?.member.id;
  const isSharedByMe = (id: string) => decks.some((d) => d.id === id && isMine(d));

  return {
    settings,
    status,
    ...(error !== undefined ? { error } : {}),
    decks,
    busy,
    refresh,
    connect,
    disconnect,
    share,
    unshare,
    isSharedByMe,
    isMine,
  };
}
