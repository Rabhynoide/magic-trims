import type { CentralGroup, CentralMember, ResolvedDeck, SharedDeck } from "@magic-trims/core";

/**
 * Données du serveur central, en SQLite : celui des Durable Objects de
 * Cloudflare en production, `node:sqlite` pour l'essai local et les tests.
 *
 * Comptes : chaque groupe d'amis a un code secret. Un joueur rejoint le
 * groupe avec ce code et son pseudo, et reçoit un jeton que l'appli garde.
 * Seule l'empreinte des jetons est stockée.
 *
 * N'utilise que des API web standard (Web Crypto), communes à Node et aux Workers.
 */

/** Accès SQL minimal, pour brancher le SQLite de Cloudflare ou celui de Node. */
export interface Sql {
  /** Exécute un script de plusieurs instructions, sans paramètre. */
  script(sql: string): void;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
  run(sql: string, ...params: (string | number | null)[]): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, name)
);
CREATE TABLE IF NOT EXISTS decks (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  deck_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, id)
);
`;

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomString(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Code de groupe lisible : 10 caractères sans lettres ambiguës, en deux blocs. */
export function newGroupCode(): string {
  const code = randomString(10, ALPHABET);
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Les joueurs tapent le code à la main : on ignore casse, espaces et tirets. */
export function normalizeGroupCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`;

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface GroupWithCode extends CentralGroup {
  code: string;
}

interface DeckRow {
  id: string;
  name: string;
  text: string;
  deck_json: string;
  updated_at: number;
  owner_id: string;
  owner_name: string;
}

export class CentralStore {
  constructor(private readonly sql: Sql) {
    sql.script(SCHEMA);
  }

  createGroup(name: string): GroupWithCode {
    const group = { id: crypto.randomUUID(), name: name.trim() || "Mes amis", code: newGroupCode() };
    this.sql.run(
      "INSERT INTO groups (id, name, code, created_at) VALUES (?, ?, ?, ?)",
      group.id,
      group.name,
      normalizeGroupCode(group.code),
      Date.now(),
    );
    return group;
  }

  listGroups(): GroupWithCode[] {
    return this.sql
      .all<{ id: string; name: string; code: string }>("SELECT id, name, code FROM groups ORDER BY created_at")
      .map((r) => ({ id: r.id, name: r.name, code: formatCode(r.code) }));
  }

  /**
   * Rejoint un groupe. Un pseudo déjà pris dans le groupe reprend le même
   * compte avec un nouveau jeton (réinstallation, autre PC) : entre amis, le
   * code du groupe suffit comme preuve.
   */
  async join(code: string, name: string): Promise<{ token: string; member: CentralMember; group: CentralGroup } | null> {
    const group = this.sql.all<CentralGroup>("SELECT id, name FROM groups WHERE code = ?", normalizeGroupCode(code))[0];
    if (!group) return null;
    const token = randomString(32, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    const hash = await hashToken(token);
    const existing = this.sql.all<CentralMember>(
      "SELECT id, name FROM members WHERE group_id = ? AND name = ?",
      group.id,
      name,
    )[0];
    let member: CentralMember;
    if (existing) {
      this.sql.run("UPDATE members SET token_hash = ? WHERE id = ?", hash, existing.id);
      member = { id: existing.id, name: existing.name };
    } else {
      member = { id: crypto.randomUUID(), name };
      this.sql.run(
        "INSERT INTO members (id, group_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        member.id,
        group.id,
        name,
        hash,
        Date.now(),
      );
    }
    return { token, member, group: { id: group.id, name: group.name } };
  }

  async authenticate(token: string): Promise<{ member: CentralMember; group: CentralGroup } | null> {
    const row = this.sql.all<{ member_id: string; member_name: string; group_id: string; group_name: string }>(
      `SELECT m.id AS member_id, m.name AS member_name, g.id AS group_id, g.name AS group_name
       FROM members m JOIN groups g ON g.id = m.group_id WHERE m.token_hash = ?`,
      await hashToken(token),
    )[0];
    if (!row) return null;
    return {
      member: { id: row.member_id, name: row.member_name },
      group: { id: row.group_id, name: row.group_name },
    };
  }

  listDecks(groupId: string): SharedDeck[] {
    return this.sql
      .all<DeckRow>(
        `SELECT d.id, d.name, d.text, d.deck_json, d.updated_at, d.owner_id, m.name AS owner_name
         FROM decks d JOIN members m ON m.id = d.owner_id
         WHERE d.group_id = ? ORDER BY d.updated_at DESC`,
        groupId,
      )
      .map(toSharedDeck);
  }

  /** Partage ou met à jour un deck ; `"forbidden"` si ce deck appartient à un autre joueur. */
  saveDeck(
    groupId: string,
    owner: CentralMember,
    deck: { id: string; name: string; text: string; deck: ResolvedDeck },
  ): SharedDeck | "forbidden" {
    const existing = this.ownerOf(groupId, deck.id);
    if (existing && existing !== owner.id) return "forbidden";
    const updatedAt = Date.now();
    this.sql.run(
      `INSERT INTO decks (id, group_id, owner_id, name, text, deck_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id, id) DO UPDATE SET name = excluded.name, text = excluded.text,
         deck_json = excluded.deck_json, updated_at = excluded.updated_at`,
      deck.id,
      groupId,
      owner.id,
      deck.name,
      deck.text,
      JSON.stringify(deck.deck),
      updatedAt,
    );
    return { id: deck.id, name: deck.name, text: deck.text, deck: deck.deck, owner, updatedAt };
  }

  /** `"missing"` si le deck n'existe pas, `"forbidden"` s'il appartient à un autre joueur. */
  deleteDeck(groupId: string, ownerId: string, id: string): "ok" | "missing" | "forbidden" {
    const existing = this.ownerOf(groupId, id);
    if (!existing) return "missing";
    if (existing !== ownerId) return "forbidden";
    this.sql.run("DELETE FROM decks WHERE group_id = ? AND id = ?", groupId, id);
    return "ok";
  }

  private ownerOf(groupId: string, id: string): string | undefined {
    return this.sql.all<{ owner_id: string }>("SELECT owner_id FROM decks WHERE group_id = ? AND id = ?", groupId, id)[0]
      ?.owner_id;
  }
}

function toSharedDeck(r: DeckRow): SharedDeck {
  return {
    id: r.id,
    name: r.name,
    text: r.text,
    deck: JSON.parse(r.deck_json) as ResolvedDeck,
    owner: { id: r.owner_id, name: r.owner_name },
    updatedAt: r.updated_at,
  };
}
