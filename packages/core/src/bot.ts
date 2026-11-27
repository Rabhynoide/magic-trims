/**
 * Un adversaire simple, joué par l'hôte : il joue un terrain, lance ses
 * permanents les plus chers qu'il peut payer, attaque quand c'est sans
 * risque, bloque quand c'est rentable, et passe sinon.
 *
 * Il ne fait que des actions du moteur, validées comme celles d'un joueur.
 * Il n'applique pas les effets des cartes (le moteur ne les connaît pas
 * encore) : il lance donc surtout des permanents.
 */
import type { GameAction } from "./actions.js";
import { canAttack, cantBlock, creatureStats, hasKeyword, isCreature } from "./combat.js";
import { isLegalTarget, spellEffectsOf, type Target } from "./effects.js";
import { abilitiesOf, stackTrigger } from "./triggers.js";
import { areTeammates, isActivePlayer, teamOf } from "./modes.js";
import { applyAction, handSizeDiscards } from "./reducer.js";
import { MAX_HAND_SIZE } from "./turn.js";
import { hasNoMaxHandSize } from "./statics.js";
import type { CardInstance, CardInstanceId, GameState, PlayerId } from "./types.js";

/** La prochaine action du bot, ou `null` s'il n'a rien à faire pour l'instant. */
export function chooseBotAction(g: GameState, botId: PlayerId): GameAction | null {
  const me = g.players[botId];
  if (!me || me.hasConceded) return null;

  // Après un mulligan : les cartes les plus chères au-dessous.
  if (me.mulliganBottom > 0) {
    const sorted = [...me.zones.hand].sort((a, b) => manaValue(g, b) - manaValue(g, a));
    return { type: "bottomMulligan", cardIds: sorted.slice(0, me.mulliganBottom) };
  }

  // Ses capacités déclenchées qui attendent des cibles : un adversaire de préférence.
  const waiting = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.needsTargets && c.controllerId === botId);
  if (waiting) {
    const specs = stackTrigger(g.cardData[waiting.cardId], waiting.ability!)?.effects.targets ?? [];
    const players = [...g.turnOrder].sort((a, b) => Number(areTeammates(g, a, botId) || a === botId) - Number(areTeammates(g, b, botId) || b === botId));
    const candidates = [
      ...players.map((id) => ({ kind: "player", id }) as Target),
      ...g.turnOrder.flatMap((id) => g.players[id]!.zones.battlefield).map((id) => ({ kind: "card", id }) as Target),
    ];
    const targets = specs.map((spec) => candidates.find((t) => isLegalTarget(g, spec, t, botId, waiting.instanceId)));
    if (targets.every((t) => t)) return { type: "chooseTargets", cardId: waiting.instanceId, targets: targets as Target[] };
  }

  // Ses capacités facultatives : oui, sauf s'il faut sacrifier (ou payer sans le pouvoir).
  const deciding = g.stack.map((id) => g.cards[id]!).find((c) => c.ability?.awaitingDecision && c.controllerId === botId);
  if (deciding) {
    const trigger = stackTrigger(g.cardData[deciding.cardId], deciding.ability!);
    const sacrifice = trigger?.effects.effects.some((e) => e.type === "sacrifice");
    const x = trigger?.payMana && /\{X\}/i.test(trigger.payMana) ? (deciding.ability!.eventAmount ?? 0) : undefined;
    const yes: GameAction = { type: "decideOptional", cardId: deciding.instanceId, accept: true, ...(x !== undefined ? { x } : {}) };
    if (!sacrifice && applyAction(g, { actorId: botId, action: yes }).ok) return yes;
    return { type: "decideOptional", cardId: deciding.instanceId, accept: false };
  }

  // La fenêtre de choix : la première carte proposée.
  const picking = g.stack.map((id) => g.cards[id]!).find((c) => c.cardChoice && c.controllerId === botId);
  if (picking) return { type: "chooseCards", cardId: picking.instanceId, cardIds: picking.cardChoice!.options.slice(0, 1) };

  // Ses modes : le premier (ou le nombre minimum).
  const choosing = g.stack.map((id) => g.cards[id]!).find((c) => c.modes && !c.modes.chosen && c.controllerId === botId);
  if (choosing) {
    const effects = choosing.ability ? stackTrigger(g.cardData[choosing.cardId], choosing.ability)?.effects : spellEffectsOf(g, choosing);
    const n = Math.max(1, effects?.modes?.min ?? 1);
    return { type: "chooseModes", cardId: choosing.instanceId, modes: Array.from({ length: n }, (_, i) => i) };
  }

  // Son regard : il garde tout au-dessus.
  const scrying = g.stack.map((id) => g.cards[id]!).find((c) => c.scry && !c.scry.done && c.controllerId === botId);
  if (scrying) {
    return { type: "scry", cardId: scrying.instanceId, top: g.players[botId]!.zones.library.slice(0, scrying.scry!.count), bottom: [] };
  }

  // Le bot ne répond jamais : il passe la priorité (pile non vide, ou avant
  // qu'un autre joueur avance dans son tour) et attend sinon.
  if (g.priority) {
    const holder = g.priority.playerId;
    if (holder === botId || (g.settings.sharedTurns && areTeammates(g, holder, botId))) {
      return { type: "passPriority" };
    }
    return null;
  }

  if (mustDeclareBlockers(g, botId)) return { type: "declareBlockers", blocks: chooseBlocks(g, botId) };
  if (!isActivePlayer(g, botId)) return null;

  // Tant que d'autres joueurs doivent finir leur mulligan ou bloquer, on attend.
  if (Object.values(g.players).some((p) => !p.hasConceded && p.mulliganBottom > 0)) return null;
  if (g.turn.step === "declareBlockers" && waitingForBlockers(g)) return null;

  switch (g.turn.step) {
    case "main1":
    case "main2": {
      const play = firstValid(g, botId, mainPhaseCandidates(g, botId));
      if (play) return play;
      return { type: "nextStep", to: g.turn.step === "main1" ? "declareAttackers" : "cleanup" };
    }
    case "declareAttackers":
      if (g.combat && !g.combat.attackersDeclared) {
        return { type: "declareAttackers", attackers: chooseAttacks(g, botId) };
      }
      return { type: "nextStep" };
    case "cleanup": {
      const excess = handSizeDiscards(g, botId);
      if (excess > 0) {
        // Défausse : d'abord les cartes les plus chères.
        const worst = [...me.zones.hand].sort((a, b) => manaValue(g, b) - manaValue(g, a)).slice(0, excess);
        return { type: "discardToHandSize", cardIds: worst };
      }
      // Actions du tour manuelles : le bot se défausse quand même.
      if (me.zones.hand.length > MAX_HAND_SIZE && !hasNoMaxHandSize(g, botId)) {
        const worst = [...me.zones.hand].sort((a, b) => manaValue(g, b) - manaValue(g, a))[0]!;
        return { type: "moveCard", cardId: worst, to: "graveyard" };
      }
      return { type: "passTurn" };
    }
    default:
      return { type: "nextStep" };
  }
}

