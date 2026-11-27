/**
 * Effets courants des éphémères et des rituels, lus dans le texte Oracle
 * (en anglais, tel que donné par Scryfall).
 *
 * Le moteur reconnaît une phrase à la fois : piocher, détruire, exiler,
 * renvoyer en main, infliger des blessures, gagner ou perdre des points de
 * vie, créer des jetons, contrer un sort. Ce qu'il ne reconnaît pas reste à
 * appliquer à la main, et le journal le rappelle.
 */
import { COMBAT_KEYWORDS, creatureStats, hasKeyword, protectedFrom } from "./combat.js";
import { grantedManaAbility, manaOptions, manaTapEffect } from "./mana.js";
import { parsePermanentAbilities } from "./triggers.js";
import { areTeammates } from "./modes.js";
import { joinModes, keywordList, selfToTilde } from "./text.js";
import { playerHasHexproof, playerHasShroud, printedEvoke, typeLineHasCreatureType } from "./statics.js";

export { selfToTilde };
import type { CardData, CardInstance, GameState, PlayerId } from "./types.js";

/** Une cible choisie au lancement : une carte (champ de bataille ou pile) ou un joueur. */
export type Target = { kind: "card"; id: string } | { kind: "player"; id: PlayerId };

/** Ce qu'une cible doit être. */
export interface TargetSpec {
  /** Texte à afficher (« créature », « n'importe quelle cible »…). */
  label: string;
  /** Une carte sur le champ de bataille correspondant au filtre peut être choisie. */
  permanent?: PermanentFilter;
  /** Un sort sur la pile correspondant au filtre peut être choisi. */
  spell?: SpellFilter;
  /** Un joueur peut être choisi. */
  player?: boolean;
  /** Seulement un adversaire du lanceur. */
  opponent?: boolean;
  /** Un choix (sacrifice…) et non une cible : le linceul et la défense talismanique ne comptent pas. */
  choice?: boolean;
  /** Une carte de sa propre main (choix d'une défausse). */
  hand?: boolean;
  /** Une carte dans un cimetière (« target creature card from your graveyard »). */
  graveyard?: GraveyardFilter;
  /** « target player other than ~'s owner » (Crown of Doom). */
  notOwner?: boolean;
  /** « up to one target » : la cible peut être omise. */
  upTo?: boolean;
  /** « another target » : pas le permanent source de la capacité. */
  another?: boolean;
}

export interface GraveyardFilter {
  /** Au moins un de ces types (vide : n'importe quelle carte). */
  types: string[];
  maxManaValue?: number;
  /** « your graveyard » ou « a graveyard ». */
  whose: "you" | "any";
  /** « another target creature card » : pas la source de la capacité. */
  another?: boolean;
  /** « target Elemental card » : un type de créature. */
  subtype?: string;
}

/** « carte de créature (valeur de mana 3 ou moins) de ton cimetière ». */
export function graveyardLabel(f: GraveyardFilter): string {
  const FR: Record<string, string> = { creature: "créature", artifact: "artefact", enchantment: "enchantement", land: "terrain", planeswalker: "planeswalker", instant: "éphémère", sorcery: "rituel" };
  const type = f.subtype ? ` ${f.subtype}` : f.types.length > 0 ? ` de ${f.types.map((t) => FR[t] ?? t).join(" ou ")}` : "";
  const mv = f.maxManaValue !== undefined ? ` (valeur de mana ${f.maxManaValue} ou moins)` : "";
  return `carte${type}${mv} ${f.whose === "you" ? "de ton cimetière" : "d'un cimetière"}`;
}

/** « another target creature card with mana value 3 or less from your graveyard » ; `null` si non compris. */
function parseGraveyardTarget(text: string): GraveyardFilter | null {
  const sub = /^(another )?target ([A-Z][a-z]+) card from (your|a) graveyard$/.exec(text.trim());
  if (sub && !/^(Creature|Artifact|Enchantment|Land|Planeswalker|Instant|Sorcery)$/.test(sub[2]!)) {
    return { types: [], subtype: sub[2]!, whose: sub[3]!.toLowerCase() === "your" ? "you" : "any", ...(sub[1] ? { another: true } : {}) };
  }
  const m = /^(another )?target ((?:creature|artifact|enchantment|land|planeswalker|instant|sorcery)(?: or (?:creature|artifact|enchantment|land|planeswalker|instant|sorcery))* )?card(?: with mana value (\d+) or less)? from (your|a) graveyard$/i.exec(text.trim());
  if (!m) return null;
  return {
    types: (m[2] ?? "").trim().toLowerCase().split(/ or /).filter(Boolean),
    ...(m[3] ? { maxManaValue: parseInt(m[3], 10) } : {}),
    whose: m[4]!.toLowerCase() === "your" ? "you" : "any",
    ...(m[1] ? { another: true } : {}),
  };
}

export interface PermanentFilter {
  /** Au moins un de ces types (vide : n'importe quel permanent). */
  types: string[];
  /** Aucun de ces types. */
  notTypes: string[];
  controller?: "you" | "notYou";
  state?: "attacking" | "blocking" | "tapped" | "untapped";
  /** « with total power and toughness 5 or less » (Cut Down). */
  maxTotalPT?: number;
  /** Un sous-type (« Enchant Forest »). */
  subtype?: string;
  /** L'un de ces sous-types (« Equip Shaman, Warlock, or Wizard »). */
  anySubtype?: string[];
  /** « legendary creature » : seulement les permanents légendaires. */
  legendary?: boolean;
  /** « nonblack » : aucune de ces couleurs. */
  notColors?: string[];
}

/** Condition entre les deux permanents échangés, vérifiée à la résolution. */
export type ExchangeRelation = "differentPlayers" | "sharePermanentType" | "shareCardType" | "lesserManaValue";

export interface SpellFilter {
  types: string[];
  notTypes: string[];
}

/** Un nombre : fixe, ou X (choisi au lancement). */
/**
 * Un nombre : fixe, X (choisi au lancement), ou « that much » d'une capacité
 * déclenchée (la quantité de l'événement : PV gagnés ou perdus).
 */
export type Amount =
  | number
  | "X"
  | "-X"
  | "event"
  | "-event"
  | "dealt"
  | "hand"
  | "given"
  | "devotion"
  | "-devotion"
  | "lost"
  | "-lostThisTurn"
  /** « for each creature you control » ; `all` : « for each creature on the battlefield » (tous les joueurs). */
  | { perPermanent: PermanentFilter; all?: boolean; times?: number; negative?: boolean }
  /** « equal to its power », « equal to the greatest toughness among creatures you control »… */
  | { q: Quantity; negative?: boolean };

/**
 * Une quantité lue sur le jeu à la résolution : la force ou l'endurance d'une
 * cible (`of` : son numéro, valeur au moment où le sort commence à se résoudre)
 * ou de la source de la capacité (`"self"`), ou la plus grande parmi des permanents.
 */
export type Quantity =
  | { stat: "power" | "toughness"; of: number | "self" }
  | { greatest: "power" | "toughness"; filter: PermanentFilter };

/** Qui subit l'effet : « you », une cible, ou le joueur de l'événement déclencheur (« that player », « they »). */
export type Who = "you" | "opponents" | "all" | "event" | { target: number } | { controllerOf: number };

/** « If you control eight or more lands, draw a card » : l'effet n'a lieu que si la condition tient à la résolution. */
export type Effect = EffectBase & {
  ifControls?: { filter: PermanentFilter; atLeast: number };
  /** Addendum : seulement si le sort a été lancé pendant une phase principale de son contrôleur. */
  ifMainPhase?: boolean;
};

