import type { ActionEnvelope, GameAction } from "./actions.js";
import { nextRandom, shuffleInPlace } from "./rng.js";
import { reduceGenericCost } from "./activated.js";
import { eliminationReason, isActivePlayer, lifeSharers, areTeammates, teamOf, playersChoosingOpeningHand } from "./modes.js";
import {
  MANA_LABELS,
  emptyPool,
  formatMana,
  isManaType,
  manaOptions,
  manaOptionsDetailed,
  grantedManaAbility,
  manaTapEffect,
  manaTapSourceFits,
  type ManaTapEffect,
  MANA_TYPES,
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
  type Amount,
  spellEffectsOf,
  flattenModes,
  modesAtCast,
  modesCost,
  modesMax,
  modesTargeted,
  auraTarget,
  permanentLabel,
  type Effect,
  type ExchangeRelation,
  type SpellEffects,
  type Target,
  type TargetSpec,
  type Who,
  type PermanentFilter,
  type TokenSpec,
  graveyardLabel,
  type CopyExcept,
} from "./effects.js";
import { abilitiesOf, colorsOfCost, manaValueOfCost, triggerConditionHolds, conditionMatches, parsePermanentAbilities, sagaChapters, stackTrigger, type TriggeredAbility, type TriggerEvent } from "./triggers.js";
import {
  attackTaxPerCreature,
  cantGainLife,
  cantPlayLands,
  castRestriction,
  costReduction,
  doesntUntap,
  entersTapped,
  entersTappedStatic,
  landPlaysAllowed,
  entersUntappedChoice,
  hasNoMaxHandSize,
  maxOneCreature,
  modifyDamage,
  skipsDrawStep,
  staticsOf,
  type StaticAbility,
  type DamageSource,
  evokeOptions,
  type EvokeCost,
  chooseTypeOf,
  foretellCost,
  colorsAmongPermanents,
  costReductions,
  selfCostReduction,
  mostCommonCreatureType,
  hasCreatureType,
  typeLineHasCreatureType,
  sharesCreatureType,
  legendRuleApplies,
  enterAsCopyOf,
} from "./statics.js";
import { canAttack, canBlock, cantAttack, cantBlock, colorsOf, creatureStats, hasKeyword, hasLethalDamage, isCreature, lethalDamage, type CombatKeyword, type CombatState } from "./combat.js";
import { MAX_HAND_SIZE, STEP_LABELS, STEP_PHRASES, TURN_STEPS, isTurnStep, stepIndex, type TurnStep } from "./turn.js";
import {
  HIDDEN_ORDERED_ZONES,
  PUBLIC_ZONES,
  type CardData,
  type CardInstance,
  type CardInstanceId,
  type CastRecord,
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
    const choosingHands = playersChoosingOpeningHand(draft).length > 0;
    if (choosingHands && !OPENING_HAND_ACTIONS.has(envelope.action.type)) {
      throw new ActionError("La partie commence quand tout le monde a gardé sa main de départ.");
    }
    handlers[envelope.action.type](draft, actor, envelope.action as never);
    if (choosingHands && playersChoosingOpeningHand(draft).length === 0) {
      log(draft, null, "Tout le monde a gardé sa main : la partie commence.");
    }
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

/** Les actions permises pendant le choix des mains de départ. */
const OPENING_HAND_ACTIONS = new Set<GameAction["type"]>([
  "mulligan",
  "bottomMulligan",
  "keepHand",
  "forceKeep",
  "concede",
  "setPriorityStops",
  "rollDie",
]);

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
    const choosing = playersChoosingOpeningHand(g).length > 0;
    if (choosing && actor.handKept !== false) throw new ActionError("Tu as déjà gardé ta main.");
    // Sans règles imposées, le mulligan reste libre (contournement).
    if (!choosing && g.settings.enforceRules) throw new ActionError("Le mulligan se fait seulement en début de partie.");
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
    if (actor.handKept === false) actor.handKept = true;
    log(g, actor.id, `${actor.name} garde sa main et met ${plural(count, "carte")} au-dessous de sa bibliothèque.`);
  },

  keepHand(g, actor) {
    if (actor.handKept !== false) throw new ActionError("Tu as déjà gardé ta main.");
    if (actor.mulliganBottom > 0) {
      throw new ActionError(`Choisis d'abord ${plural(actor.mulliganBottom, "carte")} à mettre au-dessous de ta bibliothèque.`);
    }
    actor.handKept = true;
    log(g, actor.id, `${actor.name} garde sa main (${plural(actor.zones.hand.length, "carte")}).`);
  },

  forceKeep(g, actor, { playerId }) {
    const target = getPlayer(g, playerId);
    if (target.handKept !== false || target.hasConceded) throw new ActionError(`${target.name} a déjà gardé sa main.`);
    // Cartes à mettre au-dessous après un mulligan : les plus chères.
    const count = target.mulliganBottom;
    if (count > 0) {
      const bottom = [...target.zones.hand]
        .sort((a, b) => manaValueOfCost(g.cardData[g.cards[b]!.cardId]?.manaCost ?? "") - manaValueOfCost(g.cardData[g.cards[a]!.cardId]?.manaCost ?? ""))
        .slice(0, count);
      for (const id of bottom) moveCardTo(g, id, "library", "bottom");
      target.mulliganBottom = 0;
    }
    target.handKept = true;
    log(
      g,
      actor.id,
      `${actor.name} fait garder sa main à ${target.name} (${plural(target.zones.hand.length, "carte")}${count > 0 ? `, ${plural(count, "carte")} au-dessous de sa bibliothèque` : ""}).`,
    );
  },

  discardToHandSize(g, actor, { cardIds }) {
    const count = handSizeDiscards(g, actor.id);
    if (count === 0) throw new ActionError("Tu n'as pas de cartes à défausser pour la taille maximale de main.");
    if (new Set(cardIds).size !== cardIds.length || cardIds.length !== count) {
      throw new ActionError(`Choisis exactement ${plural(count, "carte")} de ta main à défausser.`);
    }
    for (const id of cardIds) {
      if (!actor.zones.hand.includes(id)) throw new ActionError("Choisis des cartes de ta main.");
    }
    for (const id of cardIds) moveCardTo(g, id, "graveyard", "top");
    log(g, actor.id, `${actor.name} défausse ${plural(count, "carte")} (taille maximale de main).`);
    // Le joueur passait son tour : une fois tout le monde à 7 cartes, le tour suivant commence.
    if (activePlayers(g).every((p) => handSizeDiscards(g, p.id) === 0)) passTurn(g, actor);
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
      if (tapped) card.tapped = true;
      else untap(g, card);
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
    if (g.settings.enforceRules && attackers.length > 1 && maxOneCreature(g, true)) throw new ActionError("Une seule créature peut attaquer à chaque combat.");
    // Provocation : la créature doit attaquer, et un autre joueur que celui qui l'a provoquée si elle le peut.
    if (g.settings.enforceRules) {
      const foes = g.turnOrder.filter((id) => !g.players[id]!.hasConceded && !isActivePlayer(g, id));
      for (const id of actor.zones.battlefield) {
        const c = g.cards[id]!;
        if (!c.goadedBy?.length || !canAttack(g, c)) continue;
        const declared = attackers.find((a) => a.cardId === id);
        const name = cardName(g, c);
        if (!declared) throw new ActionError(`${name} est provoqué(e) : elle doit attaquer.`);
        const others = foes.filter((f) => !c.goadedBy!.includes(f));
        if (others.length > 0 && c.goadedBy.includes(declared.defender)) {
          throw new ActionError(`${name} est provoqué(e) : elle doit attaquer un autre joueur que ${names(c.goadedBy.map((p) => g.players[p]!))}.`);
        }
      }
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
    emit(g, { type: "attackDeclared", playerId: actor.id, attackers: Object.fromEntries(attackers.map((a) => [a.cardId, a.defender])) });
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
    if (g.settings.enforceRules && maxOneCreature(g, false)) {
      const already = Object.keys(combat.blockers).length;
      if (already + new Set(blocks.map((b) => b.cardId)).size > 1) throw new ActionError("Une seule créature peut bloquer à chaque combat.");
    }
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
    markBlocksDeclared(g, actor.id);
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

  playLand(g, actor, { cardId, face, chosenType, untap }) {
    const card = getCard(g, cardId);
    // Kethis : un terrain qu'on peut jouer depuis son cimetière ce tour-ci.
    const fromGraveyard = card.zone === "graveyard" && card.ownerId === actor.id && exilePermissionHolds(g, card) && card.castPermission?.lands === true;
    if (card.ownerId !== actor.id || (card.zone !== "hand" && !fromGraveyard)) throw new ActionError("Joue un terrain de ta main.");
    const faceIndex = face ?? 0;
    if (!/\bLand\b/.test(faceTypeLine(g, card, faceIndex))) throw new ActionError(`${cardName(g, card)} n'est pas un terrain.`);
    assertSorceryTiming(g, actor, "jouer un terrain");
    if (actor.landsPlayed >= (g.settings.enforceRules ? landPlaysAllowed(g, actor.id) : 1)) {
      throw new ActionError(actor.landsPlayed > 1 ? `Tu as déjà joué ${actor.landsPlayed} terrains ce tour.` : "Tu as déjà joué un terrain ce tour.");
    }
    if (g.settings.enforceRules && cantPlayLands(g, actor.id)) throw new ActionError("Un de tes permanents t'empêche de jouer des terrains.");
    const what = chooseTypeOf(g.cardData[card.cardId], faceIndex);
    const chosen = what ? checkChosenType(what, chosenType) : undefined;
    if (chosen) card.chosenType = chosen;
    if (untap && g.settings.enforceRules) {
      const offer = entersUntappedChoice(g, actor.id, card, faceIndex);
      if (!offer) throw new ActionError(`${cardName(g, card)} n'a pas de choix pour arriver dégagé.`);
      if (!offer.possible) throw new ActionError(offer.life ? `Pas assez de points de vie pour payer ${offer.life} PV.` : `Tu n'as pas de carte ${offer.reveal} à révéler.`);
    }
    card.faceIndex = faceIndex;
    const played = moveCardTo(g, cardId, "battlefield", "top", { untapChoice: untap ?? false });
    actor.landsPlayed += 1;
    log(g, actor.id, `${actor.name} joue ${cardName(g, played)}.`);
    emit(g, { type: "landPlayed", playerId: actor.id, cardId: played.instanceId });
  },

  foretell(g, actor, { cardId }) {
    const card = getCard(g, cardId);
    if (card.zone !== "hand" || card.ownerId !== actor.id) throw new ActionError("Présage : la carte doit être dans ta main.");
    const cost = foretellCost(g.cardData[card.cardId]);
    if (!cost) throw new ActionError("Cette carte n'a pas le présage.");
    if (!isActivePlayer(g, actor.id)) throw new ActionError("Tu ne peux présager que pendant ton tour.");
    if (g.priority && !samePriorityUnit(g, g.priority.playerId, actor.id)) {
      throw new ActionError(`Attends d'avoir la priorité (c'est à ${g.players[g.priority.playerId]!.name}).`);
    }
    payMana(g, actor, "{2}", 0, 0, card.instanceId, "présager");
    const exiled = moveCardTo(g, cardId, "exile", "top", { faceDown: true });
    exiled.castPermission = { free: false, turn: g.turn.number, foretell: cost, reason: "présage" };
    log(g, actor.id, `${actor.name} présage une carte (exilée face cachée).`);
  },

  castSpell(g, actor, { cardId, face, x, targets, sacrifice, alternative, chapter, evoke, evokeExile, chosenType, modes }) {
    const card = getCard(g, cardId);
    const fromCommand = card.zone === "command" && card.isCommander;
    // Rebond, cascade : lancée depuis l'exil, avec la permission notée sur la carte.
    // Etali : la permission peut aller à un autre joueur que le propriétaire de la carte.
    const permitted = (card.castPermission?.caster ?? card.ownerId) === actor.id;
    const permission = (card.zone === "exile" || card.zone === "graveyard") && permitted && exilePermissionHolds(g, card) ? card.castPermission : undefined;
    if ((card.ownerId !== actor.id && !permission) || (card.zone !== "hand" && !fromCommand && !permission)) {
      throw new ActionError("Lance un sort de ta main ou ton commandant depuis la zone de commandement.");
    }
    if ((permission?.free || permission?.foretell) && (evoke || alternative)) throw new ActionError("Ce sort se lance sans payer son coût : pas d'évocation ni de coût alternatif.");
    const faceIndex = face ?? 0;
    const data = g.cardData[card.cardId]!;
    const faceData = data.faces?.[faceIndex];
    if (face !== undefined && !faceData) throw new ActionError("Cette carte n'a pas cette face.");
    const typeLine = faceData?.typeLine ?? data.typeLine;
    if (/\bLand\b/.test(typeLine)) throw new ActionError("Un terrain se joue, il ne se lance pas.");
    const fast = /\bInstant\b/.test(typeLine) || data.keywords.includes("Flash");
    if (fast || permission?.ignoreTiming) {
      if (g.priority && !samePriorityUnit(g, g.priority.playerId, actor.id)) {
        throw new ActionError(`Attends d'avoir la priorité (c'est à ${g.players[g.priority.playerId]!.name}).`);
      }
    } else {
      assertSorceryTiming(g, actor, "lancer ce sort");
    }
    const xValue = permission?.free ? 0 : (x ?? 0);
    if (!Number.isInteger(xValue) || xValue < 0 || xValue > 100) throw new ActionError("Valeur de X invalide.");
    const castThisTurn = actor.spellsCast?.turn === g.turn.number ? actor.spellsCast.count : 0;
    if (g.settings.enforceRules) {
      const restriction = castRestriction(g, actor.id, typeLine, castThisTurn);
      if (restriction) throw new ActionError(restriction);
    }
    // Cibles des effets que le moteur sait appliquer.
    const parsedEffects = g.settings.enforceRules ? spellEffectsOf(g, card, faceIndex, alternative ?? false) : null;
    // Modes avec des cibles (Ashling's Command), un coût (Spree) ou un commandant (Akroma's Will) : choisis en lançant le sort,
    // leurs cibles s'ajoutent à celles du sort. Sans choix envoyé, un sort comme Akroma's Will les choisit à la résolution.
    const withCommander = controlsCommander(g, actor.id);
    const spec = parsedEffects?.modes;
    const atCast = !!spec && (modesTargeted(parsedEffects) || spec.list.some((m) => m.cost) || (modesAtCast(parsedEffects) && modes !== undefined));
    const earlyModes = atCast ? checkModes(spec!, modes ?? [], withCommander) : undefined;
    const effects = parsedEffects && earlyModes ? flattenModes(parsedEffects, earlyModes) : parsedEffects;
    if (alternative && !effects?.alternativeCost) throw new ActionError("Ce sort n'a pas de coût alternatif.");
    // Flawless Maneuver, Fierce Guardianship : gratuit si l'on contrôle un commandant.
    if (alternative && effects?.alternativeIf === "commander" && !controlsCommander(g, actor.id)) {
      throw new ActionError("Il faut contrôler un commandant pour lancer ce sort sans payer son coût.");
    }
    if (effects?.castOnly === "opponentCombat" && (isActivePlayer(g, actor.id) || !["beginCombat", "declareAttackers", "declareBlockers", "combatDamage", "endCombat"].includes(g.turn.step))) {
      throw new ActionError("Ce sort ne se lance que pendant le combat, au tour d'un adversaire.");
    }
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
    // Une aura enchante ce qu'on choisit en la lançant (« Enchant creature you control »).
    const auraSpec = g.settings.enforceRules && !effects ? auraTarget(typeLine, faceData?.oracleText ?? data.oracleText) : null;
    const aura = auraSpec?.permanent || auraSpec?.player ? auraSpec : null;
    if (aura && (chosen.length !== 1 || !isLegalTarget(g, aura, chosen[0]!, actor.id, card.instanceId))) {
      throw new ActionError(`Choisis ce que l'aura enchante : un(e) ${aura.label}.`);
    }
    // Évocation : le coût de la carte, ou celui que donne Ashling.
    let evokeCost: EvokeCost | undefined;
    if (evoke) {
      const options = evokeOptions(g, actor.id, data, faceIndex, card.zone === "hand");
      evokeCost = evoke === "granted" ? options.granted : (options.printed ?? options.granted);
      if (!evokeCost) throw new ActionError("Ce sort ne peut pas être lancé pour un coût d'évocation.");
    }
    let exiled: CardInstance | undefined;
    if (evokeCost?.exileColor) {
      exiled = evokeExile ? g.cards[evokeExile] : undefined;
      const colorName = { W: "blanche", U: "bleue", B: "noire", R: "rouge", G: "verte" }[evokeCost.exileColor] ?? evokeCost.exileColor;
      if (!exiled || exiled.zone !== "hand" || exiled.ownerId !== actor.id || exiled.instanceId === card.instanceId || !g.cardData[exiled.cardId]?.colors.includes(evokeCost.exileColor)) {
        throw new ActionError(`Choisis une carte ${colorName} de ta main à exiler.`);
      }
    }
    const costText = permission?.free ? "" : permission?.foretell ? permission.foretell : evokeCost ? evokeCost.mana : alternative ? effects!.alternativeCost! : faceData?.manaCost || data.manaCost;
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
    const reductions = g.settings.enforceRules
      ? costReductions(g, actor.id, { typeLine, colors: data.colors, oracleText: faceData?.oracleText ?? data.oracleText })
      : { generic: 0, colored: [] as string[] };
    // Le sort lui-même (The Great Henge, Blasphemous Act) ; rien quand il est lancé sans payer son coût.
    const selfReduction = g.settings.enforceRules && !permission?.free && !alternative && !evokeCost ? selfCostReduction(g, actor.id, card, faceIndex) : 0;
    const reduction = permission?.free || (alternative && effects?.alternativeIf) ? 0 : reductions.generic + selfReduction;
    // Morophon : retire du coût le mana coloré indiqué (une fois chaque symbole).
    // Spree : le coût supplémentaire de chaque mode choisi.
    let paidCost = costText + modesCost(parsedEffects, earlyModes);
    for (const c of reductions.colored) paidCost = paidCost.replace(`{${c}}`, "");
    // Toxic Deluge : X PV payés en coût supplémentaire (on ne peut pas payer plus de PV qu'on n'en a).
    const lifeX = effects?.payLifeX ? xValue : 0;
    if (effects?.payLifeX && x === undefined) throw new ActionError(`Choisis X, les PV à payer pour lancer ${name}.`);
    if (lifeX > actor.life) throw new ActionError(`Tu n'as que ${actor.life} PV : X ne peut pas dépasser ${actor.life}.`);
    const payment = payMana(g, actor, paidCost, effects?.payLifeX ? 0 : xValue, tax - reduction, card.instanceId, `lancer ${name}`, { typeLine, oracleText: faceData?.oracleText ?? data.oracleText });
    if (lifeX > 0) payLife(g, actor, lifeX);
    if (sacrificed) {
      const sacName = cardName(g, sacrificed);
      sacrificePermanent(g, sacrificed);
      log(g, actor.id, `${actor.name} sacrifie ${sacName}.`);
    }

    if (exiled) {
      const exiledName = cardName(g, exiled);
      moveCardTo(g, exiled.instanceId, "exile", "top");
      log(g, actor.id, `${actor.name} exile ${exiledName} de sa main pour l'évocation.`);
    }
    actor.spellsCast = { turn: g.turn.number, count: castThisTurn + 1 };
    actor.castNames = [...(actor.castNames ?? []), faceData?.name ?? data.name];
    const fromHand = card.zone === "hand";
    const cast = moveCardTo(g, cardId, "stack", "top", { controllerId: actor.id });
    if (fromHand) cast.castFromHand = true;
    const castCost = faceData?.manaCost ?? data.manaCost;
    const record: CastRecord = {
      cardId: cast.instanceId,
      typeLine,
      colors: faceData ? colorsOfCost(faceData.manaCost) : data.colors,
      manaValue: (faceData ? manaValueOfCost(faceData.manaCost) : data.manaValue) + xValue * (castCost.match(/\{X\}/g)?.length ?? 0),
      fromHand,
      hasX: /\{X\}/.test(castCost),
      ...(/^Changeling\b/m.test(faceData?.oracleText ?? data.oracleText) ? { changeling: true } : {}),
    };
    const history = actor.castHistory?.turn === g.turn.number ? actor.castHistory.spells : [];
    actor.castHistory = { turn: g.turn.number, spells: [...history, record] };
    emit(g, { type: "cast", playerId: actor.id, cardId: cast.instanceId, typeLine, spell: record });
    cast.faceIndex = faceIndex;
    if (alternative) cast.alternative = true;
    if (evokeCost) cast.evoked = true;
    if (permission?.foretell) cast.foretold = true;
    if (spec?.maxWithCommander !== undefined && withCommander) cast.castWithCommander = true;
    if (earlyModes) {
      cast.modes = { chosen: earlyModes };
      log(g, actor.id, `${actor.name} choisit : ${earlyModes.map((i) => `« ${parsedEffects!.modes!.list[i]!.label} »`).join(", ")}.`);
    }
    const what = chooseTypeOf(data, faceIndex);
    const chosenOne = what ? checkChosenType(what, chosenType) : undefined;
    if (chosenOne) cast.chosenType = chosenOne;
    // Lecture anticipée : le chapitre de départ (1 par défaut).
    const chapters = sagaChapters(data, faceIndex);
    if (chapter !== undefined && chapters > 0 && /\bRead ahead\b/i.test(faceData?.oracleText ?? data.oracleText)) {
      if (!Number.isInteger(chapter) || chapter < 1 || chapter > chapters) throw new ActionError(`Choisis un chapitre entre 1 et ${chapters}.`);
      cast.chapter = chapter;
    }
    if (aura) cast.targets = [{ ...chosen[0]! }];
    if (effects) {
      cast.targets = effects.targets.length > 0 ? chosen.map((t) => ({ ...t })) : [];
      if (x !== undefined) cast.xValue = xValue;
    }
    emitTargeted(g, cast);
    const paid = [payment.spent.length > 0 ? formatMana(payment.spent) : "rien", payment.life + lifeX > 0 ? `${payment.life + lifeX} PV` : ""]
      .filter(Boolean)
      .join(" et ");
    const details = [
      x !== undefined ? `X = ${xValue}` : "",
      alternative ? (effects?.overload ? "surcharge" : "coût alternatif") : "",
      evokeCost ? "évocation" : "",
      permission ? `${permission.reason}${permission.free ? ", sans payer son coût" : permission.foretell ? ` pour ${permission.foretell}` : ""}` : "",
      tax > 0 ? `taxe de commandant {${tax}}` : "",
      reduction > 0 ? `réduction de {${reduction}}` : "",
      reduction < 0 ? `surcoût de {${-reduction}}` : "",
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
    for (const id of actor.zones.battlefield) untap(g, g.cards[id]!);
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
    if (delta < 0) noteLifeLost(g, playerId, -delta);
    const who = names(sharers);
    const verb = sharers.length > 1 ? (delta >= 0 ? "gagnent" : "perdent") : delta >= 0 ? "gagne" : "perd";
    log(g, actor.id, `${who} ${verb} ${Math.abs(delta)} PV (${sharers[0]!.life}).`);
  },

  setMonarch(g, actor, { playerId }) {
    if (playerId === null) {
      delete g.monarch;
      log(g, actor.id, "Il n'y a plus de monarque.");
      return;
    }
    getPlayer(g, playerId);
    setMonarch(g, playerId);
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
    assertHandSizeRespected(g);
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
    assertHandSizeRespected(g);
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
    if (!effects || targets.length > effects.targets.length || targets.length < requiredTargets(effects.targets)) throw new ActionError("Nombre de cibles invalide.");
    targets.forEach((t, i) => {
      const spec = effects.targets[i]!;
      if (!isLegalTarget(g, spec, t, actor.id, card.instanceId)) throw new ActionError(`Cible invalide : il faut un(e) ${spec.label}.`);
    });
    card.targets = targets.map((t) => ({ ...t }));
    delete ability.needsTargets;
    emitTargeted(g, card);
    log(g, actor.id, targets.length > 0 ? `${actor.name} vise ${targets.map((t) => targetName(g, t)).join(", ")} avec la capacité de ${ability.sourceName}.` : `${actor.name} ne choisit aucune cible pour la capacité de ${ability.sourceName}.`);
  },

  activateAbility(g, actor, { cardId, index, targets, sacrifice, color, exile }) {
    activateAbility(g, actor, cardId, index, targets ?? [], sacrifice, color, exile);
  },

  decideOptional(g, actor, { cardId, accept, choice, x }) {
    const card = getCard(g, cardId);
    const ability = card.ability;
    if (!ability?.awaitingDecision || card.zone !== "stack") throw new ActionError("Cette capacité n'attend pas de réponse.");
    const decider = ability.decider ?? card.controllerId;
    if (decider !== actor.id) throw new ActionError(`C'est à ${g.players[decider]!.name} de décider.`);
    const trigger = stackTrigger(g.cardData[card.cardId], ability);
    // « … unless that player pays {1} » : payer empêche l'effet.
    if (ability.decider !== undefined || (trigger?.unless && ability.unlessPaid === undefined)) {
      const u = trigger!.unless!;
      const age = u.perAge ? Math.max(1, g.cards[ability.sourceId]?.counters["âge"] ?? 1) : 1;
      if (accept) {
        if (u.discard) {
          const chosen = choice ? g.cards[choice] : undefined;
          if (!chosen || chosen.zone !== "hand" || chosen.ownerId !== actor.id) throw new ActionError("Choisis une carte de ta main à défausser.");
          const name = cardName(g, chosen);
          moveCardTo(g, chosen.instanceId, "graveyard", "top");
          log(g, actor.id, `${actor.name} défausse ${name}.`);
        }
        if (u.life) {
          if (actor.life < u.life * age) throw new ActionError("Tu n'as pas assez de points de vie.");
          payLife(g, actor, u.life * age);
        }
        if (u.mana) {
          const x = u.xPower ? unlessX(g, ability.sourceId) : 0;
          const paid = payMana(g, actor, u.mana.repeat(age), x, 0, undefined, "payer ce coût");
          log(g, actor.id, `${actor.name} paie ${paid.spent.length > 0 ? formatMana(paid.spent) : "rien"}.`);
        }
        if (u.life) log(g, actor.id, `${actor.name} paie ${u.life * age} PV.`);
      } else {
        log(g, actor.id, `${actor.name} ne paie pas pour « ${ability.text} ».`);
      }
      ability.unlessPaid = accept;
      delete ability.awaitingDecision;
      delete ability.decider;
      resolveAbility(g, card);
      return;
    }
    if (accept && trigger) {
      const sac = trigger.effects.effects.find((e) => e.type === "sacrifice");
      if (sac && sac.type === "sacrifice") {
        const chosen = choice ? g.cards[choice] : undefined;
        if (!chosen || chosen.controllerId !== actor.id || !matchesPermanent(g, chosen, sac.filter, actor.id)) {
          throw new ActionError(`Choisis un(e) ${permanentLabel(sac.filter)} à sacrifier.`);
        }
        ability.choice = chosen.instanceId;
      }
      if (trigger.payLife) payLife(g, actor, trigger.payLife);
      if (trigger.payMana) {
        let xValue = 0;
        if (/\{X\}/i.test(trigger.payMana)) {
          xValue = x ?? 0;
          const max = ability.eventAmount ?? 0;
          if (!Number.isInteger(xValue) || xValue < 0 || xValue > max) throw new ActionError(`X doit être entre 0 et ${max}.`);
          card.xValue = xValue;
        }
        const paid = payMana(g, actor, trigger.payMana, xValue, 0, undefined, "payer ce coût");
        log(g, actor.id, `${actor.name} paie ${paid.spent.length > 0 ? formatMana(paid.spent) : "rien"}.`);
      }
    }
    delete ability.awaitingDecision;
    ability.accepted = accept;
    log(g, actor.id, `${actor.name} ${accept ? "accepte" : "refuse"} : « ${ability.text} ».`);
    resolveAbility(g, card);
  },

  chooseCards(g, actor, { cardId, cardIds }) {
    const card = getCard(g, cardId);
    const pending = card.cardChoice;
    if (!pending || card.zone !== "stack") throw new ActionError("Aucun choix de cartes n'est en attente.");
    const chooser = pending.playerId ?? card.controllerId;
    if (chooser !== actor.id) throw new ActionError(`C'est à ${g.players[chooser]!.name} de choisir.`);
    const chosen = [...new Set(cardIds)];
    if (chosen.length < pending.min || chosen.length > pending.max || chosen.some((id) => !pending.options.includes(id))) {
      throw new ActionError(pending.min === pending.max ? `Choisis ${plural(pending.max, "carte")} parmi celles proposées.` : `Choisis au plus ${plural(pending.max, "carte")} parmi celles proposées.`);
    }
    if (pending.perPlayer && new Set(chosen.map((id) => g.cards[id]!.controllerId)).size !== chosen.length) {
      throw new ActionError("Choisis une seule créature par joueur.");
    }
    card.choices = { ...(card.choices ?? {}), [pending.index]: chosen };
    delete card.cardChoice;
    if (card.ability) resolveAbility(g, card);
    else resolveTop(g, card.instanceId);
  },

  chooseModes(g, actor, { cardId, modes }) {
    const card = getCard(g, cardId);
    if (!card.modes || card.modes.chosen || card.zone !== "stack") throw new ActionError("Aucun choix de modes n'est en attente.");
    if (card.controllerId !== actor.id) throw new ActionError("Seul son contrôleur choisit les modes.");
    const effects = card.ability ? abilityEffects(g, card) : spellEffectsOf(g, card);
    const spec = effects?.modes;
    if (!spec) throw new ActionError("Ce sort n'a pas de modes.");
    // Akroma's Will : « if you control a commander as you cast this spell » (noté en lançant le sort).
    const chosen = checkModes(spec, modes, card.ability ? controlsCommander(g, actor.id) : !!card.castWithCommander);
    card.modes.chosen = chosen;
    log(g, actor.id, `${actor.name} choisit : ${chosen.map((i) => `« ${spec.list[i]!.label} »`).join(", ")}.`);
    // Capacité déclenchée aux modes ciblés (Titan of Industry) : les modes sont choisis en la mettant sur la pile, puis ses cibles.
    if (card.ability && modesTargeted(effects)) {
      assignAbilityTargets(g, card, abilityEffects(g, card)!.targets);
      return;
    }
    if (card.ability) resolveAbility(g, card);
    else resolveTop(g, card.instanceId);
  },

  scry(g, actor, { cardId, top, bottom }) {
    const card = getCard(g, cardId);
    if (!card.scry || card.scry.done || card.zone !== "stack") throw new ActionError("Aucun regard n'est en attente pour ce sort.");
    if (card.controllerId !== actor.id) throw new ActionError("Seul son contrôleur range les cartes du regard.");
    const library = actor.zones.library;
    const looked = library.slice(0, card.scry.count);
    const chosen = [...top, ...bottom];
    if (chosen.length !== looked.length || new Set(chosen).size !== chosen.length || chosen.some((id) => !looked.includes(id))) {
      throw new ActionError(`Range exactement les ${plural(looked.length, "carte")} du dessus de ta bibliothèque.`);
    }
    library.splice(0, looked.length);
    library.unshift(...top);
    library.push(...bottom);
    card.scry.done = true;
    log(g, actor.id, `${actor.name} garde ${plural(top.length, "carte")} au-dessus et en met ${bottom.length} au-dessous.`);
    if (card.ability) resolveAbility(g, card);
    else resolveTop(g, card.instanceId);
  },

  passPriority(g, actor) {
    const priority = g.priority;
    if (!priority) throw new ActionError("La pile est vide : personne n'a la priorité.");
    const picking = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice);
    if (picking) throw new ActionError(`${g.players[picking.controllerId]!.name} doit d'abord choisir une carte pour ${cardName(g, picking)}.`);
    const choosing = g.stack.map((id) => g.cards[id]!).find((c) => c.modes && !c.modes.chosen);
    if (choosing) throw new ActionError(`${g.players[choosing.controllerId]!.name} doit d'abord choisir les modes de ${cardName(g, choosing)}.`);
    const scrying = g.stack.map((id) => g.cards[id]!).find((c) => c.scry && !c.scry.done);
    if (scrying) throw new ActionError(`${g.players[scrying.controllerId]!.name} doit d'abord ranger les cartes de son regard.`);
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
  const holder = card.zone === "battlefield" || card.zone === "phasedOut" ? card.controllerId : card.ownerId;
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
  options: { controllerId?: PlayerId | undefined; tapped?: boolean | undefined; faceDown?: boolean | undefined; untapChoice?: boolean | undefined; copyDataId?: string | undefined } = {},
): CardInstance {
  const card = getCard(g, cardId);
  const from = card.zone;
  // Ses valeurs copiables au moment où il part (une copie reste une copie : Ratadrabik).
  const lastDataId = card.originalCardId ?? card.cardId;
  // Une créature transformée par une aura retrouve sa vraie carte en quittant le champ de bataille.
  if (card.originalCardId) {
    card.cardId = card.originalCardId;
    delete card.originalCardId;
  }
  // Une copie (Clone, Sakashima) redevient elle-même hors du champ de bataille.
  if (card.copyBaseId) {
    card.cardId = card.copyBaseId;
    delete card.copyBaseId;
  }
  const wasPublic = isVisibleToAll(card);
  removeFromZone(g, card);
  if (from === "exile") delete card.exiledUntilMonarch;
  // Une capacité qui quitte la pile (résolue, contrée, retirée) disparaît.
  if (card.ability) {
    delete g.cards[card.instanceId];
    return card;
  }
  // « Meurt » : une créature va du champ de bataille au cimetière (règle 700.4).
  const dies =
    from === "battlefield" && to === "graveyard" && !card.faceDown && isCreature(g, card)
      ? ({
          type: "dies",
          cardId: card.instanceId,
          controllerId: card.controllerId,
          dataId: lastDataId,
          faceIndex: card.faceIndex,
          isToken: card.isToken,
          ...(card.grantedTriggers ? { granted: [...card.grantedTriggers] } : {}),
        } as const)
      : null;

  if (to === "battlefield" && from !== "battlefield") {
    if (options.copyDataId && g.cardData[options.copyDataId]) {
      card.copyBaseId = card.cardId;
      card.cardId = options.copyDataId;
    }
    card.summoningSick = true;
    // Un planeswalker arrive avec ses marqueurs de loyauté.
    const data = g.cardData[card.cardId];
    const loyalty = parseInt(data?.faces?.[card.faceIndex]?.loyalty ?? data?.loyalty ?? "", 10);
    if (!card.faceDown && Number.isFinite(loyalty) && /\bPlaneswalker\b/.test(currentTypeLine(g, card))) {
      card.counters["loyauté"] = loyalty;
      card.hasLoyalty = true;
    }
    // Une saga arrive avec un marqueur de savoir (ou au chapitre choisi avec la lecture anticipée).
    if (!card.faceDown && g.settings.enforceRules && sagaChapters(data, card.faceIndex) > 0) {
      const start = card.chapter ?? 1;
      card.counters["savoir"] = start;
      emit(g, { type: "lore", cardId: card.instanceId, from: start - 1, to: start });
    }
    delete card.chapter;
  }
  if (from === "stack" && to !== "stack") {
    delete card.targets;
    delete card.xValue;
  }
  if (from === "battlefield" && to !== "battlefield") {
    if (!card.faceDown) {
      const auras = Object.values(g.cards)
        .filter((o) => o.attachedTo === card.instanceId && o.zone === "battlefield" && !o.faceDown)
        .map((o) => ({ cardId: o.instanceId, controllerId: o.controllerId, dataId: o.cardId, faceIndex: o.faceIndex }));
      emit(g, {
        type: "leaves",
        cardId: card.instanceId,
        controllerId: card.controllerId,
        dataId: lastDataId,
        faceIndex: card.faceIndex,
        to,
        ...(card.grantedTriggers ? { granted: [...card.grantedTriggers] } : {}),
        ...(auras.length > 0 ? { auras } : {}),
      });
    }
    delete card.summoningSick;
    delete card.hasLoyalty;
    delete card.damage;
    delete card.deathtouched;
    delete card.ptBoost;
    delete card.grants;
    delete card.grantsUntil;
    delete card.grantedTriggers;
    delete card.usedAbilities;
    delete card.controlReturnsTo;
    if (g.combat) {
      delete g.combat.attackers[card.instanceId];
      delete g.combat.blockers[card.instanceId];
    }
    card.tapped = false;
    card.counters = {};
    delete card.attachedTo;
    delete card.attachedPlayer;
    delete card.chosenType;
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

  if (from === "stack") {
    if (to !== "battlefield") delete card.chapter;
    delete card.cardChoice;
    delete card.choices;
    delete card.scry;
    delete card.modes;
    delete card.castWithCommander;
    delete card.alternative;
    delete card.castFromHand;
    delete card.foretold;
    if (to !== "battlefield") delete card.evoked;
  }
  if (from === "battlefield" && to !== "battlefield") delete card.goadedBy;
  if ((from === "exile" || from === "graveyard") && to !== from) {
    delete card.castPermission;
    delete card.rebound;
  }
  // Cascade : la carte non lancée va au-dessous de la bibliothèque quand le sort quitte la pile.
  if (from === "stack" && to !== "stack") {
    for (const pid of g.turnOrder) {
      for (const id of [...g.players[pid]!.zones.exile]) {
        if (g.cards[id]?.castPermission?.whileOnStack === cardId) moveCardTo(g, id, "library", "bottom");
      }
    }
  }
  card.controllerId = to === "battlefield" || to === "stack" ? (options.controllerId ?? card.controllerId) : card.ownerId;
  if (from === "battlefield" && to !== "battlefield") card.controllerId = card.ownerId;
  card.zone = to;
  card.faceDown = (to === "battlefield" || to === "exile") && (options.faceDown ?? false);
  if (to !== "battlefield") card.faceIndex = 0;
  if (to === "battlefield") card.tapped = options.tapped ?? false;
  // « This land enters tapped », éventuellement « unless … ».
  if (to === "battlefield" && from !== "battlefield" && g.settings.enforceRules && !card.faceDown && entersTapped(g.cardData[card.cardId], card.faceIndex)) {
    card.tapped = !entersUntapped(g, card, options.untapChoice ?? false);
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
  if (to === "battlefield" && from !== "battlefield") {
    // « As ~ enters, choose a creature type » : sans choix (posée à la main, copie), le type le plus courant.
    const entered = g.cards[id]!;
    const what = !entered.faceDown && chooseTypeOf(g.cardData[entered.cardId], entered.faceIndex);
    if (what && !entered.chosenType) entered.chosenType = what === "card" ? "creature" : what === "color" ? "G" : mostCommonCreatureType(g, entered.controllerId);
    if (what) log(g, null, `${cardName(g, entered)} : ${what === "color" ? "couleur choisie" : "type choisi"} « ${entered.chosenType} ».`);
    emitEnters(g, entered, from === "stack");
  }
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

/** Au nettoyage, le tour ne passe pas tant que le joueur actif a trop de cartes en main. */
function assertHandSizeRespected(g: GameState): void {
  const waiting = activePlayers(g).filter((p) => handSizeDiscards(g, p.id) > 0);
  if (waiting.length === 0) return;
  throw new ActionError(
    `${names(waiting)} ${waiting.length > 1 ? "doivent" : "doit"} d'abord défausser jusqu'à ${MAX_HAND_SIZE} cartes en main.`,
  );
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
/** Note les points de vie perdus ce tour (Wound Reflection). */
function noteLifeLost(g: GameState, playerId: PlayerId, amount: number): void {
  for (const p of lifeSharers(g, playerId)) {
    const before = p.lifeLost?.turn === g.turn.number ? p.lifeLost.amount : 0;
    p.lifeLost = { turn: g.turn.number, amount: before + amount };
  }
}

function emit(g: GameState, event: TriggerEvent): void {
  if (event.type === "lifeLoss") noteLifeLost(g, event.playerId, event.amount);
  if (!g.settings.enforceRules) return;
  (g.events ??= []).push(event);
}

function emitEnters(g: GameState, card: CardInstance, cast = false): void {
  emit(g, {
    type: "enters",
    cardId: card.instanceId,
    controllerId: card.controllerId,
    creature: !card.faceDown && isCreature(g, card),
    ...(cast ? { cast } : {}),
    ...(!card.faceDown && /\bLand\b/.test(currentTypeLine(g, card)) ? { land: true } : {}),
  });
}

/** Les capacités déclenchées « une fois par tour » sont notées dans `usedAbilities` à partir de cet index. */
const TRIGGER_KEY = 1000;

/** Texte des jetons prédéfinis (règle 111.10). */
const NAMED_TOKENS: Record<string, string> = {
  Treasure: "{T}, Sacrifice this artifact: Add one mana of any color.",
  Food: "{2}, {T}, Sacrifice this artifact: You gain 3 life.",
  Clue: "{2}, Sacrifice this artifact: Draw a card.",
  Blood: "{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.",
};

/** Index des capacités déclenchées données (Malakir Rebirth), pour les distinguer de celles de la carte. */
const GRANTED_KEY = 2000;

/** Au plus autant de capacités déclenchées par action : garde-fou contre les boucles sans fin. */
const MAX_TRIGGERS_PER_ACTION = 50;

/**
 * Met sur la pile les capacités déclenchées par les événements notés, dans
 * l'ordre du tour à partir du joueur actif (règle 603.3b). Retourne vrai si
 * au moins une capacité a été ajoutée.
 */
/** Yarok, Twinflame Travelers : combien de fois de plus la capacité se déclenche. */
function extraTriggers(g: GameState, permanents: CardInstance[], source: CardInstance, dataId: string, faceIndex: number, event: TriggerEvent): number {
  let extra = 0;
  for (const doubler of permanents) {
    if (doubler.controllerId !== source.controllerId) continue;
    for (const st of staticsOf(g, doubler)) {
      if (st.kind !== "triggerDoubler") continue;
      if (st.entering && event.type === "enters") extra++;
      if (st.subtype && doubler.instanceId !== source.instanceId) {
        const data = g.cardData[dataId];
        const face = data?.faces?.[faceIndex];
        if (typeLineHasCreatureType(face?.typeLine ?? data?.typeLine ?? "", face?.oracleText ?? data?.oracleText ?? "", st.subtype)) extra++;
      }
    }
  }
  return extra;
}

function flushTriggers(g: GameState): boolean {
  const events = g.events ?? [];
  delete g.events;
  if (events.length === 0) return false;
  type Pending = {
    source: CardInstance;
    dataId: string;
    faceIndex: number;
    index: number;
    controllerId: PlayerId;
    event: TriggerEvent;
    trigger: TriggeredAbility;
    grantedText?: string;
    batch?: CardInstanceId[];
  };
  const pending: Pending[] = [];
  const permanents = g.turnOrder
    .flatMap((id) => g.players[id]!.zones.battlefield)
    .map((id) => g.cards[id]!)
    .filter((c) => !c.faceDown);
  for (const event of events) {
    type Source = { card: CardInstance; dataId: string; faceIndex: number; granted?: string[]; spell?: boolean };
    const sources: Source[] = permanents.map((c) => ({
      card: c,
      dataId: c.cardId,
      faceIndex: c.faceIndex,
      ...(c.grantedTriggers || c.grants?.includes("myriad") ? { granted: [...(c.grantedTriggers ?? []), ...(c.grants?.includes("myriad") ? ["Myriad"] : [])] } : {}),
    }));
    // « Quand ~ meurt » : la carte regarde en arrière, depuis le cimetière (ou disparue si c'est un jeton).
    if (event.type === "dies" || event.type === "leaves") {
      const dead = g.cards[event.cardId] ?? ({ instanceId: event.cardId, controllerId: event.controllerId } as CardInstance);
      sources.push({
        card: { ...dead, controllerId: event.controllerId },
        dataId: event.dataId,
        faceIndex: event.faceIndex,
        ...(event.granted ? { granted: event.granted } : {}),
      });
    }
    // « When you cast this spell » : le sort lui-même, sur la pile.
    if (event.type === "cast") {
      const spell = g.cards[event.cardId];
      if (spell?.zone === "stack") sources.push({ card: spell, dataId: spell.cardId, faceIndex: spell.faceIndex, spell: true });
    }
    // Les auras attachées au permanent parti regardent en arrière aussi (Kaya's Ghostform).
    if (event.type === "leaves") {
      for (const a of event.auras ?? []) {
        if (sources.some((s) => s.card.instanceId === a.cardId)) continue;
        const aura = g.cards[a.cardId] ?? ({ instanceId: a.cardId } as CardInstance);
        sources.push({ card: { ...aura, controllerId: a.controllerId }, dataId: a.dataId, faceIndex: a.faceIndex });
      }
    }
    for (const { card, dataId, faceIndex, granted, spell } of sources) {
      const own = abilitiesOf(g.cardData[dataId], faceIndex).triggers.map((trigger, index) => ({ trigger, index, grantedText: undefined as string | undefined }));
      const sourceName = g.cardData[dataId]?.faces?.[faceIndex]?.name ?? g.cardData[dataId]?.name ?? "?";
      const given = (granted ?? []).flatMap((text, i) => {
        const trigger = parsePermanentAbilities(text, sourceName).triggers[0];
        return trigger ? [{ trigger, index: GRANTED_KEY + i, grantedText: text }] : [];
      });
      [...own, ...given].forEach(({ trigger, index, grantedText }) => {
        if (spell && !(trigger.condition.on === "cast" && trigger.condition.self)) return;
        if (!conditionMatches(g, trigger.condition, event, card)) return;
        if (trigger.ifUntapped && card.tapped) return;
        if (trigger.onlyIf && !triggerConditionHolds(g, trigger.onlyIf, card.controllerId, "cardId" in event ? event.cardId : undefined)) return;
        // « One or more … » et « only once each turn » : une seule fois pour cette action (et ce tour).
        // « One or more creatures you control deal combat damage » : une seule fois, avec toutes les créatures.
        if (trigger.condition.on === "combatDamage" && trigger.condition.batched && event.type === "combatDamage") {
          const already = pending.filter((p) => p.source.instanceId === card.instanceId && p.index === index);
          if (already.length > 0) {
            for (const p of already) if (!p.batch!.includes(event.cardId)) p.batch!.push(event.cardId);
            return;
          }
          const copies = 1 + extraTriggers(g, permanents, card, dataId, faceIndex, event);
          for (let i = 0; i < copies; i++) pending.push({ source: card, dataId, faceIndex, index, controllerId: card.controllerId, event, trigger, batch: [event.cardId] });
          return;
        }
        const once = trigger.oncePerTurn || (trigger.condition.on === "dies" && trigger.condition.batched);
        if (once && pending.some((p) => p.source.instanceId === card.instanceId && p.index === index)) return;
        if (trigger.oncePerTurn) {
          const live = g.cards[card.instanceId];
          const used = live?.usedAbilities?.turn === g.turn.number ? live.usedAbilities.indices : [];
          if (used.includes(TRIGGER_KEY + index)) return;
          if (live) live.usedAbilities = { turn: g.turn.number, indices: [...used, TRIGGER_KEY + index] };
        }
        const copies = 1 + extraTriggers(g, permanents, card, dataId, faceIndex, event);
        for (let i = 0; i < copies; i++) pending.push({ source: card, dataId, faceIndex, index, controllerId: card.controllerId, event, trigger, ...(grantedText ? { grantedText } : {}) });
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
    const trigger = p.trigger;
    const sourceName = g.cardData[p.dataId]?.faces?.[p.faceIndex]?.name ?? g.cardData[p.dataId]?.name ?? "?";
    const instance = newInstance(g, p.dataId, p.controllerId, "stack");
    instance.faceIndex = p.faceIndex;
    instance.ownerId = p.controllerId;
    instance.revealedTo = [...g.turnOrder];
    instance.ability = { sourceId: p.source.instanceId, sourceName, text: trigger.text, index: p.index, faceIndex: p.faceIndex };
    if (p.grantedText) instance.ability.grantedText = p.grantedText;
    const ev = p.event;
    if (ev.type === "dies" || ev.type === "leaves") {
      instance.ability.eventCardId = ev.cardId;
      instance.ability.eventZone = ev.type === "dies" ? "graveyard" : ev.to;
      // Ce qu'était la créature (Ratadrabik copie aussi un jeton ou une copie disparus).
      if (ev.type === "dies") {
        instance.ability.eventDataId = ev.dataId;
        instance.ability.eventFaceIndex = ev.faceIndex;
      }
    } else if (ev.type === "attacks" || ev.type === "enters" || ev.type === "combatDamage" || ev.type === "playerDamage" || ev.type === "cast") {
      instance.ability.eventCardId = ev.cardId;
      // « that player » d'une attaque : le joueur attaqué (The Spear of Bashenga).
      const attacked = ev.type === "attacks" ? g.combat?.attackers[ev.cardId] : undefined;
      if (attacked) instance.ability.eventPlayerId = attacked;
    } else if (ev.type === "targeted") {
      instance.ability.eventCardId = ev.spellId;
    } else if (ev.type === "sacrificed") {
      instance.ability.eventCardId = ev.cardId;
      instance.ability.eventDataId = ev.dataId;
      instance.ability.eventFaceIndex = ev.faceIndex;
    }
    if (p.batch) instance.ability.batch = [...p.batch];
    if ("playerId" in ev) instance.ability.eventPlayerId = ev.playerId;
    if ("amount" in ev) instance.ability.eventAmount = ev.amount;
    // Modes ciblés (Titan of Industry) : le contrôleur choisit les modes, puis les cibles.
    if (modesTargeted(trigger.effects)) {
      instance.modes = {};
      instance.targets = [];
      g.stack.push(instance.instanceId);
      added++;
      log(g, null, `Capacité de ${sourceName} : « ${trigger.text} » (${g.players[p.controllerId]!.name} choisit les modes).`);
      continue;
    }
    // Cibles : choisies d'office quand il n'y a qu'un choix possible.
    if (!assignAbilityTargets(g, instance, trigger.effects.targets)) {
      log(g, null, `La capacité de ${sourceName} n'a pas de cible valide.`);
      continue;
    }
    g.stack.push(instance.instanceId);
    added++;
    const aimed = (instance.targets ?? []).length > 0 ? ` (cible : ${instance.targets!.map((t) => targetName(g, t)).join(", ")})` : "";
    log(g, null, `Capacité de ${sourceName} : « ${trigger.text} »${aimed}.`);
  }
  // Les capacités mises sur la pile ont pu viser un permanent avec la garde.
  if ((g.events as TriggerEvent[] | undefined)?.length) flushTriggers(g);
  return added > 0;
}

/** Toutes les cibles valables pour une spécification. */
function legalTargets(g: GameState, spec: Parameters<typeof isLegalTarget>[1], casterId: PlayerId, sourceId: string): Target[] {
  const candidates: Target[] = [
    ...g.turnOrder.map((id) => ({ kind: "player", id }) as Target),
    ...g.turnOrder.flatMap((id) => g.players[id]!.zones.battlefield).map((id) => ({ kind: "card", id }) as Target),
    ...g.stack.map((id) => ({ kind: "card", id }) as Target),
    ...(spec.graveyard ? g.turnOrder.flatMap((id) => g.players[id]!.zones.graveyard).map((id) => ({ kind: "card", id }) as Target) : []),
  ];
  return candidates.filter((t) => isLegalTarget(g, spec, t, casterId, sourceId));
}

/** Effets de la capacité déclenchée sur la pile, relus depuis le texte de sa source. */
function abilityEffects(g: GameState, card: CardInstance): SpellEffects | undefined {
  const ability = card.ability;
  if (!ability) return undefined;
  const effects = ability.activated
    ? abilitiesOf(g.cardData[card.cardId], ability.faceIndex).activated[ability.index]?.effects
    : stackTrigger(g.cardData[card.cardId], ability)?.effects;
  return effects && flattenModes(effects, card.modes?.chosen);
}

function resolveAbility(g: GameState, card: CardInstance): void {
  const ability = card.ability!;
  const effects = abilityEffects(g, card);
  const targets = card.targets ?? [];
  if (!effects) {
    moveCardTo(g, card.instanceId, "graveyard", "top");
    return;
  }
  const trigger = stackTrigger(g.cardData[card.cardId], ability);
  // « if an opponent controls more lands than you » : revérifié à la résolution (règle 603.4).
  if (trigger?.onlyIf && !triggerConditionHolds(g, trigger.onlyIf, card.controllerId, ability.eventCardId)) {
    log(g, null, `La capacité de ${ability.sourceName} ne fait rien : sa condition n'est plus remplie.`);
    moveCardTo(g, card.instanceId, "graveyard", "top");
    return;
  }
  // « … unless that player pays » : le payeur répond d'abord (entretien cumulatif : un marqueur d'âge avant).
  if (trigger?.unless && ability.unlessPaid === undefined) {
    const source = g.cards[ability.sourceId];
    if (trigger.unless.perAge && !ability.aged && source?.zone === "battlefield") {
      source.counters["âge"] = (source.counters["âge"] ?? 0) + 1;
      ability.aged = true;
    }
    const payerId = trigger.unless.payer === "event" ? ability.eventPlayerId : card.controllerId;
    if (payerId && !g.players[payerId]!.hasConceded) {
      ability.awaitingDecision = true;
      if (payerId !== card.controllerId) ability.decider = payerId;
      log(g, null, `${g.players[payerId]!.name} choisit s'il paie pour la capacité de ${ability.sourceName}.`);
      return;
    }
    ability.unlessPaid = false;
  }
  if (ability.unlessPaid) {
    log(g, null, `La capacité de ${ability.sourceName} ne fait rien (le coût a été payé).`);
    moveCardTo(g, card.instanceId, "graveyard", "top");
    return;
  }
  // « You may » : le contrôleur répond d'abord (la capacité reste sur la pile en attendant).
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
    if (startModes(g, card, effects) || startScry(g, card, effects) || startCardChoice(g, card, withModes(effects, card), targets, legal)) return;
    log(g, null, `La capacité de ${ability.sourceName} se résout.`);
    applySpellEffects(g, card, withModes(effects, card), targets, legal);
    if (effects.unknown.length > 0) log(g, null, `À appliquer à la main pour ${ability.sourceName} : « ${effects.unknown.join(" ")} »`);
  }
  if (g.cards[card.instanceId]) moveCardTo(g, card.instanceId, "graveyard", "top");
}

/**
 * Les cibles d'une capacité déclenchée : choisies d'office quand il n'y a qu'un choix possible,
 * sinon le contrôleur les choisit (`needsTargets`). `false` (et la capacité retirée) s'il n'y en a aucune.
 */
function assignAbilityTargets(g: GameState, instance: CardInstance, specs: TargetSpec[]): boolean {
  const ability = instance.ability!;
  if (specs.length === 0) {
    instance.targets = [];
    return true;
  }
  const choices = specs.map((spec) => legalTargets(g, spec, instance.controllerId, instance.instanceId));
  const required = requiredTargets(specs);
  if (choices.slice(0, required).some((c) => c.length === 0)) {
    g.stack = g.stack.filter((id) => id !== instance.instanceId);
    delete g.cards[instance.instanceId];
    return false;
  }
  // « up to one target » sans aucune cible possible : on s'arrête aux cibles obligatoires.
  if (required < specs.length && choices.slice(required).every((c) => c.length === 0)) {
    instance.targets = choices.slice(0, required).length === required && choices.slice(0, required).every((c) => c.length === 1) ? choices.slice(0, required).map((c) => c[0]!) : [];
    if (instance.targets.length < required) ability.needsTargets = true;
  } else if (required === specs.length && choices.every((c) => c.length === 1)) instance.targets = choices.map((c) => c[0]!);
  else {
    instance.targets = [];
    ability.needsTargets = true;
  }
  emitTargeted(g, instance);
  return true;
}

/** Garde (ward) : chaque permanent visé par ce sort ou cette capacité « devient la cible » (règle 702.21). */
function emitTargeted(g: GameState, instance: CardInstance): void {
  const seen = new Set<string>();
  for (const t of instance.targets ?? []) {
    if (t.kind !== "card" || seen.has(t.id) || g.cards[t.id]?.zone !== "battlefield") continue;
    seen.add(t.id);
    emit(g, { type: "targeted", cardId: t.id, playerId: instance.controllerId, spellId: instance.instanceId });
  }
}

function targetName(g: GameState, t: Target): string {
  if (t.kind === "player") return g.players[t.id]?.name ?? "?";
  const card = g.cards[t.id];
  return card ? cardName(g, card) : "?";
}

/** Inflige des blessures non liées au combat à un joueur ou à un permanent. */
function dealDamage(g: GameState, sourceName: string, t: Target, raw: number, from: DamageSource): number {
  if (raw <= 0) return 0;
  const target = t.kind === "player" ? { player: t.id } : { card: g.cards[t.id] };
  const amount = modifyDamage(g, from, target, raw);
  if (amount <= 0) {
    log(g, null, `Les blessures de ${sourceName} sont prévenues.`);
    return 0;
  }
  if (t.kind === "player") {
    if (lifeLocked(g, t.id)) {
      log(g, null, `${sourceName} inflige ${amount} blessure${amount > 1 ? "s" : ""} à ${g.players[t.id]!.name}, dont les points de vie ne peuvent pas changer.`);
      return amount;
    }
    const sharers = lifeSharers(g, t.id);
    for (const p of sharers) p.life -= amount;
    emit(g, { type: "lifeLoss", playerId: t.id, amount });
    const dealer = from.sourceId ? g.cards[from.sourceId] : undefined;
    if (dealer?.zone === "battlefield" && !dealer.faceDown && isCreature(g, dealer)) {
      emit(g, { type: "playerDamage", cardId: dealer.instanceId, controllerId: dealer.controllerId, playerId: t.id, amount });
    }
    log(g, null, `${sourceName} inflige ${amount} blessure${amount > 1 ? "s" : ""} à ${names(sharers)} (${sharers[0]!.life} PV).`);
    return amount;
  }
  const card = g.cards[t.id];
  if (!card || card.zone !== "battlefield") return 0;
  if (useShield(g, card)) return 0;
  if (card.hasLoyalty) card.counters["loyauté"] = Math.max(0, (card.counters["loyauté"] ?? 0) - amount);
  if (isCreature(g, card)) card.damage = (card.damage ?? 0) + amount;
  emit(g, { type: "damaged", cardId: card.instanceId, amount });
  log(g, null, `${sourceName} inflige ${amount} blessure${amount > 1 ? "s" : ""} à ${cardName(g, card)}.`);
  return amount;
}

/** Marqueur bouclier : il est retiré à la place des blessures ou de la destruction. */
function useShield(g: GameState, card: CardInstance): boolean {
  const shields = card.counters.shield ?? 0;
  if (shields <= 0) return false;
  if (shields > 1) card.counters.shield = shields - 1;
  else delete card.counters.shield;
  log(g, null, `${cardName(g, card)} perd un marqueur bouclier à la place.`);
  return true;
}

function changeLife(g: GameState, playerId: PlayerId, delta: number): void {
  if (delta === 0) return;
  if (lifeLocked(g, playerId)) {
    log(g, null, `Les points de vie de ${g.players[playerId]!.name} ne peuvent pas changer.`);
    return;
  }
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

/** Jetons prédéfinis (Treasure, Food, Clue, Blood) créés sous le contrôle du joueur. */
function createNamedTokens(g: GameState, owner: PlayerState, name: string, n: number, tapped: boolean): void {
  if (n <= 0) return;
  const id = `token:${name}`;
  g.cardData[id] ??= {
    id,
    oracleId: id,
    name,
    manaCost: "",
    manaValue: 0,
    typeLine: `Token Artifact — ${name}`,
    oracleText: NAMED_TOKENS[name] ?? "",
    colors: [],
    colorIdentity: [],
    keywords: [],
    commanderLegality: "legal",
    set: "tok",
    collectorNumber: "0",
  };
  for (let i = 0; i < n; i++) {
    const instance = newInstance(g, id, owner.id, "battlefield");
    instance.isToken = true;
    instance.tapped = tapped;
    owner.zones.battlefield.push(instance.instanceId);
    emitEnters(g, instance);
  }
  log(g, null, `${owner.name} crée ${n > 1 ? `${n} jetons` : "un jeton"} ${name}.`);
}

/** Applique les effets reconnus d'un sort qui se résout. Les cibles devenues invalides sont ignorées. */
function applySpellEffects(g: GameState, source: CardInstance, effects: Effect[], targets: Target[], legal: boolean[]): void {
  const caster = g.players[source.controllerId]!;
  const x = source.xValue ?? 0;
  const ability = source.ability;
  const sourceName = ability?.sourceName ?? cardName(g, source);
  const eventAmount = ability?.eventAmount ?? 0;
  const eventPlayer = ability?.eventPlayerId ? g.players[ability.eventPlayerId] : undefined;
  // D'où viennent les blessures : un éphémère ou un rituel, ou un permanent (pour les effets qui les modifient).
  const damageFrom: DamageSource = {
    controllerId: caster.id,
    spell: !ability && /\b(Instant|Sorcery)\b/.test(currentTypeLine(g, source)),
    combat: false,
    colors: g.cardData[source.cardId]?.colors ?? [],
    // Le permanent qui inflige les blessures (capacité d'une créature : Keen Sense).
    sourceId: ability ? ability.sourceId : source.instanceId,
  };
  let dealt = 0;
  const given = () =>
    Object.values(g.cards).filter((c) => c.zone === "battlefield" && c.ownerId === caster.id && opponentsOf(g, caster.id).some((p) => p.id === c.controllerId)).length;
  let lost = 0;
  // Dévotion au noir : les {B} des coûts des permanents qu'on contrôle (hybrides compris).
  const devotion = () =>
    caster.zones.battlefield
      .map((id) => g.cards[id]!)
      .filter((c) => !c.faceDown)
      .reduce((n, c) => {
        const data = g.cardData[c.cardId];
        const cost = data?.faces?.[c.faceIndex]?.manaCost || data?.manaCost || "";
        return n + [...cost.matchAll(/\{([^}]+)\}/g)].filter((m) => m[1]!.toUpperCase().split("/").includes("B")).length;
      }, 0);
  const amountOf = (a: Parameters<typeof resolveAmount>[0]) =>
    resolveAmount(a, x, eventAmount, {
      dealt,
      lost,
      hand: caster.zones.hand.length,
      given: a === "given" ? given() : 0,
      devotion: a === "devotion" || a === "-devotion" ? devotion() : 0,
      count: (filter, all) => (all ? allMatching(filter) : controlledMatching(filter)).length,
      quantity: (q) => {
        if ("greatest" in q) return Math.max(0, ...allMatching(q.filter).filter((c) => isCreature(g, c)).map((c) => creatureStats(g, c)[q.greatest]));
        if (q.of === "self") return self ? Math.max(0, creatureStats(g, self)[q.stat]) : 0;
        return Math.max(0, statsAtStart[q.of]?.[q.stat] ?? 0);
      },
    });
  // Force et endurance des cibles au début de la résolution (« Exile target creature. Its controller gains life equal to its power. »).
  const statsAtStart = targets.map((t, i) => {
    const c = legal[i] && t.kind === "card" ? g.cards[t.id] : undefined;
    return c && c.zone === "battlefield" && isCreature(g, c) ? creatureStats(g, c) : undefined;
  });
  const controlledMatching = (filter: PermanentFilter) => caster.zones.battlefield.map((id) => g.cards[id]!).filter((c) => matchesPermanent(g, c, { ...filter, controller: "you" }, caster.id));
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
  const destroy = (c: CardInstance): boolean => {
    if (hasKeyword(g, c, "Indestructible")) {
      log(g, null, `${cardName(g, c)} est indestructible.`);
      return false;
    }
    if (useShield(g, c)) return false;
    const name = cardName(g, c);
    moveCardTo(g, c.instanceId, "graveyard", "top");
    log(g, null, `${name} est détruit(e).`);
    return true;
  };
  const allMatching = (filter: Parameters<typeof matchesPermanent>[2]) =>
    g.turnOrder
      .flatMap((id) => g.players[id]!.zones.battlefield)
      .map((id) => g.cards[id]!)
      .filter((c) => matchesPermanent(g, c, filter, caster.id));

  const makeTokens = (token: TokenSpec, owners: PlayerState[], n: number, tapped: boolean, combat: { attacking?: boolean; exileEndOfCombat?: boolean } = {}) => {
    const power = token.power === "X" ? String(x) : token.power;
    const toughness = token.toughness === "X" ? String(x) : token.toughness;
    const kind = token.subtypes.join(" ") || "Créature";
    const name = token.name ?? kind;
    const id = `token:${power}/${toughness}:${token.colors.join("")}:${name}:${token.keywords.join(",")}:${token.artifact ? "a" : ""}${token.legendary ? ":l" : ""}`;
    g.cardData[id] ??= {
      id,
      oracleId: id,
      name,
      manaCost: "",
      manaValue: 0,
      typeLine: `${token.legendary ? "Legendary " : ""}Token ${token.artifact ? "Artifact " : ""}Creature — ${kind}`,
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
    for (const owner of owners) {
      for (let i = 0; i < n; i++) {
        const instance = newInstance(g, id, owner.id, "battlefield");
        instance.isToken = true;
        instance.tapped = tapped;
        instance.summoningSick = true;
        owner.zones.battlefield.push(instance.instanceId);
        // « Enters tapped and attacking » : attaque sans avoir été déclaré attaquant (pas de déclencheur « attacks »).
        const defender = combat.attacking ? attackDefender(g, self?.instanceId, owner.id) : undefined;
        if (defender && g.combat) g.combat.attackers[instance.instanceId] = defender;
        if (combat.exileEndOfCombat && g.combat) (g.endOfCombatExile ??= []).push(instance.instanceId);
        emitEnters(g, instance);
      }
      if (n > 0) log(g, null, `${owner.name} crée ${n > 1 ? `${n} jetons` : "un jeton"} ${name} ${power}/${toughness}${combat.attacking && g.combat ? ", engagé(s) et attaquant(s)" : ""}.`);
    }
  };
  // Ephemerate : « Exile target creature you control, then return it… » (la carte exilée par ce sort).
  let lastExiled: { id: CardInstanceId; zone: Zone } | undefined;
  for (const effect of effects) {
    if (effect.ifControls && controlledMatching(effect.ifControls.filter).length < effect.ifControls.atLeast) continue;
    // Addendum : le sort se résout dans l'étape où il a été lancé ; une phase principale de son lanceur.
    if (effect.ifMainPhase && !(isActivePlayer(g, caster.id) && (g.turn.step === "main1" || g.turn.step === "main2"))) continue;
    switch (effect.type) {
      case "draw":
        for (const p of whoOf(effect.who)) drawCards(g, p, amountOf(effect.count));
        break;
      case "destroy": {
        const c = card(effect.target);
        if (c) destroy(c);
        break;
      }
      case "destroyAll": {
        let destroyed = 0;
        for (const c of allMatching(effect.filter)) if (destroy(c)) destroyed++;
        if (effect.countersOnSelf && self?.zone === "battlefield" && destroyed > 0) {
          self.counters["+1/+1"] = (self.counters["+1/+1"] ?? 0) + destroyed;
          log(g, null, `${cardName(g, self)} reçoit ${plural(destroyed, "marqueur +1/+1", "marqueurs +1/+1")}.`);
        }
        break;
      }
      case "livingDeath": {
        const players = g.turnOrder.map((id) => g.players[id]!).filter((p) => !p.hasConceded);
        const exiled = new Map<PlayerId, CardInstanceId[]>();
        for (const p of players) {
          const ids = p.zones.graveyard.filter((id) => /\bCreature\b/.test(g.cardData[g.cards[id]!.cardId]?.faces?.[0]?.typeLine ?? g.cardData[g.cards[id]!.cardId]?.typeLine ?? ""));
          exiled.set(p.id, ids.map((id) => moveCardTo(g, id, "exile", "top").instanceId));
        }
        for (const p of players) for (const id of [...p.zones.battlefield]) if (isCreature(g, g.cards[id]!)) sacrificePermanent(g, g.cards[id]!);
        for (const p of players) for (const id of exiled.get(p.id) ?? []) if (g.cards[id]?.zone === "exile") moveCardTo(g, id, "battlefield", "top", { controllerId: p.id });
        log(g, null, "Living Death : les créatures des cimetières remplacent celles du champ de bataille.");
        break;
      }
      case "graveyardToBottom":
        for (const p of whoOf(effect.who)) {
          const ids = [...p.zones.graveyard];
          g.rngState = shuffleInPlace(ids, g.rngState);
          for (const id of ids) moveCardTo(g, id, "library", "bottom");
          log(g, null, `${p.name} met ${plural(ids.length, "carte")} de son cimetière au-dessous de sa bibliothèque.`);
        }
        break;
      case "revealLandRestGraveyard": {
        const top = caster.zones.library.slice(0, effect.count);
        for (const id of top) addRevealed(g.cards[id]!, g.turnOrder);
        const chosen = source.choices?.[effects.indexOf(effect)] ?? [];
        for (const id of top) {
          const c = g.cards[id];
          if (!c || c.zone !== "library") continue;
          if (chosen.includes(id)) moveCardTo(g, id, "battlefield", "top", { controllerId: caster.id });
          else moveCardTo(g, id, "graveyard", "top");
        }
        log(g, null, `${caster.name} révèle ${plural(top.length, "carte")}, met ${chosen.length > 0 ? "un terrain sur le champ de bataille" : "aucun terrain en jeu"} et le reste au cimetière.`);
        break;
      }
      case "randomSacrificeLoop": {
        const victim = player(effect.player);
        if (!victim) break;
        for (let i = 0; i < 1000 && victim.zones.battlefield.length > 0; i++) {
          const r = nextRandom(g.rngState);
          g.rngState = r.state;
          const c = g.cards[victim.zones.battlefield[Math.floor(r.value * victim.zones.battlefield.length)]!]!;
          const land = /\bLand\b/.test(currentTypeLine(g, c));
          const name = cardName(g, c);
          sacrificePermanent(g, c);
          log(g, null, `${victim.name} sacrifie ${name} (au hasard).`);
          if (land) break;
        }
        break;
      }
      case "exileEventCard": {
        const id = ability?.eventCardId;
        const c = id ? g.cards[id] : undefined;
        if (c && c.zone === (ability?.eventZone ?? "graveyard")) {
          moveCardTo(g, c.instanceId, "exile", "top");
          log(g, null, `${cardName(g, c)} est exilé(e).`);
        }
        break;
      }
      case "shuffleEventCard": {
        const id = ability?.eventCardId;
        const c = id ? g.cards[id] : undefined;
        if (!c || c.zone !== (ability?.eventZone ?? "graveyard")) break;
        const owner = g.players[c.ownerId]!;
        const name = cardName(g, c);
        moveCardTo(g, c.instanceId, "library", "top");
        shuffleLibrary(g, owner);
        log(g, null, `${owner.name} mélange ${name} dans sa bibliothèque.`);
        break;
      }
      case "handToTop": {
        const chosen = (source.choices?.[effects.indexOf(effect)] ?? []).filter((id) => g.cards[id]?.zone === "hand");
        // Le premier choisi finit sur le dessus.
        for (const id of [...chosen].reverse()) moveCardTo(g, id, "library", "top");
        log(g, null, `${caster.name} met ${plural(chosen.length, "carte")} de sa main sur le dessus de sa bibliothèque.`);
        break;
      }
      case "chooseDrawn":
        break;
      case "payLifeOrTop": {
        const index = effects.indexOf(effect);
        const chosen = (source.choices?.[index - 1] ?? []).filter((id) => g.cards[id]?.zone === "hand");
        const kept = (source.choices?.[index] ?? []).filter((id) => chosen.includes(id));
        if (kept.length > 0) {
          payLife(g, caster, effect.life * kept.length);
          log(g, null, `${caster.name} paie ${effect.life * kept.length} points de vie pour garder ${plural(kept.length, "carte")}.`);
        }
        const back = chosen.filter((id) => !kept.includes(id));
        // La première choisie finit sur le dessus.
        for (const id of [...back].reverse()) moveCardTo(g, id, "library", "top");
        if (back.length > 0) log(g, null, `${caster.name} remet ${plural(back.length, "carte")} sur le dessus de sa bibliothèque.`);
        break;
      }
      case "searchSharingType": {
        const [id] = source.choices?.[effects.indexOf(effect)] ?? [];
        const c = id ? g.cards[id] : undefined;
        if (c && c.zone === "library") {
          const entered = moveCardTo(g, c.instanceId, "battlefield", "top", { controllerId: caster.id });
          log(g, null, `${caster.name} cherche ${cardName(g, entered)} et le met sur le champ de bataille.`);
        } else log(g, null, `${caster.name} ne trouve aucune créature.`);
        shuffleLibrary(g, caster);
        break;
      }
      case "sacrificeOneReveal": {
        const [id] = source.choices?.[effects.indexOf(effect)] ?? [];
        const victim = id ? g.cards[id] : undefined;
        if (!victim || victim.zone !== "battlefield" || victim.controllerId !== caster.id) break;
        const vData = g.cardData[victim.cardId];
        const vFace = vData?.faces?.[victim.faceIndex] ?? vData;
        const victimName = cardName(g, victim);
        sacrificePermanent(g, victim);
        log(g, null, `${caster.name} sacrifie ${victimName}.`);
        const revealed: CardInstanceId[] = [];
        let hit: CardInstanceId | undefined;
        for (const libId of [...caster.zones.library]) {
          revealed.push(libId);
          addRevealed(g.cards[libId]!, g.turnOrder);
          const d = g.cardData[g.cards[libId]!.cardId];
          const f = d?.faces?.[0] ?? d;
          if (f && vFace && /\bCreature\b/.test(f.typeLine) && sharesCreatureType({ typeLine: f.typeLine, oracleText: f.oracleText ?? "" }, { typeLine: vFace.typeLine, oracleText: vFace.oracleText ?? "" })) {
            hit = libId;
            break;
          }
        }
        if (hit) {
          const entered = moveCardTo(g, hit, "battlefield", "top", { controllerId: caster.id });
          log(g, null, `${caster.name} révèle ${plural(revealed.length, "carte")} et met ${cardName(g, entered)} sur le champ de bataille.`);
        } else log(g, null, `${caster.name} révèle toute sa bibliothèque sans trouver de créature du même type.`);
        const rest = revealed.filter((x) => x !== hit && g.cards[x]?.zone === "library");
        g.rngState = shuffleInPlace(rest, g.rngState);
        for (const x of rest) moveCardTo(g, x, "library", "bottom");
        break;
      }
      case "returnCards": {
        const chosen = (source.choices?.[effects.indexOf(effect)] ?? []).filter((id) => g.cards[id]?.zone === "graveyard" && g.cards[id]!.ownerId === caster.id);
        const names: string[] = [];
        for (const id of chosen) {
          const entered = moveCardTo(g, id, "battlefield", "top", { controllerId: caster.id });
          if (effect.sacrificeAtEnd) entered.grantedTriggers = [...(entered.grantedTriggers ?? []), "At the beginning of each end step, sacrifice this permanent."];
          names.push(cardName(g, entered));
        }
        log(g, null, names.length > 0 ? `${caster.name} remet ${names.join(", ")} de son cimetière sur le champ de bataille.` : `${caster.name} ne remet aucune créature sur le champ de bataille.`);
        break;
      }
      case "putFromHand": {
        const chosen = source.choices?.[effects.indexOf(effect)] ?? [];
        // Shadowfax : le défenseur est fixé avant que les créatures n'arrivent.
        const defender = effect.attacking ? attackDefender(g, self?.instanceId, caster.id) : undefined;
        for (const id of effect.any ? chosen : chosen.slice(0, 1)) {
          const c = g.cards[id];
          if (!c || c.zone !== "hand") continue;
          const entered = moveCardTo(g, c.instanceId, "battlefield", "top", { controllerId: caster.id });
          if (effect.haste) entered.grants = [...new Set([...(entered.grants ?? []), "haste"])];
          if (effect.sacrificeAtEnd) entered.grantedTriggers = [...(entered.grantedTriggers ?? []), "At the beginning of your end step, sacrifice this permanent."];
          if (effect.attacking) entered.tapped = true;
          if (defender && g.combat && entered.zone === "battlefield") g.combat.attackers[entered.instanceId] = defender;
          const how = effect.haste ? " avec la célérité" : defender && g.combat ? `, engagé(e) et attaquant ${g.players[defender]!.name}` : effect.attacking ? ", engagé(e)" : "";
          log(g, null, `${caster.name} met ${cardName(g, entered)} sur le champ de bataille${how}.`);
        }
        break;
      }
      case "extraLand": {
        const prev = caster.extraLands?.turn === g.turn.number ? caster.extraLands.count : 0;
        caster.extraLands = { turn: g.turn.number, count: prev + effect.count };
        log(g, null, `${caster.name} peut jouer ${effect.count === 1 ? "un terrain supplémentaire" : `${effect.count} terrains supplémentaires`} ce tour-ci.`);
        break;
      }
      case "playFromGraveyard": {
        const c = card(effect.target);
        if (!c || c.zone !== "graveyard") break;
        c.castPermission = { free: true, turn: g.turn.number, ignoreTiming: true, reason: "Horde of Notions" };
        log(g, null, `${caster.name} peut jouer ${cardName(g, c)} depuis son cimetière sans payer son coût ce tour-ci.`);
        break;
      }
      case "graveyardPlayable": {
        // Seules les cartes déjà au cimetière à la résolution sont concernées (règle 611.2c).
        const spec = { label: graveyardLabel(effect.filter), graveyard: effect.filter };
        const names: string[] = [];
        for (const id of caster.zones.graveyard) {
          const c = g.cards[id]!;
          if (!isLegalTarget(g, spec, { kind: "card", id }, caster.id)) continue;
          if (!effect.lands && /\bLand\b/.test(faceTypeLine(g, c, 0))) continue;
          c.castPermission = { free: false, turn: g.turn.number, reason: `${sourceName}, depuis le cimetière`, ...(effect.lands ? { lands: true } : {}) };
          names.push(cardName(g, c));
        }
        log(g, null, names.length > 0 ? `${caster.name} peut ${effect.lands ? "jouer" : "lancer"} ce tour-ci depuis son cimetière : ${names.join(", ")}.` : `${caster.name} n'a aucune carte concernée dans son cimetière.`);
        break;
      }
      case "exile":
      case "bounce": {
        const c = card(effect.target);
        if (!c) break;
        const name = cardName(g, c);
        const moved = moveCardTo(g, c.instanceId, effect.type === "exile" ? "exile" : "hand", "top");
        if (effect.type === "exile") lastExiled = { id: moved.instanceId, zone: "exile" };
        if (effect.type === "exile" && effect.untilMonarch && !moved.isToken && moved.zone === "exile") {
          moved.exiledUntilMonarch = caster.id;
          log(g, null, `${name} reviendra quand un adversaire de ${caster.name} deviendra le monarque.`);
        }
        if (effect.type === "exile" && effect.returnAtEnd && !moved.isToken) {
          (g.delayedReturns ??= []).push({ cardId: moved.instanceId, playerId: moved.ownerId });
          log(g, null, `${name} reviendra au début de la prochaine étape de fin de ${g.players[moved.ownerId]!.name}.`);
        }
        log(g, null, effect.type === "exile" ? `${name} est exilé(e).` : `${name} retourne dans la main de son propriétaire.`);
        break;
      }
      case "bounceAll":
        for (const c of allMatching(effect.filter)) {
          const name = cardName(g, c);
          moveCardTo(g, c.instanceId, "hand", "top");
          log(g, null, `${name} retourne dans la main de son propriétaire.`);
        }
        break;
      case "exileAll":
        for (const c of allMatching(effect.filter)) {
          const name = cardName(g, c);
          moveCardTo(g, c.instanceId, "exile", "top");
          log(g, null, `${name} est exilé(e).`);
        }
        break;
      case "phaseOut": {
        const c = card(effect.target);
        if (c?.zone === "battlefield") phaseOut(g, [c]);
        break;
      }
      case "phaseOutAll":
        phaseOut(g, allMatching(effect.filter));
        break;
      case "playerUntilNextTurn": {
        const shield = (caster.untilNextTurn ??= {});
        if (effect.lifeCantChange) shield.lifeCantChange = true;
        if (effect.protection) shield.protection = true;
        const parts = [effect.lifeCantChange ? "ses points de vie ne peuvent pas changer" : "", effect.protection ? "il a la protection contre tout" : ""].filter(Boolean);
        log(g, null, `Jusqu'au prochain tour de ${caster.name}, ${parts.join(" et ")}.`);
        break;
      }
      case "damage":
        if (effect.target === "event") {
          if (eventPlayer && !eventPlayer.hasConceded) dealt += dealDamage(g, sourceName, { kind: "player", id: eventPlayer.id }, amountOf(effect.amount), damageFrom);
        } else if (effect.target === "you") {
          dealt += dealDamage(g, sourceName, { kind: "player", id: caster.id }, amountOf(effect.amount), damageFrom);
        } else if (effect.target === "eventCard") {
          // Storm : la créature de l'événement, si elle est toujours là.
          const victim = ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
          if (victim?.zone === "battlefield") dealt += dealDamage(g, sourceName, { kind: "card", id: victim.instanceId }, amountOf(effect.amount), damageFrom);
        } else if (legal[effect.target]) dealt += dealDamage(g, sourceName, targets[effect.target]!, amountOf(effect.amount), damageFrom);
        break;
      case "damageEach": {
        const n = amountOf(effect.amount);
        if (effect.who === "creatures" || effect.who === "yourOtherCreatures") {
          const others = effect.who === "yourOtherCreatures";
          for (const c of allMatching({ types: ["creature"], notTypes: [] })) {
            if (others && (c.controllerId !== caster.id || c.instanceId === ability?.sourceId)) continue;
            dealt += dealDamage(g, sourceName, { kind: "card", id: c.instanceId }, n, damageFrom);
          }
        } else {
          const players = effect.who === "opponents" ? opponentsOf(g, caster.id) : g.turnOrder.map((id) => g.players[id]!).filter((p) => !p.hasConceded);
          for (const p of players) dealt += dealDamage(g, sourceName, { kind: "player", id: p.id }, n, damageFrom);
        }
        break;
      }
      case "life": {
        // « the life they lost this turn » : relevé pour chacun avant d'appliquer les pertes.
        const amounts = whoOf(effect.who).map((p) => ({
          p,
          n: effect.amount === "-lostThisTurn" ? -(p.lifeLost?.turn === g.turn.number ? p.lifeLost.amount : 0) : amountOf(effect.amount),
        }));
        for (const { p, n } of amounts) {
          changeLife(g, p.id, n);
          if (n < 0) lost += -n;
        }
        break;
      }
      case "wheelHand": {
        for (const p of whoOf(effect.who)) {
          const n = p.zones.hand.length;
          for (const id of [...p.zones.hand]) moveCardTo(g, id, "library", "bottom");
          log(g, null, `${p.name} met ${plural(n, "carte")} de sa main au-dessous de sa bibliothèque.`);
          drawCards(g, p, n);
        }
        break;
      }
      case "scry":
        // Déjà fait avant la résolution (voir startScry).
        break;
      case "returnEventCard": {
        const id = ability?.eventCardId ?? lastExiled?.id;
        const back = id ? g.cards[id] : undefined;
        // La carte doit être restée là où l'événement l'a mise (sinon c'est un nouvel objet, règle 400.7).
        if (!back || back.zone !== (ability?.eventCardId ? ability.eventZone : lastExiled?.zone) || back.ability) break;
        const controllerId = effect.owner ? back.ownerId : caster.id;
        moveCardTo(g, back.instanceId, "battlefield", "top", { controllerId, tapped: effect.tapped });
        log(g, null, `${cardName(g, back)} revient sur le champ de bataille${effect.tapped ? " engagé(e)" : ""} sous le contrôle de ${g.players[controllerId]!.name}.`);
        break;
      }
      case "search": {
        const chosen = source.choices?.[effects.indexOf(effect)] ?? [];
        const finder = effect.who ? (whoOf(effect.who)[0] ?? caster) : caster;
        for (const id of chosen) {
          const c = g.cards[id];
          if (!c || c.zone !== "library") continue;
          const name = cardName(g, c);
          const owner = g.players[c.ownerId]!;
          if (effect.to === "hand" || (effect.split && id !== chosen[0])) moveCardTo(g, id, "hand", "top");
          else moveCardTo(g, id, "battlefield", "top", { controllerId: owner.id, tapped: effect.tapped ?? false });
          log(g, null, `${owner.name} ${effect.reveal || effect.to === "battlefield" ? `prend ${name}` : "prend une carte"} dans sa bibliothèque.`);
        }
        if (chosen.length === 0) log(g, null, `${finder.name} ne prend aucune carte dans sa bibliothèque.`);
        break;
      }
      case "shuffle": {
        const who = effect.who ? (whoOf(effect.who)[0] ?? caster) : caster;
        shuffleLibrary(g, who);
        log(g, null, `${who.name} mélange sa bibliothèque.`);
        break;
      }
      case "revealHand":
        for (const p of whoOf(effect.who)) {
          for (const id of p.zones.hand) addRevealed(g.cards[id]!, g.turnOrder);
          log(g, null, `${p.name} révèle sa main : ${p.zones.hand.map((id) => cardName(g, g.cards[id]!)).join(", ") || "aucune carte"}.`);
        }
        break;
      case "chooseDiscard": {
        const chosen = source.choices?.[effects.indexOf(effect)] ?? [];
        for (const id of chosen) {
          const c = g.cards[id];
          if (!c || c.zone !== "hand") continue;
          const name = cardName(g, c);
          moveCardTo(g, id, "graveyard", "top");
          log(g, null, `${g.players[c.ownerId]!.name} défausse ${name}.`);
        }
        break;
      }
      case "sacrificeSelf": {
        const self2 = ability ? g.cards[ability.sourceId] : undefined;
        if (self2?.zone === "battlefield") {
          const name = cardName(g, self2);
          const victim = self2.controllerId;
          sacrificePermanent(g, self2);
          log(g, null, `${g.players[victim]?.name ?? caster.name} sacrifie ${name}.`);
          // Bronze Bombshell : « If the player does, ~ deals 7 damage to the player. »
          if (effect.thenDamage) dealt += dealDamage(g, name, { kind: "player", id: victim }, effect.thenDamage, damageFrom);
        }
        break;
      }
      case "discardHand":
        for (const p of whoOf(effect.who)) {
          const n = p.zones.hand.length;
          for (const id of [...p.zones.hand]) moveCardTo(g, id, "graveyard", "top");
          if (n > 0) log(g, null, `${p.name} défausse sa main (${plural(n, "carte")}).`);
        }
        break;
      case "coinFlipDamage": {
        const r = nextRandom(g.rngState);
        g.rngState = r.state;
        const won = r.value < 0.5;
        log(g, null, `${caster.name} lance une pièce pour ${sourceName} : ${won ? "gagné" : "perdu"}.`);
        if (!won) dealt += dealDamage(g, sourceName, { kind: "player", id: caster.id }, effect.amount, damageFrom);
        break;
      }
      case "shuffleSelfAndGraveyard": {
        const self2 = ability ? g.cards[ability.sourceId] : undefined;
        const owner = self2 ? g.players[self2.ownerId]! : caster;
        if (self2 && (self2.zone === "battlefield" || self2.zone === "graveyard")) moveCardTo(g, self2.instanceId, "library", "top");
        for (const id of [...owner.zones.graveyard]) moveCardTo(g, id, "library", "top");
        shuffleLibrary(g, owner);
        log(g, null, `${owner.name} mélange son cimetière dans sa bibliothèque.`);
        break;
      }
      case "exileGraveyards":
        for (const id of g.turnOrder) {
          const p = g.players[id]!;
          for (const cid of [...p.zones.graveyard]) moveCardTo(g, cid, "exile", "top");
        }
        log(g, null, "Tous les cimetières sont exilés.");
        break;
      case "mill":
        for (const p of whoOf(effect.who)) {
          const n = effect.count === "theirHand" ? p.zones.hand.length : amountOf(effect.count);
          let milled = 0;
          for (let i = 0; i < n && p.zones.library.length > 0; i++) {
            moveCardTo(g, p.zones.library[0]!, "graveyard", "top");
            milled++;
          }
          log(g, null, `${p.name} meule ${plural(milled, "carte")}.`);
        }
        break;
      case "untapLands": {
        const lands = caster.zones.battlefield
          .map((id) => g.cards[id]!)
          .filter((c) => c.tapped && /\bLand\b/.test(currentTypeLine(g, c)))
          .slice(0, effect.count);
        for (const c of lands) untap(g, c);
        if (lands.length > 0) log(g, null, `${caster.name} dégage ${lands.map((c) => cardName(g, c)).join(", ")}.`);
        break;
      }
      case "fromGraveyard": {
        const c = card(effect.target);
        if (!c || c.zone !== "graveyard") break;
        const name = cardName(g, c);
        if (effect.to === "libraryTop") {
          moveCardTo(g, c.instanceId, "library", "top");
          log(g, null, `${name} est mise sur le dessus de la bibliothèque de ${g.players[c.ownerId]!.name}.`);
        } else if (effect.to === "hand") {
          moveCardTo(g, c.instanceId, "hand", "top");
          log(g, null, `${name} retourne dans la main de ${g.players[c.ownerId]!.name}.`);
        } else {
          moveCardTo(g, c.instanceId, "battlefield", "top", { controllerId: caster.id });
          log(g, null, `${name} arrive sur le champ de bataille sous le contrôle de ${caster.name}.`);
        }
        break;
      }
      case "namedToken": {
        const n = amountOf(effect.count);
        for (const owner of effect.who ? whoOf(effect.who) : [caster]) createNamedTokens(g, owner, effect.name, n, effect.tapped);
        break;
      }
      case "manaBonus":
        (g.manaBonuses ??= []).push({ turn: g.turn.number, subtype: effect.subtype, mana: effect.mana as ManaType });
        log(g, null, `Jusqu'à la fin du tour, chaque ${effect.subtype} engagé pour du mana donne {${effect.mana}} en plus.`);
        break;
      case "monarch": {
        const [p] = effect.who === "you" ? [caster] : whoOf(effect.who);
        if (p) setMonarch(g, p.id);
        break;
      }
      case "grantTrigger": {
        const c = card(effect.target);
        if (!c || c.zone !== "battlefield") break;
        c.grantedTriggers = [...(c.grantedTriggers ?? []), effect.text];
        log(g, null, `${cardName(g, c)} gagne « ${effect.text} » jusqu'à la fin du tour.`);
        break;
      }
      case "keepOnePerPlayer": {
        const kept = new Set(source.choices?.[effects.indexOf(effect)] ?? []);
        for (const p of g.turnOrder.map((id) => g.players[id]!).filter((p) => !p.hasConceded)) {
          const doomed = p.zones.battlefield.map((id) => g.cards[id]!).filter((c) => isCreature(g, c) && !kept.has(c.instanceId));
          for (const c of doomed) sacrificePermanent(g, c);
          if (doomed.length > 0) log(g, null, `${p.name} sacrifie ${doomed.map((c) => cardName(g, c)).join(", ")}.`);
        }
        break;
      }
      case "extraUpkeep":
        g.turn.extraUpkeeps = (g.turn.extraUpkeeps ?? 0) + 1;
        log(g, null, `${g.players[g.turn.activePlayerId]!.name} aura une étape d'entretien supplémentaire.`);
        break;
      case "copyEventCard": {
        // Ashling : un jeton copie de l'Élémental sacrifié, avec la célérité, sacrifié à la fin du tour sauf paiement.
        // Cadric : une copie du permanent arrivé (ses données actuelles).
        const entered = ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        const dataId = ability?.eventDataId ?? (entered && !entered.faceDown ? entered.cardId : undefined);
        if (!dataId || !g.cardData[dataId]) break;
        const faceIndex = ability?.eventFaceIndex ?? entered?.faceIndex ?? 0;
        const copyId = effect.except ? copyDataWith(g, dataId, faceIndex, effect.except) : dataId;
        const instance = newInstance(g, copyId, caster.id, "battlefield");
        instance.faceIndex = copyId === dataId ? faceIndex : 0;
        instance.isToken = true;
        instance.summoningSick = true;
        if (effect.haste || effect.except?.haste) instance.grants = ["haste"];
        if (effect.endStepUnless) instance.grantedTriggers = [`At the beginning of your end step, sacrifice this permanent unless you pay ${effect.endStepUnless}.`];
        if (effect.sacrificeAtEnd) instance.grantedTriggers = ["At the beginning of each end step, sacrifice this permanent."];
        caster.zones.battlefield.push(instance.instanceId);
        emitEnters(g, instance);
        log(g, null, `${caster.name} crée un jeton copie de ${cardName(g, instance)}.`);
        break;
      }
      case "copyTarget": {
        // Ashling's Command : un jeton copie d'un permanent ciblé.
        const c = card(effect.target);
        if (!c || c.zone !== "battlefield") break;
        const instance = newInstance(g, c.cardId, caster.id, "battlefield");
        instance.faceIndex = c.faceIndex;
        instance.isToken = true;
        instance.summoningSick = true;
        caster.zones.battlefield.push(instance.instanceId);
        emitEnters(g, instance);
        log(g, null, `${caster.name} crée un jeton copie de ${cardName(g, c)}.`);
        break;
      }
      case "damageCreaturesOf": {
        const t = targets[effect.target];
        if (!t || t.kind !== "player" || !legal[effect.target]) break;
        const n = amountOf(effect.amount);
        for (const id of [...g.players[t.id]!.zones.battlefield]) {
          const c = g.cards[id]!;
          if (isCreature(g, c)) dealt += dealDamage(g, sourceName, { kind: "card", id }, n, damageFrom);
        }
        break;
      }
      case "shieldCounter": {
        const [id] = source.choices?.[effects.indexOf(effect)] ?? [];
        const c = id ? g.cards[id] : undefined;
        if (!c || c.zone !== "battlefield") break;
        c.counters.shield = (c.counters.shield ?? 0) + 1;
        log(g, null, `${cardName(g, c)} reçoit un marqueur bouclier.`);
        break;
      }
      case "copyToken": {
        const t = targets[effect.player];
        const self3 = ability ? g.cards[ability.sourceId] : undefined;
        if (!t || t.kind !== "player" || !self3) break;
        const owner = g.players[t.id]!;
        const instance = newInstance(g, self3.cardId, owner.id, "battlefield");
        instance.faceIndex = self3.faceIndex;
        instance.isToken = true;
        instance.summoningSick = true;
        owner.zones.battlefield.push(instance.instanceId);
        emitEnters(g, instance);
        log(g, null, `${owner.name} crée un jeton copie de ${cardName(g, self3)}.`);
        break;
      }
      case "shuffleIntoLibrary": {
        const c = card(effect.target);
        if (!c) break;
        const owner = g.players[c.ownerId]!;
        const name = cardName(g, c);
        moveCardTo(g, c.instanceId, "library", "top");
        g.rngState = shuffleInPlace(owner.zones.library, g.rngState);
        log(g, null, `${owner.name} mélange ${name} dans sa bibliothèque.`);
        if (!effect.revealPermanent) break;
        const topId = owner.zones.library[0];
        if (!topId) break;
        const top = g.cards[topId]!;
        addRevealed(top, g.turnOrder);
        const topName = cardName(g, top);
        const typeLine = g.cardData[top.cardId]?.faces?.[0]?.typeLine ?? g.cardData[top.cardId]?.typeLine ?? "";
        if (/\b(Artifact|Creature|Enchantment|Land|Planeswalker|Battle)\b/.test(typeLine)) {
          moveCardTo(g, topId, "battlefield", "top", { controllerId: owner.id });
          log(g, null, `${owner.name} révèle ${topName} et le met sur le champ de bataille.`);
        } else {
          log(g, null, `${owner.name} révèle ${topName} (pas un permanent).`);
        }
        break;
      }
      case "approach": {
        const name = cardName(g, source);
        const castCount = (caster.castNames ?? []).filter((n) => n === name).length;
        if (source.castFromHand && castCount >= 2) {
          const losers = opponentsOf(g, caster.id);
          for (const p of losers) p.lostReason = `${caster.name} gagne avec ${name}`;
          log(g, null, `${caster.name} gagne la partie grâce à ${name} !`);
          leaveGame(g, losers);
          break;
        }
        if (source.zone === "stack") {
          const owner = g.players[source.ownerId]!;
          moveCardTo(g, source.instanceId, "library", Math.min(effect.position - 1, owner.zones.library.length));
          log(g, null, `${name} va en ${effect.position}e position de la bibliothèque de ${owner.name}.`);
        }
        changeLife(g, caster.id, effect.life);
        break;
      }
      case "drawIfNeither": {
        const a = card(effect.a);
        const b = card(effect.b);
        if (a?.controllerId === caster.id || b?.controllerId === caster.id) break;
        drawCards(g, caster, effect.count);
        break;
      }
      case "loseLifeManaValue": {
        const t = targets[effect.target];
        const target = t?.kind === "card" ? g.cards[t.id] : undefined;
        const mv = target ? (g.cardData[target.cardId]?.manaValue ?? 0) : 0;
        if (mv > 0) changeLife(g, caster.id, -mv);
        break;
      }
      case "halfLibraryHalfLife": {
        for (const p of whoOf(effect.who)) {
          drawCards(g, p, Math.ceil(p.zones.library.length / 2));
          const loss = Math.ceil(Math.max(0, p.life) / 2);
          if (loss > 0) changeLife(g, p.id, -loss);
        }
        break;
      }
      case "goad": {
        let power = 0;
        const seen = new Set<PlayerId>();
        for (const i of effect.targets) {
          const c = card(i);
          if (!c || c.zone !== "battlefield" || c.controllerId === caster.id || seen.has(c.controllerId)) continue;
          seen.add(c.controllerId);
          c.goadedBy = [...new Set([...(c.goadedBy ?? []), caster.id])];
          power += Math.max(0, creatureStats(g, c).power);
          log(g, null, `${cardName(g, c)} est provoqué(e) par ${caster.name}.`);
        }
        if (effect.countersFromPower && self?.zone === "battlefield" && power > 0) {
          self.counters["+1/+1"] = (self.counters["+1/+1"] ?? 0) + power;
          log(g, null, `${cardName(g, self)} reçoit ${plural(power, "marqueur +1/+1", "marqueurs +1/+1")}.`);
        }
        break;
      }
      case "myriad": {
        const attacker = ability ? g.cards[ability.sourceId] : undefined;
        const defending = attacker ? g.combat?.attackers[attacker.instanceId] : undefined;
        if (!attacker || attacker.zone !== "battlefield" || !defending || !g.combat) break;
        for (const opponent of opponentsOf(g, caster.id)) {
          if (opponent.id === defending) continue;
          const token = newInstance(g, attacker.cardId, caster.id, "battlefield");
          token.faceIndex = attacker.faceIndex;
          token.isToken = true;
          token.tapped = true;
          caster.zones.battlefield.push(token.instanceId);
          g.combat.attackers[token.instanceId] = opponent.id;
          (g.endOfCombatExile ??= []).push(token.instanceId);
          emitEnters(g, token);
          log(g, null, `Myriade : un jeton copie de ${cardName(g, attacker)} attaque ${opponent.name}.`);
        }
        break;
      }
      case "encore": {
        const dataId = source.cardId;
        for (const opponent of opponentsOf(g, caster.id)) {
          const instance = newInstance(g, dataId, caster.id, "battlefield");
          instance.faceIndex = source.faceIndex;
          instance.isToken = true;
          instance.summoningSick = true;
          instance.grants = ["haste"];
          instance.grantedTriggers = ["At the beginning of your end step, sacrifice this permanent."];
          caster.zones.battlefield.push(instance.instanceId);
          emitEnters(g, instance);
          log(g, null, `${caster.name} crée un jeton copie de ${cardName(g, instance)} qui doit attaquer ${opponent.name} ce tour-ci.`);
        }
        break;
      }
      case "cascade": {
        // Jodah : la valeur de mana du sort lancé (X compris), notée au lancement.
        const spellId = effect.ofEvent ? ability?.eventCardId : ability?.sourceId;
        const spell = spellId ? g.cards[spellId] : undefined;
        const record = effect.ofEvent ? caster.castHistory?.spells.find((r) => r.cardId === spellId) : undefined;
        const mv = record ? record.manaValue : spell ? (g.cardData[spell.cardId]?.manaValue ?? 0) : 0;
        const exiled: CardInstanceId[] = [];
        let hit: CardInstance | undefined;
        while (caster.zones.library.length > 0) {
          const c = moveCardTo(g, caster.zones.library[0]!, "exile", "top");
          const d = g.cardData[c.cardId];
          const typeLine = d?.faces?.[0]?.typeLine ?? d?.typeLine ?? "";
          if (d && !/\bLand\b/.test(typeLine) && (!effect.legendary || /\bLegendary\b/.test(typeLine)) && d.manaValue < mv) {
            hit = c;
            break;
          }
          exiled.push(c.instanceId);
        }
        g.rngState = shuffleInPlace(exiled, g.rngState);
        for (const id of exiled) moveCardTo(g, id, "library", "bottom");
        if (hit) {
          const reason = effect.ofEvent ? sourceName : "cascade";
          hit.castPermission = { free: true, turn: g.turn.number, ignoreTiming: true, reason, ...(spell?.zone === "stack" ? { whileOnStack: spell.instanceId } : {}) };
          log(g, null, `${effect.ofEvent ? sourceName : "Cascade"} : ${caster.name} exile ${cardName(g, hit)} (et ${plural(exiled.length, "autre carte", "autres cartes")} mises dessous) et peut la lancer sans payer son coût.`);
        } else log(g, null, `${effect.ofEvent ? sourceName : "Cascade"} : aucune carte trouvée.`);
        break;
      }
      case "digTop": {
        const looked = caster.zones.library.slice(0, effect.count);
        const chosen = (source.choices?.[effects.indexOf(effect)] ?? []).filter((id) => looked.includes(id));
        const rest = looked.filter((id) => !chosen.includes(id));
        for (const id of chosen) moveCardTo(g, id, "hand", "top");
        if (effect.rest === "bottom") {
          for (const id of rest) moveCardTo(g, id, "library", "bottom");
        } else {
          for (const id of rest) moveCardTo(g, id, "graveyard", "top");
        }
        const where = effect.rest === "bottom" ? "au-dessous de sa bibliothèque" : "au cimetière";
        log(g, null, `${caster.name} ${effect.reveal ? "révèle" : "regarde"} ${plural(looked.length, "carte")} du dessus de sa bibliothèque, en prend ${chosen.length} et met le reste ${where}.`);
        if (effect.treasurePerRest) createNamedTokens(g, caster, "Treasure", rest.length, false);
        break;
      }
      case "exileTopEachCastFree": {
        const exiled: string[] = [];
        for (const pid of g.turnOrder) {
          const p = g.players[pid]!;
          if (p.hasConceded || p.zones.library.length === 0) continue;
          const c = moveCardTo(g, p.zones.library[0]!, "exile", "top");
          addRevealed(c, g.turnOrder);
          exiled.push(cardName(g, c));
          const d = g.cardData[c.cardId];
          if (d && !/\bLand\b/.test(d.faces?.[0]?.typeLine ?? d.typeLine)) {
            c.castPermission = { free: true, turn: g.turn.number, step: g.turn.step, ignoreTiming: true, reason: sourceName, caster: caster.id };
          }
        }
        log(g, null, `${sourceName} : ${exiled.length > 0 ? `${exiled.join(", ")} exilée(s)` : "aucune carte exilée"} ; ${caster.name} peut lancer gratuitement les sorts parmi elles pendant cette étape.`);
        break;
      }
      case "defenderSacrifices": {
        for (const id of source.choices?.[effects.indexOf(effect)] ?? []) {
          const c = g.cards[id];
          if (!c || c.zone !== "battlefield") continue;
          const name = cardName(g, c);
          const who = g.players[c.controllerId]!.name;
          sacrificePermanent(g, c);
          log(g, null, `${who} sacrifie ${name}.`);
        }
        break;
      }
      case "topLandOrHand": {
        const top = caster.zones.library[0];
        if (!top) break;
        const name = cardName(g, g.cards[top]!);
        if ((source.choices?.[effects.indexOf(effect)] ?? []).includes(top)) {
          moveCardTo(g, top, "battlefield", "top", { controllerId: caster.id, tapped: true });
          log(g, null, `${caster.name} met ${name} sur le champ de bataille engagé.`);
        } else {
          moveCardTo(g, top, "hand", "top");
          log(g, null, `${caster.name} met la carte du dessus de sa bibliothèque dans sa main.`);
        }
        break;
      }
      case "lookTopKeepOne": {
        const chosen = source.choices?.[effects.indexOf(effect)] ?? [];
        const entered = ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        const x = entered && entered.zone === "battlefield" ? Math.max(0, creatureStats(g, entered).power) : chosen.length;
        const looked = caster.zones.library.slice(0, x);
        const rest = looked.filter((id) => !chosen.includes(id));
        for (const id of rest) moveCardTo(g, id, "library", "bottom");
        log(g, null, `${caster.name} regarde ${plural(looked.length, "carte")} du dessus de sa bibliothèque et en met ${rest.length} dessous.`);
        break;
      }
      case "drawIfGreatestPower": {
        const entered = ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        if (!entered || entered.zone !== "battlefield" || !isCreature(g, entered)) break;
        const power = creatureStats(g, entered).power;
        const others = g.turnOrder
          .flatMap((id) => g.players[id]!.zones.battlefield)
          .map((id) => g.cards[id]!)
          .filter((c) => c.instanceId !== entered.instanceId && isCreature(g, c));
        if (others.every((c) => creatureStats(g, c).power < power)) drawCards(g, g.players[entered.controllerId]!, 1);
        else log(g, null, `${cardName(g, entered)} n'a pas la plus grande force : pas de pioche.`);
        break;
      }
      case "counterTarget":
      case "counterAll": {
        const list = effect.type === "counterTarget" ? [card(effect.target)].filter((c): c is CardInstance => !!c && c.zone === "battlefield") : allMatching(effect.filter);
        for (const c of list) c.counters[effect.kind] = (c.counters[effect.kind] ?? 0) + effect.count;
        if (list.length > 0) log(g, null, `${list.map((c) => cardName(g, c)).join(", ")} ${list.length > 1 ? "reçoivent" : "reçoit"} ${plural(effect.count, `marqueur ${effect.kind}`, `marqueurs ${effect.kind}`)}.`);
        break;
      }
      case "counterSelf": {
        if (!self || self.zone !== "battlefield") break;
        const value = Math.max(0, (self.counters[effect.kind] ?? 0) + effect.count);
        if (value === 0) delete self.counters[effect.kind];
        else self.counters[effect.kind] = value;
        const n = Math.abs(effect.count);
        log(g, null, `${cardName(g, self)} ${effect.count >= 0 ? "reçoit" : "perd"} ${plural(n, `marqueur ${effect.kind}`, `marqueurs ${effect.kind}`)}.`);
        break;
      }
      case "selfCounterDamage": {
        const n = self?.counters[effect.kind] ?? 0;
        if (self && n > 0) dealt += dealDamage(g, sourceName, { kind: "player", id: caster.id }, n, damageFrom);
        break;
      }
      case "untapSelf":
        if (self?.zone === "battlefield" && self.tapped) {
          untap(g, self);
          log(g, null, `${cardName(g, self)} se dégage.`);
        }
        break;
      case "tapSelf":
        if (self?.zone === "battlefield" && !self.tapped) {
          self.tapped = true;
          log(g, null, `${cardName(g, self)} s'engage.`);
        }
        break;
      case "token":
        makeTokens(effect.token, effect.forOpponents ? opponentsOf(g, caster.id) : [caster], amountOf(effect.count), effect.tapped, {
          ...(effect.attacking ? { attacking: true } : {}),
          ...(effect.exileEndOfCombat ? { exileEndOfCombat: true } : {}),
        });
        break;
      case "tokenForController": {
        const owner = legal[effect.target] ? controllers[effect.target] : undefined;
        if (owner && !g.players[owner]!.hasConceded) makeTokens(effect.token, [g.players[owner]!], 1, false);
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
      case "counterTriggering": {
        // Garde : le sort ou la capacité qui ciblait le permanent, s'il est encore sur la pile.
        const c = ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        if (!c || c.zone !== "stack") break;
        const name = c.ability ? `la capacité de ${c.ability.sourceName}` : cardName(g, c);
        if (!c.ability && /can't be countered/i.test(g.cardData[c.cardId]?.oracleText ?? "")) {
          log(g, null, `${name} ne peut pas être contré(e).`);
          break;
        }
        moveCardTo(g, c.instanceId, "graveyard", "top");
        log(g, null, `${name.charAt(0).toUpperCase()}${name.slice(1)} est contré(e) par la garde.`);
        break;
      }
      case "mana":
        for (const m of effect.mana) caster.manaPool[m as ManaType] += 1;
        log(g, null, `${caster.name} ajoute ${formatMana(effect.mana as ManaType[])}.`);
        break;
      case "manaAny": {
        const color = ability?.color ?? "B";
        const count =
          effect.count === "greatestPower"
            ? Math.max(0, ...caster.zones.battlefield.filter((id) => isCreature(g, g.cards[id]!)).map((id) => creatureStats(g, g.cards[id]!).power))
            : effect.count;
        caster.manaPool[color] += count;
        log(g, null, `${caster.name} ajoute ${formatMana(Array(count).fill(color))}.`);
        break;
      }
      case "returnSelf": {
        if (!self || self.zone !== "graveyard") break;
        const name = cardName(g, self);
        moveCardTo(g, self.instanceId, "hand", "top");
        log(g, null, `${name} retourne du cimetière dans la main de ${g.players[self.ownerId]!.name}.`);
        break;
      }
      case "counterEvent": {
        const c = ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        if (!c || c.zone !== "battlefield") break;
        c.counters[effect.kind] = (c.counters[effect.kind] ?? 0) + effect.count;
        log(g, null, `${cardName(g, c)} reçoit ${plural(effect.count, `marqueur ${effect.kind}`, `marqueurs ${effect.kind}`)}.`);
        break;
      }
      case "shareKeywords": {
        // Odric : les mots-clés sont vérifiés à la résolution, puis donnés à toutes les créatures du contrôleur.
        const mine = caster.zones.battlefield.map((id) => g.cards[id]!).filter((c) => !c.faceDown && isCreature(g, c));
        const shared = effect.keywords.filter((k) => mine.some((c) => hasKeyword(g, c, (k.charAt(0).toUpperCase() + k.slice(1)) as CombatKeyword)));
        for (const c of mine) c.grants = [...new Set([...(c.grants ?? []), ...shared])];
        const label = shared.map((k) => KEYWORD_HELP[k]?.name.toLowerCase() ?? k).join(", ");
        log(g, null, shared.length > 0 ? `Les créatures de ${caster.name} gagnent ${label} jusqu'à la fin du tour.` : `Aucun mot-clé à partager.`);
        break;
      }
      case "pumpEvent":
      case "pumpSelf": {
        const pumped = effect.type === "pumpSelf" ? (ability ? g.cards[ability.sourceId] : undefined) : ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        if (!pumped || pumped.zone !== "battlefield") break;
        const boost = pumped.ptBoost ?? { power: 0, toughness: 0 };
        pumped.ptBoost = { power: boost.power + effect.power, toughness: boost.toughness + effect.toughness };
        if (effect.keywords?.length) grantKeywords(pumped, effect.keywords);
        const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
        const parts = [...(effect.power || effect.toughness ? [`${sign(effect.power)}/${sign(effect.toughness)}`] : []), ...(effect.keywords ?? []).map((k) => KEYWORD_HELP[k]?.name.toLowerCase() ?? k)];
        log(g, null, `${cardName(g, pumped)} gagne ${parts.join(" et ")} jusqu'à la fin du tour.`);
        break;
      }
      case "pumpTarget": {
        const c = card(effect.target);
        if (!c || c.zone !== "battlefield") break;
        // Bast, Storm : « +X/+X, where X is … », lu maintenant.
        const x = effect.x ? amountOf(effect.x.amount) : 0;
        const power = effect.power + (effect.x?.power ? x : 0);
        const toughness = effect.toughness + (effect.x?.toughness ? x : 0);
        if (power || toughness) {
          const boost = c.ptBoost ?? { power: 0, toughness: 0 };
          c.ptBoost = { power: boost.power + power, toughness: boost.toughness + toughness };
        }
        grantKeywords(c, effect.keywords, effect.untilNextTurn ? caster.id : undefined);
        const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
        const parts = [...(power || toughness || effect.x ? [`${sign(power)}/${sign(toughness)}`] : []), ...effect.keywords.map((k) => KEYWORD_HELP[k]?.name.toLowerCase() ?? k)];
        log(g, null, `${cardName(g, c)} gagne ${parts.join(" et ")} ${effect.untilNextTurn ? `jusqu'au prochain tour de ${caster.name}` : "jusqu'à la fin du tour"}.`);
        break;
      }
      case "grantAll": {
        const power = amountOf(effect.power ?? 0);
        const toughness = amountOf(effect.toughness ?? 0);
        const all = allMatching(effect.filter).filter((c) => !(effect.others && c.instanceId === ability?.sourceId));
        for (const c of all) {
          if (power || toughness) {
            const boost = c.ptBoost ?? { power: 0, toughness: 0 };
            c.ptBoost = { power: boost.power + power, toughness: boost.toughness + toughness };
          }
          grantKeywords(c, effect.keywords, effect.untilNextTurn ? caster.id : undefined);
        }
        const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
        const parts = [
          ...(power || toughness ? [`${sign(power)}/${sign(toughness)}`] : []),
          ...effect.keywords.map((k) => KEYWORD_HELP[k]?.name.toLowerCase() ?? k),
        ];
        const noun = effect.filter.types.includes("creature") ? "créatures" : "permanents";
        const what = `${effect.others ? "Les autres" : "Les"} ${noun}${effect.filter.legendary ? " légendaires" : ""}${effect.filter.controller === "you" ? ` de ${caster.name}` : ""}`;
        if (parts.length > 0) log(g, null, `${what} gagnent ${parts.join(", ")} ${effect.untilNextTurn ? `jusqu'au prochain tour de ${caster.name}` : "jusqu'à la fin du tour"}.`);
        break;
      }
      case "attachEvent":
      case "attach": {
        const c = effect.type === "attach" ? card(effect.target) : ability?.eventCardId ? g.cards[ability.eventCardId] : undefined;
        if (!c || c.zone !== "battlefield" || !self || self.zone !== "battlefield") break;
        self.attachedTo = c.instanceId;
        log(g, null, `${cardName(g, self)} est attaché(e) à ${cardName(g, c)}.`);
        break;
      }
      case "gainControl": {
        const c = effect.permanent === "self" ? (self?.zone === "battlefield" ? self : undefined) : card(effect.permanent);
        const p = effect.player === "event" ? (eventPlayer && !eventPlayer.hasConceded ? eventPlayer : undefined) : player(effect.player);
        if (!c || !p || c.zone !== "battlefield") break;
        // « … you control » : le permanent doit toujours être à toi.
        if (effect.permanent === "self" ? c.controllerId !== caster.id : false) break;
        setController(g, c, p.id);
        break;
      }
      case "takeControl": {
        const targets = effect.target !== undefined ? [card(effect.target)].filter((c): c is CardInstance => !!c && c.zone === "battlefield") : allMatching(effect.filter!);
        for (const c of targets) {
          const previous = c.controllerId;
          setController(g, c, caster.id);
          // Le contrôle revient au nettoyage ; un contrôle déjà temporaire revient au même joueur.
          if (effect.untilEndOfTurn && previous !== caster.id) c.controlReturnsTo ??= previous;
          if (effect.untap) untap(g, c);
          if (effect.haste) c.grants = [...new Set([...(c.grants ?? []), "haste"])];
        }
        break;
      }
      case "exchangeControl": {
        const a = card(effect.a);
        const b = card(effect.b);
        if (!a || !b || a.controllerId === b.controllerId) break;
        if (effect.relation && !exchangeRelationHolds(g, a, b, effect.relation)) {
          log(g, null, `L'échange de contrôle n'a pas lieu : les deux permanents ne remplissent plus la condition.`);
          break;
        }
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
        const picked = source.choices?.[effects.indexOf(effect)]?.[0];
        const chosenId = ability?.choice ?? picked;
        const chosen = chosenId ? g.cards[chosenId] : undefined;
        const valid = (c: CardInstance | undefined): c is CardInstance =>
          !!c && c.zone === "battlefield" && c.controllerId === caster.id && matchesPermanent(g, c, effect.filter, caster.id) && !(effect.another && c.instanceId === ability?.sourceId);
        if (!valid(chosen)) {
          // Rust Elemental : « If you can't, tap ~ and you lose 4 life. »
          if (effect.orElse && !caster.zones.battlefield.some((id) => valid(g.cards[id]))) applySpellEffects(g, source, effect.orElse, targets, legal);
          break;
        }
        const name = cardName(g, chosen);
        sacrificePermanent(g, chosen);
        log(g, null, `${caster.name} sacrifie ${name}.`);
        // Exploit : « quand ~ exploite une créature ».
        if (ability && ability.text === "Exploit") emit(g, { type: "exploits", cardId: ability.sourceId });
        break;
      }
    }
  }
}

/**
 * Un sort ou une capacité qui commence par « Scry N » : on montre les cartes
 * du dessus à son contrôleur et la résolution attend qu'il les range.
 * Retourne vrai si la résolution doit attendre.
 */
function startScry(g: GameState, card: CardInstance, effects: SpellEffects): boolean {
  const first = effects.effects[0];
  if (first?.type !== "scry" || card.scry?.done) return false;
  const player = g.players[card.controllerId]!;
  // Cavalier of Gales : « shuffle it into its owner's library, then scry 2 ».
  if (first.shuffleEventFirst && !card.scry) {
    const dead = card.ability?.eventCardId ? g.cards[card.ability.eventCardId] : undefined;
    if (dead && dead.zone === (card.ability?.eventZone ?? "graveyard")) {
      const owner = g.players[dead.ownerId]!;
      const name = cardName(g, dead);
      moveCardTo(g, dead.instanceId, "library", "top");
      shuffleLibrary(g, owner);
      log(g, null, `${owner.name} mélange ${name} dans sa bibliothèque.`);
    }
  }
  const count = Math.min(first.count, player.zones.library.length);
  if (count === 0) return false;
  card.scry = { count };
  for (const id of player.zones.library.slice(0, count)) addRevealed(g.cards[id]!, [player.id]);
  log(g, null, `${player.name} regarde les ${plural(count, "carte")} du dessus de sa bibliothèque (regard ${first.count}).`);
  return true;
}

/**
 * Un effet qui demande de choisir des cartes (recherche dans la bibliothèque,
 * carte d'une main révélée) : la résolution attend le choix du contrôleur.
 */
function startCardChoice(g: GameState, card: CardInstance, effects: Effect[], targets: Target[], legal: boolean[]): boolean {
  const controller = g.players[card.controllerId]!;
  for (const [index, effect] of effects.entries()) {
    if (card.choices?.[index]) continue;
    // The Eternal Wanderer −4 : une créature par joueur, choisie par le contrôleur de la capacité.
    if (effect.type === "keepOnePerPlayer") {
      const options = g.turnOrder
        .map((id) => g.players[id]!)
        .filter((p) => !p.hasConceded)
        .flatMap((p) => p.zones.battlefield.filter((id) => isCreature(g, g.cards[id]!)));
      const owners = new Set(options.map((id) => g.cards[id]!.controllerId));
      if (options.length === owners.size) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: owners.size, max: owners.size, label: "Choisis une créature par joueur (les autres seront sacrifiées)", perPlayer: true };
      log(g, null, `${controller.name} choisit une créature par joueur pour ${cardName(g, card)}.`);
      return true;
    }
    // Sacrifice obligatoire (« sacrifice another artifact ») : le contrôleur choisit dans la fenêtre commune.
    if (effect.type === "sacrifice" && !card.ability?.choice) {
      const sourceId = card.ability?.sourceId;
      const options = controller.zones.battlefield.filter(
        (id) => matchesPermanent(g, g.cards[id]!, effect.filter, controller.id) && !(effect.another && id === sourceId),
      );
      if (options.length <= 1) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: 1, max: 1, label: `Choisis un(e) ${permanentLabel(effect.filter)} à sacrifier` };
      log(g, null, `${controller.name} choisit quoi sacrifier pour ${cardName(g, card)}.`);
      return true;
    }
    // Cavalier of Gales : les cartes de la main à remettre sur le dessus.
    if (effect.type === "handToTop") {
      if (effect.drawFirst && !card.drewFirst) {
        drawCards(g, controller, effect.drawFirst);
        card.drewFirst = true;
      }
      const options = [...controller.zones.hand];
      if (options.length <= effect.count) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: effect.count, max: effect.count, label: `Choisis ${plural(effect.count, "carte")} de ta main à mettre sur le dessus de ta bibliothèque (la première choisie sera dessus)` };
      return true;
    }
    // Sylvan Library : pioche en plus, puis les cartes piochées ce tour qui doivent être payées ou remises.
    if (effect.type === "chooseDrawn") {
      if (effect.drawFirst && !card.drewFirst) {
        drawCards(g, controller, effect.drawFirst);
        card.drewFirst = true;
      }
      const drawn = controller.drawnThisTurn?.turn === g.turn.number ? controller.drawnThisTurn.ids : [];
      const options = drawn.filter((id) => g.cards[id]?.zone === "hand" && controller.zones.hand.includes(id));
      if (options.length <= effect.count) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: effect.count, max: effect.count, label: `Choisis ${plural(effect.count, "carte")} de ta main piochées ce tour (à payer en points de vie ou à remettre sur le dessus de ta bibliothèque)` };
      return true;
    }
    if (effect.type === "payLifeOrTop") {
      const options = (card.choices?.[index - 1] ?? []).filter((id) => g.cards[id]?.zone === "hand");
      // On ne paie des points de vie que si on les a (règle 119.4).
      const affordable = controller.life > 0 ? Math.floor(controller.life / effect.life) : 0;
      const max = Math.min(options.length, affordable);
      if (max === 0) {
        card.choices = { ...(card.choices ?? {}), [index]: [] };
        continue;
      }
      card.cardChoice = { index, options, min: 0, max, label: `Choisis les cartes que tu gardes en payant ${effect.life} points de vie chacune (les autres vont sur le dessus de ta bibliothèque)` };
      return true;
    }
    // Pyre of Heroes : une créature qui partage un type avec la sacrifiée, de valeur de mana +1.
    if (effect.type === "searchSharingType") {
      const sacrificed = card.ability?.eventDataId ? g.cardData[card.ability.eventDataId] : undefined;
      const face = sacrificed?.faces?.[card.ability?.eventFaceIndex ?? 0] ?? sacrificed;
      const options = sacrificed
        ? controller.zones.library.filter((id) => {
            const d = g.cardData[g.cards[id]!.cardId];
            const f = d?.faces?.[0] ?? d;
            return !!d && !!f && /\bCreature\b/.test(f.typeLine) && d.manaValue === sacrificed.manaValue + effect.mvPlus &&
              sharesCreatureType({ typeLine: f.typeLine, oracleText: f.oracleText ?? "" }, { typeLine: face!.typeLine, oracleText: face!.oracleText ?? "" });
          })
        : [];
      if (options.length === 0) {
        card.choices = { ...(card.choices ?? {}), [index]: [] };
        continue;
      }
      for (const id of options) addRevealed(g.cards[id]!, [controller.id]);
      card.cardChoice = { index, options, min: 0, max: 1, label: `Choisis une créature de valeur de mana ${sacrificed!.manaValue + effect.mvPlus} à mettre sur le champ de bataille` };
      return true;
    }
    // Descendants' Fury : une des créatures qui ont infligé des blessures de combat.
    if (effect.type === "sacrificeOneReveal") {
      const options = (card.ability?.batch ?? []).filter((id) => g.cards[id]?.zone === "battlefield" && g.cards[id]!.controllerId === controller.id);
      if (options.length <= 1) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: 1, max: 1, label: "Choisis la créature à sacrifier" };
      return true;
    }
    // Titan of Industry : la créature qui reçoit le marqueur bouclier.
    if (effect.type === "shieldCounter") {
      const options = controller.zones.battlefield.filter((id) => isCreature(g, g.cards[id]!));
      if (options.length <= 1) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: 1, max: 1, label: "Choisis la créature qui reçoit un marqueur bouclier" };
      return true;
    }
    // Haunting Voyage, Wake the Dead : des cartes de créature de son cimetière.
    if (effect.type === "returnCards") {
      const type = effect.chosenType ? card.chosenType : undefined;
      const options = controller.zones.graveyard.filter((id) => {
        const d = g.cardData[g.cards[id]!.cardId];
        const t = d?.faces?.[0]?.typeLine ?? d?.typeLine ?? "";
        return /\bCreature\b/.test(t) && (!effect.chosenType || (!!type && typeLineHasCreatureType(t, d?.faces?.[0]?.oracleText ?? d?.oracleText ?? "", type)));
      });
      const count = effect.allIfForetold && card.foretold ? options.length : effect.count === "X" ? (card.xValue ?? 0) : effect.count;
      if (options.length <= count) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      const what = type ? `carte${count > 1 ? "s" : ""} de créature ${type}` : `carte${count > 1 ? "s" : ""} de créature`;
      card.cardChoice = { index, options, min: effect.count === "X" ? count : 0, max: count, label: `Choisis jusqu'à ${count} ${what} de ton cimetière à mettre sur le champ de bataille` };
      if (effect.count === "X") card.cardChoice.label = `Choisis ${count} ${what} de ton cimetière à mettre sur le champ de bataille`;
      return true;
    }
    // Incandescent Soulstoke : une créature du type de sa main ; Growth Spiral : un terrain (facultatif).
    if (effect.type === "putFromHand") {
      if (effect.drawFirst !== undefined && !card.drewFirst) {
        drawCards(g, controller, drawFirstCount(g, controller, effect.drawFirst, card.xValue ?? 0));
        card.drewFirst = true;
      }
      // Shadowfax : force inférieure à celle de la source (au moment du choix ; 0 si elle a quitté le champ).
      const source = card.ability ? g.cards[card.ability.sourceId] : undefined;
      const maxPower = effect.lesserPower ? (source?.zone === "battlefield" && isCreature(g, source) ? creatureStats(g, source).power : 0) : Infinity;
      const options = controller.zones.hand.filter((id) => {
        const d = g.cardData[g.cards[id]!.cardId];
        const t = d?.faces?.[0]?.typeLine ?? d?.typeLine ?? "";
        if (effect.land) return /\bLand\b/.test(t);
        if (effect.lesserPower && !((parseInt(d?.faces?.[0]?.power ?? d?.power ?? "0", 10) || 0) < maxPower)) return false;
        return /\bCreature\b/.test(t) && (!effect.subtype || typeLineHasCreatureType(t, d?.faces?.[0]?.oracleText ?? d?.oracleText ?? "", effect.subtype));
      });
      if (options.length === 0) {
        card.choices = { ...(card.choices ?? {}), [index]: [] };
        continue;
      }
      const label = effect.land
        ? "Tu peux choisir un terrain de ta main à mettre sur le champ de bataille"
        : effect.any
          ? "Choisis les cartes de créature de ta main à mettre sur le champ de bataille (autant que tu veux)"
          : `Tu peux choisir une carte de créature${effect.subtype ? ` ${effect.subtype}` : ""}${effect.lesserPower ? ` de force inférieure à ${maxPower}` : ""} de ta main à mettre sur le champ de bataille${effect.attacking ? ", engagée et attaquante" : ""}`;
      card.cardChoice = { index, options, min: 0, max: effect.any ? options.length : 1, label };
      return true;
    }
    // Cavalier of Thorns : un terrain parmi les cartes révélées.
    if (effect.type === "revealLandRestGraveyard") {
      const top = controller.zones.library.slice(0, effect.count);
      for (const id of top) addRevealed(g.cards[id]!, g.turnOrder);
      const lands = top.filter((id) => /\bLand\b/.test(g.cardData[g.cards[id]!.cardId]?.faces?.[0]?.typeLine ?? g.cardData[g.cards[id]!.cardId]?.typeLine ?? ""));
      if (lands.length <= 1) {
        card.choices = { ...(card.choices ?? {}), [index]: lands };
        continue;
      }
      card.cardChoice = { index, options: lands, min: 1, max: 1, label: "Choisis le terrain à mettre sur le champ de bataille (le reste va au cimetière)" };
      return true;
    }
    // Annihilateur : le joueur défenseur choisit ses permanents à sacrifier.
    if (effect.type === "defenderSacrifices") {
      const attacker = card.ability?.eventCardId;
      const defenderId = attacker ? g.combat?.attackers[attacker] : undefined;
      const defender = defenderId ? g.players[defenderId] : undefined;
      const options = defender && !defender.hasConceded ? [...defender.zones.battlefield] : [];
      if (!defender || options.length <= effect.count) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      card.cardChoice = { index, options, min: effect.count, max: effect.count, label: `Choisis ${plural(effect.count, "permanent")} à sacrifier`, playerId: defender.id };
      log(g, null, `${defender.name} choisit ${plural(effect.count, "permanent")} à sacrifier.`);
      return true;
    }
    // Risen Reef : un terrain du dessus peut aller sur le champ de bataille (sinon en main).
    if (effect.type === "topLandOrHand") {
      const top = controller.zones.library[0];
      const data = top ? g.cardData[g.cards[top]!.cardId] : undefined;
      if (!top || !/\bLand\b/.test(data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "")) {
        card.choices = { ...(card.choices ?? {}), [index]: [] };
        continue;
      }
      addRevealed(g.cards[top]!, [controller.id]);
      card.cardChoice = { index, options: [top], min: 0, max: 1, label: `Choisis ${data?.name ?? "le terrain"} pour le mettre sur le champ de bataille engagé (sinon il va dans ta main)` };
      return true;
    }
    // Stock Up, Dihada −3 : les cartes à prendre parmi celles du dessus.
    if (effect.type === "digTop") {
      const looked = controller.zones.library.slice(0, effect.count);
      for (const id of looked) addRevealed(g.cards[id]!, effect.reveal ? g.turnOrder : [controller.id]);
      const options = effect.legendary ? looked.filter((id) => /\bLegendary\b/.test(currentTypeLine(g, g.cards[id]!))) : looked;
      const max = effect.take === "any" ? options.length : Math.min(effect.take, options.length);
      const min = effect.take === "any" ? 0 : max;
      if (options.length === 0 || (min === options.length && max === options.length)) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      const what = effect.legendary ? "carte(s) légendaire(s)" : plural(max, "carte");
      const rest = effect.rest === "bottom" ? "au-dessous de ta bibliothèque" : "au cimetière";
      card.cardChoice = { index, options, min, max, label: effect.take === "any" ? `Choisis les ${what} à mettre dans ta main (le reste va ${rest})` : `Choisis ${what} à mettre dans ta main (le reste va ${rest})` };
      return true;
    }
    // Cream of the Crop : une des X cartes du dessus reste dessus.
    if (effect.type === "lookTopKeepOne") {
      const entered = card.ability?.eventCardId ? g.cards[card.ability.eventCardId] : undefined;
      const x = entered && entered.zone === "battlefield" ? Math.max(0, creatureStats(g, entered).power) : 0;
      const options = controller.zones.library.slice(0, x);
      if (options.length <= 1) {
        card.choices = { ...(card.choices ?? {}), [index]: options };
        continue;
      }
      for (const id of options) addRevealed(g.cards[id]!, [controller.id]);
      card.cardChoice = { index, options, min: 1, max: 1, label: "Choisis la carte à garder sur le dessus de ta bibliothèque (les autres vont dessous)" };
      return true;
    }
    if (effect.type !== "search" && effect.type !== "chooseDiscard") continue;
    const typeOk = (id: CardInstanceId, types: string[]) => {
      const data = g.cardData[g.cards[id]!.cardId];
      const typeLine = (data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "").toLowerCase();
      return (
        types.length === 0 ||
        types.some((t) =>
          t === "nonland" ? !/\bland\b/.test(typeLine) : t === "permanent" ? !/\b(?:instant|sorcery)\b/.test(typeLine) : new RegExp(`\\b${t}\\b`).test(typeLine),
        )
      );
    };
    let options: CardInstanceId[] = [];
    let label = "";
    let min = 0;
    let chooser = controller;
    if (effect.type === "search") {
      // « Its controller may search… » (Path to Exile) : c'est le contrôleur de la cible qui cherche.
      const who = effect.who;
      if (who && typeof who === "object" && "controllerOf" in who) {
        const t = targets[who.controllerOf];
        const id = legal[who.controllerOf] && t?.kind === "card" ? g.cards[t.id]?.controllerId : undefined;
        if (!id) {
          card.choices = { ...(card.choices ?? {}), [index]: [] };
          continue;
        }
        chooser = g.players[id]!;
      }
      const isBasic = (id: CardInstanceId) => /\bBasic\b/.test(g.cardData[g.cards[id]!.cardId]?.typeLine ?? "");
      // Tuteurs filtrés (Sisay) : légendaire, valeur de mana bornée (calculée maintenant, à la résolution).
      const isLegendary = (id: CardInstanceId) => /\bLegendary\b/.test(g.cardData[g.cards[id]!.cardId]?.faces?.[0]?.typeLine ?? g.cardData[g.cards[id]!.cardId]?.typeLine ?? "");
      const mv = effect.mv;
      const self = card.ability ? g.cards[card.ability.sourceId] : undefined;
      const bound = mv
        ? resolveAmount(mv.amount, card.xValue ?? 0, 0, {
            quantity: (q) => ("of" in q && q.of === "self" && self?.zone === "battlefield" ? Math.max(0, creatureStats(g, self)[q.stat]) : 0),
          })
        : 0;
      const mvOk = (id: CardInstanceId) => {
        if (!mv) return true;
        const v = g.cardData[g.cards[id]!.cardId]?.manaValue ?? 0;
        return mv.cmp === "lt" ? v < bound : v <= bound;
      };
      options = chooser.zones.library.filter((id) => typeOk(id, effect.types) && (!effect.basic || isBasic(id)) && (!effect.legendary || isLegendary(id)) && mvOk(id));
      const what = [
        effect.basic ? "terrain de base" : [effect.legendary ? "légendaire" : "", effect.types.join(", ")].filter(Boolean).join(" "),
        mv ? `valeur de mana ${mv.cmp === "lt" ? "inférieure à" : "au plus"} ${bound}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const n = effect.count ?? 1;
      label = `Choisis ${n > 1 ? `jusqu'à ${n} cartes` : "une carte"}${what ? ` (${what})` : ""} de ta bibliothèque${effect.split ? " : la première va sur le champ de bataille engagée, les autres en main" : ""}`;
      for (const id of options) addRevealed(g.cards[id]!, [chooser.id]);
    } else {
      const who = effect.who;
      const playerId = typeof who === "object" && "target" in who && legal[who.target] && targets[who.target]?.kind === "player" ? targets[who.target]!.id : undefined;
      const victim = playerId ? g.players[playerId] : undefined;
      // La main est révélée à tous avant le choix.
      for (const id of victim?.zones.hand ?? []) addRevealed(g.cards[id]!, g.turnOrder);
      options = victim ? victim.zones.hand.filter((id) => typeOk(id, effect.types)) : [];
      label = `Choisis la carte que ${victim?.name ?? "le joueur"} défausse`;
      min = options.length > 0 ? 1 : 0;
    }
    if (options.length === 0) {
      card.choices = { ...(card.choices ?? {}), [index]: [] };
      continue;
    }
    card.cardChoice = { index, options, min, max: effect.type === "search" ? Math.min(effect.count ?? 1, options.length) : 1, label, ...(chooser.id !== controller.id ? { playerId: chooser.id } : {}) };
    log(g, null, `${chooser.name} choisit une carte pour ${cardName(g, card)}.`);
    return true;
  }
  return false;
}

/** Les modes choisis, triés, s'ils respectent « Choose two — » et compagnie. */
function checkModes(spec: NonNullable<SpellEffects["modes"]>, modes: number[], withCommander: boolean): number[] {
  const chosen = [...new Set(modes)].sort((a, b) => a - b);
  const max = modesMax(spec, withCommander);
  if (chosen.length < Math.max(1, spec.min) || chosen.length > max || chosen.some((i) => !Number.isInteger(i) || i < 0 || i >= spec.list.length)) {
    throw new ActionError(spec.min === max ? `Choisis ${plural(spec.min, "mode")}.` : `Choisis entre ${Math.max(1, spec.min)} et ${max} modes.`);
  }
  return chosen;
}

/** Le joueur contrôle-t-il un commandant (le sien ou un autre) sur le champ de bataille ? */
export function controlsCommander(g: GameState, playerId: PlayerId): boolean {
  return g.players[playerId]!.zones.battlefield.some((id) => g.cards[id]!.isCommander);
}

/** Donne des mots-clés à un permanent, jusqu'à la fin du tour ou (`untilTurnOf`) jusqu'au prochain tour de ce joueur. */
function grantKeywords(card: CardInstance, keywords: string[], untilTurnOf?: PlayerId): void {
  if (keywords.length === 0) return;
  if (untilTurnOf) (card.grantsUntil ??= []).push({ playerId: untilTurnOf, keywords: [...keywords] });
  else card.grants = [...new Set([...(card.grants ?? []), ...keywords])];
}

/** Un sort ou une capacité modale (« Choose one or more — ») attend le choix de son contrôleur. */
function startModes(g: GameState, card: CardInstance, effects: SpellEffects): boolean {
  if (!effects.modes || card.modes?.chosen) return false;
  card.modes = {};
  log(g, null, `${g.players[card.controllerId]!.name} choisit les modes de ${cardName(g, card)}.`);
  return true;
}

/** Les effets à appliquer : ceux du sort, puis ceux des modes choisis (dans l'ordre imprimé). */
function withModes(effects: SpellEffects, card: CardInstance): Effect[] {
  // Les effets des modes choisis sont déjà ajoutés (`flattenModes`) par `spellEffectsOf` et `abilityEffects`.
  void card;
  return effects.effects;
}

/** La carte exilée peut-elle encore être lancée (rebond, cascade) ? */
export function exilePermissionHolds(g: GameState, card: CardInstance): boolean {
  const p = card.castPermission;
  if (!p || (card.zone !== "exile" && card.zone !== "graveyard")) return false;
  if (p.foretell) return g.turn.number > p.turn;
  if (p.turn !== g.turn.number) return false;
  if (p.step && g.turn.step !== p.step) return false;
  if (p.whileOnStack && !g.stack.includes(p.whileOnStack)) return false;
  return true;
}

/** Un éphémère ou un rituel résolu va au cimetière, ou en exil avec le rebond. */
function finishSpell(g: GameState, card: CardInstance): void {
  const data = g.cardData[card.cardId];
  if (card.castFromHand && g.settings.enforceRules && /^Rebound\b/m.test(data?.faces?.[card.faceIndex]?.oracleText ?? data?.oracleText ?? "")) {
    const owner = card.ownerId;
    const name = cardName(g, card);
    const exiled = moveCardTo(g, card.instanceId, "exile", "top");
    exiled.rebound = owner;
    log(g, null, `${name} est exilé (rebond) : ${g.players[owner]!.name} pourra le relancer gratuitement à son prochain entretien.`);
    return;
  }
  // « Exile ~. » (Teferi's Protection).
  if (g.settings.enforceRules && !card.ability && spellEffectsOf(g, card)?.exileSelf) {
    const name = cardName(g, card);
    moveCardTo(g, card.instanceId, "exile", "top");
    log(g, null, `${name} est exilé(e).`);
    return;
  }
  moveCardTo(g, card.instanceId, "graveyard", "top");
}

/** Index du choix « enter as a copy » dans `choices` d'un sort de permanent. */
const COPY_CHOICE = -1;

function resolveTop(g: GameState, stackId?: CardInstanceId): void {
  const id = stackId ?? g.stack.at(-1)!;
  const card = g.cards[id]!;
  if (card.ability) return resolveAbility(g, card);
  const name = cardName(g, card);
  const typeLine = currentTypeLine(g, card);
  if (/\b(Instant|Sorcery)\b/.test(typeLine)) {
    const effects = card.targets ? spellEffectsOf(g, card) : null;
    if (!effects || (effects.effects.length === 0 && !effects.modes)) {
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
    if (startModes(g, card, effects) || startScry(g, card, effects) || startCardChoice(g, card, withModes(effects, card), targets, legal)) return;
    log(g, null, `${name} se résout.`);
    applySpellEffects(g, card, withModes(effects, card), targets, legal);
    if (g.cards[id]?.zone === "stack") finishSpell(g, g.cards[id]!);
    if (effects.unknown.length > 0) {
      log(g, null, `À appliquer à la main pour ${name} : « ${effects.unknown.join(" ")} »`);
    }
  } else {
    // Une aura dont la cible est devenue invalide va au cimetière (règle 608.3b).
    const data0 = g.cardData[card.cardId];
    const aura = card.targets?.length && data0 ? auraTarget(typeLine, data0.faces?.[card.faceIndex]?.oracleText ?? data0.oracleText) : null;
    const host = aura ? card.targets![0]! : null;
    if (aura && host && !isLegalTarget(g, aura, host, card.controllerId, id)) {
      moveCardTo(g, id, "graveyard", "top");
      log(g, null, `${name} n'a plus de cible valide : elle va au cimetière.`);
      return;
    }
    // « You may have ~ enter as a copy of … » (Clone, Sakashima) : son contrôleur choisit d'abord la créature copiée.
    const asCopy = !card.faceDown && g.settings.enforceRules ? enterAsCopyOf(g.cardData[card.cardId], card.faceIndex) : undefined;
    let copyDataId: string | undefined;
    if (asCopy) {
      const chosen = card.choices?.[COPY_CHOICE];
      if (!chosen) {
        const options = Object.values(g.cards)
          .filter((c) => c.zone === "battlefield" && !c.faceDown && isCreature(g, c) && (!asCopy.yours || c.controllerId === card.controllerId))
          .map((c) => c.instanceId);
        if (options.length > 0) {
          card.cardChoice = { index: COPY_CHOICE, options, min: 0, max: 1, label: `Choisis la créature que ${name} copie en arrivant (ou aucune)` };
          log(g, null, `${g.players[card.controllerId]!.name} choisit si ${name} arrive en copie d'une créature.`);
          return;
        }
      } else if (chosen[0]) {
        const copied = g.cards[chosen[0]];
        if (copied && copied.zone === "battlefield" && !copied.faceDown) {
          copyDataId = enterCopyData(g, card.cardId, copied.originalCardId ?? copied.cardId, copied.faceIndex, asCopy.keepOthers);
          log(g, null, `${name} arrive en copie de ${cardName(g, copied)}.`);
        }
      }
    }
    const evoked = card.evoked;
    // Évoquée : elle se sacrifie en arrivant (une capacité déclenchée, en même temps que les siennes).
    if (evoked) card.grantedTriggers = [...(card.grantedTriggers ?? []), EVOKE_TRIGGER];
    const entered = moveCardTo(g, id, "battlefield", "top", { controllerId: card.controllerId, copyDataId });
    if (host?.kind === "card") {
      entered.attachedTo = host.id;
      log(g, null, `${name} enchante ${targetName(g, host)}.`);
    } else if (host?.kind === "player") {
      entered.attachedPlayer = host.id;
      log(g, null, `${name} enchante ${targetName(g, host)}.`);
    }
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
  spell?: { typeLine: string; oracleText: string; ability?: boolean },
): { spent: ManaType[]; life: number } {
  const cost = parseManaCost(costText);
  // Le mana réservé (Primal Beyond…) compte seulement pour les sorts du bon type.
  const usable = () => (actor.restrictedMana ?? []).filter((r) => restrictionFits(r, spell));
  const poolWith = () => {
    const pool = { ...actor.manaPool };
    for (const r of usable()) pool[r.mana] += 1;
    return pool;
  };
  let payment = payFromPool(poolWith(), cost, x, extraGeneric);
  while (!payment.ok) {
    const source = findManaSource(g, actor, payment.need, excludeId ?? "", spell);
    if (!source) {
      const missing = payment.need.kind === "color" ? payment.need.options.map((m) => `{${m}}`).join(" ou ") : "du mana";
      throw new ActionError(`Pas assez de mana pour ${what} : il manque ${missing}.`);
    }
    tapForMana(g, actor, source.card, source.choice);
    payment = payFromPool(poolWith(), cost, x, extraGeneric);
  }
  // Le mana réservé est dépensé en premier.
  const reserved = usable();
  const before = poolWith();
  const newPool = { ...actor.manaPool };
  for (const m of MANA_TYPES) {
    const used = before[m] - payment.pool[m];
    const fromReserved = Math.min(used, reserved.filter((r) => r.mana === m).length);
    newPool[m] -= used - fromReserved;
    let left = fromReserved;
    actor.restrictedMana = (actor.restrictedMana ?? []).filter((r) => {
      if (left > 0 && r.mana === m && reserved.includes(r)) {
        left--;
        return false;
      }
      return true;
    });
  }
  actor.manaPool = newPool;
  if (payment.life > 0) payLife(g, actor, payment.life);
  return { spent: payment.spent, life: payment.life };
}

/** Le permanent passe sous le contrôle d'un autre joueur (il a de nouveau le mal d'invocation). */
function setController(g: GameState, card: CardInstance, playerId: PlayerId): void {
  if (card.controllerId === playerId) return;
  // Un changement de contrôle durable remplace un contrôle « jusqu'à la fin du tour ».
  delete card.controlReturnsTo;
  removeFromZone(g, card);
  card.controllerId = playerId;
  card.summoningSick = true;
  if (g.combat) {
    delete g.combat.attackers[card.instanceId];
    delete g.combat.blockers[card.instanceId];
  }
  g.players[playerId]!.zones.battlefield.push(card.instanceId);
  log(g, null, `${g.players[playerId]!.name} prend le contrôle de ${cardName(g, card)}.`);
  emit(g, { type: "controlChanged", cardId: card.instanceId, controllerId: playerId });
}

/** Payer des points de vie (une perte de points de vie). */
/** « … unless you control two or more basic lands », « you may reveal … / pay 2 life. If you don't, it enters tapped. » */
function entersUntapped(g: GameState, card: CardInstance, choice: boolean): boolean {
  const s = entersTappedStatic(g.cardData[card.cardId], card.faceIndex);
  if (!s) return false;
  const player = g.players[card.controllerId]!;
  if (s.unlessBasics !== undefined) {
    const basics = player.zones.battlefield.filter((id) => id !== card.instanceId && /\bBasic\b/.test(g.cardData[g.cards[id]!.cardId]?.typeLine ?? "")).length;
    return basics >= s.unlessBasics;
  }
  if (s.unlessOpponents !== undefined) {
    return g.turnOrder.filter((id) => id !== player.id && !g.players[id]!.hasConceded && !areTeammates(g, id, player.id)).length >= s.unlessOpponents;
  }
  if (s.unlessOpponentLands !== undefined) {
    const lands = g.turnOrder
      .filter((id) => id !== player.id && !g.players[id]!.hasConceded && !areTeammates(g, id, player.id))
      .reduce((n, id) => n + g.players[id]!.zones.battlefield.filter((c) => /\bLand\b/.test(currentTypeLine(g, g.cards[c]!))).length, 0);
    return lands >= s.unlessOpponentLands;
  }
  if (s.unlessControl) {
    const types = s.unlessControl;
    return player.zones.battlefield.some((id) => id !== card.instanceId && types.some((t) => new RegExp(`\\b${t}\\b`).test(currentTypeLine(g, g.cards[id]!))));
  }
  if (s.unlessLandsAtMost !== undefined || s.unlessLandsAtLeast !== undefined) {
    const lands = player.zones.battlefield.filter((id) => id !== card.instanceId && /\bLand\b/.test(currentTypeLine(g, g.cards[id]!))).length;
    return s.unlessLandsAtMost !== undefined ? lands <= s.unlessLandsAtMost : lands >= s.unlessLandsAtLeast!;
  }
  if (!choice) return false;
  const offer = entersUntappedChoice(g, player.id, card, card.faceIndex);
  if (!offer?.possible) return false;
  if (offer.life) {
    payLife(g, player, offer.life);
    log(g, player.id, `${player.name} paie ${offer.life} points de vie : ${cardName(g, card)} arrive dégagé.`);
    return true;
  }
  if (offer.reveal) {
    const lands = s.unlessRevealLand;
    const shown = player.zones.hand.find((id) => id !== card.instanceId && (lands ? lands.some((t) => new RegExp(`\\b${t}\\b`).test(g.cardData[g.cards[id]!.cardId]?.typeLine ?? "")) : typeLineHasCreatureType(g.cardData[g.cards[id]!.cardId]?.typeLine ?? "", g.cardData[g.cards[id]!.cardId]?.oracleText ?? "", offer.reveal!)));
    if (shown) log(g, player.id, `${player.name} révèle ${cardName(g, g.cards[shown]!)} : ${cardName(g, card)} arrive dégagé.`);
    return true;
  }
  return false;
}

function payLife(g: GameState, actor: PlayerState, amount: number): void {
  // Règle 119.8 : un joueur dont les points de vie ne peuvent pas changer ne peut pas payer de PV.
  if (amount > 0 && lifeLocked(g, actor.id)) throw new ActionError("Tes points de vie ne peuvent pas changer : tu ne peux pas payer de points de vie.");
  for (const p of lifeSharers(g, actor.id)) p.life -= amount;
  emit(g, { type: "lifeLoss", playerId: actor.id, amount });
}

/**
 * Active une capacité d'un permanent (ou d'une carte du cimetière) : vérifie
 * le moment et les cibles, paie le coût, puis met la capacité sur la pile
 * (ou l'applique tout de suite pour une capacité de mana).
 */
/** Évocation : la capacité déclenchée donnée au permanent évoqué. */
const EVOKE_TRIGGER = "When this permanent enters, sacrifice this permanent.";

/** Sacrifie un permanent (« Whenever you sacrifice… » se déclenche : Ashling). */
function sacrificePermanent(g: GameState, card: CardInstance): void {
  const event: TriggerEvent = {
    type: "sacrificed",
    cardId: card.instanceId,
    controllerId: card.controllerId,
    dataId: card.originalCardId ?? card.cardId,
    faceIndex: card.faceIndex,
    isToken: card.isToken,
    typeLine: currentTypeLine(g, card),
  };
  moveCardTo(g, card.instanceId, "graveyard", "top");
  emit(g, event);
}

/** X d'un « unless … pays {X}, where X is this creature's power » : la force actuelle de la source (ou imprimée si elle est partie). */
export function unlessX(g: GameState, sourceId: CardInstanceId): number {
  const source = g.cards[sourceId];
  if (!source) return 0;
  if (source.zone === "battlefield") return Math.max(0, creatureStats(g, source).power);
  return Math.max(0, parseInt(g.cardData[source.cardId]?.power ?? "0", 10) || 0);
}

/** Dégage un permanent ; « Whenever ~ becomes untapped » (Daring Thief) se déclenche s'il était engagé. */
function untap(g: GameState, card: CardInstance): void {
  if (!card.tapped) return;
  card.tapped = false;
  emit(g, { type: "untapped", cardId: card.instanceId });
}

/** Les points de vie de ce joueur (ou de son équipe, s'ils sont partagés) ne peuvent pas changer (Teferi's Protection). */
function lifeLocked(g: GameState, playerId: PlayerId): boolean {
  return lifeSharers(g, playerId).some((p) => p.untilNextTurn?.lifeCantChange);
}

/**
 * Met des permanents hors phase (règle 702.26) : ils restent les mêmes objets mais
 * sont traités comme s'ils n'existaient pas, sans quitter le champ de bataille (rien
 * ne se déclenche). Ce qui leur est attaché part avec eux (hors phase « indirecte »).
 */
function phaseOut(g: GameState, cards: CardInstance[]): void {
  const done: CardInstance[] = [];
  const out = (c: CardInstance, indirect: boolean) => {
    if (c.zone !== "battlefield") return;
    removeFromZone(g, c);
    c.zone = "phasedOut";
    g.players[c.controllerId]!.zones.phasedOut.push(c.instanceId);
    if (indirect) c.phasedOutIndirectly = true;
    else delete c.phasedOutIndirectly;
    // Une créature hors phase est retirée du combat (règle 506.4).
    if (g.combat) {
      delete g.combat.attackers[c.instanceId];
      delete g.combat.blockers[c.instanceId];
      g.combat.blocked = g.combat.blocked.filter((id) => id !== c.instanceId);
    }
    done.push(c);
    for (const other of Object.values(g.cards)) {
      if (other.attachedTo === c.instanceId) out(other, true);
    }
  };
  for (const c of cards) out(c, false);
  if (done.length === 0) return;
  const names = done.filter((c) => !c.phasedOutIndirectly).map((c) => cardName(g, c));
  const extra = done.length - names.length;
  log(g, null, `${names.join(", ")}${extra > 0 ? ` (et ${plural(extra, "carte attachée", "cartes attachées")})` : ""} ${done.length > 1 ? "passent" : "passe"} hors phase.`);
}

/** Les permanents hors phase de ces joueurs reviennent, avec ce qui leur était attaché (règle 502.1). */
function phaseIn(g: GameState, players: PlayerState[]): void {
  const back: CardInstance[] = [];
  const bring = (c: CardInstance) => {
    if (c.zone !== "phasedOut") return;
    removeFromZone(g, c);
    c.zone = "battlefield";
    g.players[c.controllerId]!.zones.battlefield.push(c.instanceId);
    delete c.phasedOutIndirectly;
    // Il est resté sous le même contrôle : pas de mal d'invocation (règle 302.6).
    delete c.summoningSick;
    back.push(c);
    for (const other of Object.values(g.cards)) {
      if (other.attachedTo === c.instanceId && other.zone === "phasedOut" && other.phasedOutIndirectly) bring(other);
    }
  };
  for (const p of players) {
    for (const id of [...p.zones.phasedOut]) {
      const c = g.cards[id]!;
      if (!c.phasedOutIndirectly) bring(c);
    }
  }
  if (back.length > 0) log(g, null, `${back.map((c) => cardName(g, c)).join(", ")} ${back.length > 1 ? "reviennent" : "revient"} (fin de la mise hors phase).`);
}

/** Le type choisi en arrivant : un type de créature (un mot), ou un type de carte (Cloud Key). */
function checkChosenType(what: "creature" | "card" | "color", value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const v = value.trim();
  if (what === "color") {
    const c = COLOR_LETTERS[v.toLowerCase()] ?? v.toUpperCase();
    if (!["W", "U", "B", "R", "G"].includes(c)) throw new ActionError("Choisis une couleur : W, U, B, R ou G.");
    return c;
  }
  if (what === "card") {
    const t = v.toLowerCase();
    if (!["artifact", "creature", "enchantment", "instant", "sorcery"].includes(t)) throw new ActionError("Choisis : artifact, creature, enchantment, instant ou sorcery.");
    return t;
  }
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(v)) throw new ActionError("Type de créature invalide (un seul mot, en anglais : Elemental, Elf…).");
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

const COLOR_LETTERS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G", blanc: "W", bleu: "U", noir: "B", rouge: "R", vert: "G" };

const COMBAT_STEPS: TurnStep[] = ["beginCombat", "declareAttackers", "declareBlockers", "combatDamage", "endCombat"];

const PERMANENT_TYPES = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];
const CARD_TYPE_WORDS = [...PERMANENT_TYPES, "instant", "sorcery", "kindred", "tribal"];

/** Condition entre deux permanents échangés (Role Reversal, Daring Thief, Puca's Mischief, Modify Memory). */
/** Nombre de cibles obligatoires : les dernières « up to one target » peuvent manquer. */
function requiredTargets(specs: { upTo?: boolean }[]): number {
  let n = specs.length;
  while (n > 0 && specs[n - 1]!.upTo) n--;
  return n;
}

function exchangeRelationHolds(g: GameState, a: CardInstance, b: CardInstance, relation: ExchangeRelation): boolean {
  const typesOf = (c: CardInstance, list: string[]) => {
    const data = g.cardData[c.cardId];
    const line = (data?.faces?.[c.faceIndex]?.typeLine ?? data?.typeLine ?? "").toLowerCase().split("—")[0]!;
    return list.filter((t) => new RegExp(`\\b${t}\\b`).test(line));
  };
  const shares = (list: string[]) => typesOf(a, list).some((t) => typesOf(b, list).includes(t));
  switch (relation) {
    case "differentPlayers":
      return a.controllerId !== b.controllerId;
    case "sharePermanentType":
      return shares(PERMANENT_TYPES);
    case "shareCardType":
      return shares(CARD_TYPE_WORDS);
    case "lesserManaValue":
      return (g.cardData[b.cardId]?.manaValue ?? 0) <= (g.cardData[a.cardId]?.manaValue ?? 0);
  }
}

function activateAbility(
  g: GameState,
  actor: PlayerState,
  cardId: CardInstanceId,
  index: number,
  targets: Target[],
  sacrificeId: CardInstanceId | undefined,
  color: ManaType | undefined,
  exileIds: CardInstanceId[] = [],
): void {
  if (!g.settings.enforceRules) throw new ActionError("L'hôte n'applique pas les règles : gère cette capacité à la main.");
  const card = getCard(g, cardId);
  const ability = card.faceDown ? undefined : abilitiesOf(g.cardData[card.cardId], card.faceIndex).activated[index];
  if (!ability) throw new ActionError("Capacité inconnue.");
  const name = cardName(g, card);
  if (ability.zone === "battlefield") {
    if (card.zone !== "battlefield" || card.controllerId !== actor.id) throw new ActionError(`Tu ne contrôles pas ${name}.`);
  } else if (card.zone !== ability.zone || card.ownerId !== actor.id) {
    throw new ActionError(ability.zone === "hand" ? "Cette capacité s'active depuis ta main." : `Cette capacité s'active depuis ton cimetière.`);
  }
  // Moment : vitesse de rituel, ou dès qu'on a la priorité (les capacités de mana, à tout moment).
  if (ability.ownTurn && !isActivePlayer(g, actor.id)) throw new ActionError("Cette capacité ne s'active que pendant ton tour.");
  if (ability.notInCombat && COMBAT_STEPS.includes(g.turn.step)) throw new ActionError("Cette capacité ne s'active pas pendant le combat.");
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
  // Kethis : les cartes du cimetière à exiler, toutes différentes et autres que la source.
  let toExile: CardInstance[] = [];
  if (cost.exileFromGraveyard) {
    const { count, filter } = cost.exileFromGraveyard;
    const label = graveyardLabel(filter).replace(/^carte/, "cartes").replace(/ légendaire/, " légendaires");
    const spec = { label, graveyard: filter };
    const ids = [...new Set(exileIds)];
    if (ids.length !== count || ids.length !== exileIds.length) throw new ActionError(`Choisis ${count} ${count > 1 ? label : graveyardLabel(filter)} à exiler.`);
    toExile = ids.map((id) => getCard(g, id));
    if (toExile.some((c) => c.instanceId === card.instanceId || !isLegalTarget(g, spec, { kind: "card", id: c.instanceId }, actor.id))) {
      throw new ActionError(`Il faut exiler ${count} ${count > 1 ? label : graveyardLabel(filter)}.`);
    }
  }
  const specs = ability.effects.targets;
  if (targets.length !== specs.length && !(targets.length >= requiredTargets(specs) && targets.length < specs.length)) {
    throw new ActionError(`Choisis ${specs.map((t) => `une cible (${t.label})`).join(", puis ")}.`);
  }
  targets.forEach((t, i) => {
    if (!isLegalTarget(g, specs[i]!, t, actor.id, card.instanceId)) throw new ActionError(`Cible invalide : il faut un(e) ${specs[i]!.label}.`);
  });
  const anyColor = ability.effects.effects.some((e) => e.type === "manaAny");
  if (anyColor && (!color || !isManaType(color) || color === "C")) throw new ActionError("Choisis la couleur du mana.");

  // Paiement : mana d'abord (sans engager la source si elle s'engage pour le coût), puis le reste.
  const sourceData = g.cardData[card.cardId];
  const asSpell = { typeLine: currentTypeLine(g, card), oracleText: sourceData?.faces?.[card.faceIndex]?.oracleText ?? sourceData?.oracleText ?? "", ability: true };
  // Otawara : moins cher pour chaque permanent du filtre qu'on contrôle.
  const manaCost = cost.reduction
    ? reduceGenericCost(cost.mana, cost.reduction.amount * actor.zones.battlefield.filter((id) => matchesPermanent(g, g.cards[id]!, cost.reduction!.per, actor.id)).length)
    : cost.mana;
  const paid = manaCost ? payMana(g, actor, manaCost, 0, 0, cost.tap ? card.instanceId : undefined, `activer ${name}`, asSpell) : null;
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
    // Pyre of Heroes : la créature sacrifiée, telle qu'elle était.
    ...(sacrificed ? { eventDataId: sacrificed.cardId, eventFaceIndex: sacrificed.faceIndex } : {}),
  };
  if (sacrificed) {
    const sacName = cardName(g, sacrificed);
    sacrificePermanent(g, sacrificed);
    costParts.push(`en sacrifiant ${sacName}`);
  }
  const how = costParts.length > 0 ? ` (${costParts.join(", ")})` : "";
  if (ability.mana) {
    // Capacité de mana : pas de pile.
    log(g, actor.id, `${actor.name} active ${name}${how}.`);
    const source = { ...card, controllerId: actor.id, ability: stackAbility } as CardInstance;
    if (cost.sacrificeSelf) sacrificePermanent(g, card);
    applySpellEffects(g, source, ability.effects.effects, [], []);
    return;
  }
  if (cost.sacrificeSelf) {
    sacrificePermanent(g, card);
    costParts.push("en le sacrifiant");
  }
  if (cost.discardSelf) {
    moveCardTo(g, card.instanceId, "graveyard", "top");
    costParts.push("en le défaussant");
  }
  if (toExile.length > 0) {
    const names = toExile.map((c) => cardName(g, c));
    for (const c of toExile) moveCardTo(g, c.instanceId, "exile", "top");
    costParts.push(`en exilant ${names.join(" et ")} de son cimetière`);
  }
  if (cost.exileSelf) {
    const fromGraveyard = card.zone === "graveyard";
    moveCardTo(g, card.instanceId, "exile", "top");
    costParts.push(fromGraveyard ? "en l'exilant de son cimetière" : "en l'exilant");
  }
  const instance = newInstance(g, card.cardId, actor.id, "stack");
  instance.faceIndex = card.faceIndex;
  instance.revealedTo = [...g.turnOrder];
  instance.ability = stackAbility;
  instance.targets = targets.map((t) => ({ ...t }));
  g.stack.push(instance.instanceId);
  emitTargeted(g, instance);
  const aimed = instance.targets.length > 0 ? ` sur ${instance.targets.map((t) => targetName(g, t)).join(", ")}` : "";
  const how2 = costParts.length > 0 ? ` (${costParts.join(", ")})` : "";
  log(g, actor.id, `${actor.name} active ${name}${aimed}${how2} : « ${ability.text} ».`);
}

function tapForMana(g: GameState, actor: PlayerState, card: CardInstance, choice: number): void {
  const mana = cardManaOptions(g, card)[choice];
  if (!mana) throw new ActionError("Choix de mana invalide.");
  card.tapped = true;
  const owner = g.players[card.controllerId]!;
  const pool = owner.manaPool;
  const only = cardManaRestrictions(g, card)[choice];
  const typeLine = faceTypeLine(g, card, card.faceIndex);
  const effects = manaTapEffectsFor(g, owner.id, typeLine);
  // Mana Reflection, Nyxbloom Ancient : le mana produit est multiplié (remplacement).
  const factor = effects.reduce((f, e) => (e.add.kind === "multiply" ? f * e.add.factor : f), 1);
  const produced = Array.from({ length: factor }, () => mana).flat();
  // Mirari's Wake, Mana Flare, Crypt Ghast : du mana en plus (capacités de mana déclenchées, sans restriction).
  const extra: ManaType[] = [];
  for (const e of effects) {
    if (e.add.kind === "mana") extra.push(e.add.mana);
    // « one mana of any type that land produced » : le type le plus produit.
    else if (e.add.kind === "sameType" && mana.length > 0) extra.push([...mana].sort((a, b) => mana.filter((m) => m === b).length - mana.filter((m) => m === a).length)[0]!);
  }
  if (only) {
    for (const m of produced) (owner.restrictedMana ??= []).push({ mana: m, ...only });
    for (const m of extra) pool[m] += 1;
    const plus = extra.length > 0 ? `, plus ${formatMana(extra)}` : "";
    log(g, actor.id, `${actor.name} engage ${cardName(g, card)} pour ${formatMana(produced)} (réservé : ${only.subtype || "type choisi"})${plus}.`);
    return;
  }
  // Bubbling Muck : du mana en plus pour un terrain de ce type.
  const bonus = (g.manaBonuses ?? []).filter((b) => b.turn === g.turn.number && new RegExp(`\\b${b.subtype}\\b`).test(typeLine)).map((b) => b.mana);
  const all = [...produced, ...bonus, ...extra];
  for (const m of all) pool[m] += 1;
  log(g, actor.id, `${actor.name} engage ${cardName(g, card)} pour ${formatMana(all)}.`);
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
  spell?: { typeLine: string; oracleText: string; ability?: boolean },
): { card: CardInstance; choice: number } | null {
  let best: { card: CardInstance; choice: number; score: number } | null = null;
  for (const id of actor.zones.battlefield) {
    const card = g.cards[id]!;
    if (card.tapped || id === exclude || card.controllerId !== actor.id) continue;
    const options = cardManaOptions(g, card);
    const restrictions = cardManaRestrictions(g, card);
    options.forEach((mana, choice) => {
      const only = restrictions[choice];
      if (only && !restrictionFits(only, spell)) return;
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
/** Les restrictions des choix de mana de la carte (le type choisi remplacé par celui de la carte). */
function cardManaRestrictions(g: GameState, card: CardInstance): ({ subtype: string; abilities: boolean } | undefined)[] {
  return cardManaDetailed(g, card).map((o) => o.only);
}

/**
 * Les choix de mana d'un permanent : ceux de son texte, la capacité « For each
 * color among permanents you control » (Faeburrow Elder, Bloom Tender), et le
 * mana en plus des auras (Utopia Sprawl, Fertile Ground : un choix par couleur).
 */
function cardManaDetailed(g: GameState, card: CardInstance): { mana: ManaType[]; only?: { subtype: string; abilities: boolean } }[] {
  const data = g.cardData[card.cardId];
  if (!data) return [];
  const face = data.faces?.[card.faceIndex];
  const oracleText = face?.oracleText ?? data.oracleText;
  let options: { mana: ManaType[]; only?: { subtype: string; abilities: boolean } }[] = manaOptionsDetailed(face?.typeLine ?? data.typeLine, oracleText).map((o) => ({
    mana: o.mana,
    ...(o.only ? { only: { subtype: o.only.subtype === "chosen" ? (card.chosenType ?? "") : o.only.subtype, abilities: o.only.abilities } } : {}),
  }));
  if (/^(?:\w+ — )?\{T\}: For each color among permanents you control, add one mana of that color\.?$/m.test(oracleText)) {
    const colors = colorsAmongPermanents(g, card.controllerId);
    if (colors.length > 0) options.push({ mana: colors as ManaType[] });
  }
  // Capacités de mana données par d'autres permanents (Chromatic Lantern, Abundant Growth).
  const typeLine = face?.typeLine ?? data.typeLine;
  for (const ability of grantedManaAbilities(g, card, typeLine)) {
    for (const o of manaOptionsDetailed("", ability)) {
      const only = o.only ? { only: { subtype: o.only.subtype === "chosen" ? (card.chosenType ?? "") : o.only.subtype, abilities: o.only.abilities } } : {};
      if (!options.some((x) => x.mana.join() === o.mana.join() && !x.only && !o.only)) options.push({ mana: o.mana, ...only });
    }
  }
  if (options.length === 0) return options;
  for (const id of g.players[card.controllerId]?.zones.battlefield ?? []) {
    const aura = g.cards[id]!;
    if (aura.attachedTo !== card.instanceId) continue;
    for (const st of staticsOf(g, aura)) {
      if (st.kind !== "auraManaBonus") continue;
      if (st.color === "chosen") {
        const c = aura.chosenType;
        if (c && isManaType(c)) options = options.map((o) => ({ ...o, mana: [...o.mana, c] }));
      } else {
        options = options.flatMap((o) => (["W", "U", "B", "R", "G"] as ManaType[]).map((c) => ({ ...o, mana: [...o.mana, c] })));
      }
    }
  }
  return options;
}


/** Les capacités de mana que d'autres permanents donnent à celui-ci (« Lands you control have "…" », « Enchanted land has "…" »). */
function grantedManaAbilities(g: GameState, card: CardInstance, typeLine: string): string[] {
  const abilities: string[] = [];
  for (const pid of g.turnOrder) {
    for (const id of g.players[pid]?.zones.battlefield ?? []) {
      const other = g.cards[id]!;
      if (other.faceDown) continue;
      const data = g.cardData[other.cardId];
      const text = data?.faces?.[other.faceIndex]?.oracleText ?? data?.oracleText ?? "";
      if (!text.includes(" ha")) continue;
      for (const line of text.split("\n")) {
        const grant = grantedManaAbility(line);
        if (!grant) continue;
        const fits =
          grant.to === "enchanted"
            ? other.attachedTo === card.instanceId
            : other.controllerId === card.controllerId && (grant.to === "permanent" || new RegExp(`\\b${grant.to}\\b`).test(typeLine));
        if (fits) abilities.push(grant.ability);
      }
    }
  }
  return abilities;
}

/** Les effets « quand vous engagez un terrain pour du mana » qui s'appliquent à ce permanent engagé par ce joueur. */
function manaTapEffectsFor(g: GameState, tapper: PlayerId, typeLine: string): ManaTapEffect[] {
  const effects: ManaTapEffect[] = [];
  for (const pid of g.turnOrder) {
    for (const id of g.players[pid]?.zones.battlefield ?? []) {
      const other = g.cards[id]!;
      if (other.faceDown) continue;
      const data = g.cardData[other.cardId];
      const text = data?.faces?.[other.faceIndex]?.oracleText ?? data?.oracleText ?? "";
      if (!text.includes("for mana")) continue;
      for (const line of text.split("\n")) {
        const effect = manaTapEffect(line);
        if (!effect || !manaTapSourceFits(effect, typeLine)) continue;
        if (effect.who === "you" && other.controllerId !== tapper) continue;
        effects.push(effect);
      }
    }
  }
  return effects;
}

const RESTRICTION_TYPE_WORDS = /^(Artifact|Creature|Enchantment|Instant|Sorcery|Planeswalker|Battle|Legendary|Kindred)$/i;

/** Ce mana réservé peut-il payer ce sort (ou cette capacité) ? */
function restrictionFits(r: { subtype: string; abilities: boolean }, spell: { typeLine: string; oracleText: string; ability?: boolean } | undefined): boolean {
  if (!spell || !r.subtype) return false;
  if (spell.ability && !r.abilities) return false;
  // « Spend this mana only to cast creature spells » : un type de carte, lu avant le tiret.
  if (RESTRICTION_TYPE_WORDS.test(r.subtype)) return new RegExp(`\\b${r.subtype}\\b`, "i").test(spell.typeLine.split("—")[0]!);
  return typeLineHasCreatureType(spell.typeLine, spell.oracleText, r.subtype);
}

export function cardManaOptions(g: GameState, card: CardInstance): ManaType[][] {
  return cardManaDetailed(g, card).map((o) => o.mana);
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
  // Trop de cartes en main : le tour s'arrête au nettoyage le temps de choisir les défausses (règle 514.1)
  // (le rappel du nettoyage dit déjà combien de cartes défausser).
  if (activePlayers(g).some((p) => handSizeDiscards(g, p.id) > 0)) return;
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
  if (g.turn.step === "upkeep" && (g.turn.extraUpkeeps ?? 0) > 0) return "upkeep";
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

/**
 * Le joueur a déclaré ses bloqueurs (ou n'en a aucun). Quand tout le camp d'un joueur attaqué
 * l'a fait, ses attaquants non bloqués le font savoir (Coveted Jewel).
 */
function markBlocksDeclared(g: GameState, playerId: PlayerId): void {
  const combat = g.combat!;
  combat.blocksDeclared.push(playerId);
  for (const defender of new Set(Object.values(combat.attackers))) {
    const side = defendingSide(g, defender);
    if (!side.includes(playerId) || !side.every((id) => combat.blocksDeclared.includes(id) || g.players[id]?.hasConceded)) continue;
    const unblocked = Object.entries(combat.attackers)
      .filter(([id, d]) => d === defender && onBattlefield(g, id) && !combat.blocked.includes(id))
      .map(([id]) => id);
    if (unblocked.length > 0) emit(g, { type: "unblocked", playerId: g.cards[unblocked[0]!]!.controllerId, defender, cardIds: unblocked });
  }
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
  // Prévention et blessures doublées (Statecraft, Glacial Chasm, Goldnight Castigator…).
  const modified = modifyDamage(
    g,
    { controllerId: source.controllerId, spell: false, creature: source, combat: true, colors: colorsOf(g, source) },
    hit.card ? { card: g.cards[hit.card] } : { player: hit.player },
    hit.amount,
  );
  if (modified <= 0) {
    log(g, null, `Les blessures de ${sourceName} sont prévenues.`);
    return;
  }
  if (hit.card && useShield(g, g.cards[hit.card]!)) return;
  hit = { ...hit, amount: modified };
  if (hit.card) {
    const target = g.cards[hit.card]!;
    if (infect || hasKeyword(g, source, "Wither")) {
      target.counters["-1/-1"] = (target.counters["-1/-1"] ?? 0) + hit.amount;
    } else {
      target.damage = (target.damage ?? 0) + hit.amount;
    }
    if (hasKeyword(g, source, "Deathtouch")) target.deathtouched = true;
    emit(g, { type: "damaged", cardId: target.instanceId, amount: hit.amount });
    log(g, null, `${sourceName} inflige ${plural(hit.amount, "blessure")} à ${cardName(g, target)}.`);
  } else if (hit.player) {
    const sharers = lifeSharers(g, hit.player).filter((p) => !p.hasConceded);
    const locked = lifeLocked(g, hit.player);
    for (const p of sharers) {
      if (infect) p.poison += hit.amount;
      else if (!locked) p.life -= hit.amount;
      if (source.isCommander && !infect) {
        p.commanderDamage[source.instanceId] = (p.commanderDamage[source.instanceId] ?? 0) + hit.amount;
      }
    }
    if (!infect && !locked && sharers.length > 0) emit(g, { type: "lifeLoss", playerId: hit.player, amount: hit.amount });
    if (sharers.length > 0) emit(g, { type: "combatDamage", cardId: source.instanceId, controllerId: source.controllerId, playerId: hit.player, amount: hit.amount });
    const what = infect ? plural(hit.amount, "marqueur poison", "marqueurs poison") : plural(hit.amount, "blessure");
    log(g, null, `${sourceName} inflige ${what} à ${names(sharers)}${infect ? "" : ` (${sharers[0]?.life ?? 0} PV)`}.`);
    // Monarque : le contrôleur d'une créature qui inflige des blessures de combat au monarque le devient (règle 724.2).
    if (g.monarch && sharers.some((p) => p.id === g.monarch)) setMonarch(g, source.controllerId);
  }
  if (hasKeyword(g, source, "Lifelink") && (cantGainLife(g, source.controllerId) || lifeLocked(g, source.controllerId))) {
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
  // Le monarque quitte la partie : le joueur actif le devient, ou le suivant dans l'ordre du tour si c'est lui qui part (règle 724.4).
  if (g.monarch && leaving.some((p) => p.id === g.monarch)) {
    const from = Math.max(0, g.turnOrder.indexOf(g.turn.activePlayerId));
    const next = [...g.turnOrder.slice(from), ...g.turnOrder.slice(0, from)].map((id) => g.players[id]!).find((p) => !p.hasConceded);
    delete g.monarch;
    if (next) setMonarch(g, next.id);
  }
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
/**
 * Darksteel Mutation, Witness Protection : la créature enchantée prend d'autres données de carte
 * (sans capacités, autres types et caractéristiques) tant que l'aura est attachée.
 */
function applyTransformations(g: GameState): void {
  const wanted = new Map<CardInstanceId, { auraDataId: string; becomes: Extract<StaticAbility, { kind: "becomes" }> }>();
  for (const pid of g.turnOrder) {
    for (const id of g.players[pid]!.zones.battlefield) {
      const aura = g.cards[id]!;
      if (!aura.attachedTo) continue;
      const becomes = staticsOf(g, aura).find((s) => s.kind === "becomes");
      if (becomes && becomes.kind === "becomes") wanted.set(aura.attachedTo, { auraDataId: aura.cardId, becomes });
    }
  }
  for (const pid of g.turnOrder) {
    for (const id of g.players[pid]!.zones.battlefield) {
      const card = g.cards[id]!;
      const original = card.originalCardId ?? card.cardId;
      const want = wanted.get(id);
      const targetId = want ? `${original}#${want.auraDataId}` : original;
      if (card.cardId === targetId) continue;
      if (want && !g.cardData[targetId]) {
        const base = g.cardData[original]!;
        const b = want.becomes;
        g.cardData[targetId] = {
          ...base,
          id: targetId,
          name: b.name ?? base.faces?.[card.faceIndex]?.name ?? base.name,
          typeLine: b.typeLine,
          oracleText: b.keywords.join(", "),
          keywords: b.keywords,
          power: b.power,
          toughness: b.toughness,
          colors: b.colors ?? base.colors,
          faces: undefined,
        } as CardData;
      }
      if (want) {
        card.originalCardId = original;
        card.cardId = targetId;
      } else {
        card.cardId = original;
        delete card.originalCardId;
      }
      log(g, null, want ? `${cardName(g, card)} est transformé(e) par une aura.` : `${cardName(g, card)} retrouve ses caractéristiques.`);
    }
  }
}

function checkStateBasedActions(g: GameState): void {
  for (let guard = 0; guard < 20; guard++) {
    const before = g.log.length;
    if (g.settings.enforceRules) applyTransformations(g);
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
      // Une saga à son dernier chapitre est sacrifiée une fois ce chapitre parti de la pile (règle 714.4).
      for (const card of Object.values(g.cards)) {
        if (card.zone !== "battlefield" || card.faceDown) continue;
        const last = sagaChapters(g.cardData[card.cardId], card.faceIndex);
        if (last === 0 || (card.counters["savoir"] ?? 0) < last) continue;
        if ((g.events ?? []).some((e) => e.type === "lore" && e.cardId === card.instanceId)) continue;
        if (g.stack.some((id) => g.cards[id]!.ability?.sourceId === card.instanceId)) continue;
        const name = cardName(g, card);
        sacrificePermanent(g, card);
        log(g, null, `${name} a fini son dernier chapitre : elle est sacrifiée.`);
      }
      // Nine Lives : exilée à neuf marqueurs.
      for (const card of Object.values(g.cards)) {
        if (card.zone !== "battlefield" || card.faceDown) continue;
        const rule = staticsOf(g, card).find((s) => s.kind === "exileAtCounters");
        if (rule && rule.kind === "exileAtCounters" && (card.counters[rule.counter] ?? 0) >= rule.count) {
          const name = cardName(g, card);
          moveCardTo(g, card.instanceId, "exile", "top");
          log(g, null, `${name} a ${rule.count} marqueurs ${rule.counter} : elle est exilée.`);
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
 * Les données d'une copie modifiée (Ratadrabik : « except it's not legendary
 * and it's a 2/2 black Zombie in addition to its other colors and types »),
 * ajoutées une fois pour toutes à `g.cardData` ; rend leur identifiant.
 */
function copyDataWith(g: GameState, dataId: string, faceIndex: number, except: CopyExcept): string {
  const id = `${dataId}#copie:${faceIndex}:${JSON.stringify(except)}`;
  if (g.cardData[id]) return id;
  const base = g.cardData[dataId]!;
  const face = base.faces?.[faceIndex];
  let typeLine = face?.typeLine ?? base.typeLine;
  if (except.nonLegendary) typeLine = typeLine.replace(/\bLegendary\s+/, "");
  let [types, subs] = typeLine.split(/\s+—\s+/) as [string, string | undefined];
  for (const t of except.types ?? []) {
    if (!new RegExp(`\\b${t}\\b`).test(types)) types = /\bCreature\b/.test(types) ? types.replace(/\bCreature\b/, `${t} Creature`) : `${types} ${t}`;
  }
  const subList = (subs ?? "").split(/\s+/).filter(Boolean);
  for (const sub of except.subtypes ?? []) if (!subList.includes(sub)) subList.push(sub);
  typeLine = subList.length > 0 ? `${types} — ${subList.join(" ")}` : types;
  g.cardData[id] = {
    ...base,
    id,
    name: face?.name ?? base.name,
    manaCost: face?.manaCost ?? base.manaCost,
    typeLine,
    oracleText: face?.oracleText ?? base.oracleText,
    power: except.power ?? face?.power ?? base.power,
    toughness: except.toughness ?? face?.toughness ?? base.toughness,
    colors: [...new Set([...base.colors, ...(except.colors ?? [])])],
    faces: undefined,
  } as CardData;
  return id;
}

/**
 * Les données d'une créature arrivée en copie d'une autre (Clone) ; avec
 * `keepOthers`, elle garde aussi ses autres capacités (Sakashima).
 */
function enterCopyData(g: GameState, selfDataId: string, copiedId: string, copiedFace: number, keepOthers: boolean): string {
  const copied = g.cardData[copiedId]!;
  const face = copied.faces?.[copiedFace];
  if (!keepOthers && !face) return copiedId;
  const id = `${copiedId}#copie:${copiedFace}${keepOthers ? `+${selfDataId}` : ""}`;
  if (g.cardData[id]) return id;
  const self = g.cardData[selfDataId]!;
  const name = face?.name ?? copied.name;
  // Ses autres capacités : toutes ses lignes sauf « enter as a copy », son nom remplacé par celui de la copie.
  const others = keepOthers
    ? self.oracleText
        .split("\n")
        .filter((line) => !/enter as a copy of/i.test(line))
        .map((line) => [self.name, self.name.split(",")[0]!].reduce((t, n) => t.split(n).join(name), line))
    : [];
  g.cardData[id] = {
    ...copied,
    id,
    name,
    manaCost: face?.manaCost ?? copied.manaCost,
    typeLine: face?.typeLine ?? copied.typeLine,
    oracleText: [face?.oracleText ?? copied.oracleText, ...others].filter(Boolean).join("\n"),
    power: face?.power ?? copied.power,
    toughness: face?.toughness ?? copied.toughness,
    colors: copied.colors,
    keywords: [...new Set([...copied.keywords, ...(keepOthers ? self.keywords : [])])],
    faces: undefined,
  } as CardData;
  return id;
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
      // Sakashima (tous ses permanents), Cadric (ses jetons) : la règle ne s'applique pas.
      if (!legendRuleApplies(g, card)) continue;
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
  delete g.turn.extraUpkeeps;
  delete g.turn.upkeeps;
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
  if (step === "upkeep") {
    if (g.turn.step === "upkeep") {
      g.turn.extraUpkeeps = Math.max(0, (g.turn.extraUpkeeps ?? 0) - 1);
      log(g, null, "Étape d'entretien supplémentaire.");
    }
    g.turn.upkeeps = (g.turn.upkeeps ?? 0) + 1;
  }
  g.turn.step = step;
  // Mise hors phase : les permanents du joueur actif reviennent avant son dégagement (règle 502.1).
  if (step === "untap") phaseIn(g, activePlayers(g));
  // Provocation : elle dure jusqu'au prochain tour du joueur qui a provoqué.
  if (step === "untap") {
    const active = activePlayers(g).map((p) => p.id);
    for (const pid of g.turnOrder) {
      for (const id of g.players[pid]!.zones.battlefield) {
        const c = g.cards[id]!;
        if (!c.goadedBy) continue;
        c.goadedBy = c.goadedBy.filter((by) => !active.includes(by));
        if (c.goadedBy.length === 0) delete c.goadedBy;
      }
    }
  }
  // Myriade : les jetons sont exilés à la fin du combat.
  if ((step === "endCombat" || step === "main2" || step === "end") && g.endOfCombatExile?.length) {
    for (const id of g.endOfCombatExile) {
      const c = g.cards[id];
      if (c?.zone === "battlefield") moveCardTo(g, id, "exile", "top");
    }
    delete g.endOfCombatExile;
  }
  // The Eternal Wanderer : les cartes exilées reviennent au début de l'étape de fin de leur propriétaire.
  if (step === "end" && g.delayedReturns?.length) {
    const due = g.delayedReturns.filter((r) => isActivePlayer(g, r.playerId));
    g.delayedReturns = g.delayedReturns.filter((r) => !due.includes(r));
    for (const r of due) {
      const c = g.cards[r.cardId];
      if (!c || c.zone !== "exile") continue;
      moveCardTo(g, c.instanceId, "battlefield", "top", { controllerId: c.ownerId });
      log(g, null, `${cardName(g, c)} revient sur le champ de bataille.`);
    }
  }
  if (step === "upkeep" || step === "draw" || step === "main1" || step === "beginCombat" || step === "end") {
    for (const p of activePlayers(g)) emit(g, { type: "step", step, playerId: p.id });
  }
  // Monarque : il pioche une carte au début de son étape de fin (règle 724.2).
  if (step === "end" && g.monarch && g.settings.enforceRules) {
    const monarch = activePlayers(g).find((p) => p.id === g.monarch);
    if (monarch) {
      log(g, null, `${monarch.name} est le monarque.`);
      drawCards(g, monarch, 1);
    }
  }
  // Rebond : les sorts exilés se relancent gratuitement pendant cet entretien.
  if (step === "upkeep" && (g.turn.upkeeps ?? 1) <= 1) {
    for (const p of activePlayers(g)) {
      for (const id of p.zones.exile) {
        const c = g.cards[id]!;
        if (c.rebound !== p.id) continue;
        delete c.rebound;
        // Le moteur ne s'arrête pas forcément à l'entretien : la permission dure le tour.
        c.castPermission = { free: true, turn: g.turn.number, ignoreTiming: true, reason: "rebond" };
        log(g, null, `${p.name} peut relancer ${cardName(g, c)} depuis l'exil sans payer son coût (rebond).`);
      }
    }
  }
  // Herald's Horn : la carte du dessus va en main si c'est une créature du type choisi.
  if (step === "upkeep" && g.settings.enforceRules) {
    for (const p of activePlayers(g)) {
      for (const id of p.zones.battlefield) {
        const horn = g.cards[id]!;
        if (!horn.chosenType || !staticsOf(g, horn).some((st) => st.kind === "heraldsHorn")) continue;
        const topId = p.zones.library[0];
        const top = topId ? g.cards[topId] : undefined;
        if (!top) continue;
        const data = g.cardData[top.cardId];
        const typeLine = data?.typeLine ?? "";
        if (/\bCreature\b/.test(typeLine) && typeLineHasCreatureType(typeLine, data?.oracleText ?? "", horn.chosenType)) {
          addRevealed(top, g.turnOrder);
          moveCardTo(g, top.instanceId, "hand", "top");
          log(g, null, `${p.name} révèle ${cardName(g, top)} avec ${cardName(g, horn)} et le met dans sa main.`);
        } else {
          log(g, null, `${p.name} regarde la carte du dessus de sa bibliothèque (${cardName(g, horn)}).`);
        }
      }
    }
  }
  // Au début de la première phase principale, un marqueur de savoir sur chaque saga (règle 714.3b).
  if (step === "main1" && g.settings.enforceRules) {
    for (const p of activePlayers(g)) {
      for (const id of p.zones.battlefield) {
        const card = g.cards[id]!;
        if (card.faceDown || sagaChapters(g.cardData[card.cardId], card.faceIndex) === 0) continue;
        const from = card.counters["savoir"] ?? 0;
        card.counters["savoir"] = from + 1;
        log(g, null, `${cardName(g, card)} reçoit un marqueur de savoir (${from + 1}).`);
        emit(g, { type: "lore", cardId: id, from, to: from + 1 });
      }
    }
  }
  // « Until your next turn » : les effets du joueur actif prennent fin au début de son tour.
  if (step === "untap") {
    const active = new Set(activePlayers(g).map((p) => p.id));
    for (const card of Object.values(g.cards)) {
      if (!card.grantsUntil) continue;
      card.grantsUntil = card.grantsUntil.filter((x) => !active.has(x.playerId));
      if (card.grantsUntil.length === 0) delete card.grantsUntil;
    }
    for (const id of active) {
      const p = g.players[id]!;
      if (!p.untilNextTurn) continue;
      delete p.untilNextTurn;
      log(g, null, `Les effets « jusqu'à son prochain tour » sur ${p.name} prennent fin.`);
    }
  }
  // Le mana inutilisé disparaît entre deux étapes (règle 500.4).
  for (const p of Object.values(g.players)) {
    p.manaPool = emptyPool();
    delete p.restrictedMana;
  }
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
          markBlocksDeclared(g, p.id);
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
        delete card.grantedTriggers;
      }
      // Fin des contrôles « jusqu'à la fin du tour » (Dihada −11) : chaque permanent revient à son contrôleur d'avant.
      for (const card of Object.values(g.cards)) {
        if (card.controlReturnsTo === undefined) continue;
        const back = card.controlReturnsTo;
        delete card.controlReturnsTo;
        const p = g.players[back];
        if (card.zone !== "battlefield" || !p || p.hasConceded) continue;
        setController(g, card, back);
      }
      delete g.manaBonuses;
      break;
  }
  if (!g.settings.autoTurnActions) return;
  const players = activePlayers(g);
  switch (step) {
    case "untap":
      for (const p of players) {
        for (const id of p.zones.battlefield) {
          const c = g.cards[id]!;
          // « doesn't untap during your untap step » (Traxos, Claustrophobia).
          if (c.tapped && g.settings.enforceRules && doesntUntap(g, c)) {
            log(g, null, `${cardName(g, c)} ne se dégage pas.`);
            continue;
          }
          untap(g, c);
        }
      }
      if (players.length > 0) log(g, null, `${names(players)} ${players.length > 1 ? "dégagent leurs" : "dégage ses"} permanents.`);
      break;
    case "draw":
      if (skipsFirstDraw(g)) {
        log(g, null, `${names(players)} ne ${players.length > 1 ? "piochent" : "pioche"} pas au premier tour.`);
      } else {
        for (const p of players) {
          // Solitary Confinement : « Skip your draw step ».
          if (g.settings.enforceRules && skipsDrawStep(g, p.id)) log(g, null, `${p.name} passe son étape de pioche.`);
          else drawCards(g, p, 1);
        }
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
 * Cartes que le joueur doit encore défausser à l'étape de nettoyage pour
 * revenir à la taille maximale de main (règle 514.1). Le tour ne passe pas
 * avant. Sans « actions du tour automatiques », rien n'est imposé ; défausser
 * à la main (glisser au cimetière) compte aussi.
 */
export function handSizeDiscards(g: GameState, playerId: PlayerId): number {
  if (!g.settings.autoTurnActions || g.turn.step !== "cleanup") return 0;
  const player = activePlayers(g).find((p) => p.id === playerId);
  if (!player || player.lostReason || hasNoMaxHandSize(g, playerId)) return 0;
  return Math.max(0, player.zones.hand.length - MAX_HAND_SIZE);
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

/**
 * Un joueur devient le monarque (règle 724). Les cartes exilées par Palace Jailer
 * reviennent quand un adversaire de celui qui les a exilées le devient.
 */
function setMonarch(g: GameState, playerId: PlayerId): void {
  const p = g.players[playerId];
  if (!p || p.hasConceded) return;
  if (g.monarch !== playerId) {
    g.monarch = playerId;
    log(g, null, `${p.name} devient le monarque.`);
  }
  for (const card of Object.values(g.cards)) {
    const jailer = card.exiledUntilMonarch;
    if (!jailer || card.zone !== "exile" || jailer === playerId || areTeammates(g, jailer, playerId)) continue;
    const back = moveCardTo(g, card.instanceId, "battlefield", "top", { controllerId: card.ownerId });
    log(g, null, `${cardName(g, back)} revient sur le champ de bataille.`);
  }
}

function drawCards(g: GameState, player: PlayerState, count: number): void {
  const library = player.zones.library;
  const drawn = Math.min(count, library.length);
  for (let i = 0; i < drawn; i++) {
    const drawnId = library[0]!;
    moveCardTo(g, drawnId, "hand", "top");
    const before = player.drawsThisTurn?.turn === g.turn.number ? player.drawsThisTurn.count : 0;
    player.drawsThisTurn = { turn: g.turn.number, count: before + 1 };
    player.drawnThisTurn = { turn: g.turn.number, ids: [...(player.drawnThisTurn?.turn === g.turn.number ? player.drawnThisTurn.ids : []), drawnId] };
    emit(g, { type: "draw", playerId: player.id, nth: before + 1 });
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
  phasedOut: { from: "de la zone hors phase", to: "hors phase" },
};

function zoneFrom(zone: Zone): string {
  return ZONE_NAMES[zone].from;
}

function zoneTo(zone: Zone): string {
  return ZONE_NAMES[zone].to;
}

/**
 * Joueur attaqué par une créature qui arrive « tapped and attacking » : celui
 * qu'attaque la source (Kari Zev, Shadowfax), sinon celui d'un autre attaquant
 * du joueur, sinon son seul adversaire. `undefined` hors combat.
 */
function attackDefender(g: GameState, sourceId: CardInstanceId | undefined, playerId: PlayerId): PlayerId | undefined {
  if (!g.combat) return undefined;
  const bySource = sourceId ? g.combat.attackers[sourceId] : undefined;
  if (bySource) return bySource;
  const other = Object.entries(g.combat.attackers).find(([id]) => g.cards[id]?.controllerId === playerId)?.[1];
  if (other) return other;
  const opponents = g.turnOrder.filter((id) => id !== playerId && !g.players[id]!.hasConceded);
  return opponents.length === 1 ? opponents[0] : undefined;
}

/** Pioche faite avant un choix (Growth Spiral : 1 ; Last March : la plus grande endurance parmi vos créatures). */
function drawFirstCount(g: GameState, controller: PlayerState, count: Amount, x: number): number {
  const mine = () => controller.zones.battlefield.map((id) => g.cards[id]!);
  return resolveAmount(count, x, 0, {
    count: (filter) => mine().filter((c) => matchesPermanent(g, c, { ...filter, controller: "you" }, controller.id)).length,
    quantity: (q) => ("greatest" in q ? Math.max(0, ...mine().filter((c) => isCreature(g, c) && matchesPermanent(g, c, q.filter, controller.id)).map((c) => creatureStats(g, c)[q.greatest])) : 0),
  });
}
