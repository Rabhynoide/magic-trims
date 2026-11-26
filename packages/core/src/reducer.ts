import type { ActionEnvelope, GameAction } from "./actions.js";
import { nextRandom, shuffleInPlace } from "./rng.js";
import { eliminationReason, isActivePlayer, lifeSharers, areTeammates, teamOf } from "./modes.js";
import {
  MANA_LABELS,
  emptyPool,
  formatMana,
  isManaType,
  manaOptions,
  parseManaCost,
  payFromPool,
  type ManaNeed,
  type ManaType,
} from "./mana.js";
import {
  KEYWORD_HELP,
  cardSupport,
  isLegalTarget,
  matchesPermanent,
  resolveAmount,
  spellEffectsOf,
  permanentLabel,
  type Effect,
  type SpellEffects,
  type Target,
  type Who,
} from "./effects.js";
import { abilitiesOf, conditionMatches, type TriggerEvent } from "./triggers.js";
import {
  attackTaxPerCreature,
  cantGainLife,
  cantPlayLands,
  castRestriction,
  costReduction,
  entersTapped,
  hasNoMaxHandSize,
} from "./statics.js";
import { canAttack, canBlock, cantAttack, cantBlock, creatureStats, hasKeyword, hasLethalDamage, isCreature, lethalDamage, type CombatState } from "./combat.js";
import { MAX_HAND_SIZE, STEP_LABELS, STEP_PHRASES, TURN_STEPS, isTurnStep, stepIndex, type TurnStep } from "./turn.js";
import {
  HIDDEN_ORDERED_ZONES,
  PUBLIC_ZONES,
  type CardData,
  type CardInstance,
  type CardInstanceId,
  type GameState,
  type PlayerId,
  type PendingAdvance,
  type PlayerState,
  type PriorityStops,
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
      throw new ActionError(actor.lostReason ? "Tu as perdu cette partie." : "Tu as abandonné cette partie.");
    }
    handlers[envelope.action.type](draft, actor, envelope.action as never);
    checkStateBasedActions(draft);
    flushTriggers(draft);
    if (envelope.action.type !== "passPriority") updatePriority(state, draft, actor);
    // Des capacités déclenchées à la résolution : le joueur actif reçoit la priorité.
    else if (draft.stack.length > 0 && !draft.priority) draft.priority = { playerId: draft.turn.activePlayerId, passed: [] };
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

  moveCard(g, actor, { cardId, to, controllerId, position, tapped, faceDown, force }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (controllerId !== undefined) getPlayer(g, controllerId);
    const from = card.zone;
    if (
      g.settings.enforceRules &&
      !force &&
      (from === "hand" || from === "command") &&
      (to === "battlefield" || to === "stack")
    ) {
      throw new ActionError(
        "Joue cette carte avec un double-clic : le moteur vérifie le moment et paie le coût. Pour un effet qui la met directement en jeu, passe par son menu (clic droit).",
      );
    }
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

  tapForMana(g, actor, { cardId, choice }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (card.zone !== "battlefield") throw new ActionError("Seuls les permanents produisent du mana.");
    if (card.tapped) throw new ActionError(`${cardName(g, card)} est déjà engagé.`);
    const options = cardManaOptions(g, card);
    if (options.length === 0) {
      throw new ActionError(`Le moteur ne sait pas quel mana produit ${cardName(g, card)} : ajoute-le à la main.`);
    }
    if (options.length > 1 && choice === undefined) throw new ActionError("Choisis le mana à produire.");
    tapForMana(g, actor, card, choice ?? 0);
  },

  declareAttackers(g, actor, { attackers }) {
    assertActive(g, actor);
    if (g.turn.step !== "declareAttackers" || !g.combat) {
      throw new ActionError("Les attaquants se déclarent à l'étape de déclaration des attaquants.");
    }
    if (g.combat.attackersDeclared) throw new ActionError("Les attaquants sont déjà déclarés.");
    assertStackEmpty(g);
    const seen = new Set<CardInstanceId>();
    for (const { cardId, defender } of attackers) {
      const card = getCard(g, cardId);
      const name = cardName(g, card);
      if (seen.has(cardId)) throw new ActionError(`${name} est déclaré deux fois.`);
      seen.add(cardId);
      if (card.zone !== "battlefield" || !isActivePlayer(g, card.controllerId)) {
        throw new ActionError(`${name} n'est pas une de tes créatures sur le champ de bataille.`);
      }
      if (!isCreature(g, card)) throw new ActionError(`${name} n'est pas une créature.`);
      if (card.tapped) throw new ActionError(`${name} est engagé.`);
      if (card.summoningSick && !hasKeyword(g, card, "Haste")) {
        throw new ActionError(`${name} vient d'arriver : mal d'invocation.`);
      }
      if (hasKeyword(g, card, "Defender")) throw new ActionError(`${name} a le défenseur et ne peut pas attaquer.`);
      if (cantAttack(g, card)) throw new ActionError(`${name} ne peut pas attaquer.`);
      const target = getPlayer(g, defender);
      if (target.hasConceded) throw new ActionError(`${target.name} a abandonné.`);
      if (isActivePlayer(g, defender)) throw new ActionError("On n'attaque pas son propre camp.");
    }
    // Taxes d'attaque (Ghostly Prison, Propaganda…) : payées d'office, en engageant des terrains au besoin.
    if (g.settings.enforceRules) {
      let tax = 0;
      for (const { defender } of attackers) tax += attackTaxPerCreature(g, defender);
      if (tax > 0) {
        const paid = payMana(g, actor, "", 0, tax, undefined, `attaquer (taxe de {${tax}})`);
        log(g, actor.id, `${actor.name} paie ${formatMana(paid.spent)} pour attaquer.`);
      }
    }
    const combat = g.combat;
    combat.attackersDeclared = true;
    for (const { cardId, defender } of attackers) {
      combat.attackers[cardId] = defender;
      const card = g.cards[cardId]!;
      if (!hasKeyword(g, card, "Vigilance")) card.tapped = true;
      emit(g, { type: "attacks", cardId });
    }
    if (attackers.length === 0) {
      log(g, actor.id, `${actor.name} n'attaque pas.`);
      return;
    }
    const byDefender = new Map<PlayerId, string[]>();
    for (const { cardId, defender } of attackers) {
      byDefender.set(defender, [...(byDefender.get(defender) ?? []), cardName(g, g.cards[cardId]!)]);
    }
    const parts = [...byDefender].map(([d, list]) => `${g.players[d]!.name} avec ${list.join(", ")}`);
    log(g, actor.id, `${actor.name} attaque ${parts.join(" ; ")}.`);
  },

  declareBlockers(g, actor, { blocks }) {
    const combat = g.combat;
    if (g.turn.step !== "declareBlockers" || !combat) {
      throw new ActionError("Les bloqueurs se déclarent à l'étape de déclaration des bloqueurs.");
    }
    if (!pendingBlockers(g).some((p) => p.id === actor.id)) {
      throw new ActionError("Tu n'as pas de bloqueurs à déclarer.");
    }
    assertStackEmpty(g);
    const seen = new Set<CardInstanceId>();
    for (const { cardId, attackerId } of blocks) {
      const card = getCard(g, cardId);
      const name = cardName(g, card);
      if (seen.has(cardId)) throw new ActionError(`${name} ne peut bloquer qu'une créature.`);
      seen.add(cardId);
      if (card.zone !== "battlefield" || card.controllerId !== actor.id) {
        throw new ActionError(`${name} n'est pas une de tes créatures sur le champ de bataille.`);
      }
      if (!isCreature(g, card)) throw new ActionError(`${name} n'est pas une créature.`);
      if (card.tapped) throw new ActionError(`${name} est engagé et ne peut pas bloquer.`);
      if (cantBlock(g, card)) throw new ActionError(`${name} ne peut pas bloquer.`);
      const attacker = getCard(g, attackerId);
      const defender = combat.attackers[attackerId];
      if (!defender || attacker.zone !== "battlefield") throw new ActionError(`${cardName(g, attacker)} n'attaque pas.`);
      if (!defendingSide(g, defender).includes(actor.id)) {
        throw new ActionError(`${cardName(g, attacker)} n'attaque pas ton camp.`);
      }
      if (hasKeyword(g, attacker, "Flying") && !hasKeyword(g, card, "Flying") && !hasKeyword(g, card, "Reach")) {
        throw new ActionError(`${name} ne peut pas bloquer ${cardName(g, attacker)}, qui vole.`);
      }
    }
    for (const { cardId, attackerId } of blocks) {
      combat.blockers[cardId] = attackerId;
      emit(g, { type: "blocks", cardId });
    }
    // La menace : bloquée par deux créatures ou plus, ou pas du tout.
    for (const attackerId of Object.keys(combat.attackers)) {
      const count = Object.values(combat.blockers).filter((a) => a === attackerId).length;
      if (count === 1 && hasKeyword(g, g.cards[attackerId]!, "Menace")) {
        throw new ActionError(`${cardName(g, g.cards[attackerId]!)} a la menace : il faut au moins deux bloqueurs.`);
      }
    }
    for (const { attackerId } of blocks) if (!combat.blocked.includes(attackerId)) combat.blocked.push(attackerId);
    combat.blocksDeclared.push(actor.id);
    if (blocks.length === 0) {
      log(g, actor.id, `${actor.name} ne bloque pas.`);
    } else {
      const list = blocks.map((b) => `${cardName(g, g.cards[b.cardId]!)} bloque ${cardName(g, g.cards[b.attackerId]!)}`);
      log(g, actor.id, `${actor.name} : ${list.join(", ")}.`);
    }
  },

  boostCreature(g, actor, { cardId, power, toughness }) {
    const card = getCard(g, cardId);
    assertCanHandle(g, actor, card);
    if (card.zone !== "battlefield") throw new ActionError("Seules les créatures sur le champ de bataille reçoivent un bonus.");
    if (![power, toughness].every((n) => Number.isInteger(n) && Math.abs(n) <= 100)) {
      throw new ActionError("Bonus invalide.");
    }
    const boost = card.ptBoost ?? { power: 0, toughness: 0 };
    boost.power += power;
    boost.toughness += toughness;
    if (boost.power === 0 && boost.toughness === 0) delete card.ptBoost;
    else card.ptBoost = boost;
    const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    log(g, actor.id, `${cardName(g, card)} reçoit ${sign(power)}/${sign(toughness)} jusqu'à la fin du tour.`);
    destroyLethal(g);
  },

  playLand(g, actor, { cardId, face }) {
    const card = getCard(g, cardId);
    if (card.ownerId !== actor.id || card.zone !== "hand") throw new ActionError("Joue un terrain de ta main.");
    const faceIndex = face ?? 0;
    if (!/\bLand\b/.test(faceTypeLine(g, card, faceIndex))) throw new ActionError(`${cardName(g, card)} n'est pas un terrain.`);
    assertSorceryTiming(g, actor, "jouer un terrain");
    if (actor.landsPlayed >= 1) throw new ActionError("Tu as déjà joué un terrain ce tour.");
    if (g.settings.enforceRules && cantPlayLands(g, actor.id)) throw new ActionError("Un de tes permanents t'empêche de jouer des terrains.");
    const played = moveCardTo(g, cardId, "battlefield", "top");
    played.faceIndex = faceIndex;
    if (g.settings.enforceRules && entersTapped(g.cardData[played.cardId], faceIndex)) played.tapped = true;
    actor.landsPlayed += 1;
    log(g, actor.id, `${actor.name} joue ${cardName(g, played)}.`);
    emit(g, { type: "landPlayed", playerId: actor.id });
  },

  castSpell(g, actor, { cardId, face, x, targets, sacrifice }) {
    const card = getCard(g, cardId);
    const fromCommand = card.zone === "command" && card.isCommander;
    if (card.ownerId !== actor.id || (card.zone !== "hand" && !fromCommand)) {
      throw new ActionError("Lance un sort de ta main ou ton commandant depuis la zone de commandement.");
    }
    const faceIndex = face ?? 0;
    const data = g.cardData[card.cardId]!;
    const faceData = data.faces?.[faceIndex];
    if (face !== undefined && !faceData) throw new ActionError("Cette carte n'a pas cette face.");
    const typeLine = faceData?.typeLine ?? data.typeLine;
    if (/\bLand\b/.test(typeLine)) throw new ActionError("Un terrain se joue, il ne se lance pas.");
    const fast = /\bInstant\b/.test(typeLine) || data.keywords.includes("Flash");
    if (fast) {
      if (g.priority && !samePriorityUnit(g, g.priority.playerId, actor.id)) {
        throw new ActionError(`Attends d'avoir la priorité (c'est à ${g.players[g.priority.playerId]!.name}).`);
      }
    } else {
      assertSorceryTiming(g, actor, "lancer ce sort");
    }
    const xValue = x ?? 0;
    if (!Number.isInteger(xValue) || xValue < 0 || xValue > 100) throw new ActionError("Valeur de X invalide.");
    const castThisTurn = actor.spellsCast?.turn === g.turn.number ? actor.spellsCast.count : 0;
    if (g.settings.enforceRules) {
      const restriction = castRestriction(g, actor.id, typeLine, castThisTurn);
      if (restriction) throw new ActionError(restriction);
    }
    // Cibles des effets que le moteur sait appliquer.
    const effects = g.settings.enforceRules ? spellEffectsOf(g, card, faceIndex) : null;
    const chosen = targets ?? [];
    if (effects && effects.targets.length > 0) {
      if (chosen.length !== effects.targets.length) {
        throw new ActionError(`Choisis ${effects.targets.map((t) => `une cible (${t.label})`).join(", puis ")}.`);
      }
      effects.targets.forEach((spec, i) => {
        if (!isLegalTarget(g, spec, chosen[i]!, actor.id, card.instanceId)) {
          throw new ActionError(`Cible invalide : il faut ${spec.label === "n'importe quelle cible" ? "une créature, un planeswalker ou un joueur" : `un(e) ${spec.label}`}.`);
        }
      });
    }
    const costText = faceData?.manaCost || data.manaCost;
    const tax = fromCommand ? 2 * (actor.commanderCasts[card.instanceId] ?? 0) : 0;
    const name = cardName(g, card);
    // Coût supplémentaire : sacrifier un permanent (Village Rites…).
    let sacrificed: CardInstance | undefined;
    if (effects?.sacrifice) {
      if (!sacrifice) throw new ActionError(`Choisis un(e) ${permanentLabel(effects.sacrifice)} à sacrifier pour lancer ${name}.`);
      sacrificed = getCard(g, sacrifice);
      if (!matchesPermanent(g, sacrificed, effects.sacrifice, actor.id) || sacrificed.controllerId !== actor.id) {
        throw new ActionError(`Il faut sacrifier un(e) ${permanentLabel(effects.sacrifice)}.`);
      }
    }
    // Réductions de coût (Jet Medallion…), seulement quand l'hôte applique les règles.
    const reduction = g.settings.enforceRules ? costReduction(g, actor.id, { typeLine, colors: data.colors }) : 0;
    const payment = payMana(g, actor, costText, xValue, tax - reduction, card.instanceId, `lancer ${name}`);
    if (sacrificed) {
      const sacName = cardName(g, sacrificed);
      moveCardTo(g, sacrificed.instanceId, "graveyard", "top");
      log(g, actor.id, `${actor.name} sacrifie ${sacName}.`);
    }

    actor.spellsCast = { turn: g.turn.number, count: castThisTurn + 1 };
    const cast = moveCardTo(g, cardId, "stack", "top");
    emit(g, { type: "cast", playerId: actor.id, cardId: cast.instanceId, typeLine });
    cast.faceIndex = faceIndex;
    if (effects) {
      cast.targets = effects.targets.length > 0 ? chosen.map((t) => ({ ...t })) : [];
      if (x !== undefined) cast.xValue = xValue;
    }
    const paid = [payment.spent.length > 0 ? formatMana(payment.spent) : "rien", payment.life > 0 ? `${payment.life} PV` : ""]
      .filter(Boolean)
      .join(" et ");
    const details = [
      x !== undefined ? `X = ${xValue}` : "",
      tax > 0 ? `taxe de commandant {${tax}}` : "",
      reduction > 0 ? `réduction de {${reduction}}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const aimed = cast.targets && cast.targets.length > 0 ? ` sur ${cast.targets.map((t) => targetName(g, t)).join(", ")}` : "";
    log(g, actor.id, `${actor.name} lance ${cardName(g, cast)}${aimed}${details ? ` (${details})` : ""} en payant ${paid}.`);
  },

  adjustMana(g, actor, { mana, delta }) {
    if (!isManaType(mana)) throw new ActionError("Type de mana inconnu.");
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) throw new ActionError("Quantité invalide.");
    const value = actor.manaPool[mana] + delta;
    if (value < 0) throw new ActionError(`Tu n'as pas assez de mana ${MANA_LABELS[mana]}.`);
    actor.manaPool[mana] = value;
    log(g, actor.id, `${actor.name} ${delta > 0 ? "ajoute" : "dépense"} ${formatMana(Array(Math.abs(delta)).fill(mana))}.`);
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
    card.summoningSick = true;
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
      emitEnters(g, instance);
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
    assertNoResponseWindow(g);
    if (to === undefined && g.turn.step === "cleanup") return advanceTurn(g, actor, { type: "passTurn" });
    if (to !== undefined && !isTurnStep(to)) throw new ActionError("Étape inconnue.");
    const target = to ?? TURN_STEPS[stepIndex(g.turn.step) + 1]!;
    if (stepIndex(target) <= stepIndex(g.turn.step)) {
      throw new ActionError("On ne revient pas en arrière dans le tour.");
    }
    advanceTurn(g, actor, { type: "nextStep", to: target });
  },

  passTurn(g, actor) {
    assertActive(g, actor);
    assertStackEmpty(g);
    assertMulligansDone(g);
    assertNoResponseWindow(g);
    if (nextActivePlayer(g, g.turn.activePlayerId) === null) throw new ActionError("Plus aucun joueur en lice.");
    advanceTurn(g, actor, { type: "passTurn" });
  },

  setPriorityStops(g, actor, { stops }) {
    if (!Array.isArray(stops) || !stops.every((s) => RESPONSE_STEPS.has(s))) {
      throw new ActionError("On ne peut s'arrêter qu'aux étapes clés.");
    }
    actor.priorityStops = TURN_STEPS.filter((s) => stops.includes(s));
  },

  chooseTargets(g, actor, { cardId, targets }) {
    const card = getCard(g, cardId);
    const ability = card.ability;
    if (!ability || card.zone !== "stack" || !ability.needsTargets) throw new ActionError("Cette capacité n'attend pas de cibles.");
    if (card.controllerId !== actor.id) throw new ActionError("Seul le contrôleur de la capacité choisit ses cibles.");
    const effects = abilityEffects(g, card);
    if (!effects || targets.length !== effects.targets.length) throw new ActionError("Nombre de cibles invalide.");
    effects.targets.forEach((spec, i) => {
      if (!isLegalTarget(g, spec, targets[i]!, actor.id, card.instanceId)) throw new ActionError(`Cible invalide : il faut un(e) ${spec.label}.`);
    });
    card.targets = targets.map((t) => ({ ...t }));
    delete ability.needsTargets;
    log(g, actor.id, `${actor.name} vise ${targets.map((t) => targetName(g, t)).join(", ")} avec la capacité de ${ability.sourceName}.`);
  },

  activateAbility(g, actor, { cardId, index, targets, sacrifice, color }) {
    activateAbility(g, actor, cardId, index, targets ?? [], sacrifice, color);
  },

  decideOptional(g, actor, { cardId, accept, choice }) {
    const card = getCard(g, cardId);
    const ability = card.ability;
    if (!ability?.awaitingDecision || card.zone !== "stack") throw new ActionError("Cette capacité n'attend pas de réponse.");
    if (card.controllerId !== actor.id) throw new ActionError("Seul le contrôleur de la capacité décide.");
    const trigger = abilitiesOf(g.cardData[card.cardId], ability.faceIndex).triggers[ability.index];
    if (accept && trigger) {
      const sac = trigger.effects.effects.find((e) => e.type === "sacrifice");
      if (sac && sac.type === "sacrifice") {
        const chosen = choice ? g.cards[choice] : undefined;
        if (!chosen || chosen.controllerId !== actor.id || !matchesPermanent(g, chosen, sac.filter, actor.id)) {
          throw new ActionError(`Choisis un(e) ${permanentLabel(sac.filter)} à sacrifier.`);
        }
        ability.choice = chosen.instanceId;
      }
      if (trigger.payMana) {
        const paid = payMana(g, actor, trigger.payMana, 0, 0, undefined, "payer ce coût");
        log(g, actor.id, `${actor.name} paie ${paid.spent.length > 0 ? formatMana(paid.spent) : "rien"}.`);
      }
    }
    delete ability.awaitingDecision;
    ability.accepted = accept;
    log(g, actor.id, `${actor.name} ${accept ? "accepte" : "refuse"} : « ${ability.text} ».`);
    resolveAbility(g, card);
  },

  passPriority(g, actor) {
    const priority = g.priority;
    if (!priority) throw new ActionError("La pile est vide : personne n'a la priorité.");
    const deciding = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision);
    if (deciding) {
      throw new ActionError(`${g.players[deciding.controllerId]!.name} doit d'abord décider pour la capacité de ${deciding.ability!.sourceName}.`);
    }
    const waiting = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets);
    if (waiting) {
      throw new ActionError(
        `${g.players[waiting.controllerId]!.name} doit d'abord choisir les cibles de la capacité de ${waiting.ability!.sourceName}.`,
      );
    }
    if (!samePriorityUnit(g, priority.playerId, actor.id)) {
      throw new ActionError(`C'est à ${g.players[priority.playerId]!.name} d'agir.`);
    }
    const units = priorityUnits(g);
    const unit = units.find((u) => u.includes(actor.id))!;
    priority.passed = [...new Set([...priority.passed, ...unit])];
    log(g, actor.id, `${names(unit.map((id) => g.players[id]!))} ${unit.length > 1 ? "passent" : "passe"}.`);
    if (priority.pending && g.stack.length === 0) {
      // Pile vide : on cherche le prochain qui veut répondre, sinon le tour avance.
      const from = units.indexOf(unit);
      const next = units
        .slice(from + 1)
        .find((u) => !u.some((id) => priority.passed.includes(id)) && unitWantsToRespond(g, u, g.turn.step));
      if (next) {
        priority.playerId = next[0]!;
        return;
      }
      const pending = priority.pending;
      g.priority = null;
      advanceTurn(g, g.players[g.turn.activePlayerId]!, pending, true);
      return;
    }
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
    log(g, actor.id, `${names(leaving)} ${leaving.length > 1 ? "abandonnent" : "abandonne"} la partie.`);
    leaveGame(g, leaving);
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
  // Une capacité qui quitte la pile (résolue, contrée, retirée) disparaît.
  if (card.ability) {
    delete g.cards[card.instanceId];
    return card;
  }
  // « Meurt » : une créature va du champ de bataille au cimetière (règle 700.4).
  const dies =
    from === "battlefield" && to === "graveyard" && !card.faceDown && isCreature(g, card)
      ? ({ type: "dies", cardId: card.instanceId, controllerId: card.controllerId, dataId: card.cardId, faceIndex: card.faceIndex, isToken: card.isToken } as const)
      : null;

  if (to === "battlefield" && from !== "battlefield") {
    card.summoningSick = true;
    // Un planeswalker arrive avec ses marqueurs de loyauté.
    const data = g.cardData[card.cardId];
    const loyalty = parseInt(data?.faces?.[card.faceIndex]?.loyalty ?? data?.loyalty ?? "", 10);
    if (!card.faceDown && Number.isFinite(loyalty) && /\bPlaneswalker\b/.test(currentTypeLine(g, card))) {
      card.counters["loyauté"] = loyalty;
      card.hasLoyalty = true;
    }
  }
  if (from === "stack" && to !== "stack") {
    delete card.targets;
    delete card.xValue;
  }
  if (from === "battlefield" && to !== "battlefield") {
    if (!card.faceDown) {
      emit(g, { type: "leaves", cardId: card.instanceId, controllerId: card.controllerId, dataId: card.cardId, faceIndex: card.faceIndex });
    }
    delete card.summoningSick;
    delete card.hasLoyalty;
    delete card.damage;
    delete card.deathtouched;
    delete card.ptBoost;
    delete card.grants;
    delete card.usedAbilities;
    if (g.combat) {
      delete g.combat.attackers[card.instanceId];
      delete g.combat.blockers[card.instanceId];
    }
    card.tapped = false;
    card.counters = {};
    delete card.attachedTo;
    for (const other of Object.values(g.cards)) {
      if (other.attachedTo !== card.instanceId) continue;
      delete other.attachedTo;
      // Une aura sans hôte va au cimetière (règle 704.5m).
      if (g.settings.enforceRules && other.zone === "battlefield" && /\bAura\b/.test(currentTypeLine(g, other))) {
        moveCardTo(g, other.instanceId, "graveyard", "top");
        log(g, null, `${cardName(g, other)} n'est plus attachée et va au cimetière.`);
      }
    }
    if (card.isToken) {
      if (dies) emit(g, dies);
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
  // « This land enters tapped. »
  if (to === "battlefield" && from !== "battlefield" && g.settings.enforceRules && !card.faceDown && entersTapped(g.cardData[card.cardId], card.faceIndex)) {
    card.tapped = true;
  }

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
  if (dies) emit(g, dies);
  if (to === "battlefield" && from !== "battlefield") emitEnters(g, g.cards[id]!);
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
  if (zone === "battlefield") instance.summoningSick = true;
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
    // Une fenêtre de réponse (pile vide) reste ouverte tant que le tour n'a pas changé.
    const keep =
      g.priority?.pending &&
      g.turn.number === before.turn.number &&
      g.turn.activePlayerId === before.turn.activePlayerId &&
      !g.players[g.priority.playerId]!.hasConceded;
    if (!keep) g.priority = null;
    return;
  }
  const addedIds = g.stack.filter((id) => !before.stack.includes(id));
  // Un sort lancé : son lanceur reçoit la priorité ; seulement des capacités déclenchées : le joueur actif.
  const added = addedIds.some((id) => !g.cards[id]?.ability || g.cards[id]!.ability!.activated);
  if (!added && addedIds.length > 0) {
    g.priority = { playerId: g.turn.activePlayerId, passed: [] };
    return;
  }
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
/** Note un événement qui peut déclencher des capacités (seulement quand l'hôte fait respecter les règles). */
function emit(g: GameState, event: TriggerEvent): void {
  if (!g.settings.enforceRules) return;
  (g.events ??= []).push(event);
}

function emitEnters(g: GameState, card: CardInstance): void {
  emit(g, { type: "enters", cardId: card.instanceId, controllerId: card.controllerId, creature: !card.faceDown && isCreature(g, card) });
}

/** Au plus autant de capacités déclenchées par action : garde-fou contre les boucles sans fin. */
const MAX_TRIGGERS_PER_ACTION = 50;

/**
 * Met sur la pile les capacités déclenchées par les événements notés, dans
 * l'ordre du tour à partir du joueur actif (règle 603.3b). Retourne vrai si
 * au moins une capacité a été ajoutée.
 */
function flushTriggers(g: GameState): boolean {
  const events = g.events ?? [];
  delete g.events;
  if (events.length === 0) return false;
  type Pending = { source: CardInstance; dataId: string; faceIndex: number; index: number; controllerId: PlayerId; event: TriggerEvent };
  const pending: Pending[] = [];
  const permanents = g.turnOrder
    .flatMap((id) => g.players[id]!.zones.battlefield)
    .map((id) => g.cards[id]!)
    .filter((c) => !c.faceDown);
  for (const event of events) {
    const sources: { card: CardInstance; dataId: string; faceIndex: number }[] = permanents.map((c) => ({
      card: c,
      dataId: c.cardId,
      faceIndex: c.faceIndex,
    }));
    // « Quand ~ meurt » : la carte regarde en arrière, depuis le cimetière (ou disparue si c'est un jeton).
    if (event.type === "dies" || event.type === "leaves") {
      const dead = g.cards[event.cardId] ?? ({ instanceId: event.cardId, controllerId: event.controllerId } as CardInstance);
      sources.push({ card: { ...dead, controllerId: event.controllerId }, dataId: event.dataId, faceIndex: event.faceIndex });
    }
    for (const { card, dataId, faceIndex } of sources) {
      abilitiesOf(g.cardData[dataId], faceIndex).triggers.forEach((trigger, index) => {
        if (!conditionMatches(g, trigger.condition, event, card)) return;
        if (trigger.ifUntapped && card.tapped) return;
        pending.push({ source: card, dataId, faceIndex, index, controllerId: card.controllerId, event });
      });
    }
  }
  if (pending.length === 0) return false;
  const order = priorityUnits(g).flat();
  pending.sort((a, b) => order.indexOf(a.controllerId) - order.indexOf(b.controllerId));
  let added = 0;
  for (const p of pending) {
    if (g.players[p.controllerId]?.hasConceded) continue;
    if (added >= MAX_TRIGGERS_PER_ACTION) {
      log(g, null, `Trop de capacités déclenchées d'un coup : les suivantes sont ignorées (à gérer à la main).`);
      break;
    }
    const trigger = abilitiesOf(g.cardData[p.dataId], p.faceIndex).triggers[p.index]!;
    const sourceName = g.cardData[p.dataId]?.faces?.[p.faceIndex]?.name ?? g.cardData[p.dataId]?.name ?? "?";
    const instance = newInstance(g, p.dataId, p.controllerId, "stack");
    instance.faceIndex = p.faceIndex;
    instance.ownerId = p.controllerId;
    instance.revealedTo = [...g.turnOrder];
    instance.ability = { sourceId: p.source.instanceId, sourceName, text: trigger.text, index: p.index, faceIndex: p.faceIndex };
    const ev = p.event;
    if ("playerId" in ev) instance.ability.eventPlayerId = ev.playerId;
    if ("amount" in ev) instance.ability.eventAmount = ev.amount;
    // Cibles : choisies d'office quand il n'y a qu'un choix possible.
    const specs = trigger.effects.targets;
    if (specs.length > 0) {
      const choices = specs.map((spec) => legalTargets(g, spec, p.controllerId, instance.instanceId));
      if (choices.some((c) => c.length === 0)) {
        delete g.cards[instance.instanceId];
        log(g, null, `La capacité de ${sourceName} n'a pas de cible valide.`);
        continue;
      }
      if (choices.every((c) => c.length === 1)) instance.targets = choices.map((c) => c[0]!);
      else {
        instance.targets = [];
        instance.ability.needsTargets = true;
      }
    } else instance.targets = [];
    g.stack.push(instance.instanceId);
    added++;
    const aimed = instance.targets.length > 0 ? ` (cible : ${instance.targets.map((t) => targetName(g, t)).join(", ")})` : "";
    log(g, null, `Capacité de ${sourceName} : « ${trigger.text} »${aimed}.`);
  }
  return added > 0;
}

/** Toutes les cibles valables pour une spécification. */
function legalTargets(g: GameState, spec: Parameters<typeof isLegalTarget>[1], casterId: PlayerId, sourceId: string): Target[] {
  const candidates: Target[] = [
    ...g.turnOrder.map((id) => ({ kind: "player", id }) as Target),
    ...g.turnOrder.flatMap((id) => g.players[id]!.zones.battlefield).map((id) => ({ kind: "card", id }) as Target),
    ...g.stack.map((id) => ({ kind: "card", id }) as Target),
  ];
  return candidates.filter((t) => isLegalTarget(g, spec, t, casterId, sourceId));
}

/** Effets de la capacité déclenchée sur la pile, relus depuis le texte de sa source. */
function abilityEffects(g: GameState, card: CardInstance): SpellEffects | undefined {
  const ability = card.ability;
  if (!ability) return undefined;
  const abilities = abilitiesOf(g.cardData[card.cardId], ability.faceIndex);
  return ability.activated ? abilities.activated[ability.index]?.effects : abilities.triggers[ability.index]?.effects;
}

function resolveAbility(g: GameState, card: CardInstance): void {
  const ability = card.ability!;
  const effects = abilityEffects(g, card);
  const targets = card.targets ?? [];
  if (!effects) {
    moveCardTo(g, card.instanceId, "graveyard", "top");
    return;
  }
  // « You may » : le contrôleur répond d'abord (la capacité reste sur la pile en attendant).
  const trigger = ability.activated ? undefined : abilitiesOf(g.cardData[card.cardId], ability.faceIndex).triggers[ability.index];
  if (trigger?.optional && ability.accepted === undefined) {
    ability.awaitingDecision = true;
    log(g, null, `${g.players[card.controllerId]!.name} choisit s'il applique la capacité de ${ability.sourceName}.`);
    return;
  }
  if (ability.accepted === false) {
    moveCardTo(g, card.instanceId, "graveyard", "top");
    return;
  }
  const legal = targets.map((t, i) => isLegalTarget(g, effects.targets[i]!, t, card.controllerId, card.instanceId));
  if (targets.length > 0 && legal.every((ok) => !ok)) {
    log(g, null, `La capacité de ${ability.sourceName} n'a plus de cible valide : elle ne fait rien.`);
  } else {
    log(g, null, `La capacité de ${ability.sourceName} se résout.`);
    applySpellEffects(g, card, effects.effects, targets, legal);
    if (effects.unknown.length > 0) log(g, null, `À appliquer à la main pour ${ability.sourceName} : « ${effects.unknown.join(" ")} »`);
  }
  if (g.cards[card.instanceId]) moveCardTo(g, card.instanceId, "graveyard", "top");
}

function targetName(g: GameState, t: Target): string {
  if (t.kind === "player") return g.players[t.id]?.name ?? "?";
  const card = g.cards[t.id];
  return card ? cardName(g, card) : "?";
}

/** Inflige des blessures non liées au combat à un joueur ou à un permanent. */
function dealDamage(g: GameState, sourceName: string, t: Target, amount: number): number {
  if (amount <= 0) return 0;
  if (t.kind === "player") {
    const sharers = lifeSharers(g, t.id);
    for (const p of sharers) p.life -= amount;
    emit(g, { type: "lifeLoss", playerId: t.id, amount });
    log(g, null, `${sourceName} inflige ${amount} blessure${amount > 1 ? "s" : ""} à ${names(sharers)} (${sharers[0]!.life} PV).`);
    return amount;
  }
  const card = g.cards[t.id];
  if (!card || card.zone !== "battlefield") return 0;
  if (card.hasLoyalty) card.counters["loyauté"] = Math.max(0, (card.counters["loyauté"] ?? 0) - amount);
  if (isCreature(g, card)) card.damage = (card.damage ?? 0) + amount;
  log(g, null, `${sourceName} inflige ${amount} blessure${amount > 1 ? "s" : ""} à ${cardName(g, card)}.`);
  return amount;
}

function changeLife(g: GameState, playerId: PlayerId, delta: number): void {
  if (delta === 0) return;
  if (delta > 0 && cantGainLife(g, playerId)) {
    log(g, null, `${g.players[playerId]!.name} ne peut pas gagner de points de vie.`);
    return;
  }
  const sharers = lifeSharers(g, playerId);
  for (const p of sharers) p.life += delta;
  emit(g, delta > 0 ? { type: "lifeGain", playerId, amount: delta } : { type: "lifeLoss", playerId, amount: -delta });
  const verb = sharers.length > 1 ? (delta > 0 ? "gagnent" : "perdent") : delta > 0 ? "gagne" : "perd";
  log(g, null, `${names(sharers)} ${verb} ${Math.abs(delta)} PV (${sharers[0]!.life}).`);
}

function opponentsOf(g: GameState, playerId: PlayerId): PlayerState[] {
  return g.turnOrder
    .map((id) => g.players[id]!)
    .filter((p) => !p.hasConceded && p.id !== playerId && !areTeammates(g, p.id, playerId));
}

/** Applique les effets reconnus d'un sort qui se résout. Les cibles devenues invalides sont ignorées. */
function applySpellEffects(g: GameState, source: CardInstance, effects: Effect[], targets: Target[], legal: boolean[]): void {
  const caster = g.players[source.controllerId]!;
  const x = source.xValue ?? 0;
  const ability = source.ability;
  const sourceName = ability?.sourceName ?? cardName(g, source);
  const eventAmount = ability?.eventAmount ?? 0;
  const eventPlayer = ability?.eventPlayerId ? g.players[ability.eventPlayerId] : undefined;
  let dealt = 0;
  const given = () =>
    Object.values(g.cards).filter((c) => c.zone === "battlefield" && c.ownerId === caster.id && opponentsOf(g, caster.id).some((p) => p.id === c.controllerId)).length;
  const amountOf = (a: Parameters<typeof resolveAmount>[0]) =>
    resolveAmount(a, x, eventAmount, { dealt, hand: caster.zones.hand.length, given: a === "given" ? given() : 0 });
  // Contrôleurs des cibles au début de la résolution (« its controller » après « destroy target creature »).
  const controllers = targets.map((t) => (t.kind === "card" ? g.cards[t.id]?.controllerId : undefined));
  const self = ability ? g.cards[ability.sourceId] : undefined;
  const whoOf = (who: Who): PlayerState[] => {
    if (who === "you") return [caster];
    if (who === "opponents") return opponentsOf(g, caster.id);
    if (who === "all") return g.turnOrder.map((id) => g.players[id]!).filter((p) => !p.hasConceded);
    if (who === "event") return eventPlayer && !eventPlayer.hasConceded ? [eventPlayer] : [];
    if ("controllerOf" in who) {
      const id = legal[who.controllerOf] ? controllers[who.controllerOf] : undefined;
      const p = id ? g.players[id] : undefined;
      return p && !p.hasConceded ? [p] : [];
    }
    const p = player(who.target);
    return p ? [p] : [];
  };
  const card = (i: number) => (legal[i] && targets[i]?.kind === "card" ? g.cards[targets[i]!.id] : undefined);
  const player = (i: number) => (legal[i] && targets[i]?.kind === "player" ? g.players[targets[i]!.id] : undefined);
  const destroy = (c: CardInstance) => {
    if (hasKeyword(g, c, "Indestructible")) {
      log(g, null, `${cardName(g, c)} est indestructible.`);
      return;
    }
    const name = cardName(g, c);
    moveCardTo(g, c.instanceId, "graveyard", "top");
    log(g, null, `${name} est détruit(e).`);
  };
  const allMatching = (filter: Parameters<typeof matchesPermanent>[2]) =>
    g.turnOrder
      .flatMap((id) => g.players[id]!.zones.battlefield)
      .map((id) => g.cards[id]!)
      .filter((c) => matchesPermanent(g, c, filter, caster.id));

  for (const effect of effects) {
    switch (effect.type) {
      case "draw":
        for (const p of whoOf(effect.who)) drawCards(g, p, amountOf(effect.count));
        break;
      case "destroy": {
        const c = card(effect.target);
        if (c) destroy(c);
        break;
      }
      case "destroyAll":
        for (const c of allMatching(effect.filter)) destroy(c);
        break;
      case "exile":
      case "bounce": {
        const c = card(effect.target);
        if (!c) break;
        const name = cardName(g, c);
        moveCardTo(g, c.instanceId, effect.type === "exile" ? "exile" : "hand", "top");
        log(g, null, effect.type === "exile" ? `${name} est exilé(e).` : `${name} retourne dans la main de son propriétaire.`);
        break;
      }
      case "exileAll":
        for (const c of allMatching(effect.filter)) {
          const name = cardName(g, c);
          moveCardTo(g, c.instanceId, "exile", "top");
          log(g, null, `${name} est exilé(e).`);
        }
        break;
      case "damage":
        if (effect.target === "event") {
          if (eventPlayer && !eventPlayer.hasConceded) dealt += dealDamage(g, sourceName, { kind: "player", id: eventPlayer.id }, amountOf(effect.amount));
        } else if (effect.target === "you") {
          dealt += dealDamage(g, sourceName, { kind: "player", id: caster.id }, amountOf(effect.amount));
        } else if (legal[effect.target]) dealt += dealDamage(g, sourceName, targets[effect.target]!, amountOf(effect.amount));
        break;
      case "damageEach": {
        const n = amountOf(effect.amount);
        if (effect.who === "creatures") {
          for (const c of allMatching({ types: ["creature"], notTypes: [] })) dealt += dealDamage(g, sourceName, { kind: "card", id: c.instanceId }, n);
        } else {
          const players = effect.who === "opponents" ? opponentsOf(g, caster.id) : g.turnOrder.map((id) => g.players[id]!).filter((p) => !p.hasConceded);
          for (const p of players) dealt += dealDamage(g, sourceName, { kind: "player", id: p.id }, n);
        }
        break;
      }
      case "life": {
        const n = amountOf(effect.amount);
        for (const p of whoOf(effect.who)) changeLife(g, p.id, n);
        break;
      }
      case "counterSelf": {
        if (!self || self.zone !== "battlefield") break;
        self.counters[effect.kind] = (self.counters[effect.kind] ?? 0) + effect.count;
        log(g, null, `${cardName(g, self)} reçoit ${plural(effect.count, `marqueur ${effect.kind}`, `marqueurs ${effect.kind}`)}.`);
        break;
      }
      case "token": {
        const n = amountOf(effect.count);
        const { token } = effect;
        const power = token.power === "X" ? String(x) : token.power;
        const toughness = token.toughness === "X" ? String(x) : token.toughness;
        const name = token.subtypes.join(" ") || "Créature";
        const id = `token:${power}/${toughness}:${token.colors.join("")}:${name}:${token.keywords.join(",")}:${token.artifact ? "a" : ""}`;
        g.cardData[id] ??= {
          id,
          oracleId: id,
          name,
          manaCost: "",
          manaValue: 0,
          typeLine: `Token ${token.artifact ? "Artifact " : ""}Creature — ${name}`,
          oracleText: token.keywords.join(", "),
          colors: token.colors,
          colorIdentity: token.colors,
          keywords: token.keywords,
          power,
          toughness,
          commanderLegality: "legal",
          set: "tok",
          collectorNumber: "0",
        };
        for (const owner of effect.forOpponents ? opponentsOf(g, caster.id) : [caster]) {
          for (let i = 0; i < n; i++) {
            const instance = newInstance(g, id, owner.id, "battlefield");
            instance.isToken = true;
            instance.tapped = effect.tapped;
            instance.summoningSick = true;
            owner.zones.battlefield.push(instance.instanceId);
            emitEnters(g, instance);
          }
          if (n > 0) log(g, null, `${owner.name} crée ${n > 1 ? `${n} jetons` : "un jeton"} ${name} ${power}/${toughness}.`);
        }
        break;
      }
      case "counter": {
        const c = card(effect.target);
        if (!c || c.zone !== "stack") break;
        const name = cardName(g, c);
        if (/can't be countered/i.test(g.cardData[c.cardId]?.oracleText ?? "")) {
          log(g, null, `${name} ne peut pas être contré(e).`);
          break;
        }
        moveCardTo(g, c.instanceId, "graveyard", "top");
        log(g, null, `${name} est contré(e).`);
        break;
      }
      case "mana":
        for (const m of effect.mana) caster.manaPool[m as ManaType] += 1;
        log(g, null, `${caster.name} ajoute ${formatMana(effect.mana as ManaType[])}.`);
        break;
      case "manaAny": {
        const color = ability?.color ?? "B";
        caster.manaPool[color] += effect.count;
        log(g, null, `${caster.name} ajoute ${formatMana(Array(effect.count).fill(color))}.`);
        break;
      }
      case "returnSelf": {
        if (!self || self.zone !== "graveyard") break;
        const name = cardName(g, self);
        moveCardTo(g, self.instanceId, "hand", "top");
        log(g, null, `${name} retourne du cimetière dans la main de ${g.players[self.ownerId]!.name}.`);
        break;
      }
      case "pumpSelf": {
        if (!self || self.zone !== "battlefield") break;
        const boost = self.ptBoost ?? { power: 0, toughness: 0 };
        self.ptBoost = { power: boost.power + effect.power, toughness: boost.toughness + effect.toughness };
        const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
        log(g, null, `${cardName(g, self)} reçoit ${sign(effect.power)}/${sign(effect.toughness)} jusqu'à la fin du tour.`);
        break;
      }
      case "grantAll": {
        const all = allMatching(effect.filter);
        for (const c of all) c.grants = [...new Set([...(c.grants ?? []), ...effect.keywords])];
        const label = effect.keywords.map((k) => KEYWORD_HELP[k]?.name.toLowerCase() ?? k).join(", ");
        log(g, null, `Les créatures de ${caster.name} gagnent ${label} jusqu'à la fin du tour.`);
        break;
      }
      case "attach": {
        const c = card(effect.target);
        if (!c || !self || self.zone !== "battlefield") break;
        self.attachedTo = c.instanceId;
        log(g, null, `${cardName(g, self)} est attaché(e) à ${cardName(g, c)}.`);
        break;
      }
      case "gainControl": {
        const c = effect.permanent === "self" ? (self?.zone === "battlefield" ? self : undefined) : card(effect.permanent);
        const p = player(effect.player);
        if (!c || !p || c.zone !== "battlefield") break;
        // « … you control » : le permanent doit toujours être à toi.
        if (effect.permanent === "self" ? c.controllerId !== caster.id : false) break;
        setController(g, c, p.id);
        break;
      }
      case "exchangeControl": {
        const a = card(effect.a);
        const b = card(effect.b);
        if (!a || !b || a.controllerId === b.controllerId) break;
        const [ca, cb] = [a.controllerId, b.controllerId];
        setController(g, a, cb);
        setController(g, b, ca);
        break;
      }
      case "winIf": {
        const ok =
          (effect.life !== undefined && caster.life >= effect.life) ||
          (effect.handExactly !== undefined && caster.zones.hand.length === effect.handExactly);
        if (!ok) break;
        const losers = opponentsOf(g, caster.id);
        for (const p of losers) p.lostReason = `${caster.name} gagne avec ${sourceName}`;
        log(g, null, `${caster.name} gagne la partie grâce à ${sourceName} !`);
        leaveGame(g, losers);
        break;
      }
      case "loseGame": {
        const losers = g.settings.sharedTeamLife ? lifeSharers(g, caster.id) : [caster];
        for (const p of losers) p.lostReason = sourceName;
        log(g, null, `${names(losers)} perd la partie (${sourceName}).`);
        leaveGame(g, losers);
        break;
      }
      case "sacrifice": {
        const chosen = ability?.choice ? g.cards[ability.choice] : undefined;
        if (!chosen || chosen.zone !== "battlefield" || chosen.controllerId !== caster.id || !matchesPermanent(g, chosen, effect.filter, caster.id)) break;
        const name = cardName(g, chosen);
        moveCardTo(g, chosen.instanceId, "graveyard", "top");
        log(g, null, `${caster.name} sacrifie ${name}.`);
        // Exploit : « quand ~ exploite une créature ».
        if (ability && ability.text === "Exploit") emit(g, { type: "exploits", cardId: ability.sourceId });
        break;
      }
    }
  }
}

function resolveTop(g: GameState): void {
  const id = g.stack.at(-1)!;
  const card = g.cards[id]!;
  if (card.ability) return resolveAbility(g, card);
  const name = cardName(g, card);
  const typeLine = currentTypeLine(g, card);
  if (/\b(Instant|Sorcery)\b/.test(typeLine)) {
    const effects = card.targets ? spellEffectsOf(g, card) : null;
    if (!effects || effects.effects.length === 0) {
      moveCardTo(g, id, "graveyard", "top");
      log(g, null, `${name} se résout et va au cimetière (appliquez son effet à la main).`);
      return;
    }
    const targets = card.targets!;
    const legal = targets.map((t, i) => isLegalTarget(g, effects.targets[i]!, t, card.controllerId, card.instanceId));
    // Toutes ses cibles sont devenues invalides : le sort ne fait rien (règle 608.2b).
    if (targets.length > 0 && legal.every((ok) => !ok)) {
      moveCardTo(g, id, "graveyard", "top");
      log(g, null, `${name} n'a plus de cible valide : il ne fait rien.`);
      return;
    }
    log(g, null, `${name} se résout.`);
    applySpellEffects(g, card, effects.effects, targets, legal);
    if (g.cards[id]?.zone === "stack") moveCardTo(g, id, "graveyard", "top");
    if (effects.unknown.length > 0) {
      log(g, null, `À appliquer à la main pour ${name} : « ${effects.unknown.join(" ")} »`);
    }
  } else {
    moveCardTo(g, id, "battlefield", "top", { controllerId: card.controllerId });
    const data = g.cardData[card.cardId];
    const manual = data && !card.faceDown && cardSupport(data).level !== "full";
    log(g, null, `${name} se résout et arrive sur le champ de bataille${manual ? " (ses capacités sont à gérer à la main)" : ""}.`);
  }
}

/**
 * Paie un coût de mana avec la réserve, en engageant des sources de mana
 * quand il en manque. `extraGeneric` : taxe (positive) ou réduction (négative).
 */
function payMana(
  g: GameState,
  actor: PlayerState,
  costText: string,
  x: number,
  extraGeneric: number,
  excludeId: CardInstanceId | undefined,
  what: string,
): { spent: ManaType[]; life: number } {
  const cost = parseManaCost(costText);
  let payment = payFromPool(actor.manaPool, cost, x, extraGeneric);
  while (!payment.ok) {
    const source = findManaSource(g, actor, payment.need, excludeId ?? "");
    if (!source) {
      const missing = payment.need.kind === "color" ? payment.need.options.map((m) => `{${m}}`).join(" ou ") : "du mana";
      throw new ActionError(`Pas assez de mana pour ${what} : il manque ${missing}.`);
    }
    tapForMana(g, actor, source.card, source.choice);
    payment = payFromPool(actor.manaPool, cost, x, extraGeneric);
  }
  actor.manaPool = payment.pool;
  if (payment.life > 0) payLife(g, actor, payment.life);
  return { spent: payment.spent, life: payment.life };
}

/** Le permanent passe sous le contrôle d'un autre joueur (il a de nouveau le mal d'invocation). */
function setController(g: GameState, card: CardInstance, playerId: PlayerId): void {
  if (card.controllerId === playerId) return;
  removeFromZone(g, card);
  card.controllerId = playerId;
  card.summoningSick = true;
  if (g.combat) {
    delete g.combat.attackers[card.instanceId];
    delete g.combat.blockers[card.instanceId];
  }
  g.players[playerId]!.zones.battlefield.push(card.instanceId);
  log(g, null, `${g.players[playerId]!.name} prend le contrôle de ${cardName(g, card)}.`);
}

/** Payer des points de vie (une perte de points de vie). */
function payLife(g: GameState, actor: PlayerState, amount: number): void {
  for (const p of lifeSharers(g, actor.id)) p.life -= amount;
  emit(g, { type: "lifeLoss", playerId: actor.id, amount });
}

/**
 * Active une capacité d'un permanent (ou d'une carte du cimetière) : vérifie
 * le moment et les cibles, paie le coût, puis met la capacité sur la pile
 * (ou l'applique tout de suite pour une capacité de mana).
 */
function activateAbility(
  g: GameState,
  actor: PlayerState,
  cardId: CardInstanceId,
  index: number,
  targets: Target[],
  sacrificeId: CardInstanceId | undefined,
  color: ManaType | undefined,
): void {
  if (!g.settings.enforceRules) throw new ActionError("L'hôte n'applique pas les règles : gère cette capacité à la main.");
  const card = getCard(g, cardId);
  const ability = card.faceDown ? undefined : abilitiesOf(g.cardData[card.cardId], card.faceIndex).activated[index];
  if (!ability) throw new ActionError("Capacité inconnue.");
  const name = cardName(g, card);
  if (ability.zone === "battlefield") {
    if (card.zone !== "battlefield" || card.controllerId !== actor.id) throw new ActionError(`Tu ne contrôles pas ${name}.`);
  } else if (card.zone !== "graveyard" || card.ownerId !== actor.id) {
    throw new ActionError(`Cette capacité s'active depuis ton cimetière.`);
  }
  // Moment : vitesse de rituel, ou dès qu'on a la priorité (les capacités de mana, à tout moment).
  if (ability.ownTurn && !isActivePlayer(g, actor.id)) throw new ActionError("Cette capacité ne s'active que pendant ton tour.");
  if (!ability.mana) {
    if (ability.sorcery) assertSorceryTiming(g, actor, "activer cette capacité");
    else if (g.priority && !samePriorityUnit(g, g.priority.playerId, actor.id)) {
      throw new ActionError(`Attends d'avoir la priorité (c'est à ${g.players[g.priority.playerId]!.name}).`);
    }
  }
  const { cost } = ability;
  const loyaltyAbility = cost.loyalty !== undefined;
  const usedKey = loyaltyAbility ? -1 : index;
  const used = card.usedAbilities?.turn === g.turn.number ? card.usedAbilities.indices : [];
  if (ability.oncePerTurn && used.includes(usedKey)) {
    throw new ActionError(loyaltyAbility ? `${name} a déjà activé une capacité de loyauté ce tour.` : "Cette capacité s'active une seule fois par tour.");
  }
  if (cost.tap) {
    if (card.tapped) throw new ActionError(`${name} est déjà engagé.`);
    if (card.summoningSick && isCreature(g, card) && !hasKeyword(g, card, "Haste")) {
      throw new ActionError(`${name} vient d'arriver : mal d'invocation.`);
    }
  }
  if (cost.loyalty !== undefined && cost.loyalty < 0 && (card.counters["loyauté"] ?? 0) < -cost.loyalty) {
    throw new ActionError(`${name} n'a pas assez de loyauté.`);
  }
  if (cost.life > 0 && actor.life < cost.life) throw new ActionError(`Tu n'as pas assez de points de vie.`);
  let sacrificed: CardInstance | undefined;
  if (cost.sacrifice) {
    if (!sacrificeId) throw new ActionError(`Choisis un(e) ${permanentLabel(cost.sacrifice)} à sacrifier.`);
    sacrificed = getCard(g, sacrificeId);
    if (sacrificed.controllerId !== actor.id || !matchesPermanent(g, sacrificed, cost.sacrifice, actor.id)) {
      throw new ActionError(`Il faut sacrifier un(e) ${permanentLabel(cost.sacrifice)} que tu contrôles.`);
    }
  }
  const specs = ability.effects.targets;
  if (targets.length !== specs.length) {
    throw new ActionError(`Choisis ${specs.map((t) => `une cible (${t.label})`).join(", puis ")}.`);
  }
  specs.forEach((spec, i) => {
    if (!isLegalTarget(g, spec, targets[i]!, actor.id, card.instanceId)) throw new ActionError(`Cible invalide : il faut un(e) ${spec.label}.`);
  });
  const anyColor = ability.effects.effects.some((e) => e.type === "manaAny");
  if (anyColor && (!color || !isManaType(color) || color === "C")) throw new ActionError("Choisis la couleur du mana.");

  // Paiement : mana d'abord (sans engager la source si elle s'engage pour le coût), puis le reste.
  const paid = cost.mana ? payMana(g, actor, cost.mana, 0, 0, cost.tap ? card.instanceId : undefined, `activer ${name}`) : null;
  if (cost.tap) card.tapped = true;
  if (cost.life > 0) payLife(g, actor, cost.life);
  if (cost.loyalty !== undefined) setCounter(card, "loyauté", (card.counters["loyauté"] ?? 0) + cost.loyalty);
  if (ability.oncePerTurn) card.usedAbilities = { turn: g.turn.number, indices: [...used, usedKey] };
  const costParts = [
    paid && paid.spent.length > 0 ? formatMana(paid.spent) : "",
    cost.tap ? "en l'engageant" : "",
    cost.life > 0 ? `${cost.life} PV` : "",
    cost.loyalty !== undefined ? `${cost.loyalty > 0 ? "+" : ""}${cost.loyalty} loyauté` : "",
  ].filter(Boolean);
  const sourceName = g.cardData[card.cardId]?.faces?.[card.faceIndex]?.name ?? g.cardData[card.cardId]?.name ?? name;
  const stackAbility = {
    sourceId: card.instanceId,
    sourceName,
    text: ability.text,
    index,
    faceIndex: card.faceIndex,
    activated: true,
    ...(anyColor ? { color: color! } : {}),
  };
  if (sacrificed) {
    const sacName = cardName(g, sacrificed);
    moveCardTo(g, sacrificed.instanceId, "graveyard", "top");
    costParts.push(`en sacrifiant ${sacName}`);
  }
  const how = costParts.length > 0 ? ` (${costParts.join(", ")})` : "";
  if (ability.mana) {
    // Capacité de mana : pas de pile.
    log(g, actor.id, `${actor.name} active ${name}${how}.`);
    const source = { ...card, controllerId: actor.id, ability: stackAbility } as CardInstance;
    if (cost.sacrificeSelf) moveCardTo(g, card.instanceId, "graveyard", "top");
    applySpellEffects(g, source, ability.effects.effects, [], []);
    return;
  }
  if (cost.sacrificeSelf) {
    moveCardTo(g, card.instanceId, "graveyard", "top");
    costParts.push("en le sacrifiant");
  }
  const instance = newInstance(g, card.cardId, actor.id, "stack");
  instance.faceIndex = card.faceIndex;
  instance.revealedTo = [...g.turnOrder];
  instance.ability = stackAbility;
  instance.targets = targets.map((t) => ({ ...t }));
  g.stack.push(instance.instanceId);
  const aimed = instance.targets.length > 0 ? ` sur ${instance.targets.map((t) => targetName(g, t)).join(", ")}` : "";
  const how2 = costParts.length > 0 ? ` (${costParts.join(", ")})` : "";
  log(g, actor.id, `${actor.name} active ${name}${aimed}${how2} : « ${ability.text} ».`);
}

function tapForMana(g: GameState, actor: PlayerState, card: CardInstance, choice: number): void {
  const mana = cardManaOptions(g, card)[choice];
  if (!mana) throw new ActionError("Choix de mana invalide.");
  card.tapped = true;
  const pool = g.players[card.controllerId]!.manaPool;
  for (const m of mana) pool[m] += 1;
  log(g, actor.id, `${actor.name} engage ${cardName(g, card)} pour ${formatMana(mana)}.`);
}

/**
 * Choisit un permanent dégagé à engager pour couvrir un manque de mana : de
 * préférence un terrain, et la source la moins polyvalente (pour garder les
 * terrains qui donnent plusieurs couleurs pour plus tard).
 */
function findManaSource(
  g: GameState,
  actor: PlayerState,
  need: ManaNeed,
  exclude: CardInstanceId,
): { card: CardInstance; choice: number } | null {
  let best: { card: CardInstance; choice: number; score: number } | null = null;
  for (const id of actor.zones.battlefield) {
    const card = g.cards[id]!;
    if (card.tapped || id === exclude || card.controllerId !== actor.id) continue;
    const options = cardManaOptions(g, card);
    options.forEach((mana, choice) => {
      const fits = need.kind === "any" || mana.some((m: ManaType) => need.options.includes(m));
      if (!fits) return;
      const isLandCard = /\bLand\b/.test(faceTypeLine(g, card, card.faceIndex));
      // Pour le générique : l'incolore d'abord.
      const colorless = need.kind === "any" && mana.every((m) => m === "C");
      const score = options.length * 10 + (isLandCard ? 0 : 5) + (colorless ? 0 : 1);
      if (!best || score < best.score) best = { card, choice, score };
    });
  }
  return best;
}

/** Vitesse de rituel : son propre tour, phase principale, pile vide. */
function assertSorceryTiming(g: GameState, actor: PlayerState, what: string): void {
  if (!isActivePlayer(g, actor.id)) throw new ActionError(`Tu ne peux ${what} que pendant ton tour.`);
  assertNoResponseWindow(g);
  if (g.turn.step !== "main1" && g.turn.step !== "main2") {
    throw new ActionError(`Tu ne peux ${what} que pendant une phase principale.`);
  }
  if (g.stack.length > 0) throw new ActionError(`Tu ne peux ${what} que quand la pile est vide.`);
}

function faceTypeLine(g: GameState, card: CardInstance, faceIndex: number): string {
  const data = g.cardData[card.cardId];
  if (!data) return "";
  return data.faces?.[faceIndex]?.typeLine ?? data.typeLine;
}

/** Mana que la carte (sur sa face visible) peut produire en s'engageant. */
export function cardManaOptions(g: GameState, card: CardInstance) {
  const data = g.cardData[card.cardId];
  if (!data) return [];
  const face = data.faces?.[card.faceIndex];
  return manaOptions(face?.typeLine ?? data.typeLine, face?.oracleText ?? data.oracleText);
}

function currentTypeLine(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  if (!data) return "";
  return data.faces?.[card.faceIndex]?.typeLine ?? data.typeLine;
}

function assertActive(g: GameState, actor: PlayerState): void {
  if (!isActivePlayer(g, actor.id)) throw new ActionError("Ce n'est pas ton tour.");
}

/** Étapes où les autres joueurs peuvent répondre avant que le joueur actif avance. */
export const RESPONSE_STEPS: ReadonlySet<TurnStep> = new Set<TurnStep>([
  "upkeep",
  "draw",
  "beginCombat",
  "declareAttackers",
  "declareBlockers",
  "end",
]);

/** Arrêts d'un joueur : ceux qu'il a choisis, sinon toutes les étapes clés. */
export function priorityStopsOf(p: Pick<PlayerState, "priorityStops">): PriorityStops {
  return p.priorityStops ?? [...RESPONSE_STEPS];
}

/**
 * Le joueur s'arrête-t-il à cette étape du tour d'un autre ? Ne dépend que
 * de ses réglages, jamais de sa main.
 */
export function wantsToRespond(g: GameState, playerId: PlayerId, step: TurnStep = g.turn.step): boolean {
  if (!RESPONSE_STEPS.has(step)) return false;
  const p = g.players[playerId];
  if (!p || p.hasConceded) return false;
  return priorityStopsOf(p).includes(step);
}

function unitWantsToRespond(g: GameState, unit: PlayerId[], step: TurnStep): boolean {
  return unit.some((id) => wantsToRespond(g, id, step));
}

function assertNoResponseWindow(g: GameState): void {
  if (g.priority?.pending && g.stack.length === 0) {
    throw new ActionError(`${g.players[g.priority.playerId]!.name} peut encore répondre.`);
  }
}

/**
 * Ouvre une fenêtre de réponse à l'étape en cours si un autre joueur veut
 * répondre : il reçoit la priorité, pile vide. Retourne vrai si elle s'ouvre.
 */
function openResponseWindow(g: GameState, request: PendingAdvance): boolean {
  if (!g.settings.enforceRules) return false;
  const [active, ...others] = priorityUnits(g);
  const responder = others.find((u) => unitWantsToRespond(g, u, g.turn.step));
  if (!active || !responder) return false;
  g.priority = { playerId: responder[0]!, passed: [...active], pending: request };
  log(g, null, `${names(responder.map((id) => g.players[id]!))} peut répondre (${STEP_LABELS[g.turn.step]}).`);
  return true;
}

/**
 * Fait avancer le tour comme le demande le joueur actif. Avant de quitter
 * chaque étape clé, les autres joueurs qui le veulent peuvent répondre :
 * l'avancée reprend quand ils ont tous passé (`resumed` : la fenêtre de
 * l'étape en cours a déjà eu lieu).
 */
function advanceTurn(g: GameState, actor: PlayerState, request: PendingAdvance, resumed = false): void {
  let target: TurnStep = request.type === "passTurn" ? "cleanup" : request.to ?? followingStep(g);
  const start = g.turn.step;
  while (stepIndex(g.turn.step) < stepIndex(target)) {
    const first = g.turn.step === start;
    if (g.turn.step === "declareBlockers" && pendingBlockers(g).length > 0) {
      if (first) throw new ActionError(`En attente des bloqueurs de ${names(pendingBlockers(g))}.`);
      log(g, actor.id, `${actor.name} passe à ${STEP_PHRASES[g.turn.step]}.`);
      logWaitingBlockers(g);
      return;
    }
    if (!(first && resumed) && openResponseWindow(g, request)) {
      if (!first) log(g, actor.id, `${actor.name} passe à ${STEP_PHRASES[g.turn.step]}.`);
      return;
    }
    enterStep(g, followingStep(g));
    // Personne ne peut attaquer : le combat est sans objet, on va jusqu'à la seconde phase principale.
    if (g.turn.step === "declareAttackers" && noAttack(g) && request.type === "nextStep" && stepIndex(target) <= stepIndex("declareAttackers")) {
      target = "main2";
      request = { type: "nextStep", to: target };
    }
    // Des capacités se déclenchent (entretien, blessures, fin du tour…) : on s'arrête là pour les résoudre.
    checkStateBasedActions(g);
    if (flushTriggers(g)) {
      log(g, actor.id, `${actor.name} passe à ${STEP_PHRASES[g.turn.step]}.`);
      return;
    }
  }
  if (request.type === "passTurn") passTurn(g, actor);
  else log(g, actor.id, `${actor.name} passe à ${STEP_PHRASES[g.turn.step]}.`);
}

function passTurn(g: GameState, actor: PlayerState): void {
  const next = nextActivePlayer(g, g.turn.activePlayerId);
  if (next === null) throw new ActionError("Plus aucun joueur en lice.");
  // Les étapes restantes ont lieu (le nettoyage rappelle la taille de main).
  if (advanceTo(g, "cleanup") !== "cleanup") {
    log(g, actor.id, `${actor.name} passe à ${STEP_PHRASES[g.turn.step]}.`);
    logWaitingBlockers(g);
    return;
  }
  startTurn(g, next);
}

/**
 * Avance d'étape en étape jusqu'à `target`, en s'arrêtant à l'étape des
 * bloqueurs tant que des joueurs attaqués n'ont pas déclaré leurs bloqueurs.
 * Retourne l'étape atteinte.
 */
function advanceTo(g: GameState, target: TurnStep): TurnStep {
  const start = g.turn.step;
  while (g.turn.step !== target) {
    if (g.turn.step === "declareBlockers" && pendingBlockers(g).length > 0) {
      if (start === "declareBlockers") {
        throw new ActionError(`En attente des bloqueurs de ${names(pendingBlockers(g))}.`);
      }
      break;
    }
    enterStep(g, followingStep(g));
  }
  return g.turn.step;
}

/**
 * L'étape suivante. Sans attaquant, les étapes des bloqueurs et des blessures
 * de combat n'ont pas lieu (règle 508.8).
 */
function followingStep(g: GameState): TurnStep {
  if (g.turn.step === "declareAttackers" && noAttack(g)) return "endCombat";
  return TURN_STEPS[stepIndex(g.turn.step) + 1]!;
}

/** Les attaquants sont déclarés, et il n'y en a aucun. */
function noAttack(g: GameState): boolean {
  return !!g.combat?.attackersDeclared && Object.keys(g.combat.attackers).length === 0;
}

function logWaitingBlockers(g: GameState): void {
  log(g, null, `En attente des bloqueurs de ${names(pendingBlockers(g))}.`);
}

/** Les joueurs qui peuvent bloquer pour `playerId` (lui, ou son équipe en tours partagés). */
function defendingSide(g: GameState, playerId: PlayerId): PlayerId[] {
  return g.settings.sharedTurns ? teamOf(g, playerId) : [playerId];
}

/** Joueurs attaqués (ou leurs coéquipiers en tours partagés) qui n'ont pas encore déclaré leurs bloqueurs. */
function pendingBlockers(g: GameState): PlayerState[] {
  const combat = g.combat;
  if (!combat) return [];
  const attacked = new Set(
    Object.entries(combat.attackers)
      .filter(([id]) => g.cards[id]?.zone === "battlefield")
      .flatMap(([, defender]) => defendingSide(g, defender)),
  );
  return [...attacked]
    .filter((id) => !combat.blocksDeclared.includes(id))
    .map((id) => g.players[id]!)
    .filter((p) => !p.hasConceded);
}

function newCombat(): CombatState {
  return { attackersDeclared: false, attackers: {}, blockers: {}, blocked: [], blocksDeclared: [] };
}

function onBattlefield(g: GameState, id: CardInstanceId): boolean {
  return g.cards[id]?.zone === "battlefield";
}

/**
 * Blessures de combat (règle 510) : d'abord les créatures avec l'initiative
 * ou la double initiative, puis les autres (et de nouveau la double initiative).
 */
function dealCombatDamage(g: GameState): void {
  const combat = g.combat;
  if (!combat) return;
  const attackers = Object.keys(combat.attackers).filter((id) => onBattlefield(g, id));
  if (attackers.length === 0) return;
  const blockersOf = (attackerId: CardInstanceId) =>
    Object.entries(combat.blockers)
      .filter(([blocker, attacker]) => attacker === attackerId && onBattlefield(g, blocker))
      .map(([blocker]) => blocker);
  const kw = (id: CardInstanceId, k: Parameters<typeof hasKeyword>[2]) => hasKeyword(g, g.cards[id]!, k);
  const firstStriker = (id: CardInstanceId) => kw(id, "First strike") || kw(id, "Double strike");
  const participants = [...attackers, ...Object.keys(combat.blockers).filter((id) => onBattlefield(g, id))];
  const passes: ("first" | "regular")[] = participants.some(firstStriker) ? ["first", "regular"] : ["regular"];

  for (const pass of passes) {
    const strikes = (id: CardInstanceId) =>
      onBattlefield(g, id) &&
      (pass === "first" ? firstStriker(id) : !firstStriker(id) || kw(id, "Double strike") || passes.length === 1);
    type Hit = { source: CardInstanceId; card?: CardInstanceId; player?: PlayerId; amount: number };
    const hits: Hit[] = [];
    for (const a of attackers) {
      if (!strikes(a)) continue;
      const power = creatureStats(g, g.cards[a]!).power;
      if (power <= 0) continue;
      const trample = kw(a, "Trample");
      const defender = combat.attackers[a]!;
      if (!combat.blocked.includes(a)) {
        hits.push({ source: a, player: defender, amount: power });
        continue;
      }
      const blockers = blockersOf(a);
      let left = power;
      blockers.forEach((b, i) => {
        if (left <= 0) return;
        const last = i === blockers.length - 1;
        const lethal = lethalDamage(g, g.cards[b]!, kw(a, "Deathtouch"));
        const amount = last && !trample ? left : Math.min(left, lethal);
        if (amount > 0) hits.push({ source: a, card: b, amount });
        left -= amount;
      });
      if (trample && left > 0) hits.push({ source: a, player: defender, amount: left });
    }
    for (const [b, a] of Object.entries(combat.blockers)) {
      if (!strikes(b) || !onBattlefield(g, a)) continue;
      const power = creatureStats(g, g.cards[b]!).power;
      if (power > 0) hits.push({ source: b, card: a, amount: power });
    }
    // Toutes les blessures d'un même passage sont infligées en même temps.
    for (const hit of hits) applyCombatHit(g, hit);
    destroyLethal(g);
  }
}

function applyCombatHit(
  g: GameState,
  hit: { source: CardInstanceId; card?: CardInstanceId; player?: PlayerId; amount: number },
): void {
  const source = g.cards[hit.source]!;
  const sourceName = cardName(g, source);
  const infect = hasKeyword(g, source, "Infect");
  if (hit.card) {
    const target = g.cards[hit.card]!;
    if (infect || hasKeyword(g, source, "Wither")) {
      target.counters["-1/-1"] = (target.counters["-1/-1"] ?? 0) + hit.amount;
    } else {
      target.damage = (target.damage ?? 0) + hit.amount;
    }
    if (hasKeyword(g, source, "Deathtouch")) target.deathtouched = true;
    log(g, null, `${sourceName} inflige ${plural(hit.amount, "blessure")} à ${cardName(g, target)}.`);
  } else if (hit.player) {
    const sharers = lifeSharers(g, hit.player).filter((p) => !p.hasConceded);
    for (const p of sharers) {
      if (infect) p.poison += hit.amount;
      else p.life -= hit.amount;
      if (source.isCommander && !infect) {
        p.commanderDamage[source.instanceId] = (p.commanderDamage[source.instanceId] ?? 0) + hit.amount;
      }
    }
    if (!infect && sharers.length > 0) emit(g, { type: "lifeLoss", playerId: hit.player, amount: hit.amount });
    const what = infect ? plural(hit.amount, "marqueur poison", "marqueurs poison") : plural(hit.amount, "blessure");
    log(g, null, `${sourceName} inflige ${what} à ${names(sharers)}${infect ? "" : ` (${sharers[0]?.life ?? 0} PV)`}.`);
  }
  if (hasKeyword(g, source, "Lifelink") && cantGainLife(g, source.controllerId)) {
    log(g, null, `${g.players[source.controllerId]!.name} ne peut pas gagner de points de vie.`);
  } else if (hasKeyword(g, source, "Lifelink")) {
    const gainers = lifeSharers(g, source.controllerId);
    for (const p of gainers) p.life += hit.amount;
    emit(g, { type: "lifeGain", playerId: source.controllerId, amount: hit.amount });
    log(g, null, `${names(gainers)} ${gainers.length > 1 ? "gagnent" : "gagne"} ${hit.amount} PV (lien de vie).`);
  }
}

/**
 * Des joueurs quittent la partie (abandon ou défaite). Avec les règles, leurs
 * cartes la quittent aussi (règle 800.4a) : on les range dans leur exil, et
 * les permanents qu'ils contrôlaient sans les posséder reviennent à leur
 * propriétaire. Si c'était leur tour, le tour passe au suivant.
 */
function leaveGame(g: GameState, leaving: PlayerState[]): void {
  for (const p of leaving) p.hasConceded = true;
  if (g.settings.enforceRules) {
    const ids = new Set(leaving.map((p) => p.id));
    for (const card of Object.values(g.cards)) {
      if (card.zone === "exile" || card.zone === "planarDeck" || card.zone === "plane") continue;
      if (ids.has(card.ownerId)) {
        if (card.zone !== "library" && card.zone !== "schemes") moveCardTo(g, card.instanceId, "exile", "top");
      } else if (ids.has(card.controllerId) && card.zone === "battlefield") {
        removeFromZone(g, card);
        card.controllerId = card.ownerId;
        g.players[card.ownerId]!.zones.battlefield.push(card.instanceId);
      }
    }
    if (g.combat) {
      for (const [id, defender] of Object.entries(g.combat.attackers)) {
        if (ids.has(defender)) delete g.combat.attackers[id];
      }
    }
  }
  const active = g.players[g.turn.activePlayerId]!;
  if (active.hasConceded) {
    const stillActive = g.settings.sharedTurns
      ? teamOf(g, active.id).find((id) => !g.players[id]!.hasConceded)
      : undefined;
    if (stillActive) {
      g.turn.activePlayerId = stillActive;
    } else {
      const next = nextActivePlayer(g, active.id);
      // Partie finie : on donne la main sans dérouler de nouveau tour.
      if (next !== null && evaluateOutcomeOver(g)) g.turn.activePlayerId = next;
      else if (next !== null) startTurn(g, next);
    }
  }
}

/** La partie est-elle finie (une seule équipe en lice) ? */
function evaluateOutcomeOver(g: GameState): boolean {
  const alive = g.turnOrder.filter((id) => !g.players[id]!.hasConceded);
  return alive.length === 0 || g.teams.filter((t) => t.some((id) => alive.includes(id))).length <= 1;
}

/**
 * Actions d'état (règle 704), vérifiées après chaque action jusqu'à ce que
 * plus rien ne change. Les blessures mortelles s'appliquent toujours ; le
 * reste seulement quand l'hôte fait respecter les règles.
 */
function checkStateBasedActions(g: GameState): void {
  for (let guard = 0; guard < 20; guard++) {
    const before = g.log.length;
    destroyLethal(g);
    if (g.settings.enforceRules) {
      // Défaites : points de vie, poison, blessures de commandant, pioche dans une bibliothèque vide.
      const losers = g.turnOrder
        .map((id) => g.players[id]!)
        .filter((p) => !p.hasConceded)
        .map((p) => [p, eliminationReason(g, p)] as const)
        .filter(([, reason]) => reason !== null);
      if (losers.length > 0 && !evaluateOutcomeOver(g)) {
        for (const [p, reason] of losers) {
          p.lostReason = reason!;
          log(g, null, `${p.name} perd la partie (${reason}).`);
        }
        leaveGame(g, losers.map(([p]) => p));
      }
      for (const card of Object.values(g.cards)) {
        if (card.zone !== "battlefield") continue;
        // Marqueurs +1/+1 et -1/-1 : ils s'annulent.
        const plus = card.counters["+1/+1"] ?? 0;
        const minus = card.counters["-1/-1"] ?? 0;
        if (plus > 0 && minus > 0) {
          const n = Math.min(plus, minus);
          setCounter(card, "+1/+1", plus - n);
          setCounter(card, "-1/-1", minus - n);
        }
        // Planeswalker sans loyauté.
        if (card.hasLoyalty && (card.counters["loyauté"] ?? 0) <= 0 && /\bPlaneswalker\b/.test(currentTypeLine(g, card))) {
          const name = cardName(g, card);
          moveCardTo(g, card.instanceId, "graveyard", "top");
          log(g, null, `${name} n'a plus de loyauté et va au cimetière.`);
        }
      }
      legendRule(g);
      // Un commandant au cimetière ou en exil retourne dans la zone de commandement (règle 903.9a).
      for (const card of Object.values(g.cards)) {
        if (card.isCommander && (card.zone === "graveyard" || card.zone === "exile") && !card.faceDown) {
          if (g.players[card.ownerId]!.hasConceded) continue;
          moveCardTo(g, card.instanceId, "command", "top");
          log(g, null, `${cardName(g, card)} retourne dans la zone de commandement.`);
        }
      }
    }
    if (g.log.length === before) return;
  }
}

function setCounter(card: CardInstance, kind: string, value: number): void {
  if (value > 0) card.counters[kind] = value;
  else delete card.counters[kind];
}

/**
 * Règle des légendes : un joueur qui contrôle deux permanents légendaires du
 * même nom garde le plus récent ; les autres vont au cimetière.
 */
function legendRule(g: GameState): void {
  for (const player of Object.values(g.players)) {
    const seen = new Map<string, CardInstanceId>();
    // Le champ de bataille est dans l'ordre d'arrivée : on part du plus récent.
    for (const id of [...player.zones.battlefield].reverse()) {
      const card = g.cards[id]!;
      if (card.faceDown || !/\bLegendary\b/.test(currentTypeLine(g, card))) continue;
      const name = cardName(g, card);
      if (seen.has(name)) {
        moveCardTo(g, id, "graveyard", "top");
        log(g, null, `Règle des légendes : ${name} (le plus ancien) va au cimetière.`);
      } else {
        seen.set(name, id);
      }
    }
  }
}

/** Les créatures blessées mortellement (ou d'endurance nulle) vont au cimetière. */
function destroyLethal(g: GameState): void {
  for (const id of Object.values(g.players).flatMap((p) => [...p.zones.battlefield])) {
    const card = g.cards[id];
    if (!card || card.zone !== "battlefield" || !isCreature(g, card)) continue;
    if (!hasLethalDamage(g, card)) continue;
    const name = cardName(g, card);
    moveCardTo(g, id, "graveyard", "top");
    log(g, null, `${name} meurt.`);
  }
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
  for (const p of Object.values(g.players)) p.landsPlayed = 0;
  g.combat = null;
  // Les permanents des joueurs actifs ne sont plus « malades » (règle 302.6).
  for (const p of activePlayers(g)) {
    for (const id of p.zones.battlefield) delete g.cards[id]!.summoningSick;
  }
  log(g, null, `Tour ${g.turn.number} : c'est à ${activeNames(g)}.`);
  enterStep(g, "untap");
  enterStep(g, "upkeep");
}

/** Entre dans une étape et fait ses actions obligatoires (actions de tour). */
function enterStep(g: GameState, step: TurnStep): void {
  g.turn.step = step;
  if (step === "upkeep" || step === "draw" || step === "end") {
    for (const p of activePlayers(g)) emit(g, { type: "step", step, playerId: p.id });
  }
  // Le mana inutilisé disparaît entre deux étapes (règle 500.4).
  for (const p of Object.values(g.players)) p.manaPool = emptyPool();
  switch (step) {
    case "beginCombat":
      g.combat = newCombat();
      break;
    case "declareAttackers": {
      // Aucune créature ne peut attaquer : la déclaration (vide) se fait d'office.
      const combat = g.combat;
      if (!combat || !g.settings.enforceRules) break;
      const players = activePlayers(g);
      const able = players.some((p) => p.zones.battlefield.some((id) => canAttack(g, g.cards[id]!)));
      const foes = g.turnOrder.some((id) => !g.players[id]!.hasConceded && !isActivePlayer(g, id));
      if (!able || !foes) {
        combat.attackersDeclared = true;
        log(g, null, `${names(players)} n'${players.length > 1 ? "ont" : "a"} aucune créature pouvant attaquer.`);
      }
      break;
    }
    case "declareBlockers": {
      // Ceux qui n'ont aucune créature capable de bloquer un attaquant n'ont rien à déclarer.
      const combat = g.combat;
      if (!combat) break;
      for (const p of pendingBlockers(g)) {
        const attackers = Object.entries(combat.attackers)
          .filter(([, d]) => defendingSide(g, d).includes(p.id))
          .map(([id]) => g.cards[id]!)
          .filter((c) => c?.zone === "battlefield");
        const able = p.zones.battlefield.some((id) => attackers.some((a) => canBlock(g, g.cards[id]!, a)));
        if (!able) {
          combat.blocksDeclared.push(p.id);
          if (g.settings.enforceRules) log(g, null, `${p.name} n'a aucune créature pouvant bloquer.`);
        }
      }
      break;
    }
    case "combatDamage":
      dealCombatDamage(g);
      break;
    case "main2":
      g.combat = null;
      break;
    case "cleanup":
      // Les blessures et les effets « jusqu'à la fin du tour » disparaissent (règle 514.2).
      for (const card of Object.values(g.cards)) {
        delete card.damage;
        delete card.deathtouched;
        delete card.ptBoost;
        delete card.grants;
      }
      break;
  }
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
        if (excess > 0 && !hasNoMaxHandSize(g, p.id)) {
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
  for (let i = 0; i < drawn; i++) {
    moveCardTo(g, library[0]!, "hand", "top");
    emit(g, { type: "draw", playerId: player.id });
  }
  log(g, player.id, `${player.name} pioche ${plural(drawn, "carte")}.`);
  if (drawn < count) {
    player.drewFromEmpty = true;
    log(g, player.id, `${player.name} tente de piocher dans une bibliothèque vide.`);
  }
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
