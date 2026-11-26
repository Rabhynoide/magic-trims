import { randomBytes, randomUUID } from "node:crypto";
import {
  applyAction,
  chooseBotAction,
  createGame,
  evaluateOutcome,
  formatForMode,
  GAME_MODES,
  isDeckLegal,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  upgradeGame,
  validateCommanderDeck,
  viewFor,
  type CardData,
  type ClientMessage,
  type GameState,
  type LobbyConfig,
  type LobbyState,
  type PlayerId,
  type ResolvedDeck,
  type ServerMessage,
} from "@magic-trims/core";

/** Nombre d'entrées du journal envoyées à chaque mise à jour. */
const LOG_WINDOW = 150;
const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 500;
const MAX_DECK_ENTRIES = 300;

interface HostedPlayer {
  id: PlayerId;
  name: string;
  /** Secret qui permet de reprendre sa place après une déconnexion. */
  token: string;
  isHost: boolean;
  deck: ResolvedDeck | null;
  schemes: CardData[];
  connId: string | null;
  /** Joueur tenu par l'ordinateur (pas de connexion). */
  isBot?: boolean;
}

/** Tout ce qu'il faut pour reprendre une partie (sauvegarde sur disque). */
export interface HostSnapshot {
  format: 1;
  gameId: string;
  /** Clé de l'hôte, pour que l'appli qui héberge reprenne sa place. */
  hostKey: string;
  players: Omit<HostedPlayer, "connId">[];
  config: LobbyConfig;
  planarDeck: CardData[];
  game: GameState | null;
  savedAt: number;
}

export interface GameHostOptions {
  /** Clé que seule l'appli qui héberge connaît. */
  hostKey: string;
  gameId?: string;
  /** Graine des mélanges (tests). */
  seed?: number;
  /** Appelé après chaque changement à sauvegarder. */
  onChange?: (snapshot: HostSnapshot) => void;
  /** Délai entre deux actions d'un bot, en millisecondes (800 par défaut ; `null` : pas de bots automatiques, pour les tests). */
  botDelayMs?: number | null;
}

type Send = (msg: ServerMessage) => void;

/**
 * L'arbitre de la partie : il tient le salon puis l'état de la partie,
 * valide les actions et envoie à chaque joueur ce qu'il a le droit de voir.
 *
 * Il ne connaît rien du réseau : le serveur lui passe des connexions
 * (un identifiant et une fonction d'envoi) et les messages reçus.
 */