type EffectBase =
  | { type: "draw"; who: Who; count: Amount }
  | { type: "destroy"; target: number }
  /** `countersOnSelf` : Bane of Progress, un marqueur +1/+1 sur la source par permanent détruit. */
  | { type: "destroyAll"; filter: PermanentFilter; countersOnSelf?: boolean }
  /** « you may exile it » : la carte de l'événement (morte) quitte le cimetière pour l'exil. */
  | { type: "exileEventCard" }
  /** Cavalier of Gales : « shuffle it into its owner's library ». */
  | { type: "shuffleEventCard" }
  /** Cavalier of Gales : mettre N cartes de sa main sur le dessus de sa bibliothèque. */
  | { type: "handToTop"; count: number; drawFirst?: number }
  /** Incandescent Soulstoke : une carte de sa main sur le champ de bataille (au choix), célérité, sacrifiée à la fin du tour. */
  | { type: "putFromHand"; subtype: string; haste: boolean; sacrificeAtEnd: boolean }
  /**
   * Haunting Voyage, Wake the Dead : des cartes de créature de son cimetière, choisies à la résolution,
   * du type choisi en lançant (`chosenType`), toutes si le sort a été présagé (`allIfForetold`).
   */
  /** Pyre of Heroes : une créature de la bibliothèque qui partage un type avec la créature sacrifiée, de valeur de mana +1. */
  | { type: "searchSharingType"; mvPlus: number }
  /** Descendants' Fury : sacrifier une des créatures qui ont infligé des blessures, révéler jusqu'à une créature de même type. */
  | { type: "sacrificeOneReveal" }
  | { type: "returnCards"; count: number | "X"; chosenType?: boolean; allIfForetold?: boolean; sacrificeAtEnd?: boolean }
  /** Horde of Notions : la carte ciblée du cimetière se joue gratuitement ce tour-ci. */
  | { type: "playFromGraveyard"; target: number }
  /** Living Death. */
  | { type: "livingDeath" }
  /** Endurance : le joueur met son cimetière au-dessous de sa bibliothèque, dans un ordre aléatoire. */
  | { type: "graveyardToBottom"; who: Who }
  /** Cavalier of Dawn : le contrôleur de la cible (détruite) crée un jeton. */
  | { type: "tokenForController"; target: number; token: TokenSpec }
  /** Cavalier of Thorns : révéler N cartes, un terrain sur le champ de bataille, le reste au cimetière. */
  | { type: "revealLandRestGraveyard"; count: number }
  /** Tyrant of Discord : l'adversaire sacrifie un permanent au hasard, et recommence tant que c'est un non-terrain. */
  | { type: "randomSacrificeLoop"; player: number }
  /** `returnAtEnd` : revient sous le contrôle de son propriétaire au début de sa prochaine étape de fin. */
  | { type: "exile"; target: number; returnAtEnd?: boolean }
  /** The Eternal Wanderer −4 : chaque joueur garde la créature choisie et sacrifie les autres. */
  | { type: "keepOnePerPlayer" }
  | { type: "exileAll"; filter: PermanentFilter }
  | { type: "bounce"; target: number }
  | { type: "damage"; target: number | "event" | "you"; amount: Amount }
  | { type: "damageEach"; who: "opponents" | "players" | "creatures" | "yourOtherCreatures"; amount: Amount }
  | { type: "life"; who: Who; amount: Amount }
  | { type: "token"; count: Amount; token: TokenSpec; tapped: boolean; forOpponents?: boolean }
  | { type: "counter"; target: number }
  | { type: "mana"; mana: string[] }
  /** Marqueurs sur la source de la capacité (« put a +1/+1 counter on ~ »). */
  | { type: "counterSelf"; kind: string; count: number }
  /** Mana d'une couleur au choix (« Add one mana of any color »), choisie à l'activation. */
  | { type: "manaAny"; count: number | "greatestPower" }
  /** « Return ~ from your graveyard to your hand. » */
  | { type: "returnSelf" }
  /** « ~ gets +1/+1 until end of turn. » */
  | { type: "pumpSelf"; power: number; toughness: number }
  /** Havoc Eater : provoque une créature par adversaire, puis des marqueurs selon leur force totale. */
  | { type: "goad"; targets: number[]; countersFromPower?: boolean }
  /** Myriade : une copie engagée et attaquante pour chaque autre adversaire, exilée à la fin du combat. */
  | { type: "myriad" }
  /** Encore : un jeton copie par adversaire, avec la célérité, sacrifié à la fin du tour. */
  | { type: "encore" }
  /** Cascade : exiler jusqu'à une carte non-terrain de plus petite valeur de mana, lançable gratuitement. */
  /**
   * Cascade ; Jodah : `legendary` (une carte légendaire non-terrain), `ofEvent` (de plus petite valeur
   * de mana que le sort de l'événement, et non que la source).
   */
  | { type: "cascade"; legendary?: boolean; ofEvent?: boolean }
  /**
   * Stock Up, Dihada −3 : regarder (ou révéler) les N cartes du dessus, en prendre `take` (« any » : autant
   * qu'on veut) parmi celles qui sont légendaires si `legendary`, le reste dessous ou au cimetière ;
   * `treasurePerRest` : un Trésor par carte mise au cimetière ainsi.
   */
  | { type: "digTop"; count: number; take: number | "any"; legendary?: boolean; reveal: boolean; rest: "bottom" | "graveyard"; treasurePerRest?: boolean }
  /** Etali : exiler la carte du dessus de chaque bibliothèque, ses sorts se lancent gratuitement (pendant cette étape). */
  | { type: "exileTopEachCastFree" }
  /** Annihilateur : le joueur que la créature attaque sacrifie des permanents de son choix. */
  | { type: "defenderSacrifices"; count: number }
  /** Risen Reef : la carte du dessus, sur le champ de bataille engagée si c'est un terrain (au choix), sinon en main. */
  | { type: "topLandOrHand" }
  /** Cream of the Crop : regarder les X cartes du dessus (X : force de la créature arrivée), en garder une dessus, le reste dessous. */
  | { type: "lookTopKeepOne" }
  /** Selvala : le contrôleur de la créature arrivée pioche si sa force est la plus grande. */
  | { type: "drawIfGreatestPower" }
  /** « Put a +1/+1 counter on target Elemental you control. » */
  | { type: "counterTarget"; target: number; kind: string; count: number }
  /** « Put a +1/+1 counter on each Plant creature you control. » */
  | { type: "counterAll"; filter: PermanentFilter; kind: string; count: number }
  /** « Target creature gets +2/+2 and gains haste until end of turn. » */
  /** `untilNextTurn` : « until your next turn » (Dihada) au lieu de la fin du tour. */
  | { type: "pumpTarget"; target: number; power: number; toughness: number; keywords: string[]; untilNextTurn?: boolean }
  /** « Creatures you control gain lifelink until end of turn. » */
  /** « Legendary creatures you control get +1/+0 and gain indestructible until end of turn. » ; `others` : sauf la source. */
  /** `power`/`toughness` : un nombre, ou X (Toxic Deluge : « All creatures get -X/-X »). */
  | { type: "grantAll"; filter: PermanentFilter; keywords: string[]; power?: number | "X" | "-X"; toughness?: number | "X" | "-X"; others?: boolean; untilNextTurn?: boolean }
  /** Équiper : attache la source à la cible. */
  | { type: "attach"; target: number }
  /** « Sacrifice a creature » (au choix du contrôleur, à la résolution). */
  | { type: "sacrifice"; filter: PermanentFilter; another?: boolean; orElse?: Effect[] }
  /** « tap ~ ». */
  | { type: "tapSelf" }
  | { type: "untapSelf" }
  /** Jinxed Choker : « deals damage to you equal to the number of charge counters on it ». */
  | { type: "selfCounterDamage"; kind: string }
  /** « it gets +2/+0 until end of turn » : la créature de l'événement (Crown of Doom). */
  | { type: "pumpEvent"; power: number; toughness: number }
  /** « Target opponent gains control of target permanent you control » ; `permanent` : une cible, ou la source. */
  | { type: "gainControl"; permanent: number | "self"; player: number }
  /** « Exchange control of target land you control and target land an opponent controls. » */
  | { type: "exchangeControl"; a: number; b: number; relation?: ExchangeRelation }
  /** Chaos Warp : le propriétaire mélange le permanent dans sa bibliothèque ; `revealPermanent` : puis révèle et met en jeu un permanent. */
  | { type: "shuffleIntoLibrary"; target: number; revealPermanent?: boolean }
  /** Ashling : « create a token that's a copy of it » (la carte sacrifiée), avec la célérité et un sacrifice à la fin du tour. */
  | { type: "copyEventCard"; haste?: boolean; endStepUnless?: string }
  /** Paradox Haze : « that player gets an additional upkeep step after this step ». */
  | { type: "extraUpkeep" }
  /** Wedding Ring : « target opponent creates a token that's a copy of it ». */
  | { type: "copyToken"; player: number }
  /** Approach of the Second Sun. */
  | { type: "approach"; position: number; life: number }
  /** Modify Memory : « If you control neither creature, draw three cards. » */
  | { type: "drawIfNeither"; a: number; b: number; count: number }
  /** « If you have 40 or more life, you win the game. » */
  | { type: "winIf"; life?: number; handExactly?: number }
  | { type: "loseGame" }
  /** « You lose life equal to that permanent's mana value. » (valeur de mana de la cible n° `target`) */
  | { type: "loseLifeManaValue"; target: number }
  /** Peer into the Abyss : piocher la moitié de sa bibliothèque et perdre la moitié de ses PV (arrondi au supérieur). */
  | { type: "halfLibraryHalfLife"; who: Who }
  /** Teferi's Puzzle Box : mettre sa main au-dessous de sa bibliothèque, puis piocher autant de cartes. */
  | { type: "wheelHand"; who: Who }
  /** « Return that card to the battlefield under your control » : la carte de l'événement (morte ou exilée). */
  | { type: "returnEventCard"; tapped: boolean; owner: boolean }
  /** « Until end of turn, that creature gains "When this creature dies, …" » : une capacité déclenchée donnée. */
  | { type: "grantTrigger"; target: number; text: string }
  /** « Until end of turn, whenever a player taps a Swamp for mana, that player adds an additional {B}. » */
  | { type: "manaBonus"; subtype: string; mana: string }
  /** Une carte d'un cimetière va sur le champ de bataille (sous le contrôle du lanceur) ou dans la main de son propriétaire. */
  | { type: "fromGraveyard"; target: number; to: "battlefield" | "hand" | "libraryTop" }
  /** « Search your library for a land card, put it into your hand » : le lanceur choisit dans la fenêtre de choix. */
  /**
   * `types` : au moins un de ces types ou sous-types (« Forest or Island ») ; `basic` : terrain de base ;
   * `count` : « up to two » ; `split` : Cultivate (la première carte sur le champ de bataille engagée, les autres en main).
   */
  | { type: "search"; types: string[]; to: "hand" | "battlefield"; reveal: boolean; who?: Who; tapped?: boolean; basic?: boolean; count?: number; split?: boolean }
  | { type: "shuffle"; who?: Who }
  /** « Target opponent reveals their hand. » */
  | { type: "revealHand"; who: Who }
  /** « You choose a creature or planeswalker card from it. That player discards that card. » */
  | { type: "chooseDiscard"; who: Who; types: string[] }
  | { type: "discardHand"; who: Who }
  /** « Sacrifice ~. » */
  | { type: "sacrificeSelf"; thenDamage?: number }
  /** « Flip a coin. If you lose the flip, ~ deals 3 damage to you. » */
  | { type: "coinFlipDamage"; amount: number }
  /** « Shuffle ~ and your graveyard into their owner's library. » */
  | { type: "shuffleSelfAndGraveyard" }
  | { type: "exileGraveyards" }
  /** « Each opponent mills cards equal to the number of cards in their hand. » */
  | { type: "mill"; who: Who; count: Amount | "theirHand" }
  /** « Untap up to three lands. » (les terrains engagés du lanceur, choisis d'office) */
  | { type: "untapLands"; count: number }
  /** Jeton prédéfini : Treasure, Food, Clue, Blood. */
  | { type: "namedToken"; name: string; count: Amount; tapped: boolean; who?: Who }
  /** « Create a token that's a copy of target Elemental you control. » */
  | { type: "copyTarget"; target: number }
  /** « ~ deals 2 damage to each creature target player controls. » */
  | { type: "damageCreaturesOf"; target: number; amount: Amount }
  /** « Put a shield counter on a creature you control. » (choisie à la résolution) */
  | { type: "shieldCounter" }
  /** « Scry 2 » : le contrôleur range les cartes du dessus avant le reste de la résolution (seulement en premier effet). */
  /** `shuffleEventFirst` : Cavalier of Gales, la carte morte est d'abord mélangée dans la bibliothèque. */
  | { type: "scry"; count: number; shuffleEventFirst?: boolean };

export interface TokenSpec {
  power: string;
  toughness: string;
  colors: string[];
  subtypes: string[];
  /** Mots-clés du jeton (« with flying »). */
  keywords: string[];
  artifact: boolean;
}

export interface SpellEffects {
  targets: TargetSpec[];
  /** Coût supplémentaire : sacrifier un permanent (« As an additional cost to cast this spell, sacrifice a creature »). */
  sacrifice?: PermanentFilter;
  /** Coût alternatif (« You may pay {1}{B} rather than pay this spell's mana cost »). */
  alternativeCost?: string;
  /** Coût supplémentaire : payer X PV (Toxic Deluge), X choisi en lançant le sort. */
  payLifeX?: boolean;
  /** « Cast this spell only during combat on an opponent's turn » (Wake the Dead). */
  castOnly?: "opponentCombat";
  /**
   * « Choose one or more — • … » : les modes. Sans cible, ils sont choisis à la résolution ;
   * si un mode a des cibles (`targets`, numérotées dans le mode), ils sont choisis en lançant le sort.
   */
  /** `maxWithCommander` : le maximum si le lanceur contrôle un commandant (Akroma's Will). */
  modes?: { min: number; max: number; maxWithCommander?: number; list: { label: string; effects: Effect[]; targets?: TargetSpec[] }[] };
  effects: Effect[];
  /** Phrases que le moteur ne sait pas appliquer. */
  unknown: string[];
}

const NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const NUM = "(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\\d+)";

function amount(word: string): Amount {
  const w = word.toLowerCase();
  if (w === "x") return "X";
  return NUMBERS[w] ?? parseInt(w, 10);
}

const COLORS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const CARD_TYPES = ["artifact", "battle", "creature", "enchantment", "land", "planeswalker"];

/** Phrases sans effet de jeu à appliquer (rappels, précisions). */
const HARMLESS = [/^rebound\.?$/i, /^foretell (?:\{[^}]+\})+\.?$/i, /^cascade(?:, cascade)*\.?$/i, /^(it|they) can't be regenerated\.?$/i, /^~ can't be countered\.?$/i, /^round up each time\.?$/i];


/**
 * « creature », « nonland permanent an opponent controls », « artifact or
 * enchantment », « attacking creature »… ; `null` si le texte n'est pas compris.
 */
