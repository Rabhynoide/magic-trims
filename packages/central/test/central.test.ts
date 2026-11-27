import { afterEach, describe, expect, it } from "vitest";
import { CentralClient, CentralError, normalizeCentralUrl, type ResolvedDeck } from "@magic-trims/core";
import { startCentralServer, type CentralServer } from "../src/server.js";

const servers: CentralServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start() {
  const server = await startCentralServer({ port: 0, hostname: "127.0.0.1", dbPath: ":memory:", adminKey: "cle-admin" });
  servers.push(server);
  const group = server.store.createGroup("Les amis");
  const url = `http://127.0.0.1:${server.port}`;
  return { server, group, url };
}

const deck = (name: string): ResolvedDeck =>
  ({
    commanders: [{ id: "c1", oracleId: "o1", name, typeLine: "Legendary Creature" }],
    cards: [{ card: { id: "x", oracleId: "ox", name: "Swamp", typeLine: "Basic Land — Swamp" }, quantity: 99 }],
  }) as unknown as ResolvedDeck;

describe("serveur central", () => {
  it("rejoint un groupe avec son code, quelle que soit la façon de le taper", async () => {
    const { group, url } = await start();
    const joined = await new CentralClient({ url }).join(group.code.toLowerCase().replace("-", " "), "Rémi");
    expect(joined.group.name).toBe("Les amis");
    expect(joined.member.name).toBe("Rémi");
    const me = await new CentralClient({ url, token: joined.token }).me();
    expect(me.member.id).toBe(joined.member.id);
  });

  it("refuse un code inconnu et un jeton invalide", async () => {
    const { url } = await start();
    await expect(new CentralClient({ url }).join("AAAAA-BBBBB", "Rémi")).rejects.toMatchObject({ status: 404 });
    await expect(new CentralClient({ url, token: "faux" }).listDecks()).rejects.toMatchObject({ status: 401 });
  });

  it("reprend le même compte quand un pseudo rejoint à nouveau (l'ancien jeton ne marche plus)", async () => {
    const { group, url } = await start();
    const first = await new CentralClient({ url }).join(group.code, "Rémi");
    const second = await new CentralClient({ url }).join(group.code, "Rémi");
    expect(second.member.id).toBe(first.member.id);
    await expect(new CentralClient({ url, token: first.token }).me()).rejects.toMatchObject({ status: 401 });
  });

  it("partage des decks dans le groupe, seul le propriétaire peut les modifier ou les retirer", async () => {
    const { group, url } = await start();
    const remi = new CentralClient({ url, token: (await new CentralClient({ url }).join(group.code, "Rémi")).token });
    const alex = new CentralClient({ url, token: (await new CentralClient({ url }).join(group.code, "Alex")).token });

    await remi.shareDeck({ id: "d1", name: "Sheoldred", text: "1 Sheoldred", deck: deck("Sheoldred") });
    const seen = await alex.listDecks();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "d1", name: "Sheoldred", owner: { name: "Rémi" } });
    expect(seen[0]!.deck.commanders[0]!.name).toBe("Sheoldred");

    await expect(alex.shareDeck({ id: "d1", name: "Volé", text: "", deck: deck("X") })).rejects.toMatchObject({ status: 403 });
    await expect(alex.unshareDeck("d1")).rejects.toMatchObject({ status: 403 });

    await remi.shareDeck({ id: "d1", name: "Sheoldred v2", text: "", deck: deck("Sheoldred") });
    expect((await alex.listDecks())[0]!.name).toBe("Sheoldred v2");

    await remi.unshareDeck("d1");
    expect(await alex.listDecks()).toEqual([]);
  });

  it("ne mélange pas les decks de deux groupes", async () => {
    const { server, group, url } = await start();
    const other = server.store.createGroup("Autres");
    const a = new CentralClient({ url, token: (await new CentralClient({ url }).join(group.code, "A")).token });
    const b = new CentralClient({ url, token: (await new CentralClient({ url }).join(other.code, "B")).token });
    await a.shareDeck({ id: "d1", name: "Deck A", text: "", deck: deck("A") });
    expect(await b.listDecks()).toEqual([]);
  });

  it("refuse un deck illisible", async () => {
    const { group, url } = await start();
    const remi = new CentralClient({ url, token: (await new CentralClient({ url }).join(group.code, "Rémi")).token });
    await expect(
      remi.shareDeck({ id: "d1", name: "x", text: "", deck: { foo: 1 } as unknown as ResolvedDeck }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("limite les essais de code ratés", async () => {
    const { group, url } = await start();
    const c = new CentralClient({ url });
    for (let i = 0; i < 10; i++) await c.join("ZZZZZ-ZZZZZ", "x").catch(() => {});
    await expect(c.join(group.code, "Rémi")).rejects.toMatchObject({ status: 429 });
  });
});

describe("administration à distance", () => {
  it("crée et liste les groupes avec la clé d'administration", async () => {
    const { url } = await start();
    const call = (key: string, method: string, body?: unknown) =>
      fetch(`${url}/api/admin/groups`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await call("fausse", "GET")).status).toBe(403);
    const created = (await (await call("cle-admin", "POST", { name: "Jeudi" })).json()) as { code: string; name: string };
    expect(created.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const list = (await (await call("cle-admin", "GET")).json()) as { groups: { name: string }[] };
    expect(list.groups.map((g) => g.name)).toEqual(["Les amis", "Jeudi"]);
    const joined = await new CentralClient({ url }).join(created.code, "Rémi");
    expect(joined.group.name).toBe("Jeudi");
  });

  it("ferme l'administration quand aucune clé n'est configurée", async () => {
    const server = await startCentralServer({ port: 0, hostname: "127.0.0.1", dbPath: ":memory:" });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/admin/groups`, { headers: { Authorization: "Bearer " } });
    expect(res.status).toBe(403);
  });
});

describe("client du serveur central", () => {
  it("complète l'adresse saisie", () => {
    expect(normalizeCentralUrl("magic-trims-central.toto.workers.dev")).toBe(
      "https://magic-trims-central.toto.workers.dev",
    );
    expect(normalizeCentralUrl("https://central.exemple.fr/")).toBe("https://central.exemple.fr");
    expect(normalizeCentralUrl("localhost")).toBe("http://localhost:47475");
    expect(normalizeCentralUrl("192.168.1.10:8000")).toBe("http://192.168.1.10:8000");
  });

  it("échoue vite et proprement quand le serveur est injoignable", async () => {
    const { server, url } = await start();
    await server.close();
    servers.splice(0);
    const started = Date.now();
    const err = await new CentralClient({ url, timeoutMs: 1000 }).listDecks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CentralError);
    expect((err as CentralError).status).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