export class GameHost {
  readonly hostKey: string;
  readonly gameId: string;
  private players: HostedPlayer[] = [];
  private config: LobbyConfig = { mode: "freeForAll" };
  private planarDeck: CardData[] = [];
  private game: GameState | null = null;
  private readonly connections = new Map<string, { send: Send; playerId: PlayerId | null }>();
  /** Cartes dont les données ont déjà été envoyées, par joueur. */
  private readonly sentCards = new Map<PlayerId, Set<string>>();
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: GameHostOptions) {
    this.hostKey = options.hostKey;
    this.gameId = options.gameId ?? randomUUID();
  }

  /** Reprend une partie sauvegardée. Tous les joueurs sont déconnectés. */
  static restore(snapshot: HostSnapshot, options: GameHostOptions): GameHost {
    const host = new GameHost({ ...options, gameId: snapshot.gameId });
    host.players = snapshot.players.map((p) => ({ ...p, connId: null }));
    host.config = snapshot.config;
    host.planarDeck = snapshot.planarDeck;
    host.game = snapshot.game ? upgradeGame(snapshot.game) : snapshot.game;
    host.scheduleBots();
    return host;
  }

  get started(): boolean {
    return this.game !== null;
  }

  /** État complet de la partie (pour les tests et l'outillage de l'hôte). */
  get state(): GameState | null {
    return this.game;
  }

  snapshot(): HostSnapshot {
    return {
      format: 1,
      gameId: this.gameId,
      hostKey: this.hostKey,
      players: this.players.map(({ connId: _connId, ...p }) => structuredClone(p)),
      config: structuredClone(this.config),
      planarDeck: this.planarDeck,
      game: this.game,
      savedAt: Date.now(),
    };
  }

  connect(connId: string, send: Send): void {
    this.connections.set(connId, { send, playerId: null });
  }

  disconnect(connId: string): void {
    const conn = this.connections.get(connId);
    this.connections.delete(connId);
    const player = conn?.playerId ? this.player(conn.playerId) : undefined;
    if (player && player.connId === connId) {
      player.connId = null;
      this.broadcastLobby();
    }
  }

  /** Traite un message reçu d'une connexion. */
  receive(connId: string, raw: unknown): void {
    const conn = this.connections.get(connId);
    if (!conn) return;
    try {
      const msg = parseMessage(raw);
      if (msg.type === "hello") return this.hello(connId, msg);
      if (msg.type === "ping") return conn.send({ type: "pong" });
      const player = conn.playerId ? this.player(conn.playerId) : undefined;
      if (!player || player.connId !== connId) {
        throw new HostError("Présente-toi d'abord.");
      }
      switch (msg.type) {
        case "setDeck":
          return this.setDeck(player, msg.deck, msg.schemes);
        case "configure":
          return this.configure(player, msg.config, msg.planarDeck);
        case "start":
          return this.start(player);
        case "kick":
          return this.kick(player, msg.playerId);
        case "addBot":
          return this.addBot(player, msg.deck);
        case "chat":
          return this.chat(player, msg.text);
        case "action":
          return this.action(player, msg.action, msg.requestId);
      }
    } catch (err) {
      const message = err instanceof HostError ? err.message : "Message invalide.";
      conn.send({ type: "error", message });
    }
  }

  // -------------------------------------------------------------------------

  private hello(connId: string, msg: Extract<ClientMessage, { type: "hello" }>): void {
    const conn = this.connections.get(connId)!;
    if (msg.protocol !== PROTOCOL_VERSION) {
      return conn.send({
        type: "error",
        fatal: true,
        message: "Ta version de l'appli n'est pas la même que celle de l'hôte. Mettez-vous tous à jour.",
      });
    }

    let player = msg.token ? this.players.find((p) => p.token === msg.token) : undefined;
    const wantsHost = msg.hostKey !== undefined && msg.hostKey === this.hostKey;
    if (!player && wantsHost) player = this.players.find((p) => p.isHost);

    if (!player) {
      if (this.started) {
        return conn.send({ type: "error", fatal: true, message: "La partie a déjà commencé." });
      }
      if (this.players.length >= MAX_PLAYERS) {
        return conn.send({ type: "error", fatal: true, message: `La table est pleine (${MAX_PLAYERS} joueurs).` });
      }
      player = {
        id: `p${randomBytes(4).toString("hex")}`,
        name: this.uniqueName(cleanName(msg.name)),
        token: randomBytes(16).toString("hex"),
        isHost: wantsHost,
        deck: null,
        schemes: [],
        connId: null,
      };
      // L'hôte est toujours affiché en premier.
      if (wantsHost) this.players.unshift(player);
      else this.players.push(player);
    }

    // Une seule connexion par joueur : la plus récente remplace l'ancienne.
    if (player.connId && player.connId !== connId) {
      const old = this.connections.get(player.connId);
      old?.send({ type: "error", fatal: true, message: "Tu t'es connecté depuis un autre endroit." });
      if (old) old.playerId = null;
    }
    player.connId = connId;
    conn.playerId = player.id;
    this.sentCards.delete(player.id);

    conn.send({ type: "welcome", playerId: player.id, token: player.token, isHost: player.isHost });
    this.broadcastLobby();
    if (this.game) this.sendState(player);
    this.changed();
  }

  private setDeck(player: HostedPlayer, deck: ResolvedDeck, schemes: CardData[] | undefined): void {
    this.assertLobby();
    if (!isDeck(deck)) throw new HostError("Deck invalide.");
    if (schemes !== undefined && (!Array.isArray(schemes) || schemes.length > 100)) {
      throw new HostError("Pioche de machinations invalide.");
    }
    player.deck = deck;
    player.schemes = schemes ?? [];
    this.broadcastLobby();
    this.changed();
  }

  private configure(player: HostedPlayer, config: LobbyConfig, planarDeck: CardData[] | undefined): void {
    this.assertHost(player);
    this.assertLobby();
    if (!config || !(config.mode in GAME_MODES)) throw new HostError("Mode de jeu inconnu.");
    this.config = structuredClone(config);
    if (planarDeck !== undefined) {
      if (!Array.isArray(planarDeck) || planarDeck.length > 200) throw new HostError("Pioche de plans invalide.");
      this.planarDeck = planarDeck;
    }
    this.broadcastLobby();
    this.changed();
  }

  private start(player: HostedPlayer): void {
    this.assertHost(player);
    this.assertLobby();
    const missing = this.players.filter((p) => !p.deck);
    if (missing.length > 0) {
      throw new HostError(`En attente du deck de ${missing.map((p) => p.name).join(", ")}.`);
    }
    if (this.config.allowIllegalDecks === false) {
      const format = formatForMode(this.config.mode);
      const illegal = this.players.filter((p) => !isDeckLegal(validateCommanderDeck(p.deck!, format)));
      if (illegal.length > 0) {
        throw new HostError(
          `Decks non légaux pour ce mode : ${illegal.map((p) => p.name).join(", ")}. Corrigez-les ou autorisez les decks non légaux.`,
        );
      }
    }
    try {
      const options: Parameters<typeof createGame>[0] = {
        id: this.gameId,
        mode: this.config.mode,
        players: this.players.map((p) => ({ id: p.id, name: p.name, deck: p.deck!, schemes: p.schemes })),
      };
      if (this.config.teams) options.teams = this.config.teams;
      if (this.config.archenemyId) options.archenemyId = this.config.archenemyId;
      if (this.config.settings) options.settings = this.config.settings;
      if (this.planarDeck.length > 0 && this.config.settings?.planechase !== false) {
        options.planarDeck = this.planarDeck;
      }
      if (this.options.seed !== undefined) options.seed = this.options.seed;
      this.game = createGame(options);
    } catch (err) {
      throw new HostError(err instanceof Error ? err.message : "Impossible de lancer la partie.");
    }
    this.broadcastLobby();
    this.broadcastState();
    this.changed();
    this.scheduleBots();
  }

  private addBot(player: HostedPlayer, deck: ResolvedDeck): void {
    this.assertHost(player);
    this.assertLobby();
    if (!isDeck(deck)) throw new HostError("Deck invalide.");
    if (this.players.length >= MAX_PLAYERS) throw new HostError(`La table est pleine (${MAX_PLAYERS} joueurs).`);
    this.players.push({
      id: `b${randomBytes(4).toString("hex")}`,
      name: this.uniqueName("Bot"),
      token: randomBytes(16).toString("hex"),
      isHost: false,
      deck,
      schemes: [],
      connId: null,
      isBot: true,
    });
    this.broadcastLobby();
    this.changed();
  }

  /**
   * Fait jouer une action à un bot, s'il en a une. Retourne vrai si un bot a
   * joué. Appelé tout seul (avec un délai) après chaque changement.
   */
  stepBots(): boolean {
    const game = this.game;
    if (!game || evaluateOutcome(game).winners) return false;
    for (const bot of this.players.filter((p) => p.isBot)) {
      const action = chooseBotAction(game, bot.id);
      if (!action) continue;
      const result = applyAction(game, { actorId: bot.id, action });
      // Un coup refusé ne doit pas arriver ; on n'insiste pas pour ne pas boucler.
      if (!result.ok) continue;
      this.game = result.state;
      this.broadcastState();
      this.changed();
      return true;
    }
    return false;
  }

  private scheduleBots(): void {
    const delay = this.options.botDelayMs === undefined ? 800 : this.options.botDelayMs;
    if (delay === null || this.botTimer || !this.players.some((p) => p.isBot)) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (this.stepBots()) this.scheduleBots();
    }, delay);
  }

  /** Arrête les bots (fermeture de la partie). */
  stopBots(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  private kick(player: HostedPlayer, targetId: PlayerId): void {
    this.assertHost(player);
    this.assertLobby();
    const target = this.player(targetId);
    if (!target || target.isHost) throw new HostError("Joueur introuvable.");
    this.players = this.players.filter((p) => p !== target);
    if (target.connId) {
      const conn = this.connections.get(target.connId);
      conn?.send({ type: "error", fatal: true, message: "L'hôte t'a retiré de la partie." });
      if (conn) conn.playerId = null;
    }
    this.broadcastLobby();
    this.changed();
  }

  private chat(player: HostedPlayer, text: string): void {
    const clean = String(text).trim().slice(0, MAX_CHAT_LENGTH);
    if (!clean) return;
    this.broadcast({ type: "chat", fromId: player.id, fromName: player.name, text: clean, at: Date.now() });
  }

  private action(player: HostedPlayer, action: unknown, requestId: string | undefined): void {
    const reply = (ok: boolean, error?: string) => {
      const msg: ServerMessage = { type: "actionResult", ok };
      if (requestId !== undefined) msg.requestId = String(requestId);
      if (error !== undefined) msg.error = error;
      this.sendTo(player, msg);
    };
    if (!this.game) return reply(false, "La partie n'a pas commencé.");
    if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
      return reply(false, "Action invalide.");
    }
    let result;
    try {
      result = applyAction(this.game, { actorId: player.id, action: action as never });
    } catch {
      // Action mal formée (champ manquant…) : on la refuse sans planter l'hôte.
      return reply(false, "Action invalide.");
    }
    if (!result.ok) return reply(false, result.error);
    this.game = result.state;
    reply(true);
    this.broadcastState();
    this.changed();
    this.scheduleBots();
  }

  // -------------------------------------------------------------------------

  private lobbyState(): LobbyState {
    const format = formatForMode(this.config.mode);
    return {
      players: this.players.map((p) => {
        const issues = p.deck ? validateCommanderDeck(p.deck, format) : [];
        return {
          id: p.id,
          name: p.name,
          isHost: p.isHost,
          connected: p.isBot === true || p.connId !== null,
          ...(p.isBot ? { isBot: true } : {}),
          deck: p.deck
            ? {
                commanders: p.deck.commanders.map((c) => c.name),
                cardCount: p.deck.commanders.length + p.deck.cards.reduce((n, c) => n + c.quantity, 0),
                issues,
                legal: isDeckLegal(issues),
              }
            : null,
          schemeCount: p.schemes.length,
        };
      }),
      config: structuredClone(this.config),
      planeCount: this.planarDeck.length,
      started: this.started,
      maxPlayers: MAX_PLAYERS,
    };
  }

  private broadcastLobby(): void {
    const lobby = this.lobbyState();
    this.broadcast({ type: "lobby", lobby });
  }

  private broadcastState(): void {
    for (const player of this.players) this.sendState(player);
  }

  private sendState(player: HostedPlayer): void {
    if (!this.game || !player.connId) return;
    const view = viewFor(this.game, player.id);
    let sent = this.sentCards.get(player.id);
    if (!sent) this.sentCards.set(player.id, (sent = new Set()));
    const fresh: Record<string, CardData> = {};
    for (const [id, data] of Object.entries(view.cardData)) {
      if (!sent.has(id)) {
        fresh[id] = data;
        sent.add(id);
      }
    }
    view.cardData = fresh;
    view.log = view.log.slice(-LOG_WINDOW);
    this.sendTo(player, { type: "state", view });
  }

  private broadcast(msg: ServerMessage): void {
    for (const player of this.players) this.sendTo(player, msg);
  }

  private sendTo(player: HostedPlayer, msg: ServerMessage): void {
    if (!player.connId) return;
    this.connections.get(player.connId)?.send(msg);
  }

  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }

  private player(id: PlayerId): HostedPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  private uniqueName(name: string): string {
    let candidate = name;
    for (let i = 2; this.players.some((p) => p.name === candidate); i++) candidate = `${name} ${i}`;
    return candidate;
  }

  private assertHost(player: HostedPlayer): void {
    if (!player.isHost) throw new HostError("Seul l'hôte peut faire ça.");
  }

  private assertLobby(): void {
    if (this.started) throw new HostError("La partie a déjà commencé.");
  }
}

class HostError extends Error {}

function cleanName(name: unknown): string {
  const clean = String(name ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean || "Joueur";
}

function parseMessage(raw: unknown): ClientMessage {
  const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
    throw new HostError("Message invalide.");
  }
  const known = ["hello", "setDeck", "configure", "start", "kick", "addBot", "action", "chat", "ping"];
  if (!known.includes((msg as { type: string }).type)) throw new HostError("Message inconnu.");
  return msg as ClientMessage;
}

function isDeck(deck: unknown): deck is ResolvedDeck {
  if (!deck || typeof deck !== "object") return false;
  const d = deck as ResolvedDeck;
  if (!Array.isArray(d.commanders) || !Array.isArray(d.cards)) return false;
  if (d.commanders.length > 2 || d.cards.length > MAX_DECK_ENTRIES) return false;
  const isCard = (c: CardData) => c && typeof c.id === "string" && typeof c.name === "string";
  return (
    d.commanders.every(isCard) &&
    d.cards.every((e) => e && isCard(e.card) && Number.isInteger(e.quantity) && e.quantity > 0 && e.quantity <= 100)
  );
}