function parsePermanentFilter(text: string): PermanentFilter | null {
  // Un type de créature (« Elemental you control », « Plant creatures you control », « Elementals you control »).
  const sub = /^([A-Z][a-z]+?)s?( creatures?)?( you control| an opponent controls| you don't control)?$/.exec(text.trim());
  if (sub && !/^(Artifact|Battle|Creature|Enchantment|Land|Planeswalker|Permanent|Legendary|Basic|Plains|Island|Swamp|Mountain|Forest|Token|Nonland|Noncreature|Other|Attacking|Blocking|Tapped|Untapped)$/.test(sub[1]!)) {
    const base = parsePermanentFilter(`creature${sub[3] ?? ""}`);
    return base ? { ...base, subtype: sub[1]! } : null;
  }
  let t = text.trim().toLowerCase();
  const filter: PermanentFilter = { types: [], notTypes: [] };
  const total = / with total power and toughness (\d+) or less$/.exec(t);
  if (total) {
    filter.maxTotalPT = parseInt(total[1]!, 10);
    t = t.slice(0, total.index);
  }
  const suffixes: [RegExp, PermanentFilter["controller"]][] = [
    [/ (an opponent controls|you don't control)$/, "notYou"],
    [/ you control$/, "you"],
  ];
  for (const [re, controller] of suffixes) {
    if (re.test(t)) {
      t = t.replace(re, "");
      filter.controller = controller;
    }
  }
  // « nonartifact, nonblack creature » : des adjectifs, pas une liste de choix.
  const adjectives = /^((?:non[a-z]+, )+non[a-z]+) (creature|permanent|artifact|enchantment|land)$/.exec(t);
  if (adjectives) {
    const noun = adjectives[2]!;
    const out: PermanentFilter = { ...filter, types: noun === "permanent" ? [] : [noun] };
    for (const w of adjectives[1]!.split(", ")) {
      const word = w.slice(3);
      if (COLORS[word]) (out.notColors ??= []).push(COLORS[word]!);
      else if (CARD_TYPES.includes(word)) out.notTypes.push(word);
      else return null;
    }
    return out;
  }
  const basic = /^(plains|island|swamp|mountain|forest)$/.exec(t);
  if (basic) return { ...filter, types: ["land"], subtype: basic[1]!.charAt(0).toUpperCase() + basic[1]!.slice(1) };
  const state = /^(attacking|blocking|tapped|untapped) /.exec(t);
  if (state) {
    filter.state = state[1] as PermanentFilter["state"];
    t = t.slice(state[0].length);
  }
  if (/^legendary [a-z]/.test(t)) {
    filter.legendary = true;
    t = t.slice("legendary ".length);
  }
  const words = t.replace(/,? or /g, ",").split(/,\s*/).map((w) => w.trim()).filter(Boolean);
  if (words.length === 0) return null;
  for (const raw of words) {
    // Pluriel des balayages (« creatures », « nonland permanents »).
    let w = raw.replace(/s$/, "");
    // « nonland permanent », « noncreature artifact », « permanent ».
    const parts = w.split(" ");
    if (parts.length > 2) return null;
    if (parts.length === 2) {
      const [mod, base] = parts as [string, string];
      if (!mod.startsWith("non") || ![...CARD_TYPES, "legendary"].includes(mod.slice(3))) return null;
      filter.notTypes.push(mod.slice(3));
      w = base;
    }
    if (w.startsWith("non") && CARD_TYPES.includes(w.slice(3))) {
      filter.notTypes.push(w.slice(3));
      continue;
    }
    if (w === "permanent") continue;
    if (!CARD_TYPES.includes(w)) return null;
    filter.types.push(w);
  }
  return filter;
}

/** « creature », « artifact or land »… ; `null` si le texte n'est pas compris. */
export function parsePermanentFilterText(text: string): PermanentFilter | null {
  return parsePermanentFilter(text);
}

export function permanentLabel(f: PermanentFilter): string {
  const labels: Record<string, string> = {
    artifact: "artefact",
    battle: "bataille",
    creature: "créature",
    enchantment: "enchantement",
    land: "terrain",
    planeswalker: "planeswalker",
    legendary: "légendaire",
  };
  let label = f.subtype ? (f.types.includes("creature") ? `créature ${f.subtype}` : f.subtype) : f.types.length > 0 ? f.types.map((t) => labels[t]).join(" ou ") : "permanent";
  if (f.anySubtype?.length) label += ` ${f.anySubtype.join(", ").replace(/, ([^,]+)$/, " ou $1")}`;
  if (f.legendary) label += " légendaire";
  if (f.notTypes.length > 0) label += ` non-${f.notTypes.map((t) => labels[t]).join(", non-")}`;
  if (f.notColors?.length) label += ` non-${f.notColors.map((c) => ({ W: "blanche", U: "bleue", B: "noire", R: "rouge", G: "verte" })[c] ?? c).join(", non-")}`;
  if (f.state) label += { attacking: " attaquant(e)", blocking: " bloqueur(se)", tapped: " engagé(e)", untapped: " dégagé(e)" }[f.state];
  if (f.controller === "you") label += " que tu contrôles";
  if (f.controller === "notYou") label += " d'un adversaire";
  if (f.maxTotalPT !== undefined) label += ` (force + endurance ≤ ${f.maxTotalPT})`;
  return label;
}

/** « target player », « target opponent ». */
function playerTarget(text: string): TargetSpec {
  return /opponent/i.test(text) ? { label: "adversaire", player: true, opponent: true } : { label: "joueur", player: true };
}

const neg = (a: Amount): Amount => (a === "X" ? "-X" : a === "event" ? "-event" : -(a as number));

/**
 * Phrases propres aux capacités déclenchées, qui parlent de l'événement
 * (« they lose 2 life », « you gain that much life »…). `null` si la phrase
 * n'en est pas une.
 */
function parseTriggerSentence(s: string, target: (spec: TargetSpec) => number, lastTarget: () => number): Effect[] | null {
  const much = (text: string): Amount => (/that much/i.test(text) ? "event" : amount(text));
  const AMT = `(${NUM.slice(1, -1)}|that much)`;
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^(?:they|that player) loses? ${AMT} life and draws? ${NUM} cards?$`, "i").exec(s))) {
    return [
      { type: "life", who: "event", amount: neg(much(m[1]!)) },
      { type: "draw", who: "event", count: amount(m[2]!) },
    ];
  }
  if ((m = new RegExp(`^(?:they|that player) loses? ${AMT} life$`, "i").exec(s))) {
    return [{ type: "life", who: "event", amount: neg(much(m[1]!)) }];
  }
  if ((m = new RegExp(`^that player draws ${NUM} (?:additional )?cards?$`, "i").exec(s))) {
    return [{ type: "draw", who: "event", count: amount(m[1]!) }];
  }
  if ((m = /^(?:return|put) (.+? from (?:your|a) graveyard) (?:to|onto|on top of) (the battlefield|your hand|your library)(?: under your control)?$/i.exec(s))) {
    const filter = parseGraveyardTarget(m[1]!);
    if (filter) {
      const to = /hand/i.test(m[2]!) ? "hand" : /library/i.test(m[2]!) ? "libraryTop" : "battlefield";
      return [{ type: "fromGraveyard", target: target({ label: graveyardLabel(filter), graveyard: filter }), to }];
    }
  }
  if ((m = /^(?:you )?draw that many cards$/i.exec(s))) return [{ type: "draw", who: "you", count: "event" }];
  if (/^(?:you )?draw an additional card$/i.test(s)) return [{ type: "draw", who: "you", count: 1 }];
  if (/^discard your hand$/i.test(s)) return [{ type: "discardHand", who: "you" }];
  if (/^sacrifice ~$/i.test(s)) return [{ type: "sacrificeSelf" }];
  if (/^shuffle ~ and your graveyard into (?:their|its) owner's library$/i.test(s)) return [{ type: "shuffleSelfAndGraveyard" }];
  if (/^exile all graveyards$/i.test(s)) return [{ type: "exileGraveyards" }];
  if (/^each opponent mills cards equal to the number of cards in their hand$/i.test(s)) return [{ type: "mill", who: "opponents", count: "theirHand" }];
  if ((m = new RegExp(`^(target player|each opponent|you) mills? ${NUM} cards?$`, "i").exec(s))) {
    const w = m[1]!.toLowerCase();
    const who: Who = w === "you" ? "you" : w === "each opponent" ? "opponents" : { target: target({ label: "joueur", player: true }) };
    return [{ type: "mill", who, count: amount(m[2]!) }];
  }
  if ((m = new RegExp(`^untap up to ${NUM} lands$`, "i").exec(s))) {
    const n = amount(m[1]!);
    if (typeof n === "number") return [{ type: "untapLands", count: n }];
  }
  if ((m = new RegExp(`^~ deals ${NUM} damage to each other creature you control$`, "i").exec(s))) {
    return [{ type: "damageEach", who: "yourOtherCreatures", amount: amount(m[1]!) }];
  }
  if ((m = /^return (?:it|that card) to the battlefield( tapped)? under (your|its owner's) control$/i.exec(s))) {
    return [{ type: "returnEventCard", tapped: !!m[1], owner: /owner/i.test(m[2]!) }];
  }
  if ((m = new RegExp(`^~ deals ${NUM} damage to that player$`, "i").exec(s))) {
    return [{ type: "damage", target: "event", amount: amount(m[1]!) }];
  }
  if ((m = new RegExp(`^you gain ${AMT} life$`, "i").exec(s))) {
    return [{ type: "life", who: "you", amount: much(m[1]!) }];
  }
  if ((m = new RegExp(`^(target player|target opponent|each opponent) loses ${AMT} life(?: and you gain ${AMT} life)?$`, "i").exec(s))) {
    const who: Who = /each/i.test(m[1]!) ? "opponents" : { target: target(playerTarget(m[1]!)) };
    const effects: Effect[] = [{ type: "life", who, amount: neg(much(m[2]!)) }];
    if (m[3]) effects.push({ type: "life", who: "you", amount: much(m[3]) });
    return effects;
  }
  if (/^you gain life equal to the damage dealt this way$/i.test(s)) return [{ type: "life", who: "you", amount: "dealt" }];
  if (/^you gain life equal to the life lost this way$/i.test(s)) return [{ type: "life", who: "you", amount: "lost" }];
  if (/^each opponent loses life equal to the life they lost this turn$/i.test(s)) return [{ type: "life", who: "opponents", amount: "-lostThisTurn" }];
  if (/^each opponent loses X life, where X is your devotion to black$/i.test(s)) return [{ type: "life", who: "opponents", amount: "-devotion" }];
  if (/^you lose life equal to that permanent's mana value$/i.test(s) && lastTarget() >= 0) return [{ type: "loseLifeManaValue", target: lastTarget() }];
  if (/^target player draws cards equal to half the number of cards in their library and loses half their life$/i.test(s)) {
    return [{ type: "halfLibraryHalfLife", who: { target: target({ label: "joueur", player: true }) } }];
  }
  if (/^you gain X life and draw X cards, where X is the number of permanents you own that your opponents control$/i.test(s)) {
    return [
      { type: "life", who: "you", amount: "given" },
      { type: "draw", who: "you", count: "given" },
    ];
  }
  if ((m = new RegExp(`^~ deals ${NUM} damage to you$`, "i").exec(s))) return [{ type: "damage", target: "you", amount: amount(m[1]!) }];
  if ((m = /^(target opponent|target player other than ~'s owner|target player|an opponent) gains control of (~|it|target (.+?))(?: and puts an? (\w+) counter on it)?$/i.exec(s))) {
    const who = m[1]!.toLowerCase();
    const player =
      who === "an opponent"
        ? target({ label: "adversaire", player: true, opponent: true, choice: true })
        : /other than/.test(who)
          ? target({ label: "joueur autre que le propriétaire", player: true, notOwner: true })
          : target(playerTarget(who));
    if (!m[3]) {
      const counter: Effect[] = m[4] ? [{ type: "counterSelf", kind: counterKind(m[4]), count: 1 }] : [];
      return [{ type: "gainControl", permanent: "self", player }, ...counter];
    }
    if (m[4]) return null;
    const filter = parsePermanentFilter(m[3]);
    if (!filter) return null;
    return [{ type: "gainControl", permanent: target({ label: permanentLabel(filter), permanent: filter }), player }];
  }
  if ((m = /^exchange control of two target (.+?)( controlled by different players| that share a permanent type)?$/i.exec(s))) {
    const f = parsePermanentFilter(m[1]!);
    if (!f) return null;
    const relation: ExchangeRelation | undefined = !m[2] ? undefined : /different/i.test(m[2]) ? "differentPlayers" : "sharePermanentType";
    const a = target({ label: permanentLabel(f), permanent: f });
    const b = target({ label: permanentLabel(f), permanent: f });
    return [{ type: "exchangeControl", a, b, ...(relation ? { relation } : {}) }];
  }
  if ((m = /^exchange control of target (.+?) and target (.+?)( that shares a card type with it| with equal or lesser mana value)?$/i.exec(s))) {
    const fa = parsePermanentFilter(m[1]!);
    const fb = parsePermanentFilter(m[2]!);
    if (!fa || !fb) return null;
    const relation: ExchangeRelation | undefined = !m[3] ? undefined : /card type/i.test(m[3]) ? "shareCardType" : "lesserManaValue";
    const a = target({ label: permanentLabel(fa), permanent: fa });
    const b = target({ label: permanentLabel(fb), permanent: fb });
    return [{ type: "exchangeControl", a, b, ...(relation ? { relation } : {}) }];
  }
  if ((m = new RegExp(`^if you control neither creature, draw ${NUM} cards?$`, "i").exec(s))) {
    const b = lastTarget();
    if (b < 1) return null;
    return [{ type: "drawIfNeither", a: b - 1, b, count: amount(m[1]!) as number }];
  }
  if ((m = /^if you have (\d+) or more life, you win the game$/i.exec(s))) return [{ type: "winIf", life: parseInt(m[1]!, 10) }];
  if ((m = new RegExp(`^if you have exactly (${NUM.slice(1, -1)}|thirteen) cards in your hand, you win the game$`, "i").exec(s))) {
    const n = m[1]!.toLowerCase() === "thirteen" ? 13 : (amount(m[1]!) as number);
    return [{ type: "winIf", handExactly: n }];
  }
  if (/^you lose the game$/i.test(s)) return [{ type: "loseGame" }];
  if ((m = new RegExp(`^each opponent creates ${NUM} (tapped )?(.+)$`, "i").exec(s))) {
    const token = parseToken(m[3]!);
    if (token) return [{ type: "token", count: amount(m[1]!), token, tapped: !!m[2], forOpponents: true }];
  }
  if (/^you gain 1 life for each card in your hand$/i.test(s)) return [{ type: "life", who: "you", amount: "hand" }];
  if ((m = new RegExp(`^(each opponent|each player) draws ${NUM} cards?$`, "i").exec(s))) {
    return [{ type: "draw", who: /opponent/i.test(m[1]!) ? "opponents" : "all", count: amount(m[2]!) }];
  }
  if ((m = new RegExp(`^its controller draws ${NUM} cards?$`, "i").exec(s)) && lastTarget() >= 0) {
    return [{ type: "draw", who: { controllerOf: lastTarget() }, count: amount(m[1]!) }];
  }
  if (/^return ~ from your graveyard to your hand$/i.test(s)) return [{ type: "returnSelf" }];
  if ((m = /^~ gets ([+-]\d+)\/([+-]\d+) until end of turn$/i.exec(s))) {
    return [{ type: "pumpSelf", power: parseInt(m[1]!, 10), toughness: parseInt(m[2]!, 10) }];
  }
  // « Creatures you control gain lifelink until end of turn », « Permanents you control gain hexproof and indestructible… »,
  // « Legendary creatures you control get +1/+0 and gain indestructible… ».
  if ((m = /^(other )?(.+?) you control (?:get ([+-]\d+)\/([+-]\d+)(?: and gain (.+?))?|gain (.+?)) until (end of turn|your next turn)$/i.exec(s)) && !/\btarget\b/i.test(m[2]!)) {
    const filter = parsePermanentFilter(`${m[2]!} you control`);
    const keywords = keywordList(m[5] ?? m[6] ?? "");
    if (filter && keywords.every((k) => KEYWORD_HELP[k]) && (!m[3] || filter.types.includes("creature"))) {
      return [
        {
          type: "grantAll",
          filter,
          keywords,
          ...(m[3] ? { power: parseInt(m[3], 10), toughness: parseInt(m[4]!, 10) } : {}),
          ...(m[1] ? { others: true } : {}),
          ...(/next turn/i.test(m[7]!) ? { untilNextTurn: true } : {}),
        },
      ];
    }
  }
  // Selvala : approximation, les X mana sont tous de la couleur choisie.
  if (/^add x mana in any combination of colors, where x is the greatest power among creatures you control$/i.test(s)) {
    return [{ type: "manaAny", count: "greatestPower" }];
  }
  if ((m = /^add (one|two|three) mana of any (?:one )?color$/i.exec(s))) {
    return [{ type: "manaAny", count: amount(m[1]!) as number }];
  }
  if ((m = /^sacrifice (?:a|an) (.+)$/i.exec(s))) {
    const filter = parsePermanentFilter(m[1]!);
    if (filter) return [{ type: "sacrifice", filter: { ...filter, controller: "you" } }];
  }
  if ((m = new RegExp(`^put ${NUM} (\\+1/\\+1|-1/-1|\\w+) counters? on ~$`, "i").exec(s))) {
    return [{ type: "counterSelf", kind: counterKind(m[2]!), count: amount(m[1]!) as number }];
  }
  if ((m = /^~ deals damage to you equal to the number of (\w+) counters on it$/i.exec(s))) {
    return [{ type: "selfCounterDamage", kind: counterKind(m[1]!) }];
  }
  if ((m = /^it gets \+(\d+)\/\+(\d+) until end of turn$/i.exec(s))) {
    return [{ type: "pumpEvent", power: parseInt(m[1]!, 10), toughness: parseInt(m[2]!, 10) }];
  }
  if ((m = /^sacrifice another (.+)$/i.exec(s))) {
    const filter = parsePermanentFilter(m[1]!);
    if (filter) return [{ type: "sacrifice", filter: { ...filter, controller: "you" }, another: true }];
  }
  if (/^tap ~$/i.test(s)) return [{ type: "tapSelf" }];
  if (/^untap ~$/i.test(s)) return [{ type: "untapSelf" }];
  if ((m = /^(target opponent|target player) creates a token that's a copy of (?:it|~)$/i.exec(s))) {
    return [{ type: "copyToken", player: target(playerTarget(m[1]!)) }];
  }
  if (/^that player gets an additional upkeep step after this step$/i.test(s)) return [{ type: "extraUpkeep" }];
  // Bronze Bombshell : « that player sacrifices it. »
  if (/^that player sacrifices (?:it|~)$/i.test(s)) return [{ type: "sacrificeSelf" }];
  return null;
}

/**
 * « the number of creatures you control », « creature on the battlefield »… :
 * un décompte de permanents (ceux du lanceur, ou de tous les joueurs).
 */
function countOf(text: string): Amount | null {
  const t = text.trim();
  if (/^cards? in your hand$/i.test(t)) return "hand";
  const onBattlefield = /^(.+?) on the battlefield$/i.exec(t);
  const filter = parsePermanentFilter(onBattlefield ? onBattlefield[1]! : t);
  if (!filter) return null;
  // Sans « you control » ni « on the battlefield », le moteur compte les permanents du lanceur (comme avant).
  return { perPermanent: filter, ...(onBattlefield && !filter.controller ? { all: true } : {}) };
}

/**
 * Ce qui suit « equal to » : « its power » (la dernière cible), « ~'s power »
 * (la source), « the greatest toughness among creatures you control »,
 * « the number of … ». `null` si non compris.
 */
function quantityOf(text: string, lastTarget: number): Amount | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(its|that creature's|~'s) (power|toughness)$/i.exec(t))) {
    const stat = m[2]!.toLowerCase() as "power" | "toughness";
    if (m[1]!.toLowerCase() === "~'s") return { q: { stat, of: "self" } };
    return lastTarget >= 0 ? { q: { stat, of: lastTarget } } : null;
  }
  if ((m = /^the greatest (power|toughness) among (.+)$/i.exec(t))) {
    const filter = parsePermanentFilter(m[2]!.replace(/ on the battlefield$/i, ""));
    return filter ? { q: { greatest: m[1]!.toLowerCase() as "power" | "toughness", filter } } : null;
  }
  if ((m = /^the number of (.+)$/i.exec(t))) return countOf(m[1]!);
  return null;
}

const negate = (a: Amount): Amount | null => (typeof a === "object" ? { ...a, negative: !a.negative } : a === "hand" ? null : neg(a));

/**
 * Quantités variables : « equal to … », « that many », « for each … »
 * (pioche, points de vie, jetons, blessures). `null` si la phrase n'en est pas une.
 */
function parseVariableSentence(s: string, target: (spec: TargetSpec) => number, lastTarget: () => number): Effect[] | null {
  let m: RegExpExecArray | null;
  const NAMED = "(Treasure|Food|Clue|Blood)";
  const named = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  // Points de vie : « Its controller gains life equal to its power. », « You gain life equal to the greatest power among… »
  if ((m = /^(its controller|you|target player|target opponent|each opponent|each player) (gains?|loses?) life equal to (.+)$/i.exec(s))) {
    const w = m[1]!.toLowerCase();
    if (w === "its controller" && lastTarget() < 0) return null;
    const q = quantityOf(m[3]!, lastTarget());
    const amt = q && (/lose/i.test(m[2]!) ? negate(q) : q);
    if (!amt) return null;
    const who: Who =
      w === "you" ? "you" : w === "its controller" ? { controllerOf: lastTarget() } : w === "each opponent" ? "opponents" : w === "each player" ? "all" : { target: target(playerTarget(w)) };
    return [{ type: "life", who, amount: amt }];
  }
  // Pioche : « Draw cards equal to the greatest toughness among creatures you control. »
  if ((m = /^(?:(you|target player) )?draws? cards equal to (.+)$/i.exec(s))) {
    const q = quantityOf(m[2]!, lastTarget());
    if (!q) return null;
    const who: Who = /target/i.test(m[1] ?? "") ? { target: target({ label: "joueur", player: true }) } : "you";
    return [{ type: "draw", who, count: q }];
  }
  // « Draw a card for each creature you control. »
  if ((m = /^(?:(you|target player) )?draws? a card for each (.+)$/i.exec(s))) {
    const q = countOf(m[2]!);
    if (!q) return null;
    const who: Who = /target/i.test(m[1] ?? "") ? { target: target({ label: "joueur", player: true }) } : "you";
    return [{ type: "draw", who, count: q }];
  }
  // « You gain 2 life for each creature you control. », « Each opponent loses 1 life for each … »
  if ((m = new RegExp(`^(you|target player|target opponent|each opponent) (gains?|loses?) ${NUM} life for each (.+)$`, "i").exec(s))) {
    const n = amount(m[3]!);
    const q = countOf(m[4]!);
    if (typeof n !== "number" || !q || typeof q !== "object") return null;
    const w = m[1]!.toLowerCase();
    const who: Who = w === "you" ? "you" : w === "each opponent" ? "opponents" : { target: target(playerTarget(w)) };
    return [{ type: "life", who, amount: { ...q, times: n, ...(/lose/i.test(m[2]!) ? { negative: true } : {}) } }];
  }
  // Jetons : « create that many Treasure tokens », « create a number of 1/1 red Goblin creature tokens equal to ~'s power ».
  if ((m = new RegExp(`^(?:you )?create that many (tapped )?${NAMED} tokens$`, "i").exec(s))) {
    return [{ type: "namedToken", name: named(m[2]!), count: "event", tapped: !!m[1] }];
  }
  if ((m = /^(?:you )?create that many (tapped )?(.+ tokens)$/i.exec(s)) && parseToken(m[2]!)) {
    return [{ type: "token", count: "event", token: parseToken(m[2]!)!, tapped: !!m[1] }];
  }
  if ((m = /^(?:you )?create a number of (tapped )?(.+? tokens) equal to (.+)$/i.exec(s))) {
    const q = quantityOf(m[3]!, lastTarget());
    if (!q) return null;
    const nm = new RegExp(`^${NAMED} tokens$`, "i").exec(m[2]!);
    if (nm) return [{ type: "namedToken", name: named(nm[1]!), count: q, tapped: !!m[1] }];
    const token = parseToken(m[2]!);
    return token ? [{ type: "token", count: q, token, tapped: !!m[1] }] : null;
  }
  if ((m = new RegExp(`^(?:you )?create (?:a|an|one) (tapped )?${NAMED} token for each (.+)$`, "i").exec(s))) {
    const q = countOf(m[3]!);
    return q ? [{ type: "namedToken", name: named(m[2]!), count: q, tapped: !!m[1] }] : null;
  }
  // Blessures : « ~ deals damage equal to its power to target creature », « ~ deals 2 damage to each opponent for each … »
  if ((m = /^~ deals damage equal to (.+?) to (.+)$/i.exec(s)) || (m = /^~ deals damage to (.+?) equal to (.+)$/i.exec(s))) {
    const [qText, who] = /^~ deals damage equal to/i.test(s) ? [m[1]!, m[2]!] : [m[2]!, m[1]!];
    const q = quantityOf(qText, lastTarget());
    if (!q) return null;
    if (/^each opponent$/i.test(who)) return [{ type: "damageEach", who: "opponents", amount: q }];
    const spec = damageTarget(who);
    return spec ? [{ type: "damage", target: target(spec), amount: q }] : null;
  }
  if ((m = new RegExp(`^~ deals ${NUM} damage to (.+?) for each (.+)$`, "i").exec(s))) {
    const n = amount(m[1]!);
    const q = countOf(m[3]!);
    if (typeof n !== "number" || !q || typeof q !== "object") return null;
    const per: Amount = { ...q, times: n };
    if (/^each opponent$/i.test(m[2]!)) return [{ type: "damageEach", who: "opponents", amount: per }];
    const spec = damageTarget(m[2]!);
    return spec ? [{ type: "damage", target: target(spec), amount: per }] : null;
  }
  return null;
}

/** Nom d'un type de marqueur, comme l'affiche la table (« charge », « âge »…). */
const COUNTER_KINDS: Record<string, string> = { age: "âge", lore: "savoir", loyalty: "loyauté", charge: "charge", time: "temps", oil: "huile", stun: "étourdissement" };
function counterKind(word: string): string {
  return COUNTER_KINDS[word.toLowerCase()] ?? word.toLowerCase();
}

/** Cibles de blessures : « any target », « target creature or planeswalker »… */
function damageTarget(text: string): TargetSpec | null {
  const t = text.toLowerCase();
  if (t === "any target") {
    return { label: "n'importe quelle cible", player: true, permanent: { types: ["creature", "planeswalker", "battle"], notTypes: [] } };
  }
  if (t === "target player" || t === "target opponent") return playerTarget(t);
  if (t === "target player or planeswalker" || t === "target opponent or planeswalker") {
    return { label: "joueur ou planeswalker", player: true, permanent: { types: ["planeswalker"], notTypes: [] } };
  }
  const m = /^target (.+)$/.exec(t);
  const filter = m && parsePermanentFilter(m[1]!);
  return filter ? { label: permanentLabel(filter), permanent: filter } : null;
}

function parseToken(text: string): TokenSpec | null {
  // « 1/1 white Soldier creature token », « 2/2 black Zombie creature tokens with deathtouch ».
  const m = /^(\d+|x)\/(\d+|x) (.+?) (artifact )?creature tokens?(?: with (.+))?$/i.exec(text);
  if (!m) return null;
  const words = m[3]!.split(/ and |\s+/).filter(Boolean);
  const colors: string[] = [];
  const subtypes: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower === "colorless") continue;
    if (lower === "artifact") return null;
    if (COLORS[lower]) colors.push(COLORS[lower]!);
    else if (/^[A-Z]/.test(w)) subtypes.push(w);
    else return null;
  }
  const keywords = m[5] ? m[5].split(/, and |, | and /).map((k) => k.trim().replace(/^\w/, (c) => c.toUpperCase())) : [];
  return { power: m[1]!.toUpperCase(), toughness: m[2]!.toUpperCase(), colors, subtypes, keywords, artifact: !!m[4] };
}

/** Lit les effets d'un éphémère ou d'un rituel. */
export function parseSpellEffects(oracleText: string, cardName: string, options: { alternative?: boolean } = {}): SpellEffects {
  // « Choose one or more — • Sell Contraband — Create a Treasure token. … • … »
  // Akroma's Will : « Choose one. If you control a commander as you cast this spell, you may choose both instead. • … »
  const modal = /^(.*?)\bchoose (one|two|three|one or more|any number)(?: ?(?:—|-)|(\. if you control a commander as you cast (?:this spell|~), you may choose both instead\.))\s*(•.+)$/is.exec(
    joinModes(oracleText).replace(/\([^)]*\)/g, ""),
  );
  if (modal) {
    const before = modal[1]!.trim();
    const result = before ? parseSpellEffects(before, cardName, options) : { targets: [], effects: [], unknown: [] };
    const kind = modal[2]!.toLowerCase();
    const min = kind === "two" ? 2 : kind === "three" ? 3 : kind === "any number" ? 0 : 1;
    const list: { label: string; effects: Effect[]; targets?: TargetSpec[] }[] = [];
    const bullets = modal[4]!.split("•").map((b) => b.trim()).filter(Boolean);
    for (const bullet of bullets) {
      const named = /^([^—.]+?) — (.+)$/s.exec(bullet);
      const parsed = parseSpellEffects(named ? named[2]! : bullet, cardName, options);
      if (parsed.unknown.length > 0 || parsed.effects.length === 0) result.unknown.push(bullet);
      list.push({ label: bullet, effects: parsed.effects, ...(parsed.targets.length > 0 ? { targets: parsed.targets } : {}) });
    }
    const max = kind === "one or more" || kind === "any number" ? list.length : min;
    result.modes = { min, max, list, ...(modal[3] ? { maxWithCommander: list.length } : {}) };
    return result;
  }
  const result: SpellEffects = { targets: [], effects: [], unknown: [] };
  const target = (spec: TargetSpec) => result.targets.push(spec) - 1;
  // Texte de rappel entre parenthèses, nom de la carte remplacé par « ~ ».
  // Nom complet, faces d'une carte double, et nom court d'un légendaire (« Vito » pour « Vito, Thorn of the Dusk Rose »).
  const text = selfToTilde(oracleText, cardName);
  const sentences = text
    .split("\n")
    .flatMap((line) => line.split(/(?<=\.)\s+/))
    // « Scry 2, then draw two cards. »
    .flatMap((s) => s.split(/,\s*then\s+/i))
    .map((s) => s.trim())
    .filter(Boolean);

  let wheel: "event" | "all" | null = null;
  let revealing: Extract<Effect, { type: "shuffleIntoLibrary" }> | null = null;
  let approach = false;
  let keepOne = false;
  // Les phrases qui complètent un effet déjà lu (Living Death, Cavalier of Thorns, Tyrant of Discord).
  const followUps: RegExp[] = [];
  let pendingIf: { from: number; cond: NonNullable<Effect["ifControls"]> } | null = null;
  let pendingMainPhase: number | null = null;
  const flushIf = () => {
    if (pendingIf) for (const e of result.effects.slice(pendingIf.from)) e.ifControls = pendingIf.cond;
    if (pendingMainPhase !== null) for (const e of result.effects.slice(pendingMainPhase)) e.ifMainPhase = true;
    pendingIf = null;
    pendingMainPhase = null;
  };
  for (const sentence of sentences) {
    flushIf();
    let s = sentence.replace(/\.$/, "");
    if (HARMLESS.some((re) => re.test(sentence))) continue;
    const followUp = followUps.findIndex((re) => re.test(s));
    if (followUp >= 0) {
      followUps.splice(followUp, 1);
      continue;
    }
    let m: RegExpExecArray | null;
    let dig: RegExpExecArray | null;
    // « If you control eight or more lands, draw a card. »
    if ((m = /^if you control (\w+) or more (.+?), (.+)$/i.exec(s))) {
      const filter = parsePermanentFilter(`${m[2]!} you control`);
      const n = amount(m[1]!);
      if (filter && typeof n === "number" && Number.isInteger(n)) {
        pendingIf = { from: result.effects.length, cond: { filter, atLeast: n } };
        s = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1);
      }
    }

    // Addendum : « If you cast this spell during your main phase, … » (Unbreakable Formation).
    if ((m = /^(?:addendum — )?if you cast ~ during your main phase, (.+)$/i.exec(s))) {
      pendingMainPhase = result.effects.length;
      s = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    }
    // « … put a +1/+1 counter on each of those creatures and they gain vigilance until end of turn » : les créatures de l'effet précédent.
    const previous = result.effects.at(-1);
    if (
      previous?.type === "grantAll" &&
      (m = /^put a \+1\/\+1 counter on each of those (?:creatures|permanents)(?: and they gain (.+?) until end of turn)?$/i.exec(s)) &&
      keywordList(m[1] ?? "").every((k) => KEYWORD_HELP[k])
    ) {
      result.effects.push({ type: "counterAll", filter: previous.filter, kind: "+1/+1", count: 1 });
      if (m[1]) result.effects.push({ type: "grantAll", filter: previous.filter, keywords: keywordList(m[1]) });
      continue;
    }

    if ((m = /^you may pay ((?:\{[^}]+\})+) rather than pay ~'s mana cost$/i.exec(s))) {
      result.alternativeCost = m[1]!;
      continue;
    }
    // « If the {1}{B} cost was paid, an opponent draws a card. » : seulement quand le coût alternatif est payé.
    if ((m = /^if the ((?:\{[^}]+\})+) cost was paid, (.+)$/i.exec(s))) {
      if (!options.alternative) continue;
      s = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1);
    }
    if ((m = /^until end of turn, whenever a player taps an? (Plains|Island|Swamp|Mountain|Forest) for mana, that player adds an additional \{([WUBRG])\}$/i.exec(s))) {
      result.effects.push({ type: "manaBonus", subtype: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase(), mana: m[2]!.toUpperCase() });
      continue;
    }
    if ((m = /^search your library for an? ((?:basic )?(?:land|creature|artifact|enchantment|instant|sorcery|planeswalker) )?card(?:,| and) (reveal it, )?(?:then )?put (?:it|that card) (into your hand|onto the battlefield)$/i.exec(s))) {
      const types = (m[1] ?? "").trim().toLowerCase().replace(/^basic /, "").split(" ").filter(Boolean);
      result.effects.push({ type: "search", types, to: /hand/i.test(m[3]!) ? "hand" : "battlefield", reveal: !!m[2], ...(/^basic /i.test(m[1] ?? "") ? { basic: true } : {}) });
      continue;
    }
    // Fetchlands, Farseek, Rampant Growth, Cultivate, Land Tax : terrains par type ou sous-type.
    const LAND_WORDS = "(?:basic land|land|plains|island|swamp|mountain|forest)";
    if (
      (m = new RegExp(
        `^search your library for (an?|up to (?:one|two|three)) ((?:${LAND_WORDS})(?:(?:,| or|, or) ${LAND_WORDS})*) cards?,? (?:and )?(reveal (?:it|them|those cards), )?(?:then )?put (?:it|that card|them|those cards) (into your hand|onto the battlefield( tapped)?)$`,
        "i",
      ).exec(s))
    ) {
      const words = m[2]!.toLowerCase().split(/,? or |, /).map((w) => w.trim()).filter(Boolean);
      const basic = words.every((w) => w === "basic land");
      const types = basic ? ["land"] : words.map((w) => w.replace(/^basic /, ""));
      const n = /^up to/i.test(m[1]!) ? (amount(m[1]!.split(" ").at(-1)!) as number) : 1;
      result.effects.push({
        type: "search",
        types,
        to: /hand/i.test(m[4]!) ? "hand" : "battlefield",
        reveal: !!m[3],
        ...(m[5] ? { tapped: true } : {}),
        ...(basic ? { basic: true } : {}),
        ...(n > 1 ? { count: n } : {}),
      });
      continue;
    }
    if ((m = /^search your library for up to (two|three) basic land cards, reveal those cards, put one onto the battlefield tapped and the others? into your hand$/i.exec(s))) {
      result.effects.push({ type: "search", types: ["land"], basic: true, to: "battlefield", tapped: true, reveal: true, count: amount(m[1]!) as number, split: true });
      continue;
    }
    if (/^flip a coin$/i.test(s)) continue;
    if ((m = /^if you lose the flip, ~ deals (\d+) damage to you$/i.exec(s))) {
      result.effects.push({ type: "coinFlipDamage", amount: parseInt(m[1]!, 10) });
      continue;
    }
    // Path to Exile : « Its controller may search their library for a basic land card, put that card onto the battlefield tapped ».
    if ((m = /^its controller may search their library for an? (basic land|land) card, put (?:it|that card) onto the battlefield( tapped)?$/i.exec(s)) && result.targets.length > 0) {
      result.effects.push({ type: "search", types: ["land"], to: "battlefield", reveal: true, who: { controllerOf: result.targets.length - 1 }, ...(m[2] ? { tapped: true } : {}) });
      continue;
    }
    if (/^shuffle$/i.test(s)) {
      const last = result.effects.at(-1);
      result.effects.push({ type: "shuffle", ...(last?.type === "search" && last.who ? { who: last.who } : {}) });
      continue;
    }
    if ((m = /^(target opponent|target player|each opponent) reveals (?:their|his or her) hand$/i.exec(s))) {
      const who: Who = /each/i.test(m[1]!) ? "opponents" : { target: target(playerTarget(m[1]!)) };
      result.effects.push({ type: "revealHand", who });
      continue;
    }
    if ((m = /^you choose an? ((?:nonland|creature|planeswalker|artifact|enchantment|instant|sorcery|land)(?: or (?:creature|planeswalker|artifact|enchantment|instant|sorcery|land))* )?card from it$/i.exec(s))) {
      const reveal = [...result.effects].reverse().find((e) => e.type === "revealHand");
      if (reveal && reveal.type === "revealHand") {
        result.effects.push({ type: "chooseDiscard", who: reveal.who, types: (m[1] ?? "").trim().toLowerCase().split(/ or /).filter(Boolean) });
        continue;
      }
    }
    if (/^that player discards that card$/i.test(s) && result.effects.at(-1)?.type === "chooseDiscard") continue;
    if ((m = /^choose target (.+)$/i.exec(s))) {
      const filter = parsePermanentFilter(m[1]!);
      if (filter) {
        target({ label: permanentLabel(filter), permanent: filter });
        continue;
      }
    }
    // Subterfuge : « target creature gains flying and "Whenever this creature deals combat damage…" until end of turn ».
    if ((m = /^target creature gains ([a-z ]+?) and "((?:When|Whenever) .+?)\.?" until end of turn\.?$/i.exec(sentence.trim()))) {
      const t = target({ label: "créature", permanent: { types: ["creature"], notTypes: [] } });
      result.effects.push({ type: "pumpTarget", target: t, power: 0, toughness: 0, keywords: keywordList(m[1]!) }, { type: "grantTrigger", target: t, text: `${m[2]!}.` });
      continue;
    }
    if ((m = /^until end of turn, (that creature|target creature) gains "(When .+?)\.?"\.?$/i.exec(sentence.trim()))) {
      const t = /^target/i.test(m[1]!) ? target({ label: "créature", permanent: { types: ["creature"], notTypes: [] } }) : result.targets.length - 1;
      if (t >= 0) {
        result.effects.push({ type: "grantTrigger", target: t, text: `${m[2]!}.` });
        continue;
      }
    }
    if ((m = new RegExp(`^an opponent draws ${NUM} cards?$`, "i").exec(s))) {
      const who = { target: target({ label: "adversaire qui pioche", player: true, opponent: true, choice: true }) };
      result.effects.push({ type: "draw", who, count: amount(m[1]!) });
      continue;
    }

    const additional = /^as an additional cost to cast ~, sacrifice (?:a|an) (.+)$/i.exec(s);
    const sacrificed = additional && parsePermanentFilter(additional[1]!);
    if (sacrificed) {
      result.sacrifice = { ...sacrificed, controller: "you" };
      continue;
    }
    if ((m = new RegExp(`^scry ${NUM}$`, "i").exec(s))) {
      // Le regard n'est géré qu'avant les autres effets (la résolution attend le choix du joueur).
      const n = amount(m[1]!);
      if (result.effects.length === 0 && typeof n === "number") result.effects.push({ type: "scry", count: n });
      else if (result.effects.length === 1 && result.effects[0]!.type === "shuffleEventCard" && typeof n === "number") result.effects = [{ type: "scry", count: n, shuffleEventFirst: true }];
      else result.unknown.push(sentence);
      continue;
    }
    if (/^(?:that player|each player) puts the cards in (?:their|his or her) hand on the bottom of (?:their|his or her) library in any order$/i.test(s)) {
      wheel = /^each/i.test(s) ? "all" : "event";
      continue;
    }
    if (wheel && /^(?:they |that player )?draws? that many cards$/i.test(s)) {
      result.effects.push({ type: "wheelHand", who: wheel });
      wheel = null;
      continue;
    }
    if (wheel) {
      result.unknown.push("puts the cards in their hand on the bottom of their library");
      wheel = null;
    }
    // Rust Elemental : « If you can't, tap ~ and you lose 4 life. » (après « sacrifice another artifact »).
    const prev = result.effects.at(-1);
    if ((m = /^if you can't, (.+)$/i.exec(s)) && prev?.type === "sacrifice" && !prev.orElse) {
      const parts = m[1]!.split(/ and (?=you |tap |~ )/i).map((p) => parseSpellEffects(p.charAt(0).toUpperCase() + p.slice(1), "~"));
      if (parts.every((p) => p.unknown.length === 0 && p.targets.length === 0 && p.effects.length > 0)) {
        prev.orElse = parts.flatMap((p) => p.effects);
        continue;
      }
    }
    // Ashling : « create a token that's a copy of it. The token gains haste until end of turn.
    // At the beginning of your next end step, sacrifice it unless you pay {W}{U}{B}{R}{G}. »
    if (/^create a token that's a copy of it$/i.test(s)) {
      result.effects.push({ type: "copyEventCard" });
      continue;
    }
    if (/^the token gains haste until end of turn$/i.test(s) && prev?.type === "copyEventCard") {
      prev.haste = true;
      continue;
    }
    if ((m = /^at the beginning of your next end step, sacrifice it unless you pay ((?:\{[^}]+\})+)$/i.exec(s)) && prev?.type === "copyEventCard") {
      prev.endStepUnless = m[1]!;
      continue;
    }
    // Chaos Warp.
    if ((m = /^the owner of target (.+?) shuffles it into their library$/i.exec(s))) {
      const filter = parsePermanentFilter(m[1]!);
      if (filter) {
        result.effects.push({ type: "shuffleIntoLibrary", target: target({ label: permanentLabel(filter), permanent: filter }) });
        continue;
      }
    }
    if (/^reveals the top card of their library$/i.test(s) && prev?.type === "shuffleIntoLibrary" && !prev.revealPermanent) {
      revealing = prev;
      continue;
    }
    if (/^if it's a permanent card, they put it onto the battlefield$/i.test(s) && revealing) {
      revealing.revealPermanent = true;
      revealing = null;
      continue;
    }
    // Approach of the Second Sun.
    if (/^if ~ was cast from your hand and you've cast another spell named ~ this game, you win the game$/i.test(s)) {
      approach = true;
      continue;
    }
    if (approach && (m = new RegExp(`^otherwise, put ~ into its owner's library seventh from the top and you gain ${NUM} life$`, "i").exec(s))) {
      result.effects.push({ type: "approach", position: 7, life: amount(m[1]!) as number });
      approach = false;
      continue;
    }
    // The Eternal Wanderer : « Return that card to the battlefield under its owner's control at the beginning of that player's next end step. »
    if (/^return that card to the battlefield under its owner's control at the beginning of that player's next end step$/i.test(s) && prev?.type === "exile" && !prev.returnAtEnd) {
      prev.returnAtEnd = true;
      continue;
    }
    if (/^for each player, choose a creature that player controls$/i.test(s)) {
      keepOne = true;
      continue;
    }
    if (keepOne && /^each player sacrifices all creatures they control not chosen this way$/i.test(s)) {
      result.effects.push({ type: "keepOnePerPlayer" });
      keepOne = false;
      continue;
    }
    // Bronze Bombshell : « If the player does, ~ deals 7 damage to the player. »
    if ((m = /^if the player does, ~ deals (\d+) damage to the player$/i.exec(s)) && prev?.type === "sacrificeSelf" && !prev.thenDamage) {
      prev.thenDamage = parseInt(m[1]!, 10);
      continue;
    }
    // Jinxed Choker : « Put a charge counter on ~ or remove one from it. »
    if ((m = /^put an? (\w+) counter on ~ or remove one from it$/i.exec(s)) && result.effects.length === 0 && !result.modes) {
      const kind = counterKind(m[1]!);
      result.modes = {
        min: 1,
        max: 1,
        list: [
          { label: `Ajouter un marqueur ${kind}`, effects: [{ type: "counterSelf", kind, count: 1 }] },
          { label: `Retirer un marqueur ${kind}`, effects: [{ type: "counterSelf", kind, count: -1 }] },
        ],
      };
      continue;
    }
    const triggered = parseTriggerSentence(s, target, () => result.targets.length - 1);
    if (triggered) {
      result.effects.push(...triggered);
      continue;
    }
    const variable = parseVariableSentence(s, target, () => result.targets.length - 1);
    if (variable) {
      result.effects.push(...variable);
      continue;
    }
    // Toxic Deluge : « As an additional cost to cast this spell, pay X life. »
    if (/^as an additional cost to cast ~, pay X life$/i.test(s)) {
      result.payLifeX = true;
      continue;
    }
    // « All creatures get -X/-X until end of turn. »
    if ((m = /^all (.+?) get ([+-](?:\d+|X))\/([+-](?:\d+|X)) until end of turn$/i.exec(s))) {
      const filter = parsePermanentFilter(m[1]!);
      const pt = (v: string): number | "X" | "-X" => (/x$/i.test(v) ? (v.startsWith("-") ? "-X" : "X") : parseInt(v, 10));
      if (filter && filter.types.includes("creature")) {
        result.effects.push({ type: "grantAll", filter, keywords: [], power: pt(m[2]!), toughness: pt(m[3]!) });
        continue;
      }
    }
    if ((m = new RegExp(`^(you |target player )?draws? ${NUM} cards? and (?:you )?loses? ${NUM} life$`, "i").exec(s))) {
      // « You draw two cards and you lose 2 life. », « Target player draws X cards and loses X life. »
      const targeted = /target/i.test(m[1] ?? "");
      if (targeted !== /draws/i.test(s)) {
        result.unknown.push(sentence);
        continue;
      }
      const who = targeted ? { target: target({ label: "joueur", player: true }) } : ("you" as const);
      const lose = amount(m[3]!);
      result.effects.push({ type: "draw", who, count: amount(m[2]!) });
      result.effects.push({ type: "life", who, amount: lose === "X" ? "-X" : -(lose as number) });
    } else if ((m = /^add ((?:\{[WUBRGC]\})+)$/i.exec(s))) {
      result.effects.push({ type: "mana", mana: [...m[1]!.toUpperCase().matchAll(/\{([WUBRGC])\}/g)].map((x) => x[1]!) });
    } else if ((m = new RegExp(`^(?:you )?draw ${NUM} cards?$`, "i").exec(s))) {
      result.effects.push({ type: "draw", who: "you", count: amount(m[1]!) });
    } else if ((m = new RegExp(`^target player draws ${NUM} cards?$`, "i").exec(s))) {
      result.effects.push({ type: "draw", who: { target: target({ label: "joueur", player: true }) }, count: amount(m[1]!) });
    } else if ((m = /^(destroy|exile) (up to one )?target (.+)$/i.exec(s))) {
      const filter = parsePermanentFilter(m[3]!);
      if (!filter) {
        result.unknown.push(sentence);
        continue;
      }
      const t = target({ label: permanentLabel(filter), permanent: filter, ...(m[2] ? { upTo: true } : {}) });
      result.effects.push({ type: m[1]!.toLowerCase() === "destroy" ? "destroy" : "exile", target: t });
    } else if (
      (m = /^(up to one |another )?target (.+?) (?:gets ([+-]\d+)\/([+-]\d+)(?: and gains (.+?))?|gains (.+?)) until (end of turn|your next turn)$/i.exec(s)) &&
      keywordList(m[5] ?? m[6] ?? "").every((k) => KEYWORD_HELP[k]) &&
      // Un bonus de force ne va qu'à une créature ; des mots-clés seuls, à tout permanent (Tamiyo's Safekeeping).
      (m[3] ? parsePermanentFilter(m[2]!)?.types.includes("creature") : !!parsePermanentFilter(m[2]!))
    ) {
      const filter = parsePermanentFilter(m[2]!)!;
      const t = target({ label: permanentLabel(filter), permanent: filter, ...(/up to/i.test(m[1] ?? "") ? { upTo: true } : {}), ...(/another/i.test(m[1] ?? "") ? { another: true } : {}) });
      result.effects.push({
        type: "pumpTarget",
        target: t,
        power: m[3] ? parseInt(m[3], 10) : 0,
        toughness: m[4] ? parseInt(m[4], 10) : 0,
        keywords: m[5] ?? m[6] ? keywordList(m[5] ?? m[6]!) : [],
        ...(/next turn/i.test(m[7]!) ? { untilNextTurn: true } : {}),
      });
    } else if ((m = new RegExp(`^you gain ${NUM} life and draw ${NUM} cards?$`, "i").exec(s))) {
      result.effects.push({ type: "life", who: "you", amount: amount(m[1]!) }, { type: "draw", who: "you", count: amount(m[2]!) });
    } else if ((m = new RegExp(`^put ${NUM} cards from your hand on top of your library in any order$`, "i").exec(s))) {
      // « Draw three cards, then put two cards… » : la pioche se fait avant le choix.
      const prev = result.effects.at(-1);
      if (prev?.type === "draw" && prev.who === "you" && typeof prev.count === "number") {
        result.effects.pop();
        result.effects.push({ type: "handToTop", count: amount(m[1]!) as number, drawFirst: prev.count });
      } else result.effects.push({ type: "handToTop", count: amount(m[1]!) as number });
    } else if (/^shuffle it into its owner's library$/i.test(s)) {
      result.effects.push({ type: "shuffleEventCard" });
    } else if ((m = /^you may put an? (\w+) creature card from your hand onto the battlefield$/i.exec(s))) {
      result.effects.push({ type: "putFromHand", subtype: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase(), haste: false, sacrificeAtEnd: false });
    } else if (/^that creature gains haste until end of turn$/i.test(s) && result.effects.at(-1)?.type === "putFromHand") {
      (result.effects.at(-1) as Extract<Effect, { type: "putFromHand" }>).haste = true;
    } else if (/^sacrifice it at the beginning of the next end step$/i.test(s) && result.effects.at(-1)?.type === "putFromHand") {
      (result.effects.at(-1) as Extract<Effect, { type: "putFromHand" }>).sacrificeAtEnd = true;
    } else if ((m = /^you may play (target \w+ card from your graveyard) without paying its mana cost$/i.exec(s)) && parseGraveyardTarget(m[1]!)) {
      const filter = parseGraveyardTarget(m[1]!)!;
      result.effects.push({ type: "playFromGraveyard", target: target({ label: graveyardLabel(filter), graveyard: filter }) });
    } else if (/^put a \+1\/\+1 counter on ~ for each permanent destroyed this way$/i.test(s) && result.effects.at(-1)?.type === "destroyAll") {
      (result.effects.at(-1) as Extract<Effect, { type: "destroyAll" }>).countersOnSelf = true;
    } else if (/^search your library for a creature card that shares a creature type with the sacrificed creature and has mana value equal to 1 plus that creature's mana value$/i.test(s)) {
      result.effects.push({ type: "searchSharingType", mvPlus: 1 });
      followUps.push(/^put that card onto the battlefield$/i, /^shuffle$/i);
    } else if (/^choose a creature type$/i.test(s) && sentences.indexOf(sentence) === 0) {
      // Haunting Voyage : le type est choisi en lançant le sort (`chosenType`).
    } else if ((m = new RegExp(`^return (up to )?${NUM} creature cards of that type from your graveyard to the battlefield$`, "i").exec(s))) {
      result.effects.push({ type: "returnCards", count: amount(m[2]!) as number, chosenType: true });
      if (/^if (?:this spell|~) was foretold, return all creature cards of that type from your graveyard to the battlefield instead\.?$/i.test(sentences[sentences.indexOf(sentence) + 1] ?? "")) {
        (result.effects.at(-1) as Extract<Effect, { type: "returnCards" }>).allIfForetold = true;
        followUps.push(/^if (?:this spell|~) was foretold, return all creature cards of that type from your graveyard to the battlefield instead$/i);
      }
    } else if (/^cast (?:this spell|~) only during combat on an opponent's turn$/i.test(s)) {
      result.castOnly = "opponentCombat";
    } else if (/^return X target creature cards from your graveyard to the battlefield$/i.test(s)) {
      // Wake the Dead : les X cartes sont choisies à la résolution.
      result.effects.push({ type: "returnCards", count: "X" });
    } else if (/^sacrifice those creatures at the beginning of the next end step$/i.test(s) && result.effects.at(-1)?.type === "returnCards") {
      (result.effects.at(-1) as Extract<Effect, { type: "returnCards" }>).sacrificeAtEnd = true;
    } else if (/^each player exiles all creature cards from their graveyard$/i.test(s)) {
      result.effects.push({ type: "livingDeath" });
      followUps.push(/^sacrifices all creatures they control$/i, /^puts all cards they exiled this way onto the battlefield$/i);
    } else if ((m = /^(up to one )?target player puts all the cards from their graveyard on the bottom of their library in a random order$/i.exec(s))) {
      result.effects.push({ type: "graveyardToBottom", who: { target: target({ label: "joueur", player: true, ...(m[1] ? { upTo: true } : {}) }) } });
    } else if ((m = /^its controller creates (.+)$/i.exec(s)) && parseToken(m[1]!.replace(/^an? /i, "")) && result.targets.length > 0) {
      result.effects.push({ type: "tokenForController", target: result.targets.length - 1, token: parseToken(m[1]!.replace(/^an? /i, ""))! });
    } else if (
      (m = new RegExp(`^(look at|reveal) the top ${NUM} cards of your library$`, "i").exec(s)) &&
      (dig = new RegExp(`^put (${NUM}|any number) of (them|legendary cards from among them) into your hand and the rest (on the bottom of your library in (?:any|a random) order|into your graveyard)\\.?$`, "i").exec(sentences[sentences.indexOf(sentence) + 1] ?? ""))
    ) {
      // Stock Up, Dihada −3 : regarder les N cartes du dessus, en prendre quelques-unes, le reste dessous ou au cimetière.
      const count = amount(m[2]!);
      const take = /^any number$/i.test(dig[1]!) ? "any" : amount(dig[1]!);
      if (typeof count !== "number" || (take !== "any" && typeof take !== "number")) {
        result.unknown.push(sentence);
        continue;
      }
      // (NUM a sa propre parenthèse : dig[2])
      const rest = /graveyard/i.test(dig[4]!) ? "graveyard" : "bottom";
      result.effects.push({ type: "digTop", count, take, reveal: /^reveal/i.test(m[1]!), rest, ...(/legendary/i.test(dig[3]!) ? { legendary: true } : {}) });
      followUps.push(/^put (?:.+) into your hand and the rest (?:on the bottom of your library in (?:any|a random) order|into your graveyard)$/i);
    } else if (/^create a treasure token for each card put into your graveyard this way$/i.test(s) && result.effects.at(-1)?.type === "digTop") {
      (result.effects.at(-1) as Extract<Effect, { type: "digTop" }>).treasurePerRest = true;
    } else if ((m = new RegExp(`^reveal the top ${NUM} cards of your library$`, "i").exec(s)) && /^put a land card from among them onto the battlefield and the rest into your graveyard\.?$/i.test(sentences[sentences.indexOf(sentence) + 1] ?? "")) {
      result.effects.push({ type: "revealLandRestGraveyard", count: amount(m[1]!) as number });
      followUps.push(/^put a land card from among them onto the battlefield and the rest into your graveyard$/i);
    } else if (/^target opponent chooses a permanent they control at random and sacrifices it$/i.test(s)) {
      result.effects.push({ type: "randomSacrificeLoop", player: target({ label: "adversaire", player: true, opponent: true }) });
      followUps.push(/^if a nonland permanent is sacrificed this way, repeat this process$/i);
    } else if ((m = /^(destroy|exile) all (.+)$/i.exec(s))) {
      const filter = parsePermanentFilter(m[2]!.replace(/^(\w+) and (\w+)$/, "$1 or $2"));
      if (!filter) {
        result.unknown.push(sentence);
        continue;
      }
      result.effects.push({ type: m[1]!.toLowerCase() === "destroy" ? "destroyAll" : "exileAll", filter });
    } else if ((m = /^return target (.+?) to its owner's hand$/i.exec(s))) {
      const filter = parsePermanentFilter(m[1]!);
      if (!filter) {
        result.unknown.push(sentence);
        continue;
      }
      result.effects.push({ type: "bounce", target: target({ label: permanentLabel(filter), permanent: filter }) });
    } else if ((m = new RegExp(`^~ deals ${NUM} damage to each creature target player controls$`, "i").exec(s))) {
      result.effects.push({ type: "damageCreaturesOf", target: target({ label: "joueur", player: true }), amount: amount(m[1]!) });
    } else if ((m = new RegExp(`^~ deals ${NUM} damage to each (opponent|player|creature)$`, "i").exec(s))) {
      const who = ({ opponent: "opponents", player: "players", creature: "creatures" } as const)[
        m[2]!.toLowerCase() as "opponent" | "player" | "creature"
      ];
      result.effects.push({ type: "damageEach", who, amount: amount(m[1]!) });
    } else if ((m = new RegExp(`^~ deals ${NUM} damage to (.+)$`, "i").exec(s))) {
      const spec = damageTarget(m[2]!);
      if (!spec) {
        result.unknown.push(sentence);
        continue;
      }
      result.effects.push({ type: "damage", target: target(spec), amount: amount(m[1]!) });
    } else if ((m = new RegExp(`^you gain ${NUM} life$`, "i").exec(s))) {
      result.effects.push({ type: "life", who: "you", amount: amount(m[1]!) });
    } else if ((m = new RegExp(`^(?:you )?lose ${NUM} life$`, "i").exec(s))) {
      const n = amount(m[1]!);
      result.effects.push({ type: "life", who: "you", amount: n === "X" ? "-X" : -(n as number) });
    } else if ((m = new RegExp(`^each opponent loses ${NUM} life$`, "i").exec(s))) {
      const n = amount(m[1]!);
      result.effects.push({ type: "life", who: "opponents", amount: n === "X" ? "-X" : -(n as number) });
    } else if ((m = new RegExp(`^target (player|opponent) (gains|loses) ${NUM} life$`, "i").exec(s))) {
      const n = amount(m[3]!);
      const t = target(playerTarget(m[1]!));
      const loses = m[2]!.toLowerCase() === "loses";
      result.effects.push({ type: "life", who: { target: t }, amount: loses ? (n === "X" ? "-X" : -(n as number)) : n });
    } else if ((m = new RegExp(`^target player creates ${NUM} (tapped )?(Treasure|Food|Clue|Blood) tokens?$`, "i").exec(s))) {
      const name = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1).toLowerCase();
      result.effects.push({ type: "namedToken", name, count: amount(m[1]!), tapped: !!m[2], who: { target: target({ label: "joueur", player: true }) } });
    } else if ((m = /^create a token that's a copy of target (.+)$/i.exec(s)) && parsePermanentFilter(m[1]!)) {
      const filter = parsePermanentFilter(m[1]!)!;
      result.effects.push({ type: "copyTarget", target: target({ label: permanentLabel(filter), permanent: filter }) });
    } else if (/^put a shield counter on a creature you control$/i.test(s)) {
      result.effects.push({ type: "shieldCounter" });
    } else if ((m = new RegExp(`^(?:you )?create ${NUM} (tapped )?(Treasure|Food|Clue|Blood) tokens?$`, "i").exec(s))) {
      const name = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1).toLowerCase();
      result.effects.push({ type: "namedToken", name, count: amount(m[1]!), tapped: !!m[2] });
    } else if ((m = /^create (?:a|an|one) (tapped )?(.+? tokens?) for each (.+)$/i.exec(s)) && parseToken(m[2]!) && parsePermanentFilter(m[3]!)) {
      result.effects.push({ type: "token", count: { perPermanent: parsePermanentFilter(m[3]!)! }, token: parseToken(m[2]!)!, tapped: !!m[1] });
    } else if ((m = /^(?:~|it) deals damage to (.+?) equal to the number of (.+)$/i.exec(s)) && damageTarget(m[1]!) && parsePermanentFilter(m[2]!)) {
      result.effects.push({ type: "damage", target: target(damageTarget(m[1]!)!), amount: { perPermanent: parsePermanentFilter(m[2]!)! } });
    } else if ((m = new RegExp(`^put ${NUM} (\\+1/\\+1|-1/-1) counters? on (target|each) (.+)$`, "i").exec(s)) && parsePermanentFilter(m[4]!)) {
      const filter = parsePermanentFilter(m[4]!)!;
      const count = amount(m[1]!) as number;
      if (m[3]!.toLowerCase() === "each") result.effects.push({ type: "counterAll", filter, kind: m[2]!, count });
      else result.effects.push({ type: "counterTarget", target: target({ label: permanentLabel(filter), permanent: filter }), kind: m[2]!, count });
    } else if ((m = new RegExp(`^create ${NUM} (tapped )?(.+)$`, "i").exec(s))) {
      const token = parseToken(m[3]!);
      if (!token) {
        result.unknown.push(sentence);
        continue;
      }
      result.effects.push({ type: "token", count: amount(m[1]!), token, tapped: !!m[2] });
    } else if ((m = /^counter target (?:(.+) )?spell$/i.exec(s))) {
      const spec = m[1] ? parseSpellFilter(m[1]) : { types: [], notTypes: [] };
      if (!spec) {
        result.unknown.push(sentence);
        continue;
      }
      result.effects.push({ type: "counter", target: target({ label: spellLabel(spec), spell: spec }) });
    } else {
      result.unknown.push(sentence);
    }
  }
  flushIf();
  if (wheel) result.unknown.push("puts the cards in their hand on the bottom of their library");
  return result;
}

function parseSpellFilter(text: string): SpellFilter | null {
  const filter: SpellFilter = { types: [], notTypes: [] };
  for (const w of text.toLowerCase().replace(/,? or /g, ",").split(/,\s*/).filter(Boolean)) {
    if (w.startsWith("non") && [...CARD_TYPES, "instant", "sorcery"].includes(w.slice(3))) filter.notTypes.push(w.slice(3));
    else if ([...CARD_TYPES, "instant", "sorcery"].includes(w)) filter.types.push(w);
    else return null;
  }
  return filter;
}

function spellLabel(f: SpellFilter): string {
  const labels: Record<string, string> = {
    artifact: "d'artefact",
    creature: "de créature",
    enchantment: "d'enchantement",
    instant: "d'éphémère",
    sorcery: "de rituel",
    planeswalker: "de planeswalker",
    land: "de terrain",
    battle: "de bataille",
  };
  let label = "sort";
  if (f.types.length > 0) label += ` ${f.types.map((t) => labels[t]).join(" ou ")}`;
  if (f.notTypes.length > 0) label += ` non-${f.notTypes.map((t) => t).join(", non-")}`;
  return label;
}

function faceData(g: GameState, card: CardInstance): { typeLine: string; data: CardData | undefined } {
  const data = g.cardData[card.cardId];
  const face = data?.faces?.[card.faceIndex];
  return { typeLine: face?.typeLine ?? data?.typeLine ?? "", data };
}

function hasTypes(typeLine: string, types: string[], notTypes: string[]): boolean {
  const t = typeLine.toLowerCase();
  const has = (type: string) => new RegExp(`\\b${type}\\b`).test(t);
  return (types.length === 0 || types.some(has)) && !notTypes.some(has);
}

/** Ce qu'il faut savoir d'un permanent pour le comparer à un filtre (aussi utilisé par l'interface). */
export interface PermanentFacts {
  typeLine: string;
  controllerId: PlayerId;
  tapped: boolean;
  attacking: boolean;
  blocking: boolean;
  /** Force et endurance actuelles (pour « total power and toughness »). */
  power?: number;
  colors?: string[];
  toughness?: number;
}

export function permanentMatches(facts: PermanentFacts, filter: PermanentFilter, casterId: PlayerId): boolean {
  if (!hasTypes(facts.typeLine, filter.types, filter.notTypes)) return false;
  if (filter.controller === "you" && facts.controllerId !== casterId) return false;
  if (filter.controller === "notYou" && facts.controllerId === casterId) return false;
  if (filter.state === "tapped" && !facts.tapped) return false;
  if (filter.state === "untapped" && facts.tapped) return false;
  if (filter.state === "attacking" && !facts.attacking) return false;
  if (filter.state === "blocking" && !facts.blocking) return false;
  if (filter.maxTotalPT !== undefined && (facts.power ?? 0) + (facts.toughness ?? 0) > filter.maxTotalPT) return false;
  if (filter.notColors?.some((c) => facts.colors?.includes(c))) return false;
  if (filter.subtype && !new RegExp(`\\b${filter.subtype}\\b`).test(facts.typeLine.split("—")[1] ?? "")) return false;
  if (filter.anySubtype && !filter.anySubtype.some((s) => new RegExp(`\\b${s}\\b`).test(facts.typeLine.split("—")[1] ?? ""))) return false;
  if (filter.legendary && !/\bLegendary\b/.test(facts.typeLine)) return false;
  return true;
}

export function spellMatches(typeLine: string, filter: SpellFilter): boolean {
  return hasTypes(typeLine, filter.types, filter.notTypes);
}

/** Le permanent correspond-il au filtre, du point de vue du lanceur ? */
export function matchesPermanent(g: GameState, card: CardInstance, filter: PermanentFilter, casterId: PlayerId): boolean {
  if (card.zone !== "battlefield") return false;
  const stats = filter.maxTotalPT !== undefined ? creatureStats(g, card) : undefined;
  return permanentMatches(
    {
      ...(stats ?? {}),
      typeLine: card.faceDown ? "Creature" : faceData(g, card).typeLine,
      colors: card.faceDown ? [] : (g.cardData[card.cardId]?.colors ?? []),
      controllerId: card.controllerId,
      tapped: card.tapped,
      attacking: !!g.combat?.attackers[card.instanceId],
      blocking: !!g.combat?.blockers[card.instanceId],
    },
    filter,
    casterId,
  );
}

/**
 * La cible est-elle valable ? Une carte doit correspondre au filtre et ne
 * pas avoir la défense talismanique (ou la défense d'un adversaire).
 */
export function isLegalTarget(g: GameState, spec: TargetSpec, target: Target, casterId: PlayerId, sourceId?: string): boolean {
  if (target.kind === "player") {
    const p = g.players[target.id];
    if (!spec.player || !p || p.hasConceded) return false;
    if (!spec.choice && playerHasShroud(g, p.id)) return false;
    if (!spec.choice && playerHasHexproof(g, p.id) && p.id !== casterId && !areTeammates(g, p.id, casterId)) return false;
    if (spec.notOwner && sourceId) {
      const src = g.cards[sourceId];
      const perm = src?.ability ? g.cards[src.ability.sourceId] : src;
      if (perm && perm.ownerId === p.id) return false;
    }
    return !spec.opponent || (p.id !== casterId && !areTeammates(g, p.id, casterId));
  }
  const card = g.cards[target.id];
  if (!card || card.instanceId === sourceId) return false;
  if (spec.another && sourceId) {
    const src = g.cards[sourceId];
    if ((src?.ability ? src.ability.sourceId : sourceId) === card.instanceId) return false;
  }
  if (card.zone === "battlefield") {
    if (!spec.permanent || !matchesPermanent(g, card, spec.permanent, casterId)) return false;
    if (hasKeyword(g, card, "Shroud")) return false;
    if (hasKeyword(g, card, "Hexproof") && card.controllerId !== casterId && !areTeammates(g, card.controllerId, casterId)) {
      return false;
    }
    // Protection contre une couleur : pas ciblé par les sorts et capacités de cette couleur.
    const src = sourceId ? g.cards[sourceId] : undefined;
    if (src && protectedFrom(g, card, g.cardData[src.cardId]?.colors ?? [])) return false;
    return true;
  }
  if (card.zone === "stack") {
    if (!spec.spell || card.ability) return false;
    return spellMatches(faceData(g, card).typeLine, spec.spell);
  }
  if (card.zone === "graveyard") {
    const f = spec.graveyard;
    if (!f) return false;
    if (f.whose === "you" && card.ownerId !== casterId) return false;
    // « another » : pas la carte dont vient la capacité.
    if (f.another && sourceId && g.cards[sourceId]?.ability?.sourceId === card.instanceId) return false;
    const data = g.cardData[card.cardId];
    const typeLine = (data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "").toLowerCase();
    if (f.types.length > 0 && !f.types.some((t) => new RegExp(`\\b${t}\\b`).test(typeLine))) return false;
    if (f.maxManaValue !== undefined && (data?.manaValue ?? 0) > f.maxManaValue) return false;
    if (f.subtype && !typeLineHasCreatureType(data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "", data?.faces?.[0]?.oracleText ?? data?.oracleText ?? "", f.subtype)) return false;
    return true;
  }
  return false;
}

/** Les modes ont-ils des cibles (et se choisissent donc en lançant le sort ou en mettant la capacité sur la pile) ? */
/** Le nombre maximal de modes, selon que le lanceur contrôle un commandant. */
export function modesMax(modes: NonNullable<SpellEffects["modes"]>, controlsCommander: boolean): number {
  return controlsCommander && modes.maxWithCommander ? modes.maxWithCommander : modes.max;
}

export function modesTargeted(effects: SpellEffects | null | undefined): boolean {
  return !!effects?.modes?.list.some((m) => (m.targets?.length ?? 0) > 0);
}

const TARGET_KEYS = ["target", "player", "permanent", "a", "b", "controllerOf"];

/** Décale les numéros de cible d'un effet (les cibles d'un mode passent après celles du sort). */
function offsetTargets<T>(value: T, offset: number): T {
  if (offset === 0 || !value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [k, v] of Object.entries(copy)) {
    if (TARGET_KEYS.includes(k) && typeof v === "number") copy[k] = v + offset;
    else if (v && typeof v === "object" && !Array.isArray(v) && k !== "filter" && k !== "token") copy[k] = offsetTargets(v, offset);
  }
  return copy as T;
}

/** Les effets et les cibles du sort avec ceux des modes choisis, dans l'ordre imprimé. */
export function flattenModes(effects: SpellEffects, chosen: number[] | undefined): SpellEffects {
  if (!effects.modes || !chosen) return effects;
  const targets = [...effects.targets];
  const list = [...effects.effects];
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const mode = effects.modes.list[i];
    if (!mode) continue;
    const offset = targets.length;
    targets.push(...(mode.targets ?? []));
    list.push(...mode.effects.map((e) => offsetTargets(e, offset)));
  }
  return { ...effects, targets, effects: list };
}

