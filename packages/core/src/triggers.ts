/**
 * Capacités déclenchées des permanents (« When… », « Whenever… », « At the
 * beginning of… »), lues dans le texte Oracle.
 *
 * Le moteur note les événements de la partie (une carte arrive ou meurt, un
 * joueur pioche, gagne ou perd des PV, une étape commence, un terrain est
 * joué). Après chaque action, les capacités qui se déclenchent vont sur la
 * pile, dans l'ordre du tour à partir du joueur actif. Une capacité dont le
 * moteur ne comprend pas tout l'effet ne se déclenche pas : elle reste à
 * gérer à la main (et la carte porte sa pastille).
 */
import { parseActivatedLine, type ActivatedAbility } from "./activated.js";
import { KEYWORD_HELP, parseSpellEffects, selfToTilde, type Effect, type SpellEffects } from "./effects.js";
import { joinModes, keywordList } from "./text.js";
import { hasCreatureType, parseStaticLine, typeLineHasCreatureType, type StaticAbility } from "./statics.js";
import { creatureStats } from "./combat.js";
import { areTeammates, isActivePlayer } from "./modes.js";
import type { TurnStep } from "./turn.js";
import type { CardData, CardInstance, CardInstanceId, CastRecord, GameState, PlayerId, StackAbility, Zone } from "./types.js";

export type TriggerEvent =
  /** `cast` : le permanent arrive depuis la pile (il a été lancé). */
  | { type: "enters"; cardId: CardInstanceId; controllerId: PlayerId; creature: boolean; cast?: boolean; land?: boolean }
  /** `granted` : capacités données à la créature jusqu'à la fin du tour (Malakir Rebirth). */
  | { type: "dies"; cardId: CardInstanceId; controllerId: PlayerId; dataId: string; faceIndex: number; isToken: boolean; granted?: string[] }
  /** `nth` : combientième carte piochée par ce joueur ce tour-ci. */
  | { type: "draw"; playerId: PlayerId; nth?: number }
  | { type: "lifeGain"; playerId: PlayerId; amount: number }
  | { type: "lifeLoss"; playerId: PlayerId; amount: number }
  | { type: "step"; step: TurnStep; playerId: PlayerId }
  | { type: "landPlayed"; playerId: PlayerId; cardId?: CardInstanceId }
  /** `spell` : ce qu'on sait du sort (couleurs, valeur de mana, d'où il est lancé). */
  | { type: "cast"; playerId: PlayerId; cardId: CardInstanceId; typeLine: string; spell?: CastRecord }
  | { type: "attacks"; cardId: CardInstanceId }
  | { type: "blocks"; cardId: CardInstanceId }
  | { type: "exploits"; cardId: CardInstanceId }
  /** Un permanent est sacrifié (Ashling). */
  | { type: "sacrificed"; cardId: CardInstanceId; controllerId: PlayerId; dataId: string; faceIndex: number; isToken: boolean; typeLine: string }
  /** Un permanent change de contrôleur. */
  | { type: "controlChanged"; cardId: CardInstanceId; controllerId: PlayerId }
  /** Un permanent devient la cible d'un sort ou d'une capacité (`spellId`) contrôlé par `playerId` (garde). */
  | { type: "targeted"; cardId: CardInstanceId; playerId: PlayerId; spellId: CardInstanceId }
  /** Un permanent engagé se dégage. */
  | { type: "untapped"; cardId: CardInstanceId }
  /** Un permanent subit des blessures (Body of Knowledge). */
  | { type: "damaged"; cardId: CardInstanceId; amount: number }
  /** Une créature inflige des blessures de combat à un joueur. */
  | { type: "combatDamage"; cardId: CardInstanceId; controllerId: PlayerId; playerId: PlayerId; amount: number }
  /** Un permanent inflige des blessures hors combat à un joueur (Keen Sense : « deals damage to an opponent »). */
  | { type: "playerDamage"; cardId: CardInstanceId; controllerId: PlayerId; playerId: PlayerId; amount: number }
  /** Des marqueurs de savoir arrivent sur une saga : de `from` à `to`. */
  | { type: "lore"; cardId: CardInstanceId; from: number; to: number }
  /** `auras` : les auras attachées au permanent quand il est parti (Kaya's Ghostform). */
  | {
      type: "leaves";
      cardId: CardInstanceId;
      controllerId: PlayerId;
      dataId: string;
      faceIndex: number;
      to: Zone;
      granted?: string[];
      auras?: { cardId: CardInstanceId; controllerId: PlayerId; dataId: string; faceIndex: number }[];
    };

/** Qui, par rapport au contrôleur de la capacité. */
type Whose = "you" | "opponent" | "any";

export type TriggerCondition =
  /** `ifCast` : « When ~ enters, if it was cast, … » (Wedding Ring). */
  /**
   * `legendary`, `nontoken`, `token` : « another legendary permanent » (Yoshimaru), « a nontoken creature » (The Great Henge) ;
   * `types` : « an artifact enters », « an artifact creature » (tous ces types à la fois).
   */
  | {
      on: "enters";
      self: boolean;
      another: boolean;
      creature: boolean;
      whose: Whose;
      ifCast?: boolean;
      land?: boolean;
      minPower?: number;
      subtype?: string;
      orSelf?: boolean;
      legendary?: boolean;
      nontoken?: boolean;
      token?: boolean;
      types?: string[];
    }
  /** `batched` : « one or more … die » se déclenche une fois par action, quel que soit le nombre de morts. */
  | { on: "dies"; self: boolean; others: boolean; whose: Whose; batched?: boolean; subtype?: string; legendary?: boolean; nontoken?: boolean }
  /** `nth` : « draw your second card each turn ». */
  /** `controlsSameName` : « an opponent who controls an artifact named ~ » ; `theirTurn` : « during their turn ». */
  /** `legendary` : « play a legendary land » (Shanid). */
  | { on: "draw" | "lifeGain" | "lifeLoss" | "landPlayed"; whose: Whose; nth?: number; controlsSameName?: boolean; theirTurn?: boolean; legendary?: boolean }
  /** `enchanted` : « enchanted player's upkeep » (aura sur un joueur) ; `first` : « first upkeep each turn ». */
  | { on: "step"; step: "upkeep" | "draw" | "main1" | "beginCombat" | "end"; whose: Whose; enchanted?: boolean; first?: boolean }
  | ({ on: "cast"; whose: Whose; self?: boolean } & CastFilter)
  /** « Whenever ~ attacks », « … blocks », « … attacks or blocks ». */
  | { on: "combat"; attacks: boolean; blocks: boolean; anyCreature?: boolean; defender?: "you" }
  /** « Whenever you sacrifice a nontoken Elemental » : `subtype` (ou type), `nontoken`. */
  | { on: "sacrificed"; whose: Whose; subtype?: string; nontoken: boolean }
  /** Bronze Bombshell : « When a player other than ~'s owner controls it ». */
  | { on: "controlledByNonOwner" }
  /** « When ~ exploits a creature ». */
  | { on: "exploits" }
  /** « Whenever ~ becomes untapped ». */
  | { on: "untapped" }
  /**
   * « Whenever a creature deals combat damage to one of your opponents », « Whenever ~ deals combat damage to a player ».
   * `attached` : « equipped creature », « enchanted creature » (Robe of the Archmagi, Keen Sense) ;
   * `anyDamage` : « deals damage » (combat ou non) ; `token`, `nontoken`, `legendary`, `types` : filtre de la créature.
   */
  | {
      on: "combatDamage";
      self: boolean;
      creature: Whose;
      player: Whose;
      batched?: boolean;
      attached?: boolean;
      anyDamage?: boolean;
      token?: boolean;
      nontoken?: boolean;
      legendary?: boolean;
      types?: string[];
    }
  /** « Whenever ~ is dealt damage ». */
  | { on: "damaged" }
  /** Garde (ward) : « Whenever ~ becomes the target of a spell or ability an opponent controls ». */
  | { on: "targeted" }
  /** Chapitre d'une saga (« I, II — … »). */
  | { on: "chapter"; chapters: number[] }
  /** « When ~ leaves the battlefield » ; `enchanted` : « When enchanted permanent dies or is put into exile » (`to` : zones visées). */
  | { on: "leaves"; enchanted?: boolean; to?: Zone[] };