/** Le premier coup accepté par le moteur parmi les candidats. */
function firstValid(g: GameState, botId: PlayerId, candidates: GameAction[]): GameAction | null {
  for (const action of candidates) {
    if (applyAction(g, { actorId: botId, action }).ok) return action;
  }
  return null;
}

function mainPhaseCandidates(g: GameState, botId: PlayerId): GameAction[] {
  const me = g.players[botId]!;
  const candidates: GameAction[] = [];
  const hand = me.zones.hand.map((id) => g.cards[id]!);
  // Un terrain d'abord, de préférence un qui donne du mana.
  for (const card of hand) {
    if (/\bLand\b/.test(typeLine(g, card))) candidates.push({ type: "playLand", cardId: card.instanceId });
  }
  // Puis les permanents, du plus cher au moins cher (le commandant compris).
  const spells = [...hand, ...me.zones.command.map((id) => g.cards[id]!).filter((c) => c.isCommander)]
    .filter((c) => isPermanentSpell(typeLine(g, c)) && !/\{X\}/.test(manaCost(g, c)))
    .sort((a, b) => manaValue(g, b) - manaValue(g, a));
  for (const card of spells) candidates.push({ type: "castSpell", cardId: card.instanceId });
  return candidates;
}

function isPermanentSpell(type: string): boolean {
  return /\b(Creature|Artifact|Enchantment|Planeswalker|Battle)\b/.test(type) && !/\bLand\b/.test(type);
}

/**
 * Attaque : on vise l'adversaire le plus faible (moins de points de vie), et
 * on n'envoie que les créatures qu'aucun bloqueur adverse ne peut tuer sans
 * mourir… ou toutes si l'adversaire n'a rien pour bloquer.
 */
function chooseAttacks(g: GameState, botId: PlayerId): { cardId: CardInstanceId; defender: PlayerId }[] {
  const foes = g.turnOrder.filter((id) => !g.players[id]!.hasConceded && !isActivePlayer(g, id));
  if (foes.length === 0) return [];
  const defender = [...foes].sort((a, b) => g.players[a]!.life - g.players[b]!.life)[0]!;
  const blockers = untappedCreatures(g, defender);
  const ready = attackersOf(g, botId);
  return ready
    .filter((card) => {
      const { power, toughness } = creatureStats(g, card);
      if (power <= 0) return false;
      if (blockers.length === 0) return true;
      const flying = hasKeyword(g, card, "Flying");
      const able = blockers.filter((b) => !flying || hasKeyword(g, b, "Flying") || hasKeyword(g, b, "Reach"));
      // Un bloqueur capable de tuer l'attaquant en survivant rend l'attaque risquée.
      return !able.some((b) => {
        const s = creatureStats(g, b);
        return (s.power >= toughness || hasKeyword(g, b, "Deathtouch")) && s.toughness > power;
      });
    })
    .map((card) => ({ cardId: card.instanceId, defender }));
}