/** Effets d'une carte sur sa face visible, s'il s'agit d'un éphémère ou d'un rituel. */
export function spellEffectsOf(g: GameState, card: CardInstance, faceIndex = card.faceIndex, alternative = card.alternative ?? false): SpellEffects | null {
  const data = g.cardData[card.cardId];
  if (!data) return null;
  const face = data.faces?.[faceIndex];
  const typeLine = face?.typeLine ?? data.typeLine;
  if (!/\b(Instant|Sorcery)\b/.test(typeLine)) return null;
  return flattenModes(parseSpellEffects(face?.oracleText ?? data.oracleText, face?.name ?? data.name, { alternative }), card.modes?.chosen);
}

/** Valeur d'un nombre d'effet, avec la valeur de X choisie au lancement. */
export function resolveAmount(
  a: Amount,
  x: number,
  eventAmount = 0,
  context: {
    dealt?: number;
    hand?: number;
    given?: number;
    devotion?: number;
    lost?: number;
    lostThisTurn?: number;
    count?: (filter: PermanentFilter, all: boolean) => number;
    quantity?: (q: Quantity) => number;
  } = {},
): number {
  if (typeof a === "object") {
    const v = "q" in a ? (context.quantity?.(a.q) ?? 0) : (context.count?.(a.perPermanent, !!a.all) ?? 0) * (a.times ?? 1);
    return a.negative ? -v : v;
  }
  if (a === "dealt") return context.dealt ?? 0;
  if (a === "given") return context.given ?? 0;
  if (a === "devotion") return context.devotion ?? 0;
  if (a === "-devotion") return -(context.devotion ?? 0);
  if (a === "lost") return context.lost ?? 0;
  if (a === "-lostThisTurn") return -(context.lostThisTurn ?? 0);
  if (a === "hand") return context.hand ?? 0;
  if (a === "X") return x;
  if (a === "-X") return -x;
  if (a === "event") return eventAmount;
  if (a === "-event") return -eventAmount;
  return a;
}