/**
 * Ce que doit être un sort lancé : « a legendary spell », « a white spell »,
 * « their first noncreature spell each turn », « a spell from anywhere other
 * than your hand »… Toutes les précisions doivent être vraies à la fois.
 */
export interface CastFilter {
  /** Au moins un de ces types de carte (vide : n'importe lequel). */
  types: string[];
  /** Aucun de ces types. */
  notTypes: string[];
  legendary?: boolean;
  /** Artefact, légendaire ou saga. */
  historic?: boolean;
  /** Au moins une de ces couleurs. */
  colors?: string[];
  multicolored?: boolean;
  colorless?: boolean;
  /** Au moins un de ces sous-types (Merfolk, Aura, Spirit…). */
  subtypes?: string[];
  minManaValue?: number;
  /** D'où le sort est lancé. */
  from?: "hand" | "notHand";
  hasX?: boolean;
  /** Le n-ième sort de ce genre lancé par ce joueur ce tour (« your first … spell each turn »). */
  nth?: number;
  /** « during each opponent's turn ». */
  opponentsTurn?: boolean;
}

const CARD_TYPE_WORDS = ["artifact", "creature", "enchantment", "instant", "sorcery", "planeswalker", "battle", "kindred", "tribal"];
const COLOR_WORDS: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

