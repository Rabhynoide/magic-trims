import type { ActionEnvelope, GameAction } from "./actions.js";
import { nextRandom, shuffleInPlace } from "./rng.js";
import {
  PUBLIC_ZONES,
  type CardData,
  type CardInstance,
  type CardInstanceId,
  type GameState,
  type PlayerId,
  type PlayerState,
  type Zone,
} from "./types.js";

export type ActionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: string };

/** Erreur de validation d'une action ; son message est affiché au joueur. */
export class ActionError extends Error {}

/**
 * Applique une action à la partie. Ne modifie jamais `state` : retourne un
 * nouvel état, ou une erreur si l'action est refusée.
 */
export function applyAction(state: GameState, envelope: ActionEnvelope): ActionResult {
  const draft = structuredClone(state);
  try {
    const actor = getPlayer(draft, envelope.actorId);
    if (actor.hasConceded && envelope.action.type !== "concede") {
      throw new ActionError("Tu as abandonné cette partie.");
    }
    handlers[envelope.action.type](draft, actor, envelope.action as never);
    draft.version += 1;
    return { ok: true, state: draft };
  } catch (err) {
    if (err instanceof ActionError) return { ok: false, error: err.message };
    throw err;
  }
}

type Handler<T extends GameAction["type"]> = (
  g: GameState,
  actor: PlayerState,
  action: Extract<GameAction, { type: T }>,
) => void;

