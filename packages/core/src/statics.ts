/**
 * Effets statiques des permanents : ce qu'ils changent tant qu'ils sont sur
 * le champ de bataille (mots-clés et bonus donnés par un équipement, une aura
 * ou à toutes ses créatures, réductions de coût, taille de main…).
 *
 * Ce module ne dépend que des types : le combat et les effets le consultent.
 */
import { areTeammates } from "./modes.js";
import { keywordList, NUMBER_WORDS, oracleLines, selfToTilde } from "./text.js";
import { creatureStats, protectedFrom } from "./combat.js";
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
  /**
   * `legendary` : sorts légendaires (Kethis) ; `subtypes` : l'un de ces sous-types (« Dragon spells », « Aura and Equipment
   * spells ») ; `colorless` : sorts incolores ; `opponents` : les sorts des adversaires. Un `amount` négatif augmente le
   * coût (« Noncreature spells cost {1} more to cast »).
   */
  | {
      kind: "costReduction";
      amount: number;
      colors: string[];
      types: string[];
      notTypes: string[];
      chosenType?: boolean;
      everyone?: boolean;
      opponents?: boolean;
      colored?: string;
      anyColor?: boolean;
      perCounter?: string;
      legendary?: boolean;
      subtypes?: string[];
      colorless?: boolean;
    }
  /**
   * Le coût du sort lui-même, appliqué en le lançant : « This spell costs {1} less to cast for each creature on the
   * battlefield » (`per`), « costs {X} less to cast, where X is the greatest power among creatures you control » (`x`).
   * `amount` négatif : le sort coûte plus.
   */
  | { kind: "selfCost"; amount: number; per?: CountSpec; x?: CountSpec }
  /** « As ~ enters, choose a creature type » (ou un type de carte : Cloud Key). */
  | { kind: "chooseType"; what: "creature" | "card" | "color" }
  /** Utopia Sprawl, Fertile Ground : le terrain enchanté produit un mana de plus (de la couleur choisie, ou au choix). */
  | { kind: "auraManaBonus"; color: "chosen" | "any" }
  /** Herald's Horn : à l'entretien, la carte du dessus en main si c'est une créature du type choisi. */
  | { kind: "heraldsHorn" }
  /**
   * « Equipped creature has haste and shroud. », « Enchanted creature gets +2/+2. »
   * `perCount` : le bonus est multiplié par ce nombre (« gets +1/+1 for each artifact you control »).
   */
  | { kind: "attached"; keywords: string[]; power: number; toughness: number; perCount?: CountSpec }
  /**
   * Seigneurs : « Creatures you control get +1/+1. », « Other Zombies you control have vigilance. »,
   * « Legendary creatures you control get +X/+X, where X is… » (Jodah). Le bonus s'applique aux
   * permanents qui correspondent à l'un des `filters` ; `player` : mots-clés donnés au contrôleur
   * (Shalai : « You, planeswalkers you control, and other creatures you control have hexproof. »).
   */
  | { kind: "anthem"; filters: PermFilter[]; keywords: string[]; power: number; toughness: number; perCount?: CountSpec; player?: string[] }
  /** « ~'s power and toughness are each equal to the number of cards in your hand. » */
  | { kind: "ptEquals"; count: CountSpec }
  /** Faeburrow Elder, Sisay : « ~ gets +1/+1 for each color among (other legendary) permanents you control ». */
  | { kind: "selfPump"; power: number; toughness: number; count: CountSpec }
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

/** Quels permanents un effet statique touche ou compte (« other legendary creatures you control »). */
export interface PermFilter {
  /** Types de carte exigés, tous à la fois (« artifact creatures ») ; vide : tout permanent. */
  types: string[];
  /** Types de carte exclus (« nonland permanents »). */
  notTypes?: string[];
  /** Pas la source elle-même. */
  others?: boolean;
  legendary?: boolean;
  nonlegendary?: boolean;
  token?: boolean;
  nontoken?: boolean;
  commander?: boolean;
  /** Ce type de créature (ou de permanent : « Equipment »). */
  subtype?: string;
  /** Le type choisi en arrivant par la source. */
  chosenType?: boolean;
  /** L'une de ces couleurs. */
  colors?: string[];
  /** À qui sont les permanents (par rapport au contrôleur de la source). */
  whose: "you" | "opponents" | "all";
}

