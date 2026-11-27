/**
 * Effets statiques des permanents : ce qu'ils changent tant qu'ils sont sur
 * le champ de bataille (mots-clés et bonus donnés par un équipement, une aura
 * ou à toutes ses créatures, réductions de coût, taille de main…).
 *
 * Ce module ne dépend que des types : le combat et les effets le consultent.
 */
import { areTeammates } from "./modes.js";
import { keywordList, NUMBER_WORDS, oracleLines, selfToTilde } from "./text.js";
import { protectedFrom } from "./combat.js";
import type { CardData, CardInstance, GameState, PlayerId } from "./types.js";

export type StaticAbility =
  /** « You have no maximum hand size. » */
  | { kind: "noMaxHandSize" }
  /** « Your opponents can't gain life. » */
  | { kind: "opponentsCantGainLife" }
  /** « This creature can't block. » (appliqué par le combat) */
  | { kind: "restriction" }
  /** « Black creature spells you cast cost {1} less to cast. » */
  /**
   * `chosenType` : seulement le type choisi en arrivant (Herald's Horn, Cloud Key) ; `everyone` : les sorts de tous
   * les joueurs (Urza's Incubator) ; `colored` : réduit le mana coloré (Morophon : {W}{U}{B}{R}{G}).
   */
  | { kind: "costReduction"; amount: number; colors: string[]; types: string[]; notTypes: string[]; chosenType?: boolean; everyone?: boolean; colored?: string; anyColor?: boolean; perCounter?: string }
  /** « As ~ enters, choose a creature type » (ou un type de carte : Cloud Key). */
  | { kind: "chooseType"; what: "creature" | "card" | "color" }
  /** Utopia Sprawl, Fertile Ground : le terrain enchanté produit un mana de plus (de la couleur choisie, ou au choix). */
  | { kind: "auraManaBonus"; color: "chosen" | "any" }
  /** Herald's Horn : à l'entretien, la carte du dessus en main si c'est une créature du type choisi. */
  | { kind: "heraldsHorn" }
  /** « Equipped creature has haste and shroud. », « Enchanted creature gets +2/+2. » */
  | { kind: "attached"; keywords: string[]; power: number; toughness: number }
  /** « Creatures you control get +1/+1. », « Other creatures you control have flying. » */
  /** `subtype` : seulement ce type de créature (« Other Elemental creatures you control »), ou le type choisi. */
  | { kind: "anthem"; others: boolean; keywords: string[]; power: number; toughness: number; subtype?: string; chosenType?: boolean }
  /** « ~'s power and toughness are each equal to the number of cards in your hand. » */
  | { kind: "ptEqualsHand" }
  /** Faeburrow Elder : « gets +1/+1 for each color among permanents you control ». */
  | { kind: "ptPerColor" }
  /** Yarok (`entering`), Twinflame Travelers (`subtype`) : les capacités déclenchées se déclenchent une fois de plus. */
  | { kind: "triggerDoubler"; entering?: boolean; subtype?: string }
  /** « Players have no maximum hand size. » */
  | { kind: "noMaxHandSizeAll" }
  /** « This land enters tapped. » */
  | {
      kind: "entersTapped";
      /** Sodden Verdure : dégagé si l'on contrôle au moins ce nombre de terrains de base. */
      unlessBasics?: number;
      /** Flamekin Village, Primal Beyond : dégagé si l'on révèle une carte de ce type depuis sa main. */
      unlessReveal?: string;
      /** Overgrown Tomb : dégagé si l'on paie ce nombre de points de vie. */
      unlessLife?: number;
    }
  /** « Creatures can't attack you unless their controller pays {2} for each creature… » (X : nombre d'enchantements). */
  | { kind: "attackTax"; amount: number | "enchantments" }
  /** « You can't cast creature spells. » */
  | { kind: "cantCast"; types: string[] }
  | { kind: "cantPlayLands" }
  /** « You can't cast more than one spell each turn. » */
  | { kind: "oneSpellPerTurn" }
  /** « If a source would deal damage to you, it deals double that damage to you instead. » (`self` : à ce permanent) */
  | { kind: "doubleDamage"; self: boolean }
  /** « Prevent all damage that would be dealt to you. » ; `counter` : Nine Lives (un marqueur à la place). */
  | { kind: "preventToYou"; counter?: string }
  /** « Prevent all combat damage that would be dealt to and dealt by creatures you control. » */
  | { kind: "preventCombatCreatures" }
  /** « If an instant or sorcery source you control would deal damage…, it deals that much damage plus 2… » */
  | { kind: "spellDamageBonus"; amount: number }
  /** « When there are nine or more incarnation counters on ~, exile it. » */
  | { kind: "exileAtCounters"; counter: string; count: number }
  | { kind: "playerShroud" }
  | { kind: "skipDraw" }
  /** « Creatures you control can't attack. » */
  | { kind: "creaturesCantAttack" }
  /** « No more than one creature can attack (block) each combat. » */
  | { kind: "maxOne"; attack: boolean }
  /**
   * « No more than one creature can attack ~ each combat. » : les attaques se déclarent contre des
   * joueurs dans ce moteur, la limite est donc toujours respectée.
   */
  | { kind: "attackLimitSelf" }
  /** Ashling : « Elemental permanent spells you cast from your hand gain evoke {4} as you cast them. » */
  | { kind: "grantEvoke"; subtype: string; mana: string }
  /**
   * Darksteel Mutation, Witness Protection : la créature enchantée perd ses capacités et devient
   * autre chose (types, force et endurance de base, mots-clés, couleurs, nom).
   */
  | { kind: "becomes"; typeLine: string; power: string; toughness: string; keywords: string[]; colors?: string[]; name?: string };