/** Ses créatures qui peuvent attaquer maintenant. */
function attackersOf(g: GameState, botId: PlayerId): CardInstance[] {
  return g.players[botId]!.zones.battlefield
    .map((id) => g.cards[id]!)
    .filter((c) => canAttack(g, c));
}

function untappedCreatures(g: GameState, playerId: PlayerId): CardInstance[] {
  return g.players[playerId]!.zones.battlefield.map((id) => g.cards[id]!).filter((c) => isCreature(g, c) && !c.tapped);
}

function defendingSide(g: GameState, playerId: PlayerId): PlayerId[] {
  return g.settings.sharedTurns ? teamOf(g, playerId) : [playerId];
}

function mustDeclareBlockers(g: GameState, botId: PlayerId): boolean {
  const combat = g.combat;
  if (!combat || g.turn.step !== "declareBlockers" || combat.blocksDeclared.includes(botId)) return false;
  return Object.entries(combat.attackers).some(
    ([id, defender]) => g.cards[id]?.zone === "battlefield" && defendingSide(g, defender).includes(botId),
  );
}

function waitingForBlockers(g: GameState): boolean {
  const combat = g.combat;
  if (!combat) return false;
  return Object.entries(combat.attackers).some(
    ([id, defender]) =>
      g.cards[id]?.zone === "battlefield" &&
      defendingSide(g, defender).some((p) => !g.players[p]!.hasConceded && !combat.blocksDeclared.includes(p)),
  );
}

/**
 * Blocages : on bloque un attaquant quand un bloqueur le tue en survivant,
 * ou survit simplement ; et on sacrifie des bloqueurs quand les blessures
 * qui arrivent seraient mortelles.
 */
function chooseBlocks(g: GameState, botId: PlayerId): { cardId: CardInstanceId; attackerId: CardInstanceId }[] {
  const combat = g.combat!;
  const me = g.players[botId]!;
  const attackers = Object.entries(combat.attackers)
    .filter(([id, defender]) => g.cards[id]?.zone === "battlefield" && defendingSide(g, defender).includes(botId))
    .map(([id]) => g.cards[id]!)
    .sort((a, b) => creatureStats(g, b).power - creatureStats(g, a).power);
  const available = untappedCreatures(g, botId).filter((c) => !cantBlock(g, c));
  const blocks: { cardId: CardInstanceId; attackerId: CardInstanceId }[] = [];
  const canBlock = (blocker: CardInstance, attacker: CardInstance) =>
    !hasKeyword(g, attacker, "Flying") || hasKeyword(g, blocker, "Flying") || hasKeyword(g, blocker, "Reach");
  const take = (blocker: CardInstance, attacker: CardInstance) => {
    blocks.push({ cardId: blocker.instanceId, attackerId: attacker.instanceId });
    available.splice(available.indexOf(blocker), 1);
  };

  let incoming = attackers.reduce((n, a) => n + Math.max(0, creatureStats(g, a).power), 0);
  for (const attacker of attackers) {
    if (hasKeyword(g, attacker, "Menace")) continue;
    const a = creatureStats(g, attacker);
    const good =
      available.find((b) => {
        const s = creatureStats(g, b);
        return canBlock(b, attacker) && s.toughness > a.power && s.power >= a.toughness && !hasKeyword(g, attacker, "Deathtouch");
      }) ??
      available.find((b) => canBlock(b, attacker) && creatureStats(g, b).toughness > a.power && !hasKeyword(g, attacker, "Deathtouch"));
    if (good) {
      take(good, attacker);
      if (!hasKeyword(g, attacker, "Trample")) incoming -= a.power;
    }
  }
  // Blessures mortelles : on bloque coûte que coûte, en commençant par les plus gros attaquants.
  for (const attacker of attackers) {
    if (incoming < me.life) break;
    if (blocks.some((b) => b.attackerId === attacker.instanceId) || hasKeyword(g, attacker, "Menace")) continue;
    const chump = [...available]
      .filter((b) => canBlock(b, attacker))
      .sort((x, y) => creatureStats(g, x).power - creatureStats(g, y).power)[0];
    if (chump) {
      take(chump, attacker);
      if (!hasKeyword(g, attacker, "Trample")) incoming -= creatureStats(g, attacker).power;
    }
  }
  return blocks;
}

function typeLine(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  return data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "";
}

function manaCost(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  return data?.faces?.[0]?.manaCost || data?.manaCost || "";
}

function manaValue(g: GameState, card: CardInstanceId | CardInstance): number {
  const c = typeof card === "string" ? g.cards[card]! : card;
  return g.cardData[c.cardId]?.manaValue ?? 0;
}