/** Un nombre lu dans le texte : « for each … », « where X is the number of … ». */
export type CountSpec =
  | { kind: "permanents"; filter: PermFilter }
  /** « color among permanents you control » */
  | { kind: "colors"; filter: PermFilter }
  /** « cards in your hand » */
  | { kind: "hand" }
  /** « (creature) cards in your graveyard » */
  | { kind: "graveyard"; types: string[]; whose: "you" | "all" }
  /** « the greatest power among creatures you control », « the total power of creatures you control » */
  | { kind: "power"; filter: PermFilter; total: boolean };

const COLOR_WORDS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const PERMANENT_TYPES = ["creature", "artifact", "enchantment", "land", "planeswalker", "battle"];
/** Pluriels irréguliers des types de créature. */
const IRREGULAR_PLURALS: Record<string, string> = { elves: "Elf", dwarves: "Dwarf", wolves: "Wolf", werewolves: "Werewolf", fungi: "Fungus", homunculi: "Homunculus", mice: "Mouse", octopi: "Octopus" };

function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** « Zombies » → « Zombie », « Elves » → « Elf », « Sphinxes » → « Sphinx ». */
function singularSubtype(word: string): string {
  const low = word.toLowerCase();
  if (IRREGULAR_PLURALS[low]) return IRREGULAR_PLURALS[low]!;
  if (/(x|ch|sh)es$/.test(low)) return capitalize(low.slice(0, -2));
  if (/s$/.test(low) && !/ss$/.test(low)) return capitalize(low.slice(0, -1));
  return capitalize(low);
}

/** Un mot qui ne peut pas être un type de créature : on renonce plutôt que de deviner. */
const NOT_SUBTYPES = /^(attacking|blocking|tapped|untapped|enchanted|equipped|modified|multicolored|colorless|monocolored|face-down|cards?|spells?|players?|opponents?|that|with|without|each|all|another|target)$/i;

/**
 * « other legendary creatures », « Horses », « nonland permanents », « creature token » :
 * le groupe nominal devant « you control ». `whose` est fixé par l'appelant.
 */
function parsePermanentGroup(text: string, whose: PermFilter["whose"]): PermFilter | null {
  let words = text.trim().split(/\s+/);
  const filter: PermFilter = { types: [], whose };
  if (words[0] && /^(other|another)$/i.test(words[0])) {
    filter.others = true;
    words = words.slice(1);
  }
  if (words.length === 0) return null;
  const noun = words[words.length - 1]!;
  const low = noun.toLowerCase();
  const nounType = low.replace(/s$/, "");
  if (PERMANENT_TYPES.includes(nounType)) filter.types.push(nounType);
  else if (low === "permanents" || low === "permanent") {
    /* tout permanent */
  } else if (low === "tokens" || low === "token") filter.token = true;
  else if (/^[A-Z]/.test(noun) && !NOT_SUBTYPES.test(noun)) filter.subtype = singularSubtype(noun);
  else return null;
  for (const w of words.slice(0, -1)) {
    const lw = w.toLowerCase();
    if (lw === "legendary") filter.legendary = true;
    else if (lw === "nonlegendary") filter.nonlegendary = true;
    else if (lw === "nontoken") filter.nontoken = true;
    else if (lw === "token") filter.token = true;
    else if (lw === "commander") filter.commander = true;
    else if (COLOR_WORDS[lw]) (filter.colors ??= []).push(COLOR_WORDS[lw]!);
    else if (PERMANENT_TYPES.includes(lw)) filter.types.push(lw);
    else if (lw.startsWith("non") && PERMANENT_TYPES.includes(lw.slice(3))) (filter.notTypes ??= []).push(lw.slice(3));
    else if (/^[A-Z]/.test(w) && !NOT_SUBTYPES.test(w) && !filter.subtype) filter.subtype = capitalize(w);
    else return null;
  }
  return filter;
}

/** « creatures you control », « Zombies your opponents control », « creatures on the battlefield », « all creatures ». */
function parsePermanentSubject(text: string): PermFilter | null {
  let m: RegExpExecArray | null;
  const t = text.trim();
  if ((m = /^(.+?) you control( of the chosen type)?$/i.exec(t))) {
    const f = parsePermanentGroup(m[1]!, "you");
    if (f && m[2]) f.chosenType = true;
    return f;
  }
  if ((m = /^(.+?) (?:your opponents control|an opponent controls)$/i.exec(t))) return parsePermanentGroup(m[1]!, "opponents");
  if ((m = /^(.+?) on the battlefield$/i.exec(t))) return parsePermanentGroup(m[1]!, "all");
  if ((m = /^all (.+)$/i.exec(t))) return parsePermanentGroup(m[1]!, "all");
  return null;
}