const COLOR_WORDS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const SPELL_TYPES = ["creature", "artifact", "enchantment", "instant", "sorcery", "planeswalker", "battle"];

/** « gets +1/+1 », « has flying », « gets +1/+1 and has flying ». */
function grant(text: string): { keywords: string[]; power: number; toughness: number } | null {
  let power = 0;
  let toughness = 0;
  let keywords: string[] = [];
  let rest = text.trim();
  const pt = /^gets? ([+-]\d+)\/([+-]\d+)(?: and (.+))?$/i.exec(rest);
  if (pt) {
    power = parseInt(pt[1]!, 10);
    toughness = parseInt(pt[2]!, 10);
    rest = pt[3] ?? "";
  }
  if (rest) {
    const has = /^(?:has|have) (.+)$/i.exec(rest);
    if (!has) return null;
    keywords = keywordList(has[1]!);
    if (keywords.some((k) => !/^[a-z]+( [a-z]+)?$/.test(k))) return null;
  }
  return { keywords, power, toughness };
}

/** Lit une ligne d'effet statique (le nom de la carte déjà remplacé par « ~ »). */
export function parseStaticLine(line: string): StaticAbility | null {
  const l = line.replace(/\.$/, "").replace(/\. this effect reduces only the amount of colored mana you pay$/i, "").trim();
  let m: RegExpExecArray | null;
  if (/^you have no maximum hand size$/i.test(l)) return { kind: "noMaxHandSize" };
  if (/^no more than one creature can attack ~ each combat$/i.test(l)) return { kind: "attackLimitSelf" };
  if ((m = /^(\w+) permanent spells you cast from your hand gain evoke ((?:\{[^}]+\})+) as you cast them$/i.exec(l))) {
    return { kind: "grantEvoke", subtype: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase(), mana: m[2]! };
  }
  if (/^players have no maximum hand size$/i.test(l)) return { kind: "noMaxHandSizeAll" };
  if (/^~ enters tapped$/i.test(l)) return { kind: "entersTapped" };
  if ((m = /^~ enters tapped unless you control (\w+) or more basic lands$/i.exec(l))) {
    const n = NUMBER_WORDS[m[1]!.toLowerCase()] ?? parseInt(m[1]!, 10);
    if (Number.isInteger(n)) return { kind: "entersTapped", unlessBasics: n };
  }
  if ((m = /^as ~ enters, you may reveal an? (\w+) card from your hand\. if you don't, (?:~|it) enters tapped$/i.exec(l))) {
    return { kind: "entersTapped", unlessReveal: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() };
  }
  if ((m = /^as ~ enters, you may pay (\d+) life\. if you don't, (?:~|it) enters tapped$/i.exec(l))) {
    return { kind: "entersTapped", unlessLife: parseInt(m[1]!, 10) };
  }
  if (/^you can't play lands$/i.test(l)) return { kind: "cantPlayLands" };
  if (/^you can't cast more than one spell each turn$/i.test(l)) return { kind: "oneSpellPerTurn" };
  if ((m = /^you can't cast (creature|noncreature|artifact|enchantment|instant|sorcery) spells$/i.exec(l))) return { kind: "cantCast", types: [m[1]!.toLowerCase()] };
  if (
    (m =
      /^creatures can't attack you(?: or planeswalkers you control)? unless their controller pays \{(\d+|X)\} for each (?:creature they control that's attacking you|of those creatures)(, where X is the number of enchantments you control)?$/i.exec(
        l,
      ))
  ) {
    if (m[1]!.toUpperCase() === "X") return m[2] ? { kind: "attackTax", amount: "enchantments" } : null;
    return { kind: "attackTax", amount: parseInt(m[1]!, 10) };
  }
  if (/^your opponents can't gain life$/i.test(l)) return { kind: "opponentsCantGainLife" };
  if (/^if a source would deal damage to you, it deals double that damage to you instead$/i.test(l)) return { kind: "doubleDamage", self: false };
  if (/^if a source would deal damage to ~, it deals double that damage to ~ instead$/i.test(l)) return { kind: "doubleDamage", self: true };
  if (/^prevent all damage that would be dealt to you$/i.test(l)) return { kind: "preventToYou" };
  if ((m = /^if a source would deal damage to you, prevent that damage and put an? (\w+) counter on ~$/i.exec(l))) return { kind: "preventToYou", counter: m[1]!.toLowerCase() };
  if (/^prevent all combat damage that would be dealt to and dealt by creatures you control$/i.test(l)) return { kind: "preventCombatCreatures" };
  if ((m = /^if an instant or sorcery source you control would deal damage to a permanent or player, it deals that much damage plus (\d+) to that permanent or player instead$/i.exec(l))) {
    return { kind: "spellDamageBonus", amount: parseInt(m[1]!, 10) };
  }
  if ((m = /^when there are (\w+) or more (\w+) counters on ~, exile it$/i.exec(l))) {
    const n = NUMBER_WORDS[m[1]!.toLowerCase()] ?? parseInt(m[1]!, 10);
    if (Number.isFinite(n)) return { kind: "exileAtCounters", counter: m[2]!.toLowerCase(), count: n };
  }
  if (/^you have shroud$/i.test(l)) return { kind: "playerShroud" };
  if (/^skip your draw step$/i.test(l)) return { kind: "skipDraw" };
  if (/^creatures you control can't attack$/i.test(l)) return { kind: "creaturesCantAttack" };
  if ((m = /^no more than one creature can (attack|block) each combat$/i.exec(l))) return { kind: "maxOne", attack: m[1]!.toLowerCase() === "attack" };
  if (/^~ can't (attack|block)( or (attack|block))?$/i.test(l)) return { kind: "restriction" };
  if (/^~'s power and toughness are each equal to the number of cards in your hand$/i.test(l)) return { kind: "ptEqualsHand" };
  if (/^~ gets \+1\/\+1 for each color among permanents you control$/i.test(l)) return { kind: "ptPerColor" };
  if ((m = /^if a triggered ability of another (\w+) you control triggers, it triggers an additional time$/i.exec(l))) {
    return { kind: "triggerDoubler", subtype: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() };
  }
  if (/^if a permanent entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time$/i.test(l)) {
    return { kind: "triggerDoubler", entering: true };
  }
  if (/^as ~ enters, choose a creature type$/i.test(l)) return { kind: "chooseType", what: "creature" };
  if (/^as ~ enters, choose artifact, creature, enchantment, instant, or sorcery$/i.test(l)) return { kind: "chooseType", what: "card" };
  if (/^as ~ enters, choose a color$/i.test(l)) return { kind: "chooseType", what: "color" };
  if ((m = /^whenever enchanted (?:land|forest|plains|island|swamp|mountain) is tapped for mana, its controller adds an additional one mana of (the chosen color|any color)$/i.exec(l))) {
    return { kind: "auraManaBonus", color: /chosen/i.test(m[1]!) ? "chosen" : "any" };
  }
  // Herald's Horn, Urza's Incubator, Cloud Key, Morophon : le type choisi.
  if ((m = /^(creature )?spells (?:you cast )?of the chosen type (?:you cast )?cost (\{\d+\}|(?:\{[WUBRG]\})+) less to cast$/i.exec(l))) {
    const everyone = !/you cast/i.test(l);
    const colored = /^\{\d+\}$/.test(m[2]!) ? undefined : m[2]!;
    return {
      kind: "costReduction",
      amount: colored ? 0 : parseInt(m[2]!.slice(1, -1), 10),
      colors: [],
      types: m[1] ? ["creature"] : [],
      notTypes: [],
      chosenType: true,
      ...(everyone ? { everyone } : {}),
      ...(colored ? { colored } : {}),
    };
  }
  // Animar : « Creature spells you cast cost {1} less to cast for each +1/+1 counter on ~. »
  if ((m = /^(creature )?spells you cast cost \{(\d+)\} less to cast for each (\+1\/\+1) counter on ~$/i.exec(l))) {
    return { kind: "costReduction", amount: parseInt(m[2]!, 10), colors: [], types: m[1] ? ["creature"] : [], notTypes: [], perCounter: m[3]! };
  }
  if (/^this effect reduces only the amount of colored mana you pay$/i.test(l)) return { kind: "restriction" };
  // Goblin Anarchomancer : « Each spell you cast that's red or green costs {1} less to cast. »
  if ((m = /^each spell you cast that's (white|blue|black|red|green) or (white|blue|black|red|green) costs \{(\d+)\} less to cast$/i.exec(l))) {
    return { kind: "costReduction", amount: parseInt(m[3]!, 10), colors: [COLOR_WORDS[m[1]!.toLowerCase()]!, COLOR_WORDS[m[2]!.toLowerCase()]!], types: [], notTypes: [] };
  }
  if (/^at the beginning of your upkeep, look at the top card of your library\. if it's a creature card of the chosen type, you may reveal it and put it into your hand$/i.test(l)) {
    return { kind: "heraldsHorn" };
  }
  if ((m = /^other (\w+) creatures you control (.+)$/i.exec(l)) && !/^other$/i.test(m[1]!)) {
    const g = grant(m[2]!);
    return g ? { kind: "anthem", others: true, ...g, subtype: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() } : null;
  }
  if ((m = /^other creatures you control of the chosen type (.+)$/i.exec(l))) {
    const g = grant(m[1]!);
    return g ? { kind: "anthem", others: true, ...g, chosenType: true } : null;
  }
  if ((m = /^((?:white|blue|black|red|green) )?((?:non)?[a-z]+ )?spells you cast cost \{(\d+)\} less to cast$/i.exec(l))) {
    const color = m[1]?.trim().toLowerCase();
    const type = m[2]?.trim().toLowerCase();
    const types: string[] = [];
    const notTypes: string[] = [];
    if (type) {
      const base = type.replace(/^non/, "");
      if (!SPELL_TYPES.includes(base)) return null;
      (type.startsWith("non") ? notTypes : types).push(base);
    }
    return { kind: "costReduction", amount: parseInt(m[3]!, 10), colors: color ? [COLOR_WORDS[color]!] : [], types, notTypes };
  }
  if ((m = /^enchanted creature (?:loses all abilities and )?is an? (?:(white|blue|black|red|green) and (white|blue|black|red|green) )?(\w+) (artifact )?creature with base power and toughness (\d+)\/(\d+)(?: named (.+?))?(?: and has (\w+))?(, and it loses all other abilities, card types, and creature types)?$/i.exec(l))) {
    if (!/loses all abilities/i.test(l) && !m[9]) return null;
    const subtype = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1);
    const keyword = m[8] ? m[8].charAt(0).toUpperCase() + m[8].slice(1).toLowerCase() : null;
    return {
      kind: "becomes",
      typeLine: `${m[4] ? "Artifact " : ""}Creature — ${subtype}`,
      power: m[5]!,
      toughness: m[6]!,
      keywords: keyword ? [keyword] : [],
      ...(m[1] ? { colors: [COLOR_WORDS[m[1].toLowerCase()]!, COLOR_WORDS[m[2]!.toLowerCase()]!] } : {}),
      ...(m[7] ? { name: m[7] } : {}),
    };
  }
  if ((m = /^(?:equipped|enchanted) creature (.+)$/i.exec(l))) {
    const g = grant(m[1]!);
    return g ? { kind: "attached", ...g } : null;
  }
  if ((m = /^(other )?creatures you control (.+)$/i.exec(l))) {
    const g = grant(m[2]!);
    return g ? { kind: "anthem", others: !!m[1], ...g } : null;
  }
  return null;
}

const cache = new Map<string, StaticAbility[]>();

/** Les effets statiques reconnus d'une face. */
export function parseStatics(oracleText: string, cardName: string): StaticAbility[] {
  const key = `${cardName}\u0000${oracleText}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result: StaticAbility[] = [];
  for (const line of oracleLines(selfToTilde(oracleText, cardName))) {
    const s = parseStaticLine(line);
    if (s) result.push(s);
  }
  cache.set(key, result);
  return result;
}

export function staticsOfData(data: CardData | undefined, faceIndex = 0): StaticAbility[] {
  if (!data) return [];
  const face = data.faces?.[faceIndex];
  return parseStatics(face?.oracleText ?? data.oracleText, face?.name ?? data.name);
}

/** Effets statiques de la face visible d'un permanent. */
export function staticsOf(g: GameState, card: CardInstance): StaticAbility[] {
  if (card.faceDown || card.zone !== "battlefield") return [];
  return staticsOfData(g.cardData[card.cardId], card.faceIndex);
}

function battlefield(g: GameState): CardInstance[] {
  return g.turnOrder.flatMap((id) => g.players[id]!.zones.battlefield).map((id) => g.cards[id]!);
}

/** Ce que les autres permanents donnent à cette créature : mots-clés (minuscules) et bonus. */
export function grantedTo(g: GameState, card: CardInstance): { keywords: string[]; power: number; toughness: number } {
  const out = { keywords: [...(card.grants ?? [])], power: 0, toughness: 0 };
  if (card.zone !== "battlefield") return out;
  for (const other of battlefield(g)) {
    for (const s of staticsOf(g, other)) {
      const applies =
        (s.kind === "attached" && card.instanceId === other.attachedTo) ||
        (s.kind === "anthem" &&
          other.controllerId === card.controllerId &&
          !(s.others && other.instanceId === card.instanceId) &&
          (!s.subtype || hasCreatureType(g, card, s.subtype)) &&
          (!s.chosenType || (!!other.chosenType && hasCreatureType(g, card, other.chosenType))));
      if (!applies || (s.kind !== "attached" && s.kind !== "anthem")) continue;
      out.keywords.push(...s.keywords);
      out.power += s.power;
      out.toughness += s.toughness;
    }
  }
  return out;
}

/** Un permanent de ce joueur a-t-il cet effet ? */
function controls(g: GameState, playerId: PlayerId, kind: StaticAbility["kind"]): boolean {
  return g.players[playerId]!.zones.battlefield.some((id) => staticsOf(g, g.cards[id]!).some((s) => s.kind === kind));
}

/** Le joueur n'a pas de taille maximale de main. */
export function hasNoMaxHandSize(g: GameState, playerId: PlayerId): boolean {
  return controls(g, playerId, "noMaxHandSize") || g.turnOrder.some((id) => !g.players[id]!.hasConceded && controls(g, id, "noMaxHandSizeAll"));
}

/** Le permanent arrive-t-il engagé (« This land enters tapped ») ? Sans `g`, toute condition compte comme non remplie. */
export function entersTapped(data: CardData | undefined, faceIndex: number): boolean {
  return staticsOfData(data, faceIndex).some((s) => s.kind === "entersTapped");
}

export type EntersTappedStatic = Extract<StaticAbility, { kind: "entersTapped" }>;

/** La condition « arrive engagé sauf si… » de la carte, ou undefined. */
export function entersTappedStatic(data: CardData | undefined, faceIndex: number): EntersTappedStatic | undefined {
  return staticsOfData(data, faceIndex).find((s): s is EntersTappedStatic => s.kind === "entersTapped");
}

/** Le choix proposé au joueur pour que le terrain arrive dégagé (révéler une carte, payer des PV), ou null. */
export function entersUntappedChoice(g: GameState, playerId: PlayerId, card: CardInstance, faceIndex: number): { reveal?: string; life?: number; possible: boolean } | null {
  const s = entersTappedStatic(g.cardData[card.cardId], faceIndex);
  if (!s) return null;
  if (s.unlessReveal) {
    const subtype = s.unlessReveal;
    const possible = g.players[playerId]!.zones.hand.some((id) => id !== card.instanceId && typeLineHasCreatureType(handTypeLine(g, id), g.cardData[g.cards[id]!.cardId]?.oracleText ?? "", subtype));
    return { reveal: subtype, possible };
  }
  if (s.unlessLife) return { life: s.unlessLife, possible: g.players[playerId]!.life >= s.unlessLife };
  return null;
}

function handTypeLine(g: GameState, id: string): string {
  const data = g.cardData[g.cards[id]!.cardId];
  return [data?.typeLine ?? "", ...(data?.faces ?? []).map((f) => f.typeLine)].join(" // ");
}

/** Taxe à payer pour chaque créature qui attaque ce joueur (Ghostly Prison, Propaganda…). */
export function attackTaxPerCreature(g: GameState, defenderId: PlayerId): number {
  let total = 0;
  const mine = g.players[defenderId]!.zones.battlefield.map((id) => g.cards[id]!);
  for (const card of mine) {
    for (const s of staticsOf(g, card)) {
      if (s.kind !== "attackTax") continue;
      total += s.amount === "enchantments" ? mine.filter((c) => !c.faceDown && /\bEnchantment\b/.test(typeLineOf(g, c))).length : s.amount;
    }
  }
  return total;
}

function typeLineOf(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  return data?.faces?.[card.faceIndex]?.typeLine ?? data?.typeLine ?? "";
}

/** Pourquoi ce joueur ne peut pas lancer ce sort (Steel Golem, Moderation…), ou `null`. */
export function castRestriction(g: GameState, playerId: PlayerId, typeLine: string, spellsThisTurn: number): string | null {
  const type = typeLine.toLowerCase();
  for (const id of g.players[playerId]!.zones.battlefield) {
    const card = g.cards[id]!;
    for (const s of staticsOf(g, card)) {
      const name = g.cardData[card.cardId]?.name ?? "?";
      if (s.kind === "cantCast" && s.types.some((t) => (t.startsWith("non") ? !type.includes(t.slice(3)) : new RegExp(`\\b${t}\\b`).test(type)))) {
        return `${name} t'empêche de lancer ce sort.`;
      }
      if (s.kind === "oneSpellPerTurn" && spellsThisTurn >= 1) return `${name} : un seul sort par tour.`;
    }
  }
  return null;
}

/** Un permanent empêche-t-il ce joueur de jouer des terrains (Aggressive Mining) ? */
export function cantPlayLands(g: GameState, playerId: PlayerId): boolean {
  return controls(g, playerId, "cantPlayLands");
}

/** Un adversaire du joueur l'empêche-t-il de gagner des points de vie ? */
export function cantGainLife(g: GameState, playerId: PlayerId): boolean {
  return g.turnOrder.some((id) => id !== playerId && !areTeammates(g, id, playerId) && !g.players[id]!.hasConceded && controls(g, id, "opponentsCantGainLife"));
}

/** Réduction du coût générique d'un sort lancé par ce joueur. */
export function costReduction(g: GameState, playerId: PlayerId, spell: { typeLine: string; colors: string[]; oracleText?: string }): number {
  return costReductions(g, playerId, spell).generic;
}

/** Réductions de coût : le générique, et le mana coloré retiré (Morophon). */
export function costReductions(g: GameState, playerId: PlayerId, spell: { typeLine: string; colors: string[]; oracleText?: string }): { generic: number; colored: string[] } {
  let generic = 0;
  const colored: string[] = [];
  const type = spell.typeLine.toLowerCase();
  const has = (t: string) => new RegExp(`\\b${t}\\b`).test(type);
  for (const pid of g.turnOrder) {
    for (const id of g.players[pid]!.zones.battlefield) {
      const source = g.cards[id]!;
      for (const s of staticsOf(g, source)) {
        if (s.kind !== "costReduction") continue;
        if (pid !== playerId && !s.everyone) continue;
        if (s.colors.length > 0 && !s.colors.some((c) => spell.colors.includes(c))) continue;
        if (s.types.length > 0 && !s.types.some(has)) continue;
        if (s.notTypes.some(has)) continue;
        if (s.chosenType) {
          const chosen = source.chosenType;
          if (!chosen) continue;
          const isCardType = ["artifact", "creature", "enchantment", "instant", "sorcery"].includes(chosen.toLowerCase());
          if (isCardType ? !has(chosen.toLowerCase()) : !typeLineHasCreatureType(spell.typeLine, spell.oracleText ?? "", chosen)) continue;
        }
        generic += s.perCounter ? s.amount * (source.counters[s.perCounter] ?? 0) : s.amount;
        if (s.colored) colored.push(...[...s.colored.matchAll(/\{([WUBRG])\}/g)].map((x) => x[1]!));
      }
    }
  }
  return { generic, colored };
}

/** La ligne de type a-t-elle ce type de créature ? Changelin : tous les types de créature. */
export function typeLineHasCreatureType(typeLine: string, oracleText: string, subtype: string): boolean {
  if (new RegExp(`\\b${subtype}\\b`, "i").test(typeLine)) return true;
  return /\b(Creature|Kindred|Tribal)\b/.test(typeLine) && /^Changeling\b/m.test(oracleText);
}

/** Deux cartes partagent-elles un type de créature (Changelin compris) ? */
export function sharesCreatureType(a: { typeLine: string; oracleText: string }, b: { typeLine: string; oracleText: string }): boolean {
  const types = (t: string) => (/\b(Creature|Kindred|Tribal)\b/.test(t) ? (t.split("—")[1] ?? "").split("//")[0]!.trim().split(/\s+/).filter(Boolean) : []);
  const changeling = (c: { typeLine: string; oracleText: string }) => /\b(Creature|Kindred|Tribal)\b/.test(c.typeLine) && /^Changeling\b/m.test(c.oracleText);
  const ta = types(a.typeLine);
  const tb = types(b.typeLine);
  if (changeling(a) && (changeling(b) || tb.length > 0)) return true;
  if (changeling(b) && ta.length > 0) return true;
  return ta.some((t) => tb.includes(t));
}

/** Le permanent a-t-il ce type de créature (Changelin compris) ? */
export function hasCreatureType(g: GameState, card: CardInstance, subtype: string): boolean {
  const data = g.cardData[card.cardId];
  const face = data?.faces?.[card.faceIndex];
  return typeLineHasCreatureType(face?.typeLine ?? data?.typeLine ?? "", face?.oracleText ?? data?.oracleText ?? "", subtype);
}

/** Le type le plus fréquent parmi les créatures d'un joueur (le choix par défaut). */
export function mostCommonCreatureType(g: GameState, playerId: PlayerId): string {
  const counts = new Map<string, number>();
  for (const c of Object.values(g.cards)) {
    if (c.ownerId !== playerId || c.ability) continue;
    const typeLine = g.cardData[c.cardId]?.typeLine ?? "";
    if (!/\bCreature\b/.test(typeLine)) continue;
    for (const t of (typeLine.split("—")[1] ?? "").trim().split(/\s+/).filter(Boolean)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Elemental";
}

/** Le coût de présage (« Foretell {5}{B}{B} »), ou `null`. */
export function foretellCost(data: CardData | undefined): string | null {
  const m = /^Foretell ((?:\{[^}]+\})+)/m.exec(data?.oracleText ?? "");
  return m ? m[1]! : null;
}

/** Ce que la carte fait choisir en arrivant (« As ~ enters, choose a creature type »). */
export function chooseTypeOf(data: CardData | undefined, faceIndex = 0): "creature" | "card" | "color" | null {
  // Un rituel ou un éphémère qui commence par « Choose a creature type. » (Haunting Voyage) : choisi en le lançant.
  const face = data?.faces?.[faceIndex];
  if (data && /\b(Instant|Sorcery)\b/.test(face?.typeLine ?? data.typeLine) && /^Choose a creature type\./.test(face?.oracleText ?? data.oracleText)) return "creature";
  const s = staticsOfData(data, faceIndex).find((x) => x.kind === "chooseType");
  return s && s.kind === "chooseType" ? s.what : null;
}

/** D'où viennent des blessures : pour les effets qui les modifient. */
export interface DamageSource {
  controllerId: PlayerId;
  /** Un éphémère ou un rituel (Pyromancer's Swath). */
  spell: boolean;
  /** La créature qui inflige des blessures de combat. */
  creature?: CardInstance;
  combat: boolean;
  /** Couleurs de la source (pour la protection). */
  colors?: string[];
}

/**
 * Les blessures réellement infligées après les effets de remplacement et de
 * prévention (Goldnight Castigator, Glacial Chasm, Statecraft, Nine Lives…).
 * Peut poser des marqueurs (Nine Lives) : appelé seulement sur l'état modifiable.
 */
export function modifyDamage(g: GameState, source: DamageSource, target: { player?: PlayerId; card?: CardInstance }, amount: number): number {
  if (amount <= 0) return 0;
  // Protection contre une couleur : les blessures de cette couleur sont prévenues.
  if (target.card && source.colors?.length && protectedFrom(g, target.card, source.colors)) return 0;
  let n = amount;
  // + 2 pour un éphémère ou un rituel (avant le double : l'ordre est au choix du joueur, on prend le plus fort).
  if (source.spell) {
    for (const c of g.players[source.controllerId]!.zones.battlefield.map((id) => g.cards[id]!)) {
      for (const s of staticsOf(g, c)) if (s.kind === "spellDamageBonus") n += s.amount;
    }
  }
  // Statecraft : rien de ce qu'inflige une créature (ou qu'on lui inflige) en combat.
  if (source.combat) {
    const protects = (playerId: PlayerId) => controls(g, playerId, "preventCombatCreatures");
    if (source.creature && protects(source.creature.controllerId)) return 0;
    if (target.card && protects(target.card.controllerId) && /\bCreature\b/.test(typeLineOf(g, target.card))) return 0;
  }
  if (target.player) {
    const owner = g.players[target.player]!;
    for (const c of owner.zones.battlefield.map((id) => g.cards[id]!)) {
      for (const s of staticsOf(g, c)) {
        if (s.kind !== "preventToYou") continue;
        if (s.counter) c.counters[s.counter] = (c.counters[s.counter] ?? 0) + 1;
        return 0;
      }
    }
    for (const c of owner.zones.battlefield.map((id) => g.cards[id]!)) {
      for (const s of staticsOf(g, c)) if (s.kind === "doubleDamage" && !s.self) n *= 2;
    }
  }
  if (target.card) {
    for (const s of staticsOf(g, target.card)) if (s.kind === "doubleDamage" && s.self) n *= 2;
  }
  return n;
}

/** Le joueur a-t-il le linceul (Solitary Confinement) ? */
export function playerHasShroud(g: GameState, playerId: PlayerId): boolean {
  return controls(g, playerId, "playerShroud");
}

/** Le joueur passe-t-il son étape de pioche ? */
export function skipsDrawStep(g: GameState, playerId: PlayerId): boolean {
  return controls(g, playerId, "skipDraw");
}

/** Les créatures de ce joueur ne peuvent pas attaquer (Glacial Chasm). */
export function creaturesCantAttack(g: GameState, playerId: PlayerId): boolean {
  return controls(g, playerId, "creaturesCantAttack");
}

/** Au plus une créature attaque (bloque) à chaque combat (Silent Arbiter). */
export function maxOneCreature(g: GameState, attack: boolean): boolean {
  return battlefield(g).some((c) => staticsOf(g, c).some((s) => s.kind === "maxOne" && s.attack === attack));
}

/** Coût d'évocation : du mana, ou exiler une carte d'une couleur de sa main (Endurance, Fury). */
export interface EvokeCost {
  mana: string;
  exileColor?: string;
}

/** « Evoke {1}{B} », « Evoke—Exile a green card from your hand. » */
export function printedEvoke(oracleText: string): EvokeCost | null {
  for (const raw of oracleText.split("\n")) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    let m = /^Evoke(?: |—)((?:\{[^}]+\})+)\.?$/i.exec(line);
    if (m) return { mana: m[1]! };
    m = /^Evoke—Exile an? (white|blue|black|red|green) card from your hand\.?$/i.exec(line);
    if (m) return { mana: "", exileColor: COLOR_WORDS[m[1]!.toLowerCase()]! };
  }
  return null;
}

/**
 * Les évocations possibles pour lancer cette carte : la sienne, et celle que donne un permanent
 * (Ashling : les sorts de permanent Élémentaux lancés depuis la main).
 */
export function evokeOptions(
  g: GameState,
  playerId: PlayerId,
  data: CardData | undefined,
  faceIndex: number,
  fromHand: boolean,
): { printed?: EvokeCost; granted?: EvokeCost } {
  if (!data) return {};
  const face = data.faces?.[faceIndex];
  const typeLine = face?.typeLine ?? data.typeLine;
  if (/\b(Instant|Sorcery|Land)\b/.test(typeLine)) return {};
  const printed = printedEvoke(face?.oracleText ?? data.oracleText);
  let granted: EvokeCost | undefined;
  if (fromHand) {
    for (const c of g.players[playerId]?.zones.battlefield.map((id) => g.cards[id]!) ?? []) {
      const s = staticsOf(g, c).find((x) => x.kind === "grantEvoke");
      if (s && s.kind === "grantEvoke" && typeLineHasCreatureType(typeLine, face?.oracleText ?? data.oracleText, s.subtype)) granted = { mana: s.mana };
    }
  }
  return { ...(printed ? { printed } : {}), ...(granted ? { granted } : {}) };
}

/** Les couleurs parmi les permanents que contrôle le joueur. */
export function colorsAmongPermanents(g: GameState, playerId: PlayerId): string[] {
  const found = new Set<string>();
  for (const id of g.players[playerId]?.zones.battlefield ?? []) {
    const c = g.cards[id]!;
    if (c.faceDown) continue;
    for (const color of g.cardData[c.cardId]?.colors ?? []) found.add(color);
  }
  return (["W", "U", "B", "R", "G"] as string[]).filter((c) => found.has(c));
}
