import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeJoinCode, GameClient, websocketUrl, type GameView, type LobbyState } from "@magic-trims/core";
import { loadSnapshot } from "../src/persistence.js";
import { startHostServer, type HostServer } from "../src/server.js";
import { fakeDeck } from "./helpers.js";

const servers: HostServer[] = [];
const clients: GameClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function start(options: Parameters<typeof startHostServer>[0] = {}) {
  const server = await startHostServer({ port: 0, upnp: false, seed: 5, ...options });
  servers.push(server);
  return server;
}

function client(server: HostServer, name: string, extra: Partial<ConstructorParameters<typeof GameClient>[0]> = {}) {
  const c = new GameClient({ url: websocketUrl("127.0.0.1", server.port), name, ...extra });
  clients.push(c);
  return c;
}

function next<T>(c: GameClient, event: "lobby" | "state", predicate: (v: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const off = c.on(event as never, ((v: T) => {
      if (predicate(v)) {
        off();
        resolve(v);
      }
    }) as never);
  });
}

describe("serveur de partie", () => {
  it("fait jouer trois joueurs de bout en bout", async () => {
    const server = await start();
    const alice = client(server, "Alice", { hostKey: server.hostKey });
    const bruno = client(server, "Bruno");
    const chloe = client(server, "Chloé");
    expect((await alice.connect()).isHost).toBe(true);
    await bruno.connect();
    await chloe.connect();

    const ready = next<LobbyState>(alice, "lobby", (l) => l.players.length === 3 && l.players.every((p) => p.deck));
    alice.setDeck(fakeDeck("Alice"));
    bruno.setDeck(fakeDeck("Bruno"));
    chloe.setDeck(fakeDeck("Chloé"));
    await ready;

    const started = next<GameView>(bruno, "state", () => true);
    alice.start();
    const view = await started;
    expect(view.turnOrder).toHaveLength(3);
    expect(view.players[bruno.playerId!]!.zones.hand).toHaveLength(7);

    const activeClient = [alice, bruno, chloe].find((c) => c.playerId === view.turn.activePlayerId)!;
    const update = next<GameView>(chloe, "state", (v) => v.version === 1);
    expect(await activeClient.act({ type: "draw", count: 1 })).toEqual({ ok: true });
    await update;
    // Le cache du client garde les données de cartes reçues plus tôt.
    expect(Object.keys(chloe.view!.cardData).length).toBeGreaterThan(0);

    const refused = await [alice, bruno, chloe].find((c) => c !== activeClient)!.act({ type: "passTurn" });
    expect(refused).toEqual({ ok: false, error: "Ce n'est pas ton tour." });
  });

  it("reconnecte automatiquement un joueur après une coupure", async () => {
    const server = await start();
    const alice = client(server, "Alice", { hostKey: server.hostKey });
    await alice.connect();
    const bruno = client(server, "Bruno");
    const { playerId } = await bruno.connect();

    const reconnected = new Promise<void>((resolve) => {
      const off = bruno.on("welcome", (w) => {
        off();
        expect(w.playerId).toBe(playerId);
        resolve();
      });
    });
    const disconnected = new Promise((resolve) => bruno.on("disconnected", resolve));
    // Coupe brutalement la connexion de Bruno côté serveur.
    (bruno as unknown as { socket: { close(): void } }).socket.close();
    expect(await disconnected).toEqual({ willReconnect: true });
    const bothConnected = next<LobbyState>(alice, "lobby", (l) => l.players.every((p) => p.connected));
    await reconnected;
    await bothConnected;
  });

  it("refuse un joueur quand la partie a commencé", async () => {
    const server = await start();
    const alice = client(server, "Alice", { hostKey: server.hostKey });
    await alice.connect();
    alice.setDeck(fakeDeck("Alice"));
    const started = next<GameView>(alice, "state", () => true);
    alice.start();
    await started;
    await expect(client(server, "Bruno").connect()).rejects.toThrow("La partie a déjà commencé.");
  });

  it("signale une adresse injoignable", async () => {
    const c = new GameClient({ url: "ws://127.0.0.1:1", name: "X", autoReconnect: false });
    await expect(c.connect()).rejects.toThrow(/Impossible de joindre/);
  });

  it("sauvegarde la partie et la reprend après un redémarrage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magic-trims-"));
    const savePath = join(dir, "partie.json");
    const server = await start({ savePath });
    const alice = client(server, "Alice", { hostKey: server.hostKey });
    await alice.connect();
    alice.setDeck(fakeDeck("Alice"));
    const started = next<GameView>(alice, "state", () => true);
    alice.start();
    await started;
    expect(await alice.act({ type: "adjustLife", playerId: alice.playerId!, delta: -3 })).toEqual({ ok: true });
    alice.close();
    await server.close();
    servers.splice(servers.indexOf(server), 1);

    const snapshot = await loadSnapshot(savePath);
    expect(JSON.parse(await readFile(savePath, "utf8")).game.version).toBe(1);
    const resumed = await start({ restore: snapshot });
    expect(resumed.hostKey).toBe(server.hostKey);
    const again = client(resumed, "Alice", { hostKey: resumed.hostKey });
    const state = next<GameView>(again, "state", () => true);
    await again.connect();
    expect((await state).players[again.playerId!]!.life).toBe(37);
  });

  it("donne des codes de connexion qui redonnent l'adresse", async () => {
    const server = await start();
    for (const a of server.addresses) {
      expect(decodeJoinCode(a.code)).toEqual({ host: a.ip, port: server.port });
    }
    expect(server.upnp).toEqual({ ok: false, reason: "désactivé" });
  });
});
