import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@magic-trims/core";
import { GameHost, type HostSnapshot } from "../src/game-host.js";
import { fakeDeck } from "./helpers.js";

/** Une fausse connexion qui garde les messages reçus. */
class Conn {
  received: ServerMessage[] = [];
  constructor(
    readonly host: GameHost,
    readonly id: string,
  ) {
    host.connect(id, (msg) => this.received.push(structuredClone(msg)));
  }
  send(msg: ClientMessage) {
    this.host.receive(this.id, msg);
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> {
    const found = this.received.filter((m) => m.type === type).at(-1);
    if (!found) throw new Error(`Aucun message ${type}`);
    return found as Extract<ServerMessage, { type: T }>;
  }
  hello(name: string, extra: Partial<Extract<ClientMessage, { type: "hello" }>> = {}) {
    this.send({ type: "hello", protocol: PROTOCOL_VERSION, name, ...extra });
    return this.last("welcome");
  }
}

function setup(playerCount: number) {
  const snapshots: HostSnapshot[] = [];
  const host = new GameHost({ hostKey: "secret", seed: 3, onChange: (s) => snapshots.push(s) });
  const conns = Array.from({ length: playerCount }, (_, i) => new Conn(host, `c${i}`));
  const names = ["Alice", "Bruno", "Chloé", "David", "Emma", "Farid"];
  const welcomes = conns.map((c, i) => c.hello(names[i]!, i === 0 ? { hostKey: "secret" } : {}));
  return { host, conns, welcomes, snapshots };
}

describe("salon", () => {
  it("accueille les joueurs et reconnaît l'hôte", () => {
    const { conns, welcomes } = setup(3);
    expect(welcomes.map((w) => w.isHost)).toEqual([true, false, false]);
    const lobby = conns[2]!.last("lobby").lobby;
    expect(lobby.players.map((p) => [p.name, p.isHost, p.connected])).toEqual([
      ["Alice", true, true],
      ["Bruno", false, true],
      ["Chloé", false, true],
    ]);
  });

  it("refuse une mauvaise version et un sixième joueur", () => {
    const { host } = setup(5);
    const sixth = new Conn(host, "x");
    sixth.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "Farid" });
    expect(sixth.received).toEqual([{ type: "error", fatal: true, message: "La table est pleine (5 joueurs)." }]);
    const old = new Conn(host, "y");
    old.send({ type: "hello", protocol: 0, name: "Vieux" });
    expect(old.last("error").fatal).toBe(true);
  });

  it("donne un nom unique", () => {
    const host = new GameHost({ hostKey: "k" });
    new Conn(host, "a").hello("Alice");
    const b = new Conn(host, "b");
    b.hello("Alice");
    expect(b.last("lobby").lobby.players.map((p) => p.name)).toEqual(["Alice", "Alice 2"]);
  });

  it("résume les decks et leurs problèmes dans le salon", () => {
    const { conns } = setup(2);
    conns[1]!.send({ type: "setDeck", deck: fakeDeck("Bruno") });
    const deck = conns[0]!.last("lobby").lobby.players[1]!.deck;
    expect(deck).toEqual({ commanders: ["Bruno Commander"], cardCount: 100, issues: [] });
  });

  it("réserve les réglages et le lancement à l'hôte", () => {
    const { conns } = setup(2);
    conns[1]!.send({ type: "configure", config: { mode: "duel" } });
    expect(conns[1]!.last("error").message).toBe("Seul l'hôte peut faire ça.");
    conns[1]!.send({ type: "start" });
    expect(conns[1]!.last("error").message).toBe("Seul l'hôte peut faire ça.");
  });

  it("attend tous les decks avant de lancer", () => {
    const { conns } = setup(2);
    conns[0]!.send({ type: "setDeck", deck: fakeDeck("Alice") });
    conns[0]!.send({ type: "start" });
    expect(conns[0]!.last("error").message).toBe("En attente du deck de Bruno.");
  });

  it("explique un mode incompatible avec le nombre de joueurs", () => {
    const { conns } = setup(3);
    conns.forEach((c, i) => c.send({ type: "setDeck", deck: fakeDeck(`P${i}`) }));
    conns[0]!.send({ type: "configure", config: { mode: "star" } });
    conns[0]!.send({ type: "start" });
    expect(conns[0]!.last("error").message).toBe("Le mode Étoile (Pentacle) se joue à 5 joueurs.");
  });

  it("permet à l'hôte d'exclure un joueur avant la partie", () => {
    const { conns, welcomes } = setup(3);
    conns[0]!.send({ type: "kick", playerId: welcomes[2]!.playerId });
    expect(conns[2]!.last("error")).toEqual({ type: "error", fatal: true, message: "L'hôte t'a retiré de la partie." });
    expect(conns[0]!.last("lobby").lobby.players).toHaveLength(2);
  });

