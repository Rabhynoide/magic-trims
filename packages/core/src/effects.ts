/**
 * Effets courants des éphémères et des rituels, lus dans le texte Oracle
 * (en anglais, tel que donné par Scryfall).
 *
 * Le moteur reconnaît une phrase à la fois : piocher, détruire, exiler,
 * renvoyer en main, infliger des blessures, gagner ou perdre des points de
 * vie, créer des jetons, contrer un sort. Ce qu'il ne reconnaît pas reste à
 * appliquer à la main, et le journal le rappelle.
 */
import { COMBAT_KEYWORDS, creatureStats, hasKeyword } from "./combat.js";
import { manaOptions } from "./mana.js";
import { parsePermanentAbilities } from "./triggers.js";
import { areTeammates } from "./modes.js";
import { joinModes, keywordList, selfToTilde } from "./text.js";

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
  /** Une carte dans un cimetière (« target creature card from your graveyard »). */
  graveyard?: GraveyardFilter;
}

export interface GraveyardFilter {
  /** Au moins un de ces types (vide : n'importe quelle carte). */
  types: string[];
  maxManaValue?: number;
  /** « your graveyard » ou « a graveyard ». */
  whose: "you" | "any";
  /** « another target creature card » : pas la source de la capacité. */
  another?: boolean;
}

/** « carte de créature (valeur de mana 3 ou moins) de ton cimetière ». */
export function graveyardLabel(f: GraveyardFilter): string {
  const FR: Record<string, string> = { creature: "créature", artifact: "artefact", enchantment: "enchantement", land: "terrain", planeswalker: "planeswalker", instant: "éphémère", sorcery: "rituel" };
  const type = f.types.length > 0 ? ` de ${f.types.map((t) => FR[t] ?? t).join(" ou ")}` : "";
  const mv = f.maxManaValue !== undefined ? ` (valeur de mana ${f.maxManaValue} ou moins)` : "";
  return `carte${type}${mv} ${f.whose === "you" ? "de ton cimetière" : "d'un cimetière"}`;
}

/** « another target creature card with mana value 3 or less from your graveyard » ; `null` si non compris. */
function parseGraveyardTarget(text: string): GraveyardFilter | null {
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
}

export interface SpellFilter {
  types: string[];
  notTypes: string[];
}

/** Un nombre : fixe, ou X (choisi au lancement). */
/**
 * Un nombre : fixe, X (choisi au lancement), ou « that much » d'une capacité
 * déclenchée (la quantité de l'événement : PV gagnés ou perdus).
 */
export type Amount = number | "X" | "-X" | "event" | "-event" | "dealt" | "hand" | "given" | "devotion" | "-devotion" | "lost" | "-lostThisTurn";

/** Qui subit l'effet : « you », une cible, ou le joueur de l'événement déclencheur (« that player », « they »). */
export type Who = "you" | "opponents" | "all" | "event" | { target: number } | { controllerOf: number };

export type Effect =
  | { type: "draw"; who: Who; count: Amount }
  | { type: "destroy"; target: number }
  | { type: "destroyAll"; filter: PermanentFilter }
  | { type: "exile"; target: number }
  | { type: "exileAll"; filter: PermanentFilter }
  | { type: "bounce"; target: number }
  | { type: "damage"; target: number | "event" | "you"; amount: Amount }
  | { type: "damageEach"; who: "opponents" | "players" | "creatures"; amount: Amount }
  | { type: "life"; who: Who; amount: Amount }
  | { type: "token"; count: Amount; token: TokenSpec; tapped: boolean; forOpponents?: boolean }
  | { type: "counter"; target: number }
  | { type: "mana"; mana: string[] }
  /** Marqueurs sur la source de la capacité (« put a +1/+1 counter on ~ »). */
  | { type: "counterSelf"; kind: string; count: number }
  /** Mana d'une couleur au choix (« Add one mana of any color »), choisie à l'activation. */
  | { type: "manaAny"; count: number }
  /** « Return ~ from your graveyard to your hand. » */
  | { type: "returnSelf" }
  /** « ~ gets +1/+1 until end of turn. » */
  | { type: "pumpSelf"; power: number; toughness: number }
  /** « Creatures you control gain lifelink until end of turn. » */
  | { type: "grantAll"; filter: PermanentFilter; keywords: string[] }
  /** Équiper : attache la source à la cible. */
  | { type: "attach"; target: number }
  /** « Sacrifice a creature » (au choix du contrôleur, à la résolution). */
  | { type: "sacrifice"; filter: PermanentFilter }
  /** « Target opponent gains control of target permanent you control » ; `permanent` : une cible, ou la source. */
  | { type: "gainControl"; permanent: number | "self"; player: number }
  /** « Exchange control of target land you control and target land an opponent controls. » */
  | { type: "exchangeControl"; a: number; b: number }
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
  | { type: "fromGraveyard"; target: number; to: "battlefield" | "hand" }
  /** « Search your library for a land card, put it into your hand » : le lanceur choisit dans la fenêtre de choix. */
  | { type: "search"; types: string[]; to: "hand" | "battlefield"; reveal: boolean }
  | { type: "shuffle" }
  /** « Target opponent reveals their hand. » */
  | { type: "revealHand"; who: Who }
  /** « You choose a creature or planeswalker card from it. That player discards that card. » */
  | { type: "chooseDiscard"; who: Who; types: string[] }
  /** Jeton prédéfini : Treasure, Food, Clue, Blood. */
  | { type: "namedToken"; name: string; count: Amount; tapped: boolean }
  /** « Scry 2 » : le contrôleur range les cartes du dessus avant le reste de la résolution (seulement en premier effet). */
  | { type: "scry"; count: number };

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
  /** « Choose one or more — • … » : les modes, choisis à la résolution (sans cible pour l'instant). */
  modes?: { min: number; max: number; list: { label: string; effects: Effect[] }[] };
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
const HARMLESS = [/^(it|they) can't be regenerated\.?$/i, /^~ can't be countered\.?$/i, /^round up each time\.?$/i];


