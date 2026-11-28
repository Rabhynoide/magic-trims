import type { GameAction } from "./actions.js";
import type { DeckIssue } from "./deck/validate.js";
import type { ResolvedDeck } from "./deck/resolve.js";
import type { CardData, GameModeType, GameSettings, PlayerId } from "./types.js";
import type { GameView } from "./view.js";

/**
 * Messages échangés entre l'appli de chaque joueur et l'hôte de la partie,
 * en JSON sur une connexion WebSocket.
 */
export const PROTOCOL_VERSION = 1;

/** Port utilisé par défaut pour héberger une partie. */
export const DEFAULT_PORT = 47474;

/** Version de l'appli d'un joueur (affichée dans le salon). */
export interface AppVersion {
  /** Numéro de version, ex. `0.1.212`. */
  version: string;
  /** Commit du code, quand il est connu (identifie exactement le code joué). */
  commit?: string;
}

/**
 * Deux joueurs ont-ils le même code ? On compare le commit quand les deux le
 * connaissent (une appli lancée avec `npm run app` garde le numéro de version
 * du dépôt), sinon le numéro de version.
 */
export function sameAppVersion(a: AppVersion, b: AppVersion): boolean {
  if (a.commit && b.commit) return a.commit === b.commit;
  return a.version === b.version;
}

/** Texte court d'une version, ex. `0.1.212 (3fa9c2e)`. */
export function formatAppVersion(v: AppVersion): string {
  return v.commit ? `${v.version} (${v.commit.slice(0, 7)})` : v.version;
}

export interface LobbyPlayer {
  id: PlayerId;
  name: string;
  isHost: boolean;
  connected: boolean;
  /** Joueur tenu par l'ordinateur. */
  isBot?: boolean;
  /** Résumé du deck choisi, ou `null` s'il n'a pas encore été envoyé. */
  deck: {
    commanders: string[];
    cardCount: number;
    /** Problèmes de construction pour le mode choisi. */
    issues: DeckIssue[];
    legal: boolean;
  } | null;
  /** Nombre de machinations (mode Archenemy). */
  schemeCount: number;
  /** Version de son appli (absente pour un bot ou une appli trop ancienne). */
  app?: AppVersion;
}

/** Réglages de la partie choisis par l'hôte dans le salon. */
export interface LobbyConfig {
  mode: GameModeType;
  teams?: PlayerId[][];
  archenemyId?: PlayerId;
  settings?: Partial<GameSettings>;
  /** Accepter les decks non légaux pour le mode (vrai par défaut, entre amis). */
  allowIllegalDecks?: boolean;
}

export interface LobbyState {
  players: LobbyPlayer[];
  config: LobbyConfig;
  /** Nombre de plans dans la pioche de plans (variante Planechase). */
  planeCount: number;
  started: boolean;
  maxPlayers: number;
}

export type ClientMessage =
  | {
      type: "hello";
      protocol: number;
      name: string;
      /** Jeton reçu lors d'une connexion précédente, pour reprendre sa place. */
      token?: string;
      /** Clé secrète connue seulement de l'appli qui héberge. */
      hostKey?: string;
      /** Version de l'appli du joueur, pour signaler les différences dans le salon. */
      app?: AppVersion;
    }
  | { type: "setDeck"; deck: ResolvedDeck; schemes?: CardData[] }
  /** Hôte seulement. */
  | { type: "configure"; config: LobbyConfig; planarDeck?: CardData[] }
  /** Hôte seulement. */
  | { type: "start" }
  /** Hôte seulement, avant le début de la partie. */
  | { type: "kick"; playerId: PlayerId }
  /** Hôte seulement, avant le début de la partie : ajoute un adversaire joué par l'ordinateur. */
  | { type: "addBot"; deck: ResolvedDeck }
  | { type: "action"; action: GameAction; requestId?: string }
  | { type: "chat"; text: string }
  | { type: "ping" };

export type ServerMessage =
  | { type: "welcome"; playerId: PlayerId; token: string; isHost: boolean }
  | { type: "lobby"; lobby: LobbyState }
  /**
   * Vue de la partie pour ce joueur. Pour alléger les envois, `cardData` ne
   * contient que les cartes pas encore envoyées à ce joueur : le client
   * garde les précédentes en cache.
   */
  | { type: "state"; view: GameView }
  | { type: "actionResult"; requestId?: string; ok: boolean; error?: string }
  | { type: "chat"; fromId: PlayerId; fromName: string; text: string; at: number }
  /** `fatal` : la connexion va être fermée (refus, exclusion…). */
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "pong" };

// ---------------------------------------------------------------------------
// Code de connexion : l'adresse IPv4 et le port de l'hôte, en 10 caractères
// faciles à dicter (alphabet de Crockford, sans I, L, O ni U).

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeJoinCode(ip: string, port: number): string {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Adresse IPv4 invalide : ${ip}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port invalide : ${port}`);
  let value = 0n;
  for (const p of [...parts, port >> 8, port & 0xff]) value = (value << 8n) | BigInt(p);
  let code = "";
  for (let i = 0; i < 10; i++) {
    code = ALPHABET[Number(value & 31n)]! + code;
    value >>= 5n;
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Retrouve l'adresse de l'hôte à partir d'un code de connexion, ou d'une
 * adresse tapée telle quelle (« 192.168.1.20 », « 82.64.1.2:47474 »).
 */
export function decodeJoinCode(input: string): { host: string; port: number } {
  const text = input.trim();
  const address = /^([\w.-]+)(?::(\d+))?$/.exec(text);
  if (address && (text.includes(".") || text.includes(":") || text === "localhost")) {
    return { host: address[1]!, port: address[2] ? Number(address[2]) : DEFAULT_PORT };
  }
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (clean.length !== 10 || [...clean].some((c) => !ALPHABET.includes(c))) {
    throw new Error("Code de connexion invalide.");
  }
  let value = 0n;
  for (const c of clean) value = (value << 5n) | BigInt(ALPHABET.indexOf(c));
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  const port = (bytes[4]! << 8) | bytes[5]!;
  if (port === 0) throw new Error("Code de connexion invalide.");
  return { host: bytes.slice(0, 4).join("."), port };
}

export function websocketUrl(host: string, port: number): string {
  return `ws://${host}:${port}`;
}