/** Ce que le moteur sait faire d'une carte. */
export interface CardSupport {
  /** « full » : tout est automatique ; « partial » : une partie ; « manual » : à gérer à la main. */
  level: "full" | "partial" | "manual";
  /** Phrases ou capacités que le moteur n'applique pas. */
  unknown: string[];
}

const HANDLED_KEYWORDS = new Set([...COMBAT_KEYWORDS, "Flash", "Exploit", "Read ahead", "Evoke", "Changeling", "Rebound", "Cascade", "Myriad", "Foretell"].map((k) => k.toLowerCase()));

/** Ce que le moteur fait d'une ligne de texte d'un permanent. */
interface LineStatus {
  title: string;
  status: "auto" | "partial" | "manual";
  manual?: string[];
}

/** Ce qu'une aura enchante (« Enchant creature or planeswalker you control ») : la cible à choisir en la lançant. */
export function auraTarget(typeLine: string, oracleText: string): TargetSpec | null {
  if (!/\bAura\b/.test(typeLine)) return null;
  for (const raw of oracleText.split("\n")) {
    const m = /^enchant (.+)$/i.exec(raw.replace(/\([^)]*\)/g, "").trim());
    if (!m) continue;
    if (/^player$/i.test(m[1]!)) return { label: "joueur", player: true };
    if (/^opponent$/i.test(m[1]!)) return { label: "adversaire", player: true, opponent: true };
    const filter = parsePermanentFilter(m[1]!);
    return filter ? { label: permanentLabel(filter), permanent: filter } : null;
  }
  return null;
}

