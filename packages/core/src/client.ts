import type { GameAction } from "./actions.js";
import type { ResolvedDeck } from "./deck/resolve.js";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type LobbyConfig,
  type LobbyState,
  type ServerMessage,
} from "./protocol.js";
import type { CardData, PlayerId } from "./types.js";
import type { GameView } from "./view.js";

/** Le strict nécessaire d'un WebSocket (celui du navigateur ou de Node 22+). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface GameClientOptions {
  url: string;
  name: string;
  /** Jeton d'une connexion précédente, pour reprendre sa place. */
  token?: string;
  /** Clé de l'hôte, pour l'appli qui héberge la partie. */
  hostKey?: string;
  /** Par défaut, le WebSocket global (navigateur, Electron, Node 22+). */
  createSocket?: WebSocketFactory;
  /** Se reconnecter automatiquement après une coupure (vrai par défaut). */
  autoReconnect?: boolean;
  /** Délai d'attente d'une réponse à une action, en millisecondes. */
  actionTimeoutMs?: number;
}

export interface ClientEvents {
  welcome: { playerId: PlayerId; token: string; isHost: boolean };
  lobby: LobbyState;
  state: GameView;
  chat: { fromId: PlayerId; fromName: string; text: string; at: number };
  error: { message: string; fatal: boolean };
  disconnected: { willReconnect: boolean };
}

type Listener<T> = (payload: T) => void;

/**
 * Connexion d'un joueur à une partie hébergée. Utilisée par l'interface :
 * elle garde le dernier état du salon et de la partie, et se reconnecte
 * toute seule en cas de coupure.
 */
export class GameClient {
  playerId: PlayerId | null = null;
  token: string | null;
  isHost = false;
  lobby: LobbyState | null = null;
  view: GameView | null = null;

  private socket: WebSocketLike | null = null;
  private readonly listeners = new Map<keyof ClientEvents, Set<Listener<never>>>();
  private readonly cardCache: Record<string, CardData> = {};
  private readonly pending = new Map<string, (result: { ok: boolean; error?: string }) => void>();
  private requestSeq = 0;
  private closedByUser = false;
  private fatal = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: GameClientOptions) {
    this.token = options.token ?? null;
  }

  on<K extends keyof ClientEvents>(event: K, listener: Listener<ClientEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  /** Se connecte et attend l'accueil de l'hôte. */
  connect(): Promise<ClientEvents["welcome"]> {
    this.closedByUser = false;
    this.fatal = false;
    return new Promise((resolve, reject) => {
      const offWelcome = this.on("welcome", (w) => {
        offWelcome();
        offError();
        resolve(w);
      });
      const offError = this.on("error", (e) => {
        if (!e.fatal) return;
        offWelcome();
        offError();
        reject(new Error(e.message));
      });
      const offDisconnected = this.on("disconnected", () => {
        offDisconnected();
        if (this.playerId === null) {
          offWelcome();
          offError();
          reject(new Error("Impossible de joindre l'hôte. Vérifie l'adresse et que la partie est bien lancée."));
        }
      });
      this.open();
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Au revoir");
    this.socket = null;
  }

  setDeck(deck: ResolvedDeck, schemes?: CardData[]): void {
    this.send(schemes ? { type: "setDeck", deck, schemes } : { type: "setDeck", deck });
  }

  configure(config: LobbyConfig, planarDeck?: CardData[]): void {
    this.send(planarDeck ? { type: "configure", config, planarDeck } : { type: "configure", config });
  }

  start(): void {
    this.send({ type: "start" });
  }

  kick(playerId: PlayerId): void {
    this.send({ type: "kick", playerId });
  }

  chat(text: string): void {
    this.send({ type: "chat", text });
  }

  /** Envoie une action et attend la réponse de l'hôte (acceptée ou refusée). */
  act(action: GameAction): Promise<{ ok: boolean; error?: string }> {
    const requestId = `r${++this.requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: "L'hôte ne répond pas." });
      }, this.options.actionTimeoutMs ?? 10_000);
      this.pending.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      if (!this.send({ type: "action", action, requestId })) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, error: "Pas de connexion à l'hôte." });
      }
    });
  }

  private open(): void {
    const create =
      this.options.createSocket ??
      ((url: string) => new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url));
    const socket = create(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectDelay = 1000;
      const hello: ClientMessage = { type: "hello", protocol: PROTOCOL_VERSION, name: this.options.name };
      if (this.token) hello.token = this.token;
      if (this.options.hostKey) hello.hostKey = this.options.hostKey;
      this.send(hello);
    };
    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    // Certains WebSocket (celui de Node) signalent un échec de connexion par
    // une erreur sans événement de fermeture : on traite les deux pareil.
    socket.onerror = () => {
      if (socket.readyState !== 1) socket.onclose?.({});
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const resolve of this.pending.values()) resolve({ ok: false, error: "Connexion perdue." });
      this.pending.clear();
      const willReconnect =
        !this.closedByUser && !this.fatal && this.playerId !== null && (this.options.autoReconnect ?? true);
      this.emit("disconnected", { willReconnect });
      if (willReconnect) {
        this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
      }
    };
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.isHost = msg.isHost;
        this.emit("welcome", { playerId: msg.playerId, token: msg.token, isHost: msg.isHost });
        break;
      case "lobby":
        this.lobby = msg.lobby;
        this.emit("lobby", msg.lobby);
        break;
      case "state": {
        Object.assign(this.cardCache, msg.view.cardData);
        this.view = { ...msg.view, cardData: this.cardCache };
        this.emit("state", this.view);
        break;
      }
      case "actionResult": {
        const resolve = msg.requestId ? this.pending.get(msg.requestId) : undefined;
        if (resolve) {
          this.pending.delete(msg.requestId!);
          resolve(msg.error === undefined ? { ok: msg.ok } : { ok: msg.ok, error: msg.error });
        }
        break;
      }
      case "chat":
        this.emit("chat", { fromId: msg.fromId, fromName: msg.fromName, text: msg.text, at: msg.at });
        break;
      case "error":
        if (msg.fatal) this.fatal = true;
        this.emit("error", { message: msg.message, fatal: msg.fatal ?? false });
        break;
      case "pong":
        break;
    }
  }

  private send(msg: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as Listener<ClientEvents[K]>)(payload);
  }
}