const handlers: { [T in GameAction["type"]]: Handler<T> } = {
  draw(g, actor, { count }) {
    assertCount(count);
    const library = actor.zones.library;
    const drawn = Math.min(count, library.length);
    for (let i = 0; i < drawn; i++) {
      moveCardTo(g, library[0]!, "hand", "top");
    }
    log(g, actor.id, `${actor.name} pioche ${plural(drawn, "carte")}.`);
    if (drawn < count) {
      log(g, actor.id, `${actor.name} tente de piocher dans une bibliothèque vide.`);
    }
  },

  shuffleLibrary(g, actor) {
    shuffleLibrary(g, actor);
    log(g, actor.id, `${actor.name} mélange sa bibliothèque.`);
  },

  mulligan(g, actor) {
    for (const id of [...actor.zones.hand]) moveCardTo(g, id, "library", "top");
    shuffleLibrary(g, actor);
    for (let i = 0; i < 7 && actor.zones.library.length > 0; i++) {
      moveCardTo(g, actor.zones.library[0]!, "hand", "top");
    }
    actor.mulligans += 1;
    const toBottom = Math.max(0, actor.mulligans - (g.settings.freeFirstMulligan ? 1 : 0));
    log(
      g,
      actor.id,
      toBottom > 0
        ? `${actor.name} prend un mulligan et devra mettre ${plural(toBottom, "carte")} au-dessous de sa bibliothèque.`
        : `${actor.name} prend un mulligan gratuit.`,
    );
  },

  moveTopOfLibrary(g, actor, { count, to, faceDown }) {
    assertCount(count);
    const moved: CardInstance[] = [];
    for (let i = 0; i < count && actor.zones.library.length > 0; i++) {
      moved.push(moveCardTo(g, actor.zones.library[0]!, to, "top", { faceDown }));
    }
    const visible = PUBLIC_ZONES.has(to) && !faceDown;
    const names = visible ? ` : ${moved.map((c) => cardName(g, c)).join(", ")}` : "";
    log(
      g,
      actor.id,
      `${actor.name} met ${plural(moved.length, "carte")} du dessus de sa bibliothèque ${zoneTo(to)}${names}.`,
    );
  },

  lookAtLibraryTop(g, actor, { count }) {
    assertCount(count);
    for (const id of actor.zones.library.slice(0, count)) {
      addRevealed(g.cards[id]!, [actor.id]);
    }
    log(g, actor.id, `${actor.name} regarde les ${count} cartes du dessus de sa bibliothèque.`);
  },

  revealLibraryTop(g, actor, { count }) {
    assertCount(count);
    const ids = actor.zones.library.slice(0, count);
    for (const id of ids) addRevealed(g.cards[id]!, g.turnOrder);
    log(
      g,
      actor.id,
      `${actor.name} révèle le dessus de sa bibliothèque : ${ids.map((id) => cardName(g, g.cards[id]!)).join(", ")}.`,
    );
  },

  moveCard(g, actor, { cardId, to, controllerId, position, tapped, faceDown }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (controllerId !== undefined) getPlayer(g, controllerId);
    const from = card.zone;
    const wasVisible = isVisibleToAll(card);
    const moved = moveCardTo(g, cardId, to, position ?? "top", { controllerId, tapped, faceDown });
    const nowVisible = g.cards[moved.instanceId] ? isVisibleToAll(moved) : PUBLIC_ZONES.has(to);
    const label = wasVisible || nowVisible ? cardName(g, moved) : "une carte";
    const owner = g.players[moved.ownerId]!;
    const whose = owner.id === actor.id ? "" : ` ${deName(owner.name)}`;
    log(g, actor.id, `${actor.name} déplace ${label}${whose} ${zoneFrom(from)} ${zoneTo(to)}.`);
  },

  setTapped(g, actor, { cardIds, tapped }) {
    const names: string[] = [];
    for (const id of cardIds) {
      const card = getCard(g, id);
      assertCanHandle(g, actor, card);
      if (card.zone !== "battlefield") throw new ActionError("Seuls les permanents s'engagent.");
      card.tapped = tapped;
      names.push(cardName(g, card));
    }
    log(g, actor.id, `${actor.name} ${tapped ? "engage" : "dégage"} ${names.join(", ")}.`);
  },

  untapAll(g, actor) {
    for (const id of actor.zones.battlefield) g.cards[id]!.tapped = false;
    log(g, actor.id, `${actor.name} dégage ses permanents.`);
  },

  setFaceDown(g, actor, { cardId, faceDown }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (card.zone !== "battlefield" && card.zone !== "exile") {
      throw new ActionError("Une carte ne peut être face cachée que sur le champ de bataille ou en exil.");
    }
    const wasVisible = isVisibleToAll(card);
    card.faceDown = faceDown;
    if (faceDown) card.revealedTo = [card.controllerId];
    const name = wasVisible || !faceDown ? cardName(g, card) : "une carte";
    log(g, actor.id, `${actor.name} ${faceDown ? "retourne face cachée" : "retourne face visible"} ${name}.`);
  },

  transform(g, actor, { cardId }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    const faces = g.cardData[card.cardId]?.faces?.length ?? 0;
    if (faces < 2) throw new ActionError("Cette carte n'a qu'une face.");
    const before = cardName(g, card);
    card.faceIndex = (card.faceIndex + 1) % faces;
    log(g, actor.id, `${actor.name} transforme ${before} en ${cardName(g, card)}.`);
  },

  adjustCardCounter(g, actor, { cardId, kind, delta }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (!kind.trim()) throw new ActionError("Type de marqueur vide.");
    const value = Math.max(0, (card.counters[kind] ?? 0) + delta);
    if (value === 0) delete card.counters[kind];
    else card.counters[kind] = value;
    log(g, actor.id, `${actor.name} ${delta >= 0 ? "ajoute" : "retire"} ${plural(Math.abs(delta), `marqueur ${kind}`)} ${delta >= 0 ? "sur" : "de"} ${cardName(g, card)}.`);
  },

  attach(g, actor, { cardId, targetId }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (targetId === null) {
      delete card.attachedTo;
      log(g, actor.id, `${actor.name} détache ${cardName(g, card)}.`);
      return;
    }
    if (targetId === cardId) throw new ActionError("Une carte ne peut pas s'attacher à elle-même.");
    const target = getCard(g, targetId);
    if (card.zone !== "battlefield" || target.zone !== "battlefield") {
      throw new ActionError("Les deux cartes doivent être sur le champ de bataille.");
    }
    card.attachedTo = targetId;
    log(g, actor.id, `${actor.name} attache ${cardName(g, card)} à ${cardName(g, target)}.`);
  },

  changeControl(g, actor, { cardId, controllerId }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (card.zone !== "battlefield") throw new ActionError("Seuls les permanents changent de contrôleur.");
    const newController = getPlayer(g, controllerId);
    removeFromZone(g, card);
    card.controllerId = controllerId;
    newController.zones.battlefield.push(card.instanceId);
    log(g, actor.id, `${newController.name} prend le contrôle de ${cardName(g, card)}.`);
  },

  revealCards(g, actor, { cardIds, to }) {
    const targets = to === "all" ? g.turnOrder : to;
    for (const id of targets) getPlayer(g, id);
    const names: string[] = [];
    for (const id of cardIds) {
      const card = getCard(g, id);
      if (!canSee(card, actor.id)) throw new ActionError("Tu ne peux révéler qu'une carte que tu vois.");
      addRevealed(card, targets);
      names.push(cardName(g, card));
    }
    const audience = to === "all" ? "à tous" : `à ${targets.map((id) => g.players[id]!.name).join(", ")}`;
    // Le journal est public : on ne nomme les cartes que si elles sont révélées à tous.
    const what = to === "all" ? names.join(", ") : plural(names.length, "carte");
    log(g, actor.id, `${actor.name} révèle ${what} ${audience}.`);
  },

  createToken(g, actor, { card, count, tapped }) {
    const n = count ?? 1;
    assertCount(n);
    g.cardData[card.id] ??= card;
    for (let i = 0; i < n; i++) {
      const instance = newInstance(g, card.id, actor.id, "battlefield");
      instance.isToken = true;
      instance.tapped = tapped ?? false;
      actor.zones.battlefield.push(instance.instanceId);
    }
    log(g, actor.id, `${actor.name} crée ${n > 1 ? `${n} jetons` : "un jeton"} ${card.name}.`);
  },

  adjustLife(g, actor, { playerId, delta }) {
    const player = getPlayer(g, playerId);
    player.life += delta;
    log(g, actor.id, `${player.name} ${delta >= 0 ? "gagne" : "perd"} ${Math.abs(delta)} PV (${player.life}).`);
  },

  adjustPoison(g, actor, { playerId, delta }) {
    const player = getPlayer(g, playerId);
    player.poison = Math.max(0, player.poison + delta);
    log(g, actor.id, `${player.name} a ${plural(player.poison, "marqueur poison", "marqueurs poison")}.`);
  },

  adjustCommanderDamage(g, actor, { playerId, commanderId, delta, affectLife }) {
    const player = getPlayer(g, playerId);
    const commander = getCard(g, commanderId);
    if (!commander.isCommander) throw new ActionError("Cette carte n'est pas un commandant.");
    const total = Math.max(0, (player.commanderDamage[commanderId] ?? 0) + delta);
    player.commanderDamage[commanderId] = total;
    if (affectLife ?? true) player.life -= delta;
    log(
      g,
      actor.id,
      `${player.name} ${delta >= 0 ? "subit" : "retire"} ${Math.abs(delta)} blessures de ${cardName(g, commander)} (total ${total}/${g.settings.commanderDamageLimit}).`,
    );
  },

  adjustPlayerCounter(g, actor, { playerId, kind, delta }) {
    const player = getPlayer(g, playerId);
    if (!kind.trim()) throw new ActionError("Type de marqueur vide.");
    const value = Math.max(0, (player.counters[kind] ?? 0) + delta);
    if (value === 0) delete player.counters[kind];
    else player.counters[kind] = value;
    log(g, actor.id, `${player.name} a ${value} ${kind}.`);
  },

  passTurn(g, actor) {
    if (g.turn.activePlayerId !== actor.id) {
      throw new ActionError("Ce n'est pas ton tour.");
    }
    const next = nextActivePlayer(g, actor.id);
    if (next === null) throw new ActionError("Plus aucun joueur en lice.");
    g.turn.number += 1;
    g.turn.activePlayerId = next;
    log(g, actor.id, `Tour ${g.turn.number} : c'est à ${g.players[next]!.name}.`);
  },

  rollDie(g, actor, { sides }) {
    if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
      throw new ActionError("Nombre de faces invalide.");
    }
    const r = nextRandom(g.rngState);
    g.rngState = r.state;
    const result = 1 + Math.floor(r.value * sides);
    log(g, actor.id, `${actor.name} lance un dé à ${sides} faces : ${result}.`);
  },

  concede(g, actor) {
    if (actor.hasConceded) throw new ActionError("Tu as déjà abandonné.");
    actor.hasConceded = true;
    log(g, actor.id, `${actor.name} abandonne la partie.`);
    if (g.turn.activePlayerId === actor.id) {
      const next = nextActivePlayer(g, actor.id);
      if (next !== null) {
        g.turn.number += 1;
        g.turn.activePlayerId = next;
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Outils internes, exportés pour la mise en place de partie et les tests.

export function getPlayer(g: GameState, id: PlayerId): PlayerState {
  const player = g.players[id];
  if (!player) throw new ActionError("Joueur inconnu.");
  return player;
}

export function getCard(g: GameState, id: CardInstanceId): CardInstance {
  const card = g.cards[id];
  if (!card) throw new ActionError("Carte introuvable.");
  return card;
}

/** Liste (modifiable) des cartes d'une zone. */
export function zoneList(g: GameState, card: Pick<CardInstance, "zone" | "ownerId" | "controllerId">): CardInstanceId[] {
  if (card.zone === "stack") return g.stack;
  const holder = card.zone === "battlefield" ? card.controllerId : card.ownerId;
  return g.players[holder]!.zones[card.zone];
}

export function canSee(card: CardInstance, viewerId: PlayerId): boolean {
  if (card.revealedTo.includes(viewerId)) return true;
  if (card.zone === "library") return false;
  if (card.zone === "hand") return card.ownerId === viewerId;
  if (card.faceDown) return card.controllerId === viewerId;
  return true;
}

function isVisibleToAll(card: CardInstance): boolean {
  return PUBLIC_ZONES.has(card.zone) && !card.faceDown;
}

/**
 * Un joueur peut manipuler ses propres cartes, et toute carte visible par tous
 * (pratique pour détruire ou voler un permanent adverse : le journal garde la
 * trace de qui a fait quoi).
 */
function assertCanHandle(g: GameState, actor: PlayerState, card: CardInstance): void {
  if (card.ownerId === actor.id || card.controllerId === actor.id) return;
  if (PUBLIC_ZONES.has(card.zone)) return;
  throw new ActionError("Tu ne peux pas toucher aux cartes cachées d'un autre joueur.");
}

function removeFromZone(g: GameState, card: CardInstance): void {
  const list = zoneList(g, card);
  const index = list.indexOf(card.instanceId);
  if (index >= 0) list.splice(index, 1);
}

function insertAt(list: CardInstanceId[], id: CardInstanceId, zone: Zone, position: "top" | "bottom" | number): void {
  if (typeof position === "number") {
    list.splice(Math.max(0, Math.min(position, list.length)), 0, id);
  } else if (position === "bottom") {
    list.push(id);
  } else if (zone === "library") {
    // Bibliothèque : l'index 0 est le dessus.
    list.unshift(id);
  } else {
    // Autres zones : la carte la plus récente est à la fin (dessus du cimetière, haut de la pile).
    list.push(id);
  }
}

/**
 * Déplace une carte en appliquant les règles de changement de zone :
 * - une carte qui quitte le champ de bataille perd ses marqueurs, se dégage,
 *   revient à son propriétaire et se détache ;
 * - un jeton qui quitte le champ de bataille cesse d'exister ;
 * - une carte qui entre dans une bibliothèque devient un nouvel objet inconnu ;
 * - lancer son commandant depuis la zone de commandement augmente la taxe.
 *
 * Retourne la carte déplacée (son identifiant peut avoir changé).
 */
export function moveCardTo(
  g: GameState,
  cardId: CardInstanceId,
  to: Zone,
  position: "top" | "bottom" | number,
  options: { controllerId?: PlayerId | undefined; tapped?: boolean | undefined; faceDown?: boolean | undefined } = {},
): CardInstance {
  const card = getCard(g, cardId);
  const from = card.zone;
  const wasPublic = isVisibleToAll(card);
  removeFromZone(g, card);

  if (from === "battlefield" && to !== "battlefield") {
    card.tapped = false;
    card.counters = {};
    delete card.attachedTo;
    for (const other of Object.values(g.cards)) {
      if (other.attachedTo === card.instanceId) delete other.attachedTo;
    }
    if (card.isToken) {
      delete g.cards[card.instanceId];
      return card;
    }
  }

  if (card.isCommander && from === "command" && (to === "stack" || to === "battlefield")) {
    const owner = g.players[card.ownerId]!;
    owner.commanderCasts[card.instanceId] = (owner.commanderCasts[card.instanceId] ?? 0) + 1;
  }

  card.controllerId = to === "battlefield" || to === "stack" ? (options.controllerId ?? card.controllerId) : card.ownerId;
  if (from === "battlefield" && to !== "battlefield") card.controllerId = card.ownerId;
  card.zone = to;
  card.faceDown = (to === "battlefield" || to === "exile") && (options.faceDown ?? false);
  if (to !== "battlefield") card.faceIndex = 0;
  if (to === "battlefield") card.tapped = options.tapped ?? false;

  if (card.faceDown) {
    card.revealedTo = [card.controllerId];
  } else if (to === "library") {
    card.revealedTo = wasPublic ? [...g.turnOrder] : [];
  } else if (wasPublic) {
    card.revealedTo = [...g.turnOrder];
  }

  let id = card.instanceId;
  if (to === "library" && from !== "library") {
    id = renameInstance(g, id);
  }
  insertAt(zoneList(g, card), id, to, position);
  return g.cards[id]!;
}

function shuffleLibrary(g: GameState, player: PlayerState): void {
  const library = player.zones.library;
  g.rngState = shuffleInPlace(library, g.rngState);
  // Après un mélange, plus personne ne sait où sont les cartes : on leur
  // donne de nouveaux identifiants pour qu'on ne puisse pas les suivre.
  for (let i = 0; i < library.length; i++) {
    const card = g.cards[library[i]!]!;
    card.revealedTo = [];
    library[i] = renameInstance(g, card.instanceId, false);
  }
}

/** Crée une nouvelle instance de carte (non placée dans une zone). */
export function newInstance(g: GameState, cardId: string, ownerId: PlayerId, zone: Zone): CardInstance {
  const instance: CardInstance = {
    instanceId: newInstanceId(g),
    cardId,
    ownerId,
    controllerId: ownerId,
    zone,
    tapped: false,
    faceDown: false,
    faceIndex: 0,
    counters: {},
    isToken: false,
    isCommander: false,
    revealedTo: [],
  };
  g.cards[instance.instanceId] = instance;
  return instance;
}

function newInstanceId(g: GameState): string {
  // Identifiant aléatoire : il ne révèle rien sur l'ordre ou le contenu du deck.
  let id: string;
  do {
    id = "c";
    for (let i = 0; i < 2; i++) {
      const r = nextRandom(g.rngState);
      g.rngState = r.state;
      id += Math.floor(r.value * 2 ** 32).toString(36).padStart(7, "0");
    }
  } while (g.cards[id]);
  return id;
}

/**
 * Donne un nouvel identifiant à une carte et met à jour toutes les
 * références (blessures et taxe de commandant comprises, car un commandant
 * reste le même commandant d'une zone à l'autre).
 */
function renameInstance(g: GameState, oldId: CardInstanceId, updateZone = true): CardInstanceId {
  const card = g.cards[oldId]!;
  const newId = newInstanceId(g);
  delete g.cards[oldId];
  card.instanceId = newId;
  g.cards[newId] = card;
  if (updateZone) {
    const list = zoneList(g, card);
    const index = list.indexOf(oldId);
    if (index >= 0) list[index] = newId;
  }
  for (const other of Object.values(g.cards)) {
    if (other.attachedTo === oldId) other.attachedTo = newId;
  }
  if (card.isCommander) {
    for (const player of Object.values(g.players)) {
      renameKey(player.commanderDamage, oldId, newId);
      renameKey(player.commanderCasts, oldId, newId);
    }
  }
  return newId;
}

function renameKey(record: Record<string, number>, oldKey: string, newKey: string): void {
  if (oldKey in record) {
    record[newKey] = record[oldKey]!;
    delete record[oldKey];
  }
}

function addRevealed(card: CardInstance, players: PlayerId[]): void {
  for (const id of players) if (!card.revealedTo.includes(id)) card.revealedTo.push(id);
}

function nextActivePlayer(g: GameState, from: PlayerId): PlayerId | null {
  const start = g.turnOrder.indexOf(from);
  for (let i = 1; i <= g.turnOrder.length; i++) {
    const candidate = g.turnOrder[(start + i) % g.turnOrder.length]!;
    if (!g.players[candidate]!.hasConceded) return candidate;
  }
  return null;
}

export function cardName(g: GameState, card: CardInstance): string {
  const data: CardData | undefined = g.cardData[card.cardId];
  if (!data) return "une carte";
  return data.faces?.[card.faceIndex]?.name ?? data.name;
}

export function log(g: GameState, actorId: PlayerId | null, message: string): void {
  const seq = (g.log[g.log.length - 1]?.seq ?? 0) + 1;
  g.log.push({ seq, actorId, message });
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new ActionError("Nombre de cartes invalide.");
  }
}

/** « de Bruno », « d'Alice ». */
function deName(name: string): string {
  return /^[aeiouyhàâéèêëîïôöûüæœ]/i.test(name) ? `d'${name}` : `de ${name}`;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

const ZONE_NAMES: Record<Zone, { from: string; to: string }> = {
  library: { from: "de la bibliothèque", to: "dans la bibliothèque" },
  hand: { from: "de la main", to: "en main" },
  battlefield: { from: "du champ de bataille", to: "sur le champ de bataille" },
  graveyard: { from: "du cimetière", to: "au cimetière" },
  exile: { from: "de l'exil", to: "en exil" },
  command: { from: "de la zone de commandement", to: "dans la zone de commandement" },
  stack: { from: "de la pile", to: "sur la pile" },
};

function zoneFrom(zone: Zone): string {
  return ZONE_NAMES[zone].from;
}

function zoneTo(zone: Zone): string {
  return ZONE_NAMES[zone].to;
}