  it("diffuse le chat", () => {
    const { conns } = setup(2);
    conns[1]!.send({ type: "chat", text: "  Salut !  " });
    expect(conns[0]!.last("chat")).toMatchObject({ fromName: "Bruno", text: "Salut !" });
  });

  it("ignore les messages invalides sans planter", () => {
    const { host, conns } = setup(1);
    host.receive("c0", "pas du json");
    host.receive("c0", { type: "inconnu" });
    conns[0]!.send({ type: "setDeck", deck: { commanders: "x" } as never });
    expect(conns[0]!.received.filter((m) => m.type === "error")).toHaveLength(3);
  });
});

describe("partie", () => {
  function started(playerCount = 3) {
    const s = setup(playerCount);
    s.conns.forEach((c, i) => c.send({ type: "setDeck", deck: fakeDeck(`P${i}`) }));
    s.conns[0]!.send({ type: "start" });
    return s;
  }

  it("envoie à chacun sa propre vue de la partie", () => {
    const { conns, welcomes } = started();
    const view = conns[1]!.last("state").view;
    expect(view.viewerId).toBe(welcomes[1]!.playerId);
    expect(view.players[welcomes[1]!.playerId]!.zones.hand.every((c) => !c.hidden)).toBe(true);
    expect(view.players[welcomes[0]!.playerId]!.zones.hand.every((c) => c.hidden)).toBe(true);
    expect(conns[0]!.last("lobby").lobby.started).toBe(true);
  });

  it("applique les actions, répond et diffuse le nouvel état", () => {
    const { host, conns, welcomes } = started();
    const active = host.state!.turn.activePlayerId;
    const i = welcomes.findIndex((w) => w.playerId === active);
    conns[i]!.send({ type: "action", requestId: "r1", action: { type: "draw", count: 1 } });
    expect(conns[i]!.last("actionResult")).toEqual({ type: "actionResult", requestId: "r1", ok: true });
    for (const c of conns) expect(c.last("state").view.version).toBe(1);
    const other = conns[(i + 1) % 3]!;
    other.send({ type: "action", requestId: "r2", action: { type: "passTurn" } });
    expect(other.last("actionResult")).toEqual({
      type: "actionResult",
      requestId: "r2",
      ok: false,
      error: "Ce n'est pas ton tour.",
    });
  });

  it("refuse une action mal formée sans planter", () => {
    const { conns } = started();
    conns[0]!.send({ type: "action", requestId: "r", action: { type: "setTapped" } as never });
    expect(conns[0]!.last("actionResult")).toMatchObject({ ok: false });
  });

  it("n'envoie les données d'une carte qu'une fois", () => {
    const { host, conns, welcomes } = started();
    const first = conns[0]!.last("state").view;
    expect(Object.keys(first.cardData).length).toBeGreaterThan(0);
    const active = welcomes.findIndex((w) => w.playerId === host.state!.turn.activePlayerId);
    conns[active]!.send({ type: "action", action: { type: "rollDie", sides: 6 } });
    expect(conns[0]!.last("state").view.cardData).toEqual({});
  });

  it("refuse les nouveaux venus mais laisse revenir un joueur avec son jeton", () => {
    const { host, conns, welcomes } = started();
    const late = new Conn(host, "late");
    late.send({ type: "hello", protocol: PROTOCOL_VERSION, name: "Retardataire" });
    expect(late.last("error").message).toBe("La partie a déjà commencé.");

    host.disconnect("c1");
    expect(conns[0]!.last("lobby").lobby.players[1]!.connected).toBe(false);
    const back = new Conn(host, "back");
    const welcome = back.hello("Bruno", { token: welcomes[1]!.token });
    expect(welcome.playerId).toBe(welcomes[1]!.playerId);
    // Après une reconnexion, toutes les données de cartes sont renvoyées.
    expect(Object.keys(back.last("state").view.cardData).length).toBeGreaterThan(0);
  });

  it("reprend une partie sauvegardée", () => {
    const { snapshots, welcomes } = started();
    const restored = GameHost.restore(snapshots.at(-1)!, { hostKey: "secret" });
    expect(restored.started).toBe(true);
    const hostConn = new Conn(restored, "h");
    expect(hostConn.hello("Alice", { hostKey: "secret" }).playerId).toBe(welcomes[0]!.playerId);
    const guest = new Conn(restored, "g");
    expect(guest.hello("Chloé", { token: welcomes[2]!.token }).playerId).toBe(welcomes[2]!.playerId);
    expect(guest.last("state").view.version).toBe(0);
  });
});