/**
 * La valeur de X : « the number of … », « the greatest power among creatures you control »,
 * « the total power of creatures you control ».
 */
export function parseXValue(text: string): CountSpec | null {
  let m: RegExpExecArray | null;
  const t = text.trim().replace(/\.$/, "");
  if ((m = /^the number of (.+)$/i.exec(t))) return parseCount(m[1]!);
  if ((m = /^the (greatest|total) power (?:among|of) (.+)$/i.exec(t))) {
    const f = parsePermanentSubject(m[2]!);
    if (!f || f.types.join() !== "creature") return null;
    return { kind: "power", filter: f, total: m[1]!.toLowerCase() === "total" };
  }
  return null;
}

/** Ce que l'on compte : « artifact you control », « color among permanents you control », « card in your hand ». */
export function parseCount(text: string): CountSpec | null {
  let m: RegExpExecArray | null;
  const t = text.trim().replace(/\.$/, "");
  if (/^cards? in your hand$/i.test(t)) return { kind: "hand" };
  if ((m = /^((?:creature|artifact|enchantment|land|instant|sorcery|planeswalker) )?cards? in (your|all) graveyards?$/i.exec(t))) {
    return { kind: "graveyard", types: m[1] ? [m[1].trim().toLowerCase()] : [], whose: m[2]!.toLowerCase() === "your" ? "you" : "all" };
  }
  if ((m = /^colors? among (.+)$/i.exec(t))) {
    const f = parsePermanentSubject(m[1]!);
    return f ? { kind: "colors", filter: f } : null;
  }
  const f = parsePermanentSubject(t);
  return f ? { kind: "permanents", filter: f } : null;
}
const SPELL_TYPES = ["creature", "artifact", "enchantment", "instant", "sorcery", "planeswalker", "battle"];

/** « +1 », « -1 », « +X » (X vaut 1 : multiplié ensuite par le nombre compté). */
function ptValue(v: string): number {
  return /x$/i.test(v) ? (v.startsWith("-") ? -1 : 1) : parseInt(v, 10) || 0;
}

/**
 * « gets +1/+1 », « has flying », « gets +1/+1 and has flying », « gets +1/+1 for each artifact you control »,
 * « get +X/+X, where X is the number of legendary creatures you control ».
 */
