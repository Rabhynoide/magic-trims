import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CentralGroup, CentralMember, ResolvedDeck, SharedDeck } from "@magic-trims/core";

/**
 * Données du serveur central, dans un seul fichier SQLite (facile à
 * sauvegarder : il suffit de copier le fichier).
 *
 * Comptes : chaque groupe d'amis a un code secret. Un joueur rejoint le
 * groupe avec ce code et son pseudo, et reçoit un jeton que l'appli garde.
 * Seule l'empreinte des jetons est stockée.
 */

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

/** Code de groupe lisible : 10 caractères sans lettres ambiguës, en deux blocs. */
export function newGroupCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i++) code += alphabet[bytes[i]! % alphabet.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Les joueurs tapent le code à la main : on ignore casse, espaces et tirets. */
export function normalizeGroupCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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
  private readonly db: DatabaseSync;

  /** `:memory:` pour les tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createGroup(name: string): GroupWithCode {
    const group = { id: randomUUID(), name: name.trim() || "Mes amis", code: newGroupCode() };
    this.db
      .prepare("INSERT INTO groups (id, name, code, created_at) VALUES (?, ?, ?, ?)")
      .run(group.id, group.name, normalizeGroupCode(group.code), Date.now());
    return group;
  }

  listGroups(): GroupWithCode[] {
    const rows = this.db.prepare("SELECT id, name, code FROM groups ORDER BY created_at").all() as {
      id: string;
      name: string;
      code: string;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, code: `${r.code.slice(0, 5)}-${r.code.slice(5)}` }));
  }

  /**
   * Rejoint un groupe. Un pseudo déjà pris dans le groupe reprend le même
   * compte avec un nouveau jeton (réinstallation, autre PC) : entre amis, le
   * code du groupe suffit comme preuve.
   */
  join(code: string, name: string): { token: string; member: CentralMember; group: CentralGroup } | null {
    const group = this.db.prepare("SELECT id, name FROM groups WHERE code = ?").get(normalizeGroupCode(code)) as
      | CentralGroup
      | undefined;
    if (!group) return null;
    const token = randomBytes(24).toString("base64url");
    const existing = this.db
      .prepare("SELECT id, name FROM members WHERE group_id = ? AND name = ?")
      .get(group.id, name) as CentralMember | undefined;
    let member: CentralMember;
    if (existing) {
      this.db.prepare("UPDATE members SET token_hash = ? WHERE id = ?").run(hashToken(token), existing.id);
      member = { id: existing.id, name: existing.name };
    } else {
      member = { id: randomUUID(), name };
      this.db
        .prepare("INSERT INTO members (id, group_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(member.id, group.id, name, hashToken(token), Date.now());
    }
    return { token, member, group: { id: group.id, name: group.name } };
  }

  authenticate(token: string): { member: CentralMember; group: CentralGroup } | null {
    const row = this.db
      .prepare(
        `SELECT m.id AS member_id, m.name AS member_name, g.id AS group_id, g.name AS group_name
         FROM members m JOIN groups g ON g.id = m.group_id WHERE m.token_hash = ?`,
      )
      .get(hashToken(token)) as
      | { member_id: string; member_name: string; group_id: string; group_name: string }
      | undefined;
    if (!row) return null;
    return {
      member: { id: row.member_id, name: row.member_name },
      group: { id: row.group_id, name: row.group_name },
    };
  }

  listDecks(groupId: string): SharedDeck[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name, d.text, d.deck_json, d.updated_at, d.owner_id, m.name AS owner_name
         FROM decks d JOIN members m ON m.id = d.owner_id
         WHERE d.group_id = ? ORDER BY d.updated_at DESC`,
      )
      .all(groupId) as unknown as DeckRow[];
    return rows.map(toSharedDeck);
  }

  /** Partage ou met à jour un deck ; `"forbidden"` si ce deck appartient à un autre joueur. */
  saveDeck(
    groupId: string,
    owner: CentralMember,
    deck: { id: string; name: string; text: string; deck: ResolvedDeck },
  ): SharedDeck | "forbidden" {
    const existing = this.db.prepare("SELECT owner_id FROM decks WHERE group_id = ? AND id = ?").get(groupId, deck.id) as
      | { owner_id: string }
      | undefined;
    if (existing && existing.owner_id !== owner.id) return "forbidden";
    const updatedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO decks (id, group_id, owner_id, name, text, deck_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, id) DO UPDATE SET name = excluded.name, text = excluded.text,
           deck_json = excluded.deck_json, updated_at = excluded.updated_at`,
      )
      .run(deck.id, groupId, owner.id, deck.name, deck.text, JSON.stringify(deck.deck), updatedAt);
    return { id: deck.id, name: deck.name, text: deck.text, deck: deck.deck, owner, updatedAt };
  }

  /** `"missing"` si le deck n'existe pas, `"forbidden"` s'il appartient à un autre joueur. */
  deleteDeck(groupId: string, ownerId: string, id: string): "ok" | "missing" | "forbidden" {
    const existing = this.db.prepare("SELECT owner_id FROM decks WHERE group_id = ? AND id = ?").get(groupId, id) as
      | { owner_id: string }
      | undefined;
    if (!existing) return "missing";
    if (existing.owner_id !== ownerId) return "forbidden";
    this.db.prepare("DELETE FROM decks WHERE group_id = ? AND id = ?").run(groupId, id);
    return "ok";
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
