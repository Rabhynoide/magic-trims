import type { ActionEnvelope, GameAction } from "./actions.js";
import { nextRandom, shuffleInPlace } from "./rng.js";
import { isActivePlayer, lifeSharers, areTeammates, teamOf } from "./modes.js";
import { MAX_HAND_SIZE, STEP_PHRASES, TURN_STEPS, isTurnStep, stepIndex, type TurnStep } from "./turn.js";
import {
  HIDDEN_ORDERED_ZONES,
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
    if (envelope.action.type !== "passPriority") updatePriority(state, draft, actor);
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
    drawCards(g, actor, count);
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
    const toBottom = Math.min(
      actor.zones.hand.length,
      Math.max(0, actor.mulligans - (g.settings.freeFirstMulligan ? 1 : 0)),
    );
    actor.mulliganBottom = toBottom;
    log(
      g,
      actor.id,
      toBottom > 0
        ? `${actor.name} prend un mulligan et doit mettre ${plural(toBottom, "carte")} au-dessous de sa bibliothèque.`
        : `${actor.name} prend un mulligan gratuit.`,
    );
  },

  bottomMulligan(g, actor, { cardIds }) {
    const count = actor.mulliganBottom;
    if (count === 0) throw new ActionError("Tu n'as pas de cartes à mettre au-dessous après un mulligan.");
    if (new Set(cardIds).size !== cardIds.length || cardIds.length !== count) {
      throw new ActionError(`Choisis exactement ${plural(count, "carte")} de ta main.`);
    }
    for (const id of cardIds) {
      if (!actor.zones.hand.includes(id)) throw new ActionError("Choisis des cartes de ta main.");
    }
    for (const id of cardIds) moveCardTo(g, id, "library", "bottom");
    actor.mulliganBottom = 0;
    log(g, actor.id, `${actor.name} garde sa main et met ${plural(count, "carte")} au-dessous de sa bibliothèque.`);
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
      if (!canSee(g, card, actor.id)) throw new ActionError("Tu ne peux révéler qu'une carte que tu vois.");
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
    getPlayer(g, playerId);
    const sharers = lifeSharers(g, playerId);
    for (const p of sharers) p.life += delta;
    const who = names(sharers);
    const verb = sharers.length > 1 ? (delta >= 0 ? "gagnent" : "perdent") : delta >= 0 ? "gagne" : "perd";
    log(g, actor.id, `${who} ${verb} ${Math.abs(delta)} PV (${sharers[0]!.life}).`);
  },

  adjustPoison(g, actor, { playerId, delta }) {
    getPlayer(g, playerId);
    const sharers = lifeSharers(g, playerId);
    for (const p of sharers) p.poison = Math.max(0, p.poison + delta);
    const total = sharers[0]!.poison;
    log(g, actor.id, `${names(sharers)} ${sharers.length > 1 ? "ont" : "a"} ${plural(total, "marqueur poison", "marqueurs poison")}.`);
  },

  adjustCommanderDamage(g, actor, { playerId, commanderId, delta, affectLife }) {
    getPlayer(g, playerId);
    const commander = getCard(g, commanderId);
    if (!commander.isCommander) throw new ActionError("Cette carte n'est pas un commandant.");
    const sharers = lifeSharers(g, playerId);
    const total = Math.max(0, (sharers[0]!.commanderDamage[commanderId] ?? 0) + delta);
    for (const p of sharers) {
      p.commanderDamage[commanderId] = total;
      if (affectLife ?? true) p.life -= delta;
    }
    const verb = sharers.length > 1 ? (delta >= 0 ? "subissent" : "retirent") : delta >= 0 ? "subit" : "retire";
    log(
      g,
      actor.id,
      `${names(sharers)} ${verb} ${Math.abs(delta)} blessures de ${cardName(g, commander)} (total ${total}/${g.settings.commanderDamageLimit}).`,
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

  nextStep(g, actor, { to }) {
    assertActive(g, actor);
    assertStackEmpty(g);
    assertMulligansDone(g);
    if (to === undefined && g.turn.step === "cleanup") return passTurn(g, actor);
    if (to !== undefined && !isTurnStep(to)) throw new ActionError("Étape inconnue.");
    const target = to ?? TURN_STEPS[stepIndex(g.turn.step) + 1]!;
    if (stepIndex(target) <= stepIndex(g.turn.step)) {
      throw new ActionError("On ne revient pas en arrière dans le tour.");
    }
    while (g.turn.step !== target) enterStep(g, TURN_STEPS[stepIndex(g.turn.step) + 1]!);
    log(g, actor.id, `${actor.name} passe à ${STEP_PHRASES[target]}.`);
  },

  passTurn(g, actor) {
    assertActive(g, actor);
    assertStackEmpty(g);
    assertMulligansDone(g);
    passTurn(g, actor);
  },

  passPriority(g, actor) {
    const priority = g.priority;
    if (!priority || g.stack.length === 0) throw new ActionError("La pile est vide : personne n'a la priorité.");
    if (!samePriorityUnit(g, priority.playerId, actor.id)) {
      throw new ActionError(`C'est à ${g.players[priority.playerId]!.name} d'agir.`);
    }
    const units = priorityUnits(g);
    const unit = units.find((u) => u.includes(actor.id))!;
    priority.passed = [...new Set([...priority.passed, ...unit])];
    log(g, actor.id, `${names(unit.map((id) => g.players[id]!))} ${unit.length > 1 ? "passent" : "passe"}.`);
    if (units.every((u) => u.some((id) => priority.passed.includes(id)))) {
      resolveTop(g);
      g.priority = g.stack.length > 0 ? { playerId: g.turn.activePlayerId, passed: [] } : null;
      return;
    }
    const next = units[(units.indexOf(unit) + 1) % units.length]!;
    priority.playerId = next[0]!;
  },

  setSchemeInMotion(g, actor) {
    if (g.archenemyId !== actor.id) throw new ActionError("Seul l'archenemy met des machinations en marche.");
    const top = actor.zones.schemes[0];
    if (!top) throw new ActionError("Ta pioche de machinations est vide.");
    const scheme = moveCardTo(g, top, "command", "top");
    log(g, actor.id, `${actor.name} met en marche la machination ${cardName(g, scheme)}.`);
  },

  planeswalk(g, actor) {
    if (!g.settings.planechase) throw new ActionError("La variante Planechase n'est pas activée.");
    planeswalk(g, actor);
  },

  rollPlanarDie(g, actor) {
    if (!g.settings.planechase) throw new ActionError("La variante Planechase n'est pas activée.");
    const cost = g.turn.planarDieRolls;
    g.turn.planarDieRolls += 1;
    const r = nextRandom(g.rngState);
    g.rngState = r.state;
    // Dé planaire : une face planeswalk, une face chaos, quatre faces vierges.
    const face = Math.floor(r.value * 6);
    const costText = cost > 0 ? ` (coût : {${cost}})` : "";
    if (face === 0) {
      log(g, actor.id, `${actor.name} lance le dé planaire${costText} : planeswalk !`);
      planeswalk(g, actor);
    } else if (face === 1) {
      const plane = g.plane[0];
      log(g, actor.id, `${actor.name} lance le dé planaire${costText} : chaos${plane ? ` (${cardName(g, g.cards[plane]!)})` : ""} !`);
    } else {
      log(g, actor.id, `${actor.name} lance le dé planaire${costText} : rien.`);
    }
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
    // Quand les points de vie sont partagés, l'équipe perd ensemble.
    const leaving = g.settings.sharedTeamLife ? lifeSharers(g, actor.id) : [actor];
    for (const p of leaving) p.hasConceded = true;
    log(g, actor.id, `${names(leaving)} ${leaving.length > 1 ? "abandonnent" : "abandonne"} la partie.`);
    const active = g.players[g.turn.activePlayerId]!;
    if (active.hasConceded) {
      const stillActive = g.settings.sharedTurns
        ? teamOf(g, active.id).find((id) => !g.players[id]!.hasConceded)
        : undefined;
      if (stillActive) {
        g.turn.activePlayerId = stillActive;
      } else {
        const next = nextActivePlayer(g, active.id);
        if (next !== null) startTurn(g, next);
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
  if (card.zone === "stack" || card.zone === "planarDeck" || card.zone === "plane") return g[card.zone];
  const holder = card.zone === "battlefield" ? card.controllerId : card.ownerId;
  return g.players[holder]!.zones[card.zone];
}

export function canSee(g: GameState, card: CardInstance, viewerId: PlayerId): boolean {
  if (card.revealedTo.includes(viewerId)) return true;
  if (HIDDEN_ORDERED_ZONES.has(card.zone)) return false;
  if (card.zone === "hand") {
    return card.ownerId === viewerId || (g.settings.teammatesSeeHands && areTeammates(g, card.ownerId, viewerId));
  }
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
  } else if (HIDDEN_ORDERED_ZONES.has(zone)) {
    // Bibliothèque et autres pioches : l'index 0 est le dessus.
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
  } else if (HIDDEN_ORDERED_ZONES.has(to)) {
    card.revealedTo = wasPublic ? [...g.turnOrder] : [];
  } else if (wasPublic) {
    card.revealedTo = [...g.turnOrder];
  }

  let id = card.instanceId;
  if (HIDDEN_ORDERED_ZONES.has(to) && from !== to) {
    id = renameInstance(g, id);
  }
  insertAt(zoneList(g, card), id, to, position);
  return g.cards[id]!;
}

function shuffleLibrary(g: GameState, player: PlayerState): void {
  shuffleZone(g, player.zones.library);
}

/** Mélange une pioche cachée (bibliothèque, machinations, plans). */
export function shuffleZone(g: GameState, library: CardInstanceId[]): void {
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

/**
 * Prochain joueur actif dans l'ordre du tour. En tours partagés, on saute les
 * coéquipiers du joueur actuel : c'est l'équipe suivante qui joue.
 */
function nextActivePlayer(g: GameState, from: PlayerId): PlayerId | null {
  const start = g.turnOrder.indexOf(from);
  const skip = g.settings.sharedTurns ? teamOf(g, from) : [from];
  for (let i = 1; i <= g.turnOrder.length; i++) {
    const candidate = g.turnOrder[(start + i) % g.turnOrder.length]!;
    if (skip.includes(candidate) && candidate !== from) continue;
    if (!g.players[candidate]!.hasConceded) return candidate;
  }
  return null;
}

/** Tant qu'un joueur n'a pas fini son mulligan, la partie n'avance pas. */
function assertMulligansDone(g: GameState): void {
  const waiting = Object.values(g.players).filter((p) => !p.hasConceded && p.mulliganBottom > 0);
  if (waiting.length === 0) return;
  throw new ActionError(
    `${names(waiting)} ${waiting.length > 1 ? "doivent" : "doit"} d'abord mettre des cartes au-dessous de ${waiting.length > 1 ? "leur" : "sa"} bibliothèque (mulligan).`,
  );
}

function assertStackEmpty(g: GameState): void {
  if (g.stack.length > 0) throw new ActionError("La pile n'est pas vide : elle doit d'abord se résoudre.");
}

/**
 * Ceux qui reçoivent la priorité, dans l'ordre du tour à partir du joueur
 * actif. En tours partagés, une équipe la reçoit en bloc.
 */
function priorityUnits(g: GameState): PlayerId[][] {
  const start = g.turnOrder.indexOf(g.turn.activePlayerId);
  const units: PlayerId[][] = [];
  for (let i = 0; i < g.turnOrder.length; i++) {
    const id = g.turnOrder[(start + i) % g.turnOrder.length]!;
    if (g.players[id]!.hasConceded || units.some((u) => u.includes(id))) continue;
    const unit = g.settings.sharedTurns ? teamOf(g, id).filter((m) => !g.players[m]!.hasConceded) : [id];
    units.push(unit);
  }
  return units;
}

function samePriorityUnit(g: GameState, a: PlayerId, b: PlayerId): boolean {
  return a === b || (g.settings.sharedTurns && areTeammates(g, a, b));
}

/**
 * Tient la priorité à jour après une action (hors « passer ») : quand un
 * joueur met un objet sur la pile, il reçoit la priorité et les passes
 * repartent de zéro ; si la pile change autrement, c'est au joueur actif.
 */
function updatePriority(before: GameState, g: GameState, actor: PlayerState): void {
  if (g.stack.length === 0) {
    g.priority = null;
    return;
  }
  const added = g.stack.some((id) => !before.stack.includes(id));
  const changed = g.stack.length !== before.stack.length || g.stack.some((id, i) => before.stack[i] !== id);
  if (added) g.priority = { playerId: actor.id, passed: [] };
  else if (changed || !g.priority) g.priority = { playerId: g.turn.activePlayerId, passed: [] };
  // Un joueur qui abandonne en tenant la priorité la laisse au suivant.
  if (g.players[g.priority.playerId]!.hasConceded) {
    const from = g.turnOrder.indexOf(g.priority.playerId);
    const next = g.turnOrder.map((_, i) => g.turnOrder[(from + 1 + i) % g.turnOrder.length]!).find((id) => !g.players[id]!.hasConceded);
    g.priority.playerId = next ?? g.turn.activePlayerId;
  }
}

/**
 * Résout l'objet du dessus de la pile. Le moteur ne connaît pas encore les
 * effets des cartes : il range la carte (champ de bataille pour un permanent,
 * cimetière pour un éphémère ou un rituel) et les joueurs appliquent l'effet.
 */
function resolveTop(g: GameState): void {
  const id = g.stack.at(-1)!;
  const card = g.cards[id]!;
  const name = cardName(g, card);
  const typeLine = currentTypeLine(g, card);
  if (/\b(Instant|Sorcery)\b/.test(typeLine)) {
    moveCardTo(g, id, "graveyard", "top");
    log(g, null, `${name} se résout et va au cimetière (appliquez son effet).`);
  } else {
    moveCardTo(g, id, "battlefield", "top", { controllerId: card.controllerId });
    log(g, null, `${name} se résout et arrive sur le champ de bataille.`);
  }
}

function currentTypeLine(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  if (!data) return "";
  return data.faces?.[card.faceIndex]?.typeLine ?? data.typeLine;
}

function assertActive(g: GameState, actor: PlayerState): void {
  if (!isActivePlayer(g, actor.id)) throw new ActionError("Ce n'est pas ton tour.");
}

function passTurn(g: GameState, actor: PlayerState): void {
  const next = nextActivePlayer(g, g.turn.activePlayerId);
  if (next === null) throw new ActionError("Plus aucun joueur en lice.");
  // Les étapes restantes ont lieu (le nettoyage rappelle la taille de main).
  while (g.turn.step !== "cleanup") enterStep(g, TURN_STEPS[stepIndex(g.turn.step) + 1]!);
  startTurn(g, next);
}

/** Joueurs actifs encore en lice (plusieurs en tours partagés). */
function activePlayers(g: GameState): PlayerState[] {
  const ids = g.settings.sharedTurns ? teamOf(g, g.turn.activePlayerId) : [g.turn.activePlayerId];
  return ids.map((id) => g.players[id]!).filter((p) => !p.hasConceded);
}

/**
 * Début d'un tour : l'étape de dégagement n'a pas de priorité (règle 502.4),
 * on enchaîne donc directement sur l'entretien.
 */
function startTurn(g: GameState, playerId: PlayerId): void {
  g.turn.number += 1;
  g.turn.activePlayerId = playerId;
  g.turn.planarDieRolls = 0;
  log(g, null, `Tour ${g.turn.number} : c'est à ${activeNames(g)}.`);
  enterStep(g, "untap");
  enterStep(g, "upkeep");
}

/** Entre dans une étape et fait ses actions obligatoires (actions de tour). */
function enterStep(g: GameState, step: TurnStep): void {
  g.turn.step = step;
  if (!g.settings.autoTurnActions) return;
  const players = activePlayers(g);
  switch (step) {
    case "untap":
      for (const p of players) {
        for (const id of p.zones.battlefield) g.cards[id]!.tapped = false;
      }
      if (players.length > 0) log(g, null, `${names(players)} ${players.length > 1 ? "dégagent leurs" : "dégage ses"} permanents.`);
      break;
    case "draw":
      if (skipsFirstDraw(g)) {
        log(g, null, `${names(players)} ne ${players.length > 1 ? "piochent" : "pioche"} pas au premier tour.`);
      } else {
        for (const p of players) drawCards(g, p, 1);
      }
      break;
    case "cleanup":
      for (const p of players) {
        const excess = p.zones.hand.length - MAX_HAND_SIZE;
        if (excess > 0) {
          log(g, null, `${p.name} a ${p.zones.hand.length} cartes en main et doit en défausser ${excess} (maximum ${MAX_HAND_SIZE}).`);
        }
      }
      break;
  }
}

/**
 * Le premier joueur ne pioche pas à son premier tour dans une partie à deux
 * (règle 103.8a), ni l'équipe qui commence en Géant à deux têtes (103.8b).
 * En multijoueur, tout le monde pioche.
 */
function skipsFirstDraw(g: GameState): boolean {
  if (g.turn.number !== 1) return false;
  return g.turnOrder.length === 2 || g.settings.mode === "twoHeadedGiant";
}

function drawCards(g: GameState, player: PlayerState, count: number): void {
  const library = player.zones.library;
  const drawn = Math.min(count, library.length);
  for (let i = 0; i < drawn; i++) moveCardTo(g, library[0]!, "hand", "top");
  log(g, player.id, `${player.name} pioche ${plural(drawn, "carte")}.`);
  if (drawn < count) log(g, player.id, `${player.name} tente de piocher dans une bibliothèque vide.`);
}

function activeNames(g: GameState): string {
  const active = g.settings.sharedTurns ? teamOf(g, g.turn.activePlayerId) : [g.turn.activePlayerId];
  return names(active.map((id) => g.players[id]!).filter((p) => !p.hasConceded));
}

/** Le plan actif retourne au-dessous de la pioche de plans, et on révèle le suivant. */
function planeswalk(g: GameState, actor: PlayerState): void {
  if (g.planarDeck.length + g.plane.length === 0) throw new ActionError("La pioche de plans est vide.");
  for (const id of [...g.plane]) moveCardTo(g, id, "planarDeck", "bottom");
  // Le dessus a pu changer si la pioche ne contenait qu'un plan.
  const plane = moveCardTo(g, g.planarDeck[0]!, "plane", "top");
  log(g, actor.id, `${actor.name} se rend sur le plan ${cardName(g, plane)}.`);
}

function names(players: PlayerState[]): string {
  const list = players.map((p) => p.name);
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} et ${list.at(-1)}`;
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
  schemes: { from: "de la pioche de machinations", to: "dans la pioche de machinations" },
  planarDeck: { from: "de la pioche de plans", to: "dans la pioche de plans" },
  plane: { from: "du plan actif", to: "sur le plan actif" },
};

function zoneFrom(zone: Zone): string {
  return ZONE_NAMES[zone].from;
}

function zoneTo(zone: Zone): string {
  return ZONE_NAMES[zone].to;
}