/**
 * Capacités qui ne servent qu'à construire le deck (deux commandants, carte
 * non-créature qui peut être commandant) : la validation du deck les applique.
 */
const DECKBUILDING_LINES: [RegExp, string][] = [
  [/^Partner$/i, "Partenaire"],
  [/^Partner\s*[—–-]\s*[^.]+\.?$/i, "Partenaire"],
  [/^Friends forever$/i, "Amis pour toujours"],
  [/^Choose a Background$/i, "Choisissez un historique"],
  [/^Doctor's companion$/i, "Compagnon du Docteur"],
  [/^.+ can be your commander\.?$/i, "Peut être votre commandant"],
];

function permanentLineStatus(line: string, typeLine: string, name: string): LineStatus {
  for (const [re, title] of DECKBUILDING_LINES) if (re.test(line)) return { title, status: "auto" };
  // « Partner with X » : la paire est vérifiée, mais la recherche du partenaire à l'arrivée reste à faire.
  if (/^Partner with [^.]+$/i.test(line)) {
    return { title: "Partenaire avec", status: "partial", manual: ["À l'arrivée, un joueur ciblé peut chercher le partenaire dans sa bibliothèque."] };
  }
  if (/^enchant /i.test(line) && auraTarget(typeLine, line)) return { title: "Aura", status: "auto" };
  if (printedEvoke(line)) return { title: "Évocation", status: "auto" };
  const abilities = parsePermanentAbilities(line, name, typeLine);
  if (/^\{T\}: Add /.test(line) && manaOptions(typeLine, line).length > 0) return { title: "Capacité de mana", status: "auto" };
  if (/^(?:\w+ — )?\{T\}: For each color among permanents you control, add one mana of that color\.?$/.test(line)) return { title: "Capacité de mana", status: "auto" };
  if (grantedManaAbility(line)) return { title: "Capacité de mana donnée", status: "auto" };
  if (manaTapEffect(line)) return { title: "Mana en plus", status: "auto" };
  if (abilities.triggers.length > 0) return { title: "Capacité déclenchée", status: "auto" };
  const activated = abilities.activated[0];
  if (activated) {
    const title = activated.equip ? "Équipement" : activated.cost.loyalty !== undefined ? "Capacité de loyauté" : activated.mana ? "Capacité de mana" : "Capacité activée";
    const { effects, unknown } = activated.effects;
    if (unknown.length === 0 && (effects.length > 0 || activated.effects.modes)) return { title, status: "auto" };
    // Le coût est payé par le moteur ; l'effet (ou une partie) reste à faire à la main.
    return { title, status: "partial", manual: unknown };
  }
  if (abilities.statics.length > 0) return { title: "Effet statique", status: "auto" };
  const title = /^(When|Whenever|At) /.test(line) ? "Capacité déclenchée" : /^[^"]*:/.test(line) ? "Capacité activée" : "Capacité";
  return { title, status: "manual" };
}

function faceSupport(typeLine: string, oracleText: string, name: string): { known: number; unknown: string[] } {
  if (/\b(Instant|Sorcery)\b/.test(typeLine)) {
    const parsed = parseSpellEffects(oracleText, name, { alternative: true });
    return {
      known: parsed.effects.length + (parsed.sacrifice ? 1 : 0) + (parsed.alternativeCost ? 1 : 0) + (parsed.modes?.list.length ?? 0),
      unknown: parsed.unknown,
    };
  }
  let known = 0;
  const unknown: string[] = [];
  for (const raw of joinModes(oracleText).split("\n")) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    if (!line) continue;
    const parts = line.split(/,\s*/).map((p) => p.trim().toLowerCase());
    const isProtection = (p: string) => /^protection from (white|blue|black|red|green)(?:,? and from (white|blue|black|red|green))*$/.test(p);
    if (parts.every((p) => HANDLED_KEYWORDS.has(p) || isProtection(p))) {
      known++;
      continue;
    }
    const st = permanentLineStatus(line, typeLine, name);
    if (st.status === "auto") known++;
    else if (st.status === "partial") {
      known++;
      unknown.push(line);
    } else unknown.push(line);
  }
  return { known, unknown };
}

/** Le moteur gère-t-il cette carte (toutes ses faces) ? */
export function cardSupport(data: CardData): CardSupport {
  const faces = data.faces && data.faces.length > 0 ? data.faces : [data];
  let known = 0;
  const unknown: string[] = [];
  for (const face of faces) {
    const r = faceSupport(face.typeLine ?? data.typeLine, face.oracleText ?? "", face.name ?? data.name);
    known += r.known;
    unknown.push(...r.unknown);
  }
  const level = unknown.length === 0 ? "full" : known > 0 ? "partial" : "manual";
  return { level, unknown };
}

/** Une capacité de la carte, et ce que le moteur en fait. */
export interface AbilityReportItem {
  /** Titre court (mot-clé en français, ou genre de capacité). */
  title: string;
  /** Texte de la capacité (anglais, tel que lu par le moteur). */
  text: string;
  /** « auto » : appliquée par le moteur ; « partial » : en partie ; « manual » : à faire à la main. */
  status: "auto" | "partial" | "manual";
  /** Ce qui reste à faire à la main, pour « partial ». */
  manual?: string[];
}

/** Noms français des mots-clés gérés, avec ce que fait le moteur. */
export const KEYWORD_HELP: Record<string, { name: string; help: string }> = {
  flying: { name: "Vol", help: "Ne peut être bloquée que par des créatures avec le vol ou la portée." },
  reach: { name: "Portée", help: "Peut bloquer les créatures avec le vol." },
  vigilance: { name: "Vigilance", help: "Attaquer ne la fait pas s'engager." },
  haste: { name: "Célérité", help: "Peut attaquer et s'engager dès son arrivée." },
  "first strike": { name: "Initiative", help: "Inflige ses blessures de combat avant les créatures sans initiative." },
  "double strike": { name: "Double initiative", help: "Inflige des blessures de combat deux fois." },
  deathtouch: { name: "Contact mortel", help: "Toute blessure qu'elle inflige à une créature est mortelle." },
  lifelink: { name: "Lien de vie", help: "Ses blessures font gagner autant de PV à son contrôleur." },
  trample: { name: "Piétinement", help: "Les blessures en trop passent au joueur attaqué." },
  menace: { name: "Menace", help: "Ne peut être bloquée que par deux créatures ou plus." },
  infect: { name: "Infection", help: "Blesse les créatures avec des marqueurs -1/-1 et les joueurs avec des marqueurs poison." },
  wither: { name: "Flétrissure", help: "Blesse les créatures avec des marqueurs -1/-1." },
  defender: { name: "Défenseur", help: "Ne peut pas attaquer." },
  indestructible: { name: "Indestructible", help: "Ni « détruire » ni les blessures mortelles ne la détruisent." },
  hexproof: { name: "Défense talismanique", help: "Les adversaires ne peuvent pas la cibler." },
  shroud: { name: "Linceul", help: "Personne ne peut la cibler." },
  "protection from each color": { name: "Protection contre chaque couleur", help: "Ni ciblée, ni bloquée, ni blessée par une source de couleur." },
  "read ahead": { name: "Lecture anticipée", help: "En lançant la saga, tu choisis le chapitre de départ ; les chapitres sautés ne se déclenchent pas." },
  exploit: { name: "Exploitation", help: "En arrivant, tu peux sacrifier une créature (le moteur te le demande)." },
  flash: { name: "Flash", help: "Peut se lancer à tout moment où l'on a la priorité." },
  fear: { name: "Peur", help: "Ne peut être bloquée que par des créatures-artefacts et/ou noires." },
  goad: { name: "Provocation", help: "Jusqu'au prochain tour du joueur qui provoque, la créature doit attaquer à chaque combat, et un autre joueur que lui si possible." },
  myriad: { name: "Myriade", help: "Quand elle attaque, une copie attaque chacun des autres adversaires ; les copies sont exilées à la fin du combat." },
  cascade: { name: "Cascade", help: "Quand tu la lances, exile des cartes jusqu'à une carte non-terrain de plus petite valeur de mana : tu peux la lancer gratuitement." },
  encore: { name: "Encore", help: "Depuis le cimetière, en l'exilant : un jeton copie par adversaire, qui l'attaque, avec la célérité, sacrifié à la fin du tour." },
  rebound: { name: "Rebond", help: "Lancé depuis la main, il est exilé en se résolvant ; tu peux le relancer gratuitement à ton prochain entretien." },
  annihilator: { name: "Annihilateur", help: "Quand elle attaque, le joueur défenseur sacrifie autant de permanents." },
  evoke: { name: "Évocation", help: "Peut se lancer pour son coût d'évocation ; elle est alors sacrifiée en arrivant." },
  changeling: { name: "Changelin", help: "Cette carte a tous les types de créature." },
};

/**
 * Le détail, capacité par capacité, de ce que le moteur applique pour la
 * face visible d'une carte (pour l'encart à côté de la carte agrandie).
 */
export function abilityReport(data: CardData, faceIndex = 0): AbilityReportItem[] {
  const face = data.faces?.[faceIndex];
  const typeLine = face?.typeLine ?? data.typeLine;
  const oracleText = face?.oracleText ?? data.oracleText;
  const name = face?.name ?? data.name;
  const items: AbilityReportItem[] = [];
  const spell = /\b(Instant|Sorcery)\b/.test(typeLine);
  for (const raw of joinModes(oracleText).split("\n")) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    if (!line) continue;
    const parts = line.split(/,\s*/).map((p) => p.trim());
    // « Lifelink, ward {2} » : une liste de mots-clés (avec un coût éventuel).
    const isKeywordLine = !spell && !line.includes(".") && !line.includes(":") && parts.every((p) => /^[A-Za-z]+( [a-z]+)?( \{[^}]+\})*$/.test(p));
    if (isKeywordLine) {
      for (const part of parts) {
        const help = KEYWORD_HELP[part.toLowerCase()];
        const other = help ? null : permanentLineStatus(part, typeLine, name);
        items.push(
          help
            ? { title: help.name, text: help.help, status: "auto" }
            : other && other.status !== "manual"
              ? { title: other.title, text: part, status: other.status }
              : { title: part.charAt(0).toUpperCase() + part.slice(1), text: "Mot-clé que le moteur n'applique pas encore.", status: "manual" },
        );
      }
      continue;
    }
    if (spell) {
      const parsed = parseSpellEffects(line, name, { alternative: true });
      const known = parsed.effects.length + (parsed.sacrifice ? 1 : 0) + (parsed.alternativeCost ? 1 : 0) + (parsed.modes?.list.length ?? 0);
      const status = known === 0 ? "manual" : parsed.unknown.length === 0 ? "auto" : "partial";
      const title = parsed.alternativeCost && parsed.effects.length === 0 ? "Coût alternatif" : parsed.sacrifice && parsed.effects.length === 0 ? "Coût supplémentaire" : "Effet du sort";
      items.push({ title, text: line, status, ...(status === "partial" ? { manual: parsed.unknown } : {}) });
      continue;
    }
    const st = permanentLineStatus(line, typeLine, name);
    items.push({ title: st.title, text: line, status: st.status, ...(st.manual && st.manual.length > 0 ? { manual: st.manual } : {}) });
  }
  return items;
}