/**
 * « creature », « nonland permanent an opponent controls », « artifact or
 * enchantment », « attacking creature »… ; `null` si le texte n'est pas compris.
 */
function parsePermanentFilter(text: string): PermanentFilter | null {
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
  const state = /^(attacking|blocking|tapped|untapped) /.exec(t);
  if (state) {
    filter.state = state[1] as PermanentFilter["state"];
    t = t.slice(state[0].length);
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
      if (!mod.startsWith("non") || !CARD_TYPES.includes(mod.slice(3))) return null;
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
  };
  let label = f.types.length > 0 ? f.types.map((t) => labels[t]).join(" ou ") : "permanent";
  if (f.notTypes.length > 0) label += ` non-${f.notTypes.map((t) => labels[t]).join(", non-")}`;
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
  if ((m = /^(?:return|put) (.+? from (?:your|a) graveyard) (?:to|onto) (the battlefield|your hand)(?: under your control)?$/i.exec(s))) {
    const filter = parseGraveyardTarget(m[1]!);
    if (filter) {
      return [{ type: "fromGraveyard", target: target({ label: graveyardLabel(filter), graveyard: filter }), to: /hand/i.test(m[2]!) ? "hand" : "battlefield" }];
    }
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
  if ((m = /^(target opponent|target player|an opponent) gains control of (~|it|target (.+))$/i.exec(s))) {
    const who = m[1]!.toLowerCase();
    const player = who === "an opponent" ? target({ label: "adversaire", player: true, opponent: true, choice: true }) : target(playerTarget(who));
    if (!m[3]) return [{ type: "gainControl", permanent: "self", player }];
    const filter = parsePermanentFilter(m[3]);
    if (!filter) return null;
    return [{ type: "gainControl", permanent: target({ label: permanentLabel(filter), permanent: filter }), player }];
  }
  if ((m = /^exchange control of target (.+?) and target (.+)$/i.exec(s))) {
    const fa = parsePermanentFilter(m[1]!);
    const fb = parsePermanentFilter(m[2]!);
    if (!fa || !fb) return null;
    const a = target({ label: permanentLabel(fa), permanent: fa });
    const b = target({ label: permanentLabel(fb), permanent: fb });
    return [{ type: "exchangeControl", a, b }];
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
  if ((m = /^(other )?creatures you control gain (.+) until end of turn$/i.exec(s))) {
    const keywords = keywordList(m[2]!);
    if (keywords.every((k) => KEYWORD_HELP[k])) {
      return [{ type: "grantAll", filter: { types: ["creature"], notTypes: [], controller: "you" }, keywords }];
    }
  }
  if ((m = /^add (one|two|three) mana of any (?:one )?color$/i.exec(s))) {
    return [{ type: "manaAny", count: amount(m[1]!) as number }];
  }
  if ((m = /^sacrifice (?:a|an) (.+)$/i.exec(s))) {
    const filter = parsePermanentFilter(m[1]!);
    if (filter) return [{ type: "sacrifice", filter: { ...filter, controller: "you" } }];
  }
  if ((m = new RegExp(`^put ${NUM} (\\+1/\\+1|-1/-1) counters? on ~$`, "i").exec(s))) {
    return [{ type: "counterSelf", kind: m[2]!, count: amount(m[1]!) as number }];
  }
  return null;
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
  const modal = /^(.*?)\bchoose (one|two|three|one or more|any number) ?(?:—|-)\s*(•.+)$/is.exec(joinModes(oracleText).replace(/\([^)]*\)/g, ""));
  if (modal) {
    const before = modal[1]!.trim();
    const result = before ? parseSpellEffects(before, cardName, options) : { targets: [], effects: [], unknown: [] };
    const kind = modal[2]!.toLowerCase();
    const min = kind === "two" ? 2 : kind === "three" ? 3 : kind === "any number" ? 0 : 1;
    const list: { label: string; effects: Effect[] }[] = [];
    const bullets = modal[3]!.split("•").map((b) => b.trim()).filter(Boolean);
    for (const bullet of bullets) {
      const named = /^([^—.]+?) — (.+)$/s.exec(bullet);
      const parsed = parseSpellEffects(named ? named[2]! : bullet, cardName, options);
      // Un mode avec des cibles reste à faire à la main pour l'instant.
      if (parsed.targets.length > 0 || parsed.unknown.length > 0 || parsed.effects.length === 0) result.unknown.push(bullet);
      list.push({ label: bullet, effects: parsed.targets.length > 0 ? [] : parsed.effects });
    }
    const max = kind === "one or more" || kind === "any number" ? list.length : min;
    result.modes = { min, max, list };
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
  for (const sentence of sentences) {
    let s = sentence.replace(/\.$/, "");
    if (HARMLESS.some((re) => re.test(sentence))) continue;
    let m: RegExpExecArray | null;

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
      result.effects.push({ type: "search", types, to: /hand/i.test(m[3]!) ? "hand" : "battlefield", reveal: !!m[2] });
      continue;
    }
    if (/^shuffle$/i.test(s)) {
      result.effects.push({ type: "shuffle" });
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
    const triggered = parseTriggerSentence(s, target, () => result.targets.length - 1);
    if (triggered) {
      result.effects.push(...triggered);
      continue;
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
    } else if ((m = /^(destroy|exile) target (.+)$/i.exec(s))) {
      const filter = parsePermanentFilter(m[2]!);
      if (!filter) {
        result.unknown.push(sentence);
        continue;
      }
      const t = target({ label: permanentLabel(filter), permanent: filter });
      result.effects.push({ type: m[1]!.toLowerCase() === "destroy" ? "destroy" : "exile", target: t });
    } else if ((m = /^(destroy|exile) all (.+)$/i.exec(s))) {
      const filter = parsePermanentFilter(m[2]!);
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
    } else if ((m = new RegExp(`^create ${NUM} (tapped )?(Treasure|Food|Clue|Blood) tokens?$`, "i").exec(s))) {
      const name = m[3]!.charAt(0).toUpperCase() + m[3]!.slice(1).toLowerCase();
      result.effects.push({ type: "namedToken", name, count: amount(m[1]!), tapped: !!m[2] });
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
    return !spec.opponent || (p.id !== casterId && !areTeammates(g, p.id, casterId));
  }
  const card = g.cards[target.id];
  if (!card || card.instanceId === sourceId) return false;
  if (card.zone === "battlefield") {
    if (!spec.permanent || !matchesPermanent(g, card, spec.permanent, casterId)) return false;
    if (hasKeyword(g, card, "Shroud")) return false;
    if (hasKeyword(g, card, "Hexproof") && card.controllerId !== casterId && !areTeammates(g, card.controllerId, casterId)) {
      return false;
    }
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
    return true;
  }
  return false;
}

/** Effets d'une carte sur sa face visible, s'il s'agit d'un éphémère ou d'un rituel. */
export function spellEffectsOf(g: GameState, card: CardInstance, faceIndex = card.faceIndex, alternative = card.alternative ?? false): SpellEffects | null {
  const data = g.cardData[card.cardId];
  if (!data) return null;
  const face = data.faces?.[faceIndex];
  const typeLine = face?.typeLine ?? data.typeLine;
  if (!/\b(Instant|Sorcery)\b/.test(typeLine)) return null;
  return parseSpellEffects(face?.oracleText ?? data.oracleText, face?.name ?? data.name, { alternative });
}

/** Valeur d'un nombre d'effet, avec la valeur de X choisie au lancement. */
export function resolveAmount(a: Amount, x: number, eventAmount = 0, context: { dealt?: number; hand?: number; given?: number; devotion?: number; lost?: number; lostThisTurn?: number } = {}): number {
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

const HANDLED_KEYWORDS = new Set([...COMBAT_KEYWORDS, "Flash", "Exploit", "Read ahead"].map((k) => k.toLowerCase()));

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

function permanentLineStatus(line: string, typeLine: string, name: string): LineStatus {
  if (/^enchant /i.test(line) && auraTarget(typeLine, line)) return { title: "Aura", status: "auto" };
  const abilities = parsePermanentAbilities(line, name, typeLine);
  if (/^\{T\}: Add /.test(line) && manaOptions(typeLine, line).length > 0) return { title: "Capacité de mana", status: "auto" };
  if (abilities.triggers.length > 0) return { title: "Capacité déclenchée", status: "auto" };
  const activated = abilities.activated[0];
  if (activated) {
    const title = activated.equip ? "Équipement" : activated.cost.loyalty !== undefined ? "Capacité de loyauté" : activated.mana ? "Capacité de mana" : "Capacité activée";
    const { effects, unknown } = activated.effects;
    if (unknown.length === 0 && effects.length > 0) return { title, status: "auto" };
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
    if (parts.every((p) => HANDLED_KEYWORDS.has(p))) {
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
  "read ahead": { name: "Lecture anticipée", help: "En lançant la saga, tu choisis le chapitre de départ ; les chapitres sautés ne se déclenchent pas." },
  exploit: { name: "Exploitation", help: "En arrivant, tu peux sacrifier une créature (le moteur te le demande)." },
  flash: { name: "Flash", help: "Peut se lancer à tout moment où l'on a la priorité." },
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