/** Lit « [your first] legendary spell from your hand » (après « you cast »). */
function parseCastFilter(text: string): CastFilter | null {
  let t = text.trim();
  const f: CastFilter = { types: [], notTypes: [] };
  const ord = /^(?:your|their|his or her) (first|second|third|fourth|fifth) (.+)$/i.exec(t);
  if (ord) {
    f.nth = ORDINALS[ord[1]!.toLowerCase()]!;
    t = ord[2]!;
  } else {
    const art = /^(?:an?|another) (.+)$/i.exec(t);
    if (!art) return null;
    t = art[1]!;
  }
  let perTurn = false;
  for (;;) {
    let m: RegExpExecArray | null;
    if ((m = / each turn$/i.exec(t))) perTurn = true;
    else if ((m = / during each opponent's turn$/i.exec(t))) f.opponentsTurn = true;
    else if ((m = / from your hand$/i.exec(t))) f.from = "hand";
    else if ((m = / from anywhere other than your hand$/i.exec(t))) f.from = "notHand";
    else if ((m = / with mana value (\d+) or greater$/i.exec(t))) f.minManaValue = parseInt(m[1]!, 10);
    else if ((m = / with \{X\} in its mana cost$/i.exec(t))) f.hasX = true;
    else break;
    t = t.slice(0, m.index);
  }
  if (f.nth !== undefined && !perTurn && !f.opponentsTurn) return null;
  if (f.nth === undefined && (perTurn || f.opponentsTurn)) return null;
  const desc = /^(?:(.*) )?spell$/i.exec(t);
  if (!desc) return null;
  const words = (desc[1] ?? "").trim();
  if (!words) return f;
  // « instant or sorcery », « Aura or Equipment », « Spirit or Arcane » : une seule sorte de mot de chaque côté.
  const alts = words.split(/ or /);
  if (alts.length > 1) {
    if (alts.some((a) => /\s/.test(a))) return null;
    const low = alts.map((a) => a.toLowerCase());
    if (low.every((a) => CARD_TYPE_WORDS.includes(a))) f.types = low;
    else if (low.every((a) => a in COLOR_WORDS)) f.colors = low.map((a) => COLOR_WORDS[a]!);
    else if (alts.every((a) => /^[A-Z][a-z]+$/.test(a))) f.subtypes = alts;
    else return null;
    return f;
  }
  for (const word of words.split(/\s+/)) {
    const w = word.toLowerCase();
    if (w === "legendary") f.legendary = true;
    else if (w === "historic") f.historic = true;
    else if (w === "multicolored") f.multicolored = true;
    else if (w === "colorless") f.colorless = true;
    else if (w in COLOR_WORDS) f.colors = [...(f.colors ?? []), COLOR_WORDS[w]!];
    else if (w.startsWith("non") && CARD_TYPE_WORDS.includes(w.slice(3))) f.notTypes.push(w.slice(3));
    else if (CARD_TYPE_WORDS.includes(w) && f.types.length === 0) f.types.push(w);
    else if (/^[A-Z][a-z]+$/.test(word) && !f.subtypes) f.subtypes = [word];
    else return null;
  }
  // « white blue spell » n'existe pas : deux couleurs voudraient dire « les deux ».
  if ((f.colors?.length ?? 0) > 1) return null;
  return f;
}

/** Le sort lancé correspond-il au filtre (sans compter le rang) ? */
function castFilterMatches(f: CastFilter, spell: CastRecord): boolean {
  const type = spell.typeLine.toLowerCase();
  const has = (t: string) => new RegExp(`\\b${t}\\b`).test(type);
  if (f.types.length > 0 && !f.types.some(has)) return false;
  if (f.notTypes.some(has)) return false;
  if (f.legendary && !has("legendary")) return false;
  if (f.historic && !has("artifact") && !has("legendary") && !has("saga")) return false;
  if (f.colors && !f.colors.some((c) => spell.colors.includes(c))) return false;
  if (f.multicolored && spell.colors.length < 2) return false;
  if (f.colorless && spell.colors.length > 0) return false;
  if (f.subtypes) {
    const sub = (spell.typeLine.split("—")[1] ?? "").split("//")[0]!;
    if (!f.subtypes.some((s) => new RegExp(`\\b${s}\\b`, "i").test(sub))) return false;
  }
  if (f.minManaValue !== undefined && spell.manaValue < f.minManaValue) return false;
  if (f.from === "hand" && !spell.fromHand) return false;
  if (f.from === "notHand" && spell.fromHand) return false;
  if (f.hasX && !spell.hasX) return false;
  return true;
}

/** Couleurs d'un coût de mana (« {1}{W/U} » : blanc et bleu). */
export function colorsOfCost(cost: string): string[] {
  return ["W", "U", "B", "R", "G"].filter((c) => new RegExp(`\\{[^}]*${c}[^}]*\\}`).test(cost));
}

/** Valeur de mana d'un coût imprimé (X compte pour 0). */
export function manaValueOfCost(cost: string): number {
  let total = 0;
  for (const [, sym] of cost.matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(sym!)) total += parseInt(sym!, 10);
    else if (/^[XYZ]$/i.test(sym!)) continue;
    else if (/^2\//.test(sym!)) total += 2;
    else total += 1;
  }
  return total;
}

export interface TriggeredAbility {
  /** Texte de la capacité, tel qu'imprimé. */
  text: string;
  condition: TriggerCondition;
  effects: SpellEffects;
  /** « if ~ is untapped » : la capacité ne se déclenche que si la source est dégagée. */
  ifUntapped: boolean;
  /** « You may … » : le contrôleur choisit à la résolution. */
  optional: boolean;
  /** « You may pay {1}. If you do, … » : le mana à payer pour accepter. */
  payMana?: string;
  /** « may pay 1 life. If they do, … » : les points de vie à payer pour accepter. */
  payLife?: number;
  /**
   * « … unless that player pays {1} », « sacrifice ~ unless you discard a card », entretien cumulatif :
   * le payeur peut payer pour empêcher l'effet. `perAge` : le coût est multiplié par les marqueurs d'âge.
   */
  unless?: Unless;
  /** « This ability triggers only once each turn. » */
  oncePerTurn?: boolean;
  /** Condition vérifiée au déclenchement et à la résolution (« if an opponent controls more lands than you », Land Tax). */
  onlyIf?: "opponentMoreLands" | "uniqueName";
}

export interface PermanentAbilities {
  triggers: TriggeredAbility[];
  /** Capacités activées dont le coût est compris (leurs effets peuvent l'être en partie). */
  activated: ActivatedAbility[];
  statics: StaticAbility[];
  /** Lignes que le moteur ne sait pas gérer. */
  unknown: string[];
}

function whose(text: string): Whose | null {
  const t = text.toLowerCase();
  if (t === "you" || t === "your") return "you";
  if (t === "an opponent" || t === "each opponent's") return "opponent";
  if (t === "a player" || t === "each" || t === "each player's") return "any";
  return null;
}

/** Lit la condition d'une capacité déclenchée (sans « When »/« Whenever »/« At »). */
export function parseTriggerCondition(text: string): TriggerCondition | null {
  let t = text.trim();
  // Wedding Ring : « an opponent who controls an artifact named ~ draws a card during their turn ».
  const named = /^an opponent who controls an? (?:artifact|permanent|creature|enchantment) named ~ (draws a card|gains life) during their turn$/i.exec(t);
  if (named) {
    const base = parseTriggerCondition(`an opponent ${named[1]}`);
    if (base && (base.on === "draw" || base.on === "lifeGain")) return { ...base, controlsSameName: true, theirTurn: true };
    return null;
  }
  let m: RegExpExecArray | null;
  if (/^~ enters(?: the battlefield)?$/i.test(t)) {
    return { on: "enters", self: true, another: false, creature: false, whose: "you" };
  }
  if ((m = /^(an?|another|~ or another) ((?:(?:nontoken|token|legendary|artifact|enchantment) )*)(creature|permanent|land|artifact|enchantment|planeswalker|[A-Z][a-z]+)( token)?( you control| an opponent controls)?(?: with power (\d+) or greater)? enters(?: the battlefield)?(?: under your control)?$/.exec(t))) {
    const controls = (m[5] ?? "").trim().toLowerCase();
    const kind = m[3]!;
    const subtype = /^[A-Z]/.test(kind) ? kind : undefined;
    const adj = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
    const types = [...adj.filter((a) => a === "artifact" || a === "enchantment"), ...(["artifact", "enchantment", "planeswalker"].includes(kind) ? [kind] : [])];
    const token = adj.includes("token") || !!m[4];
    if (token && adj.includes("nontoken")) return null;
    return {
      on: "enters",
      self: false,
      another: !/^an?$/.test(m[1]!),
      creature: kind === "creature" || !!subtype,
      ...(kind === "land" ? { land: true } : {}),
      ...(subtype ? { subtype } : {}),
      ...(m[6] ? { minPower: parseInt(m[6], 10) } : {}),
      ...(m[1] === "~ or another" ? { orSelf: true } : {}),
      ...(adj.includes("legendary") ? { legendary: true } : {}),
      ...(adj.includes("nontoken") ? { nontoken: true } : {}),
      ...(token ? { token: true } : {}),
      ...(types.length > 0 ? { types } : {}),
      whose: controls === "you control" || /under your control/i.test(t) ? "you" : controls ? "opponent" : "any",
    };
  }
  if (/^~ dies$/i.test(t)) return { on: "dies", self: true, others: false, whose: "you" };
  if ((m = /^one or more other creatures( you control| an opponent controls)? die$/i.exec(t))) {
    const controls = (m[1] ?? "").trim().toLowerCase();
    return { on: "dies", self: false, others: true, whose: controls === "you control" ? "you" : controls ? "opponent" : "any", batched: true };
  }
  if ((m = /^(~ or another|another|a) ((?:(?:nontoken|legendary) )*)(creature|[A-Z][a-z]+)( you control| an opponent controls)? dies$/.exec(t))) {
    const controls = (m[4] ?? "").trim().toLowerCase();
    const who: Whose = controls === "you control" ? "you" : controls ? "opponent" : "any";
    const adj = (m[2] ?? "").trim().split(/\s+/);
    return {
      on: "dies",
      self: m[1]!.startsWith("~"),
      others: true,
      whose: who,
      ...(m[3] !== "creature" ? { subtype: m[3]! } : {}),
      ...(adj.includes("legendary") ? { legendary: true } : {}),
      ...(adj.includes("nontoken") ? { nontoken: true } : {}),
    };
  }
  if ((m = /^(you|an opponent|a player) draws? a card$/i.exec(t))) return { on: "draw", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) draws? (?:your|their|his or her) (second|third) card each turn$/i.exec(t))) {
    return { on: "draw", whose: whose(m[1]!)!, nth: m[2]!.toLowerCase() === "second" ? 2 : 3 };
  }
  if ((m = /^(you|an opponent|a player) gains? life$/i.exec(t))) return { on: "lifeGain", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) loses? life$/i.exec(t))) return { on: "lifeLoss", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) plays? a land$/i.exec(t))) return { on: "landPlayed", whose: whose(m[1]!)! };
  if (/^you cast ~$/i.test(t)) return { on: "cast", whose: "you", types: [], notTypes: [], self: true };
  if ((m = /^(you|an opponent|a player) casts? (.+)$/i.exec(t))) {
    const filter = parseCastFilter(m[2]!);
    if (filter) return { on: "cast", whose: whose(m[1]!)!, ...filter };
  }
  if ((m = /^(you|an opponent|a player) plays? a legendary land$/i.exec(t))) return { on: "landPlayed", whose: whose(m[1]!)!, legendary: true };
  if ((m = /^~ (attacks|blocks|attacks or blocks)$/i.exec(t))) {
    const what = m[1]!.toLowerCase();
    return { on: "combat", attacks: what.includes("attacks"), blocks: what.includes("blocks") };
  }
  if (/^~ exploits a creature$/i.test(t)) return { on: "exploits" };
  if (/^~ becomes untapped$/i.test(t)) return { on: "untapped" };
  if (/^a creature attacks you(?: or a planeswalker you control)?$/i.test(t)) return { on: "combat", attacks: true, blocks: false, anyCreature: true, defender: "you" };
  if (/^a player other than ~'s owner controls it$/i.test(t)) return { on: "controlledByNonOwner" };
  if ((m = /^you sacrifice an? (nontoken )?(\w+)$/i.exec(t))) {
    const what = m[2]!.toLowerCase();
    return { on: "sacrificed", whose: "you", nontoken: !!m[1], ...(what === "permanent" ? {} : { subtype: m[2]! }) };
  }
  if (/^~ is dealt damage$/i.test(t)) return { on: "damaged" };
  if (/^one or more creatures you control deal combat damage to a player$/i.test(t)) {
    return { on: "combatDamage", self: false, creature: "you", player: "any", batched: true };
  }
  // « ~ », « equipped creature », « a nontoken creature you control », « an artifact creature you control », « a creature token you control »…
  if ((m = /^(~|equipped creature|enchanted creature|an? ((?:(?:nontoken|token|legendary|artifact) )*)creature( token)?( you control| an opponent controls)?) deals (combat )?damage to (a player|an opponent|one of your opponents|you)$/.exec(t))) {
    const who = m[1]!;
    const to = m[6]!.toLowerCase();
    const adj = (m[2] ?? "").trim().split(/\s+/);
    const token = adj.includes("token") || !!m[3];
    if (token && adj.includes("nontoken")) return null;
    return {
      on: "combatDamage",
      self: who === "~",
      creature: who.endsWith("you control") ? "you" : who.endsWith("opponent controls") ? "opponent" : "any",
      player: to === "a player" ? "any" : to === "you" ? "you" : "opponent",
      ...(/^(?:equipped|enchanted) /.test(who) ? { attached: true } : {}),
      ...(!m[5] ? { anyDamage: true } : {}),
      ...(token ? { token: true } : {}),
      ...(adj.includes("nontoken") ? { nontoken: true } : {}),
      ...(adj.includes("legendary") ? { legendary: true } : {}),
      ...(adj.includes("artifact") ? { types: ["artifact"] } : {}),
    };
  }
  if (/^~ leaves the battlefield$/i.test(t)) return { on: "leaves" };
  if ((m = /^(?:enchanted (?:permanent|creature)|equipped creature) (dies|is put into exile|dies or is put into exile|leaves the battlefield)$/i.exec(t))) {
    const what = m[1]!.toLowerCase();
    const to: Zone[] = what.startsWith("leaves") ? [] : [...(what.includes("dies") ? (["graveyard"] as Zone[]) : []), ...(what.includes("exile") ? (["exile"] as Zone[]) : [])];
    return { on: "leaves", enchanted: true, ...(to.length > 0 ? { to } : {}) };
  }
  if ((m = /^the beginning of (your|each|each player's|each opponent's) (?:first|precombat) main phase$/i.exec(t))) {
    return { on: "step", step: "main1", whose: whose(m[1]!)! };
  }
  if (/^the beginning of combat on your turn$/i.test(t)) return { on: "step", step: "beginCombat", whose: "you" };
  if (/^the beginning of each combat$/i.test(t)) return { on: "step", step: "beginCombat", whose: "any" };
  if (/^the beginning of enchanted player's first upkeep each turn$/i.test(t)) return { on: "step", step: "upkeep", whose: "any", enchanted: true, first: true };
  if (/^the beginning of enchanted player's upkeep$/i.test(t)) return { on: "step", step: "upkeep", whose: "any", enchanted: true };
  if ((m = /^the beginning of (your|each|each player's|each opponent's) (upkeep|draw step|end step)$/i.exec(t))) {
    const step = m[2]!.toLowerCase().startsWith("upkeep") ? "upkeep" : m[2]!.toLowerCase().startsWith("draw") ? "draw" : "end";
    return { on: "step", step, whose: whose(m[1]!)! };
  }
  return null;
}

/**
 * Une ou plusieurs conditions : « you play a legendary land or cast a legendary
 * spell » (Shanid) donne deux déclencheurs au même effet.
 */
export function parseTriggerConditions(text: string): TriggerCondition[] | null {
  const single = parseTriggerCondition(text);
  if (single) return [single];
  const both = /^(you|an opponent|a player) (plays? an? (?:legendary )?land) or (casts? .+)$/i.exec(text.trim());
  if (both) {
    const a = parseTriggerCondition(`${both[1]} ${both[2]}`);
    const b = parseTriggerCondition(`${both[1]} ${both[3]}`);
    if (a && b) return [a, b];
  }
  return null;
}

const cache = new Map<string, PermanentAbilities>();

export interface Unless {
  payer: "event" | "you";
  mana?: string;
  life?: number;
  discard?: number;
  perAge?: boolean;
  /** « {X}, where X is this creature's power » : X vaut la force de la source au moment de payer (Esper Sentinel). */
  xPower?: boolean;
}

/** Coût de la garde (« ward {2} », « Ward—Pay 3 life. », « Ward—Discard a card. »), payé par le contrôleur du sort ; null sinon. */
export function parseWard(part: string): Unless | null {
  const p = part.trim().replace(/\.$/, "");
  let m: RegExpExecArray | null;
  if ((m = /^ward ((?:\{[^}]+\})+)$/i.exec(p))) return { payer: "event", mana: m[1]! };
  if ((m = /^ward\s*[—-]\s*pay (\d+) life$/i.exec(p))) return { payer: "event", life: parseInt(m[1]!, 10) };
  if (/^ward\s*[—-]\s*discard a card$/i.test(p)) return { payer: "event", discard: 1 };
  return null;
}

/** Lit le corps d'une capacité déclenchée : ses effets, et si elle est facultative. */
function parseTriggerBody(text: string): { effects: SpellEffects; optional: boolean; payMana?: string; payLife?: number; unless?: Unless } | null {
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const bare = text.replace(/\.$/, "");
  // Rhystic Study : « you may draw a card unless that player pays {1} ».
  const unlessMay = /^you may (.+) unless that player pays ((?:\{[^}]+\})+)$/i.exec(bare);
  if (unlessMay) return { effects: parseSpellEffects(cap(unlessMay[1]!), "~"), optional: true, unless: { payer: "event", mana: unlessMay[2]! } };
  // Smothering Tithe : « that player may pay {2}. If the player doesn't, you create a Treasure token. »
  const tithe = /^that player may pay ((?:\{[^}]+\})+)\. If (?:the player|they) (?:doesn't|don't), (.+)$/i.exec(bare);
  if (tithe) return { effects: parseSpellEffects(cap(tithe[2]!), "~"), optional: false, unless: { payer: "event", mana: tithe[1]! } };
  // Solitary Confinement : « sacrifice ~ unless you discard a card ».
  const discard = /^(.+) unless you discard a card$/i.exec(bare);
  if (discard) return { effects: parseSpellEffects(cap(discard[1]!), "~"), optional: false, unless: { payer: "you", discard: 1 } };
  // Une seule phrase : « … unless you pay {1} » (pas la dernière phrase d'un texte plus long, comme Ashling).
  const unlessPay = /\.\s/.test(bare) ? null : /^(.+) unless (?:you pay|that player pays) ((?:\{[^}]+\})+)(, where X is ~'s power)?$/i.exec(bare);
  if (unlessPay && (!unlessPay[3] || unlessPay[2] === "{X}")) {
    return {
      effects: parseSpellEffects(cap(unlessPay[1]!), "~"),
      optional: false,
      unless: { payer: /that player/i.test(text) ? "event" : "you", mana: unlessPay[2]!, ...(unlessPay[3] ? { xPower: true } : {}) },
    };
  }
  // « You may pay 2 life. If you do, … », « its controller may pay 1 life. If they do, they draw a card. »
  const life = /^(?:you|its controller) may pay (\d+) life\. If (?:you|they) do, (?:they )?(.+)$/i.exec(text);
  if (life) return { effects: parseSpellEffects(cap(life[2]!), "~"), optional: true, payLife: parseInt(life[1]!, 10) };
  // Well of Lost Dreams : X au plus égal à la quantité de l'événement.
  const payX = /^you may pay \{X\}, where X is less than or equal to the amount of life you (?:gained|lost)\. If you do, (.+)$/i.exec(text);
  if (payX) return { effects: parseSpellEffects(cap(payX[1]!), "~"), optional: true, payMana: "{X}" };
  const pay = /^you may pay ((?:\{[^}]+\})+)\. If you do, (.+)$/i.exec(text);
  if (pay) return { effects: parseSpellEffects(cap(pay[2]!), "~"), optional: true, payMana: pay[1]! };
  // Risen Reef, Cream of the Crop, Selvala : des « may » au milieu du texte.
  const fixed = (effect: Effect, optional = false) => ({ effects: { targets: [], effects: [effect], unknown: [] }, optional });
  if (/^look at the top card of your library\. If it's a land card, you may put it onto the battlefield tapped\. If you don't put the card onto the battlefield, put it into your hand\.?$/i.test(text)) {
    return fixed({ type: "topLandOrHand" });
  }
  if (/^you may look at the top X cards of your library, where X is that creature's power\. If you do, put one of those cards on top of your library and the rest on the bottom of your library in any order\.?$/i.test(text)) {
    return fixed({ type: "lookTopKeepOne" }, true);
  }
  // Descendants' Fury : sacrifier une des créatures qui ont infligé les blessures, puis révéler jusqu'à une créature de même type.
  if (/^you may sacrifice one of them\. If you do, reveal cards from the top of your library until you reveal a creature card that shares a creature type with the sacrificed creature\. Put that card onto the battlefield and the rest on the bottom of your library in a random order\.?$/i.test(text)) {
    return fixed({ type: "sacrificeOneReveal" }, true);
  }
  // Greenwarden of Murasa, Cavalier of Thorns : « you may exile it. If you do, … ».
  const exileIt = /^you may exile it\. If you do, (.+)$/i.exec(text);
  if (exileIt) {
    const rest = parseSpellEffects(cap(exileIt[1]!), "~");
    return { effects: { ...rest, effects: [{ type: "exileEventCard" }, ...rest.effects] }, optional: true };
  }
  // Fury : 4 blessures réparties ; chaque choix de cible vaut 1 blessure (la même cible peut revenir).
  const divided = /^it deals (\d+) damage divided as you choose among any number of target creatures and\/or planeswalkers\.?$/i.exec(text);
  if (divided) {
    const n = parseInt(divided[1]!, 10);
    const spec = { label: "créature ou planeswalker (1 blessure par choix)", permanent: { types: ["creature", "planeswalker"], notTypes: [] }, upTo: true };
    return {
      effects: { targets: Array.from({ length: n }, () => spec), effects: Array.from({ length: n }, (_, i) => ({ type: "damage" as const, target: i, amount: 1 })), unknown: [] },
      optional: false,
    };
  }
  // Havoc Eater : une cible facultative par adversaire (quatre au plus).
  if (/^for each opponent, goad up to one target creature that opponent controls\. Put X \+1\/\+1 counters on ~, where X is the total power of creatures goaded this way\.?$/i.test(text)) {
    const spec = { label: "créature d'un adversaire (une par adversaire)", permanent: { types: ["creature"], notTypes: [], controller: "notYou" as const }, upTo: true };
    return { effects: { targets: [spec, spec, spec, spec], effects: [{ type: "goad", targets: [0, 1, 2, 3], countersFromPower: true }], unknown: [] }, optional: false };
  }
  if (/^its controller may draw a card if its power is greater than each other creature's power\.?$/i.test(text)) return fixed({ type: "drawIfGreatestPower" });
  // Odric, Lunarch Marshal : chaque mot-clé qu'a une de vos créatures est donné à toutes.
  const share = /^creatures you control gain ([a-z ]+) until end of turn if a creature you control has \1\. The same is true for (.+?)\.?$/i.exec(text);
  if (share) {
    const keywords = [share[1]!.toLowerCase(), ...keywordList(share[2]!)];
    if (keywords.every((k) => KEYWORD_HELP[k])) return fixed({ type: "shareKeywords", keywords });
  }
  const may = /^you may (.+)$/i.exec(text);
  if (may) return { effects: parseSpellEffects(cap(may[1]!), "~"), optional: true };
  if (/\bmay\b/i.test(text)) return null;
  return { effects: parseSpellEffects(cap(text), "~"), optional: false };
}