function grant(text: string): { keywords: string[]; power: number; toughness: number; perCount?: CountSpec } | null {
  let power = 0;
  let toughness = 0;
  let keywords: string[] = [];
  let perCount: CountSpec | undefined;
  let rest = text.trim();
  // « …, where X is the number of … » : à la fin de la phrase.
  const where = /^(.*), where X is the number of (.+)$/i.exec(rest);
  if (where) {
    if (!/[+-]X\//i.test(where[1]!)) return null;
    const c = parseCount(where[2]!);
    if (!c) return null;
    perCount = c;
    rest = where[1]!;
  }
  const pt = /^gets? ([+-](?:\d+|X))\/([+-](?:\d+|X))(?: for each (.+?))?(?: and (ha(?:s|ve) .+))?$/i.exec(rest);
  if (pt) {
    if (/x/i.test(pt[1]! + pt[2]!) !== !!where) return null;
    power = ptValue(pt[1]!);
    toughness = ptValue(pt[2]!);
    if (pt[3]) {
      if (perCount) return null;
      const c = parseCount(pt[3]);
      if (!c) return null;
      perCount = c;
    }
    rest = pt[4] ?? "";
  } else if (where) return null;
  if (rest) {
    const has = /^(?:has|have) (.+)$/i.exec(rest);
    if (!has) return null;
    keywords = keywordList(has[1]!);
    if (keywords.some((k) => !/^[a-z]+( [a-z]+)?$/.test(k))) return null;
  }
  return { keywords, power, toughness, ...(perCount ? { perCount } : {}) };
}

/**
 * Seigneurs : « Legendary creatures you control get +X/+X… », « Horses you control have haste »,
 * « You, planeswalkers you control, and other creatures you control have hexproof ».
 */
function parseAnthem(l: string): StaticAbility | null {
  const m = /^(.+? (?:you control|your opponents control|an opponent controls|on the battlefield)(?: of the chosen type)?|you) (gets? .+|ha(?:s|ve) .+)$/i.exec(l);
  if (!m) return null;
  const parts = m[1]!.split(/,\s*and\s+|,\s*|\s+and\s+/).filter(Boolean);
  const filters: PermFilter[] = [];
  let you = false;
  for (const part of parts) {
    if (/^you$/i.test(part)) {
      you = true;
      continue;
    }
    const f = parsePermanentSubject(part);
    if (!f) return null;
    filters.push(f);
  }
  const g = grant(m[2]!);
  if (!g) return null;
  if (you) {
    // Seuls la défense talismanique et le linceul ont un sens pour un joueur ici.
    if (g.power || g.toughness || g.keywords.some((k) => k !== "hexproof" && k !== "shroud")) return null;
    return { kind: "anthem", filters, keywords: g.keywords, power: 0, toughness: 0, player: g.keywords };
  }
  return { kind: "anthem", filters, ...g };
}

type SpellClass = { colors: string[]; types: string[]; notTypes: string[]; legendary?: boolean; subtypes?: string[]; colorless?: boolean };

/**
 * Les sorts concernés par une réduction : « Black creature », « Legendary », « Instant and sorcery »,
 * « Aura and Equipment », « Angel spells and Human », « Dragon », « Colorless », « Noncreature », ou rien.
 */
function parseSpellClass(text: string): SpellClass | null {
  const out: SpellClass = { colors: [], types: [], notTypes: [] };
  const t = text.replace(/ spells (and|or) /gi, " $1 ").trim();
  if (!t) return out;
  const parts = t.split(/,\s*(?:and |or )?|\s+(?:and|or)\s+/).filter(Boolean);
  if (parts.length > 1) {
    // Une alternative : des types de carte, ou des sous-types.
    for (const p of parts) {
      const low = p.toLowerCase();
      if (SPELL_TYPES.includes(low)) out.types.push(low);
      else if (/^[A-Z][a-z]+$/.test(p) && !NOT_SUBTYPES.test(p)) (out.subtypes ??= []).push(p);
      else return null;
    }
    return out.types.length > 0 && out.subtypes ? null : out;
  }
  const words = t.split(/\s+/);
  for (const [i, w] of words.entries()) {
    const low = w.toLowerCase();
    if (COLOR_WORDS[low] && out.colors.length === 0) out.colors.push(COLOR_WORDS[low]!);
    else if (low === "colorless") out.colorless = true;
    else if (low === "legendary") out.legendary = true;
    else if (SPELL_TYPES.includes(low) && out.types.length === 0) out.types.push(low);
    else if (low.startsWith("non") && SPELL_TYPES.includes(low.slice(3))) out.notTypes.push(low.slice(3));
    else if (i === words.length - 1 && /^[A-Z][a-z]+$/.test(w) && !NOT_SUBTYPES.test(w)) out.subtypes = [w];
    else return null;
  }
  return out;
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
  if ((m = /^~'s power and toughness are each equal to the number of (.+)$/i.exec(l))) {
    const count = parseCount(m[1]!);
    return count ? { kind: "ptEquals", count } : null;
  }
  if ((m = /^~ gets ([+-]\d+)\/([+-]\d+) for each (.+)$/i.exec(l))) {
    const count = parseCount(m[3]!);
    return count ? { kind: "selfPump", power: parseInt(m[1]!, 10), toughness: parseInt(m[2]!, 10), count } : null;
  }
  if ((m = /^~ gets ([+-])X\/([+-])X, where X is the number of (.+)$/i.exec(l))) {
    const count = parseCount(m[3]!);
    return count ? { kind: "selfPump", power: m[1] === "-" ? -1 : 1, toughness: m[2] === "-" ? -1 : 1, count } : null;
  }
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
  if ((m = /^(?:~|this spell) costs \{(\d+)\} (less|more) to cast for each (.+)$/i.exec(l))) {
    const per = parseCount(m[3]!);
    if (!per) return null;
    return { kind: "selfCost", amount: parseInt(m[1]!, 10) * (m[2]!.toLowerCase() === "more" ? -1 : 1), per };
  }
  if ((m = /^(?:~|this spell) costs \{X\} less to cast, where X is (.+)$/i.exec(l))) {
    const x = parseXValue(m[1]!);
    return x ? { kind: "selfCost", amount: 1, x } : null;
  }
  if ((m = /^(.*?)spells (you cast |your opponents cast )?cost \{(\d+)\} (less|more) to cast$/i.exec(l))) {
    const filter = parseSpellClass(m[1]!.trim());
    if (!filter) return null;
    const who = m[2]?.trim().toLowerCase();
    const amount = parseInt(m[3]!, 10) * (m[4]!.toLowerCase() === "more" ? -1 : 1);
    return { kind: "costReduction", amount, ...filter, ...(who === undefined ? { everyone: true } : who === "your opponents cast" ? { everyone: true, opponents: true } : {}) };
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
  return parseAnthem(l);
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

function cardTypeLine(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  return data?.faces?.[card.faceIndex]?.typeLine ?? data?.typeLine ?? "";
}

/** Le permanent correspond-il au filtre ? `source` : le permanent qui porte l'effet. */
export function matchesFilter(g: GameState, card: CardInstance, filter: PermFilter, source: { instanceId: string; controllerId: PlayerId; chosenType?: string }): boolean {
  if (filter.others && card.instanceId === source.instanceId) return false;
  if (filter.whose === "you" && card.controllerId !== source.controllerId) return false;
  if (filter.whose === "opponents" && (card.controllerId === source.controllerId || areTeammates(g, card.controllerId, source.controllerId))) return false;
  if (card.faceDown) {
    // Une carte face cachée est une créature 2/2 sans nom, sans type ni couleur.
    return filter.types.every((t) => t === "creature") && !filter.subtype && !filter.legendary && !filter.colors && !filter.chosenType && !filter.commander && !filter.token;
  }
  const typeLine = cardTypeLine(g, card);
  const has = (t: string) => new RegExp(`\\b${t}\\b`, "i").test(typeLine);
  if (!filter.types.every(has)) return false;
  if (filter.notTypes?.some(has)) return false;
  if (filter.legendary && !has("legendary")) return false;
  if (filter.nonlegendary && has("legendary")) return false;
  if (filter.token && !card.isToken) return false;
  if (filter.nontoken && card.isToken) return false;
  if (filter.commander && !card.isCommander) return false;
  if (filter.subtype && !hasCreatureType(g, card, filter.subtype)) return false;
  if (filter.chosenType && (!source.chosenType || !hasCreatureType(g, card, source.chosenType))) return false;
  if (filter.colors && !filter.colors.some((c) => (g.cardData[card.cardId]?.colors ?? []).includes(c))) return false;
  return true;
}

/** Les permanents qui correspondent au filtre, vus depuis la source. */
function permanentsMatching(g: GameState, filter: PermFilter, source: CardInstance): CardInstance[] {
  return battlefield(g).filter((c) => matchesFilter(g, c, filter, source));
}

/** La valeur d'un nombre lu dans le texte (« for each … ») pour ce permanent. */
export function countValue(g: GameState, spec: CountSpec, source: CardInstance): number {
  const me = g.players[source.controllerId];
  if (!me) return 0;
  switch (spec.kind) {
    case "hand":
      return me.zones.hand.length;
    case "graveyard": {
      const players = spec.whose === "you" ? [me] : g.turnOrder.map((id) => g.players[id]!);
      return players
        .flatMap((p) => p.zones.graveyard)
        .filter((id) => spec.types.every((t) => new RegExp(`\\b${t}\\b`, "i").test(g.cardData[g.cards[id]!.cardId]?.typeLine ?? ""))).length;
    }
    case "permanents":
      return permanentsMatching(g, spec.filter, source).length;
    case "colors":
      return colorsAmongPermanents(g, source.controllerId, spec.filter, source).length;
    case "power": {
      const powers = permanentsMatching(g, spec.filter, source).map((c) => creatureStats(g, c).power);
      return spec.total ? powers.reduce((a, b) => a + Math.max(0, b), 0) : Math.max(0, ...powers);
    }
  }
}

/** Ce que les autres permanents donnent à cette créature : mots-clés (minuscules) et bonus. */
export function grantedTo(g: GameState, card: CardInstance): { keywords: string[]; power: number; toughness: number } {
  const out = { keywords: [...(card.grants ?? [])], power: 0, toughness: 0 };
  if (card.zone !== "battlefield") return out;
  for (const other of battlefield(g)) {
    for (const s of staticsOf(g, other)) {
      const applies =
        (s.kind === "attached" && card.instanceId === other.attachedTo) ||
        (s.kind === "anthem" && s.filters.some((f) => matchesFilter(g, card, f, other)));
      if (!applies || (s.kind !== "attached" && s.kind !== "anthem")) continue;
      out.keywords.push(...s.keywords);
      const times = s.perCount ? countValue(g, s.perCount, other) : 1;
      out.power += s.power * times;
      out.toughness += s.toughness * times;
    }
  }
  return out;
}

/** Ce que la créature se donne elle-même : force et endurance de base (« equal to the number of … ») et bonus « for each ». */
export function selfStats(g: GameState, card: CardInstance): { base?: number; power: number; toughness: number } {
  const out: { base?: number; power: number; toughness: number } = { power: 0, toughness: 0 };
  for (const s of staticsOf(g, card)) {
    if (s.kind === "ptEquals") out.base = countValue(g, s.count, card);
    if (s.kind === "selfPump") {
      const n = countValue(g, s.count, card);
      out.power += s.power * n;
      out.toughness += s.toughness * n;
    }
  }
  return out;
}

/** Mots-clés que les permanents du joueur lui donnent (Shalai : défense talismanique). */
export function playerKeywords(g: GameState, playerId: PlayerId): string[] {
  const out: string[] = [];
  for (const id of g.players[playerId]?.zones.battlefield ?? []) {
    for (const s of staticsOf(g, g.cards[id]!)) if (s.kind === "anthem" && s.player) out.push(...s.player);
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

/** Le joueur contrôle-t-il un commandant (le sien ou celui d'un autre) ? */
export function controlsCommander(g: GameState, playerId: PlayerId): boolean {
  return g.players[playerId]!.zones.battlefield.some((id) => g.cards[id]!.isCommander && g.cards[id]!.controllerId === playerId);
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
        if (s.opponents && (pid === playerId || areTeammates(g, pid, playerId))) continue;
        if (s.colors.length > 0 && !s.colors.some((c) => spell.colors.includes(c))) continue;
        if (s.colorless && spell.colors.length > 0) continue;
        if (s.types.length > 0 && !s.types.some(has)) continue;
        if (s.notTypes.some(has)) continue;
        if (s.legendary && !has("legendary")) continue;
        if (s.subtypes && !s.subtypes.some((t) => typeLineHasCreatureType(spell.typeLine, spell.oracleText ?? "", t))) continue;
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

/**
 * Ce que le sort lui-même change à son coût (The Great Henge, Blasphemous Act) : positif, il coûte moins.
 * `card` : la carte lancée, vue comme si elle était contrôlée par `playerId`.
 */
export function selfCostReduction(g: GameState, playerId: PlayerId, card: CardInstance, faceIndex: number): number {
  const source = { ...card, controllerId: playerId };
  let total = 0;
  for (const s of staticsOfData(g.cardData[card.cardId], faceIndex)) {
    if (s.kind !== "selfCost") continue;
    total += s.amount * (s.per ? countValue(g, s.per, source) : s.x ? countValue(g, s.x, source) : 1);
  }
  return total;
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
  return controls(g, playerId, "playerShroud") || playerKeywords(g, playerId).includes("shroud");
}

/** Le joueur a-t-il la défense talismanique (Shalai, Leyline of Sanctity…) ? */
export function playerHasHexproof(g: GameState, playerId: PlayerId): boolean {
  return playerKeywords(g, playerId).includes("hexproof");
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

/** Les couleurs parmi les permanents que contrôle le joueur (seulement ceux du filtre : Sisay, « other legendary permanents »). */
export function colorsAmongPermanents(g: GameState, playerId: PlayerId, filter?: PermFilter, source?: CardInstance): string[] {
  const found = new Set<string>();
  for (const id of g.players[playerId]?.zones.battlefield ?? []) {
    const c = g.cards[id]!;
    if (c.faceDown) continue;
    if (filter && source && !matchesFilter(g, c, filter, source)) continue;
    for (const color of g.cardData[c.cardId]?.colors ?? []) found.add(color);
  }
  return (["W", "U", "B", "R", "G"] as string[]).filter((c) => found.has(c));
}