/** Exploit : « When this creature enters, you may sacrifice a creature. » */
const EXPLOIT: TriggeredAbility = {
  text: "Exploit",
  condition: { on: "enters", self: true, another: false, creature: false, whose: "you" },
  effects: { targets: [], effects: [{ type: "sacrifice", filter: { types: ["creature"], notTypes: [], controller: "you" } }], unknown: [] },
  ifUntapped: false,
  optional: true,
};

/** Capacités (déclenchées, activées, statiques) d'une face de permanent. */
export function parsePermanentAbilities(oracleText: string, cardName: string, typeLine = ""): PermanentAbilities {
  const key = `${cardName}\u0000${typeLine}\u0000${oracleText}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result: PermanentAbilities = { triggers: [], activated: [], statics: [], unknown: [] };
  const planeswalker = /\bPlaneswalker\b/.test(typeLine);
  for (const raw of joinModes(oracleText).split("\n")) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    if (!line) continue;
    let tilde = selfToTilde(line, cardName).trim();
    // Mot de capacité (« Inspired — … », « Landfall — … ») : sans effet de jeu.
    const abilityWord = /^\s*[A-Z][a-z]+(?: [a-z]+)* — (?=(?:When|Whenever|At)\b)/.exec(tilde);
    if (abilityWord) tilde = tilde.slice(abilityWord[0].length);
    if (/^exploit$/i.test(line)) {
      result.triggers.push(EXPLOIT);
      continue;
    }
    // Cascade (une fois par mot) : se déclenche quand on lance le sort.
    if (/^cascade(?:, cascade)*$/i.test(line)) {
      for (const _ of line.split(",")) {
        result.triggers.push({
          text: "Cascade",
          condition: { on: "cast", whose: "you", types: [], notTypes: [], self: true },
          effects: { targets: [], effects: [{ type: "cascade" }], unknown: [] },
          ifUntapped: false,
          optional: false,
        });
      }
      continue;
    }
    // Garde (ward) : « Vigilance, ward {2} », « Ward—Pay 3 life. » : contrer le sort ou la capacité
    // d'un adversaire qui cible ce permanent, sauf si son contrôleur paie le coût.
    const wards = line.split(/,\s*/).map(parseWard);
    if (wards.some(Boolean)) {
      for (const unless of wards) {
        if (!unless) continue;
        result.triggers.push({
          text: `Ward ${unless.mana ?? (unless.life ? `— Pay ${unless.life} life` : "— Discard a card")}`,
          condition: { on: "targeted" },
          effects: { targets: [], effects: [{ type: "counterTriggering" }], unknown: [] },
          ifUntapped: false,
          optional: false,
          unless,
        });
      }
      continue;
    }
    // Myriade : une copie qui attaque chacun des autres adversaires.
    if (/^Myriad$/i.test(line)) {
      result.triggers.push({
        text: "Myriad",
        condition: { on: "combat", attacks: true, blocks: false },
        effects: { targets: [], effects: [{ type: "myriad" }], unknown: [] },
        ifUntapped: false,
        optional: false,
      });
      continue;
    }
    // Annihilateur N : le joueur défenseur sacrifie N permanents.
    const annihilator = /^Annihilator (\d+)$/i.exec(line);
    if (annihilator) {
      result.triggers.push({
        text: line,
        condition: { on: "combat", attacks: true, blocks: false },
        effects: { targets: [], effects: [{ type: "defenderSacrifices", count: parseInt(annihilator[1]!, 10) }], unknown: [] },
        ifUntapped: false,
        optional: false,
      });
      continue;
    }
    // Entretien cumulatif : un marqueur d'âge, puis payer autant de fois le coût ou sacrifier.
    const cumulative = /^Cumulative upkeep(?: |—)(?:((?:\{[^}]+\})+)|Pay (\d+) life)\.?$/i.exec(line);
    if (cumulative) {
      result.triggers.push({
        text: line,
        condition: { on: "step", step: "upkeep", whose: "you" },
        effects: { targets: [], effects: [{ type: "sacrificeSelf" }], unknown: [] },
        ifUntapped: false,
        optional: false,
        unless: { payer: "you", perAge: true, ...(cumulative[1] ? { mana: cumulative[1] } : { life: parseInt(cumulative[2]!, 10) }) },
      });
      continue;
    }
    // Chapitres d'une saga : « I — … », « II, III — … ».
    const chapter = /^((?:I{1,3}|IV|V|VI)(?:, (?:I{1,3}|IV|V|VI))*) — (.+)$/.exec(tilde);
    if (chapter && /\bSaga\b/.test(typeLine)) {
      const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
      const chapters = chapter[1]!.split(/,\s*/).map((r) => ROMAN[r]!);
      const parsed = parseTriggerBody(chapter[2]!);
      if (!parsed || parsed.effects.unknown.length > 0 || (parsed.effects.effects.length === 0 && !parsed.effects.modes)) {
        result.unknown.push(line);
        continue;
      }
      result.triggers.push({
        text: line,
        condition: { on: "chapter", chapters },
        effects: parsed.effects,
        ifUntapped: false,
        optional: parsed.optional,
        ...(parsed.payMana ? { payMana: parsed.payMana } : {}),
        ...(parsed.payLife ? { payLife: parsed.payLife } : {}),
        ...(parsed.unless ? { unless: parsed.unless } : {}),
      });
      continue;
    }
    // « When there are nine or more … counters on ~, exile it » : une règle d'état, lue comme un effet statique.
    const stateRule = /^When there are |^At the beginning of your upkeep, look at the top card of your library\. If it's a creature card of the chosen type|^Whenever enchanted \w+ is tapped for mana, its controller adds an additional/i.test(tilde) ? parseStaticLine(tilde) : null;
    if (stateRule) {
      result.statics.push(stateRule);
      continue;
    }
    const m = /^(When|Whenever|At) (.+?), (.+)$/.exec(tilde);
    // « Whenever ~ enters or attacks » : deux capacités déclenchées au même effet.
    const both = m && /^~ enters or attacks$/i.test(m[2]!) ? parseTriggerBody(m[3]!) : null;
    if (both && both.effects.unknown.length === 0 && both.effects.effects.length > 0) {
      for (const condition of [{ on: "enters", self: true, another: false, creature: false, whose: "you" }, { on: "combat", attacks: true, blocks: false }] as TriggerCondition[]) {
        result.triggers.push({ text: line, condition, effects: both.effects, ifUntapped: false, optional: both.optional });
      }
      continue;
    }
    if (m) {
      const conditions = parseTriggerConditions(m[2]!);
      const condition = conditions?.[0] ?? null;
      let body = m[3]!;
      let oncePerTurn = false;
      if (/\s*This ability triggers only once each turn\.?$/i.test(body)) {
        oncePerTurn = true;
        body = body.replace(/\s*This ability triggers only once each turn\.?$/i, "");
      }
      let ifUntapped = false;
      let onlyIf: TriggeredAbility["onlyIf"];
      const moreLands = /^if an opponent controls more lands than you, (.+)$/i.exec(body);
      if (moreLands) {
        onlyIf = "opponentMoreLands";
        body = moreLands[1]!;
      }
      // Guardian Project : « if it doesn't have the same name as another creature you control or a creature card in your graveyard ».
      const unique = /^if it doesn't have the same name as another creature you control or a creature card in your graveyard, (.+)$/i.exec(body);
      if (unique && condition?.on === "enters") {
        onlyIf = "uniqueName";
        body = unique[1]!;
      }
      const wasCast = /^if it was cast, (.+)$/i.exec(body);
      if (wasCast && condition?.on === "enters") {
        condition.ifCast = true;
        body = wasCast[1]!;
      }
      const untapped = /^if ~ is untapped, (.+)$/i.exec(body);
      if (untapped) {
        ifUntapped = true;
        body = untapped[1]!;
      }
      // « Whenever ~ attacks, put a +1/+1 counter on it » : « it » est la source elle-même.
      if (/^~ /.test(m[2]!)) body = body.replace(/^put (an? [^ ]+ counter) on it\b/i, "put $1 on ~");
      const parsed = parseTriggerBody(body);
      if (!condition || !parsed || parsed.effects.unknown.length > 0 || (parsed.effects.effects.length === 0 && !parsed.effects.modes)) {
        result.unknown.push(line);
        continue;
      }
      for (const each of conditions!) result.triggers.push({
        text: line,
        condition: each,
        effects: parsed.effects,
        ifUntapped,
        optional: parsed.optional,
        ...(parsed.payMana ? { payMana: parsed.payMana } : {}),
        ...(parsed.payLife ? { payLife: parsed.payLife } : {}),
        ...(parsed.unless ? { unless: parsed.unless } : {}),
        ...(oncePerTurn ? { oncePerTurn } : {}),
        ...(onlyIf ? { onlyIf } : {}),
      });
      continue;
    }
    const activated = parseActivatedLine(tilde, planeswalker);
    if (activated) {
      // Les capacités de mana « {T}: Add … » sans autre coût passent par « engager pour du mana ».
      if (activated.mana && activated.cost.tap && !activated.cost.mana && !activated.cost.life && !activated.cost.sacrificeSelf && !activated.cost.sacrifice) {
        continue;
      }
      result.activated.push({ ...activated, text: line });
      continue;
    }
    const stat = parseStaticLine(tilde);
    if (stat) result.statics.push(stat);
  }
  cache.set(key, result);
  return result;
}

/** Dernier chapitre d'une saga (0 si ce n'en est pas une). */
export function sagaChapters(data: CardData | undefined, faceIndex = 0): number {
  const face = data?.faces?.[faceIndex];
  if (!/\bSaga\b/.test(face?.typeLine ?? data?.typeLine ?? "")) return 0;
  const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
  const text = face?.oracleText ?? data?.oracleText ?? "";
  return Math.max(0, ...[...text.matchAll(/^((?:I{1,3}|IV|V|VI)(?:, (?:I{1,3}|IV|V|VI))*) —/gm)].flatMap((m) => m[1]!.split(/,\s*/).map((r) => ROMAN[r]!)));
}

/** Capacités déclenchées de la face visible d'une carte. */
export function abilitiesOf(data: CardData | undefined, faceIndex = 0): PermanentAbilities {
  if (!data) return { triggers: [], activated: [], statics: [], unknown: [] };
  const face = data.faces?.[faceIndex];
  return parsePermanentAbilities(face?.oracleText ?? data.oracleText, face?.name ?? data.name, face?.typeLine ?? data.typeLine);
}

/** La capacité déclenchée d'un objet de la pile : celle de la carte source, ou celle qui lui a été donnée. */
export function stackTrigger(data: CardData | undefined, ability: StackAbility): TriggeredAbility | undefined {
  if (ability.activated) return undefined;
  if (ability.grantedText !== undefined) return parsePermanentAbilities(ability.grantedText, ability.sourceName).triggers[0];
  return abilitiesOf(data, ability.faceIndex).triggers[ability.index];
}

function whoseMatches(g: GameState, w: Whose, controllerId: PlayerId, playerId: PlayerId): boolean {
  if (w === "any") return true;
  const mine = playerId === controllerId;
  if (w === "you") return mine;
  return !mine && !areTeammates(g, playerId, controllerId);
}

/** L'événement déclenche-t-il la capacité de cette source ? */
export function conditionMatches(
  g: GameState,
  condition: TriggerCondition,
  event: TriggerEvent,
  source: { instanceId: CardInstanceId; controllerId: PlayerId },
): boolean {
  const c = condition;
  // Wedding Ring : « an opponent who controls an artifact named ~ draws a card during their turn ».
  if ((c.on === "draw" || c.on === "lifeGain") && (event.type === "draw" || event.type === "lifeGain")) {
    if (c.theirTurn && !isActivePlayer(g, event.playerId)) return false;
    if (c.controlsSameName) {
      const name = g.cardData[g.cards[source.instanceId]?.cardId ?? ""]?.name;
      const controls = g.players[event.playerId]?.zones.battlefield.some((id) => g.cardData[g.cards[id]!.cardId]?.name === name);
      if (!name || !controls) return false;
    }
  }
  switch (event.type) {
    case "enters":
      if (c.on !== "enters") return false;
      if (c.ifCast && !event.cast) return false;
      if (c.self) return event.cardId === source.instanceId;
      if (c.orSelf && event.cardId === source.instanceId) return true;
      if (c.another && event.cardId === source.instanceId) return false;
      if (c.subtype || c.minPower !== undefined || c.legendary || c.nontoken || c.token || c.types) {
        const entered = g.cards[event.cardId];
        if (!entered || entered.zone !== "battlefield") return false;
        if (c.subtype && !hasCreatureType(g, entered, c.subtype)) return false;
        if (c.minPower !== undefined && creatureStats(g, entered).power < c.minPower) return false;
        if (!permanentMatches(g, entered, c)) return false;
      }
      if (c.creature && !event.creature) return false;
      if (c.land && !event.land) return false;
      return whoseMatches(g, c.whose, source.controllerId, event.controllerId);
    case "dies":
      if (c.on !== "dies") return false;
      if (event.cardId !== source.instanceId && (c.legendary || c.nontoken)) {
        if (c.nontoken && event.isToken) return false;
        const data = g.cardData[event.dataId];
        if (c.legendary && !/\bLegendary\b/.test(data?.faces?.[event.faceIndex]?.typeLine ?? data?.typeLine ?? "")) return false;
      }
      if (c.subtype && event.cardId !== source.instanceId) {
        const data = g.cardData[event.dataId];
        const face = data?.faces?.[event.faceIndex];
        if (!typeLineHasCreatureType(face?.typeLine ?? data?.typeLine ?? "", face?.oracleText ?? data?.oracleText ?? "", c.subtype)) return false;
      }
      if (event.cardId === source.instanceId) return c.self;
      return c.others && whoseMatches(g, c.whose, source.controllerId, event.controllerId);
    case "step":
      if (c.on !== "step" || c.step !== event.step) return false;
      if (c.enchanted && g.cards[source.instanceId]?.attachedPlayer !== event.playerId) return false;
      if (c.first && (g.turn.upkeeps ?? 1) > 1) return false;
      return whoseMatches(g, c.whose, source.controllerId, event.playerId);
    case "cast": {
      if (c.on !== "cast" || !whoseMatches(g, c.whose, source.controllerId, event.playerId)) return false;
      if (c.self) return event.cardId === source.instanceId;
      const spell: CastRecord = event.spell ?? { cardId: event.cardId, typeLine: event.typeLine, colors: [], manaValue: 0, fromHand: true, hasX: false };
      if (!castFilterMatches(c, spell)) return false;
      if (c.opponentsTurn && isActivePlayer(g, event.playerId)) return false;
      if (c.nth !== undefined) {
        // Rang parmi les sorts du même genre lancés par ce joueur ce tour, jusqu'à celui-ci compris.
        const player = g.players[event.playerId];
        const spells = player?.castHistory?.turn === g.turn.number ? player.castHistory.spells : [spell];
        const upTo = spells.findIndex((s) => s.cardId === event.cardId);
        const rank = (upTo < 0 ? spells : spells.slice(0, upTo + 1)).filter((s) => castFilterMatches(c, s)).length;
        if (rank !== c.nth) return false;
      }
      return true;
    }
    case "targeted":
      return c.on === "targeted" && event.cardId === source.instanceId && whoseMatches(g, "opponent", source.controllerId, event.playerId);
    case "attacks":
    case "blocks":
      if (c.on !== "combat" || !(event.type === "attacks" ? c.attacks : c.blocks)) return false;
      if (c.defender === "you" && g.combat?.attackers[event.cardId] !== source.controllerId) return false;
      return c.anyCreature ? true : event.cardId === source.instanceId;
    case "sacrificed":
      if (c.on !== "sacrificed" || (c.nontoken && event.isToken)) return false;
      if (c.subtype && !new RegExp(`\\b${c.subtype}\\b`, "i").test(event.typeLine)) return false;
      return whoseMatches(g, c.whose, source.controllerId, event.controllerId);
    case "controlChanged":
      return c.on === "controlledByNonOwner" && event.cardId === source.instanceId && g.cards[source.instanceId]?.ownerId !== event.controllerId;
    case "exploits":
      return c.on === "exploits" && event.cardId === source.instanceId;
    case "untapped":
      return c.on === "untapped" && event.cardId === source.instanceId;
    case "damaged":
      return c.on === "damaged" && event.cardId === source.instanceId;
    case "combatDamage":
    case "playerDamage": {
      if (c.on !== "combatDamage") return false;
      if (event.type === "playerDamage" && !c.anyDamage) return false;
      if (c.self && event.cardId !== source.instanceId) return false;
      if (c.attached && g.cards[source.instanceId]?.attachedTo !== event.cardId) return false;
      if (c.token || c.nontoken || c.legendary || c.types) {
        const dealer = g.cards[event.cardId];
        if (!dealer || !permanentMatches(g, dealer, c)) return false;
      }
      // « equipped creature … you draw » : la créature équipée peut être à un autre joueur.
      const creatureOk = c.attached || whoseMatches(g, c.creature, source.controllerId, event.controllerId);
      return creatureOk && whoseMatches(g, c.player, source.controllerId, event.playerId);
    }
    case "lore":
      return c.on === "chapter" && event.cardId === source.instanceId && c.chapters.some((n) => n > event.from && n <= event.to);
    case "draw":
      if (c.on !== "draw" || (c.nth !== undefined && event.nth !== c.nth)) return false;
      return whoseMatches(g, c.whose, source.controllerId, event.playerId);
    case "leaves":
      if (c.on !== "leaves") return false;
      if (c.to && !c.to.includes(event.to)) return false;
      if (c.enchanted) return Boolean(event.auras?.some((a) => a.cardId === source.instanceId));
      return event.cardId === source.instanceId;
    case "landPlayed": {
      if (c.on !== "landPlayed") return false;
      if (c.legendary) {
        const land = event.cardId ? g.cards[event.cardId] : undefined;
        const data = land ? g.cardData[land.cardId] : undefined;
        if (!/\bLegendary\b/.test(data?.faces?.[land!.faceIndex]?.typeLine ?? data?.typeLine ?? "")) return false;
      }
      return whoseMatches(g, c.whose, source.controllerId, event.playerId);
    }
    default:
      return c.on === event.type && whoseMatches(g, c.whose, source.controllerId, event.playerId);
  }
}

/** Type actuel d'un permanent (face visible). */
function typeLineOf(g: GameState, card: CardInstance): string {
  const data = g.cardData[card.cardId];
  return data?.faces?.[card.faceIndex]?.typeLine ?? data?.typeLine ?? "";
}

/** Le permanent a-t-il les qualités demandées (légendaire, jeton ou non, types) ? */
function permanentMatches(g: GameState, card: CardInstance, f: { legendary?: boolean; nontoken?: boolean; token?: boolean; types?: string[] }): boolean {
  if (f.nontoken && card.isToken) return false;
  if (f.token && !card.isToken) return false;
  const type = typeLineOf(g, card);
  if (f.legendary && !/\bLegendary\b/.test(type)) return false;
  if (f.types && !f.types.every((t) => new RegExp(`\\b${t}\\b`, "i").test(type))) return false;
  return true;
}

/** Nom de la face visible d'une carte. */
function nameOf(g: GameState, card: CardInstance): string | undefined {
  const data = g.cardData[card.cardId];
  return data?.faces?.[card.faceIndex]?.name ?? data?.name;
}

/** La condition « if … » d'une capacité déclenchée est-elle remplie pour ce joueur ? */
export function triggerConditionHolds(g: GameState, onlyIf: TriggeredAbility["onlyIf"], controllerId: PlayerId, eventCardId?: CardInstanceId): boolean {
  // Guardian Project : la créature arrivée n'a pas le nom d'une autre de vos créatures ni d'une carte de créature de votre cimetière.
  if (onlyIf === "uniqueName") {
    const entered = eventCardId ? g.cards[eventCardId] : undefined;
    const name = entered && nameOf(g, entered);
    if (!name) return false;
    const player = g.players[controllerId]!;
    const clash = (id: CardInstanceId, zone: "battlefield" | "graveyard") => {
      if (id === eventCardId) return false;
      const other = g.cards[id];
      if (!other || other.faceDown) return false;
      return /\bCreature\b/.test(zone === "battlefield" ? typeLineOf(g, other) : (g.cardData[other.cardId]?.typeLine ?? "")) && nameOf(g, other) === name;
    };
    return !player.zones.battlefield.some((id) => clash(id, "battlefield")) && !player.zones.graveyard.some((id) => clash(id, "graveyard"));
  }
  if (onlyIf === "opponentMoreLands") {
    const lands = (id: PlayerId) =>
      g.players[id]!.zones.battlefield.filter((c) => /\bLand\b/.test(g.cardData[g.cards[c]!.cardId]?.typeLine ?? "")).length;
    const mine = lands(controllerId);
    return g.turnOrder.some((id) => id !== controllerId && !g.players[id]!.hasConceded && !areTeammates(g, id, controllerId) && lands(id) > mine);
  }
  return true;
}
