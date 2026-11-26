/**
 * Effets courants des éphémères et des rituels, lus dans le texte Oracle
 * (en anglais, tel que donné par Scryfall).
 *
 * Le moteur reconnaît une phrase à la fois : piocher, détruire, exiler,
 * renvoyer en main, infliger des blessures, gagner ou perdre des points de
 * vie, créer des jetons, contrer un sort. Ce qu'il ne reconnaît pas reste à
 * appliquer à la main, et le journal le rappelle.
 */
import { COMBAT_KEYWORDS, hasKeyword } from "./combat.js";
import { manaOptions } from "./mana.js";
import { parsePermanentAbilities } from "./triggers.js";
import { areTeammates } from "./modes.js";
import { keywordList, selfToTilde } from "./text.js";

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
}

export interface PermanentFilter {
  /** Au moins un de ces types (vide : n'importe quel permanent). */
  types: string[];
  /** Aucun de ces types. */
  notTypes: string[];
  controller?: "you" | "notYou";
  state?: "attacking" | "blocking" | "tapped" | "untapped";
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
export type Amount = number | "X" | "-X" | "event" | "-event" | "dealt" | "hand" | "given";

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
  | { type: "loseGame" };

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
const HARMLESS = [/^(it|they) can't be regenerated\.?$/i, /^~ can't be countered\.?$/i];


/**
 * « creature », « nonland permanent an opponent controls », « artifact or
 * enchantment », « attacking creature »… ; `null` si le texte n'est pas compris.
 */
function parsePermanentFilter(text: string): PermanentFilter | null {
  let t = text.trim().toLowerCase();
  const filter: PermanentFilter = { types: [], notTypes: [] };
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
export function parseSpellEffects(oracleText: string, cardName: string): SpellEffects {
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

  for (const sentence of sentences) {
    const s = sentence.replace(/\.$/, "");
    if (HARMLESS.some((re) => re.test(sentence))) continue;
    let m: RegExpExecArray | null;

    const additional = /^as an additional cost to cast ~, sacrifice (?:a|an) (.+)$/i.exec(s);
    const sacrificed = additional && parsePermanentFilter(additional[1]!);
    if (sacrificed) {
      result.sacrifice = { ...sacrificed, controller: "you" };
      continue;
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
}

export function permanentMatches(facts: PermanentFacts, filter: PermanentFilter, casterId: PlayerId): boolean {
  if (!hasTypes(facts.typeLine, filter.types, filter.notTypes)) return false;
  if (filter.controller === "you" && facts.controllerId !== casterId) return false;
  if (filter.controller === "notYou" && facts.controllerId === casterId) return false;
  if (filter.state === "tapped" && !facts.tapped) return false;
  if (filter.state === "untapped" && facts.tapped) return false;
  if (filter.state === "attacking" && !facts.attacking) return false;
  if (filter.state === "blocking" && !facts.blocking) return false;
  return true;
}

export function spellMatches(typeLine: string, filter: SpellFilter): boolean {
  return hasTypes(typeLine, filter.types, filter.notTypes);
}

/** Le permanent correspond-il au filtre, du point de vue du lanceur ? */
export function matchesPermanent(g: GameState, card: CardInstance, filter: PermanentFilter, casterId: PlayerId): boolean {
  if (card.zone !== "battlefield") return false;
  return permanentMatches(
    {
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
  return false;
}

/** Effets d'une carte sur sa face visible, s'il s'agit d'un éphémère ou d'un rituel. */
export function spellEffectsOf(g: GameState, card: CardInstance, faceIndex = card.faceIndex): SpellEffects | null {
  const data = g.cardData[card.cardId];
  if (!data) return null;
  const face = data.faces?.[faceIndex];
  const typeLine = face?.typeLine ?? data.typeLine;
  if (!/\b(Instant|Sorcery)\b/.test(typeLine)) return null;
  return parseSpellEffects(face?.oracleText ?? data.oracleText, face?.name ?? data.name);
}

/** Valeur d'un nombre d'effet, avec la valeur de X choisie au lancement. */
export function resolveAmount(a: Amount, x: number, eventAmount = 0, context: { dealt?: number; hand?: number; given?: number } = {}): number {
  if (a === "dealt") return context.dealt ?? 0;
  if (a === "given") return context.given ?? 0;
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

const HANDLED_KEYWORDS = new Set([...COMBAT_KEYWORDS, "Flash", "Exploit"].map((k) => k.toLowerCase()));

/** Ce que le moteur fait d'une ligne de texte d'un permanent. */
interface LineStatus {
  title: string;
  status: "auto" | "partial" | "manual";
  manual?: string[];
}

function permanentLineStatus(line: string, typeLine: string, name: string): LineStatus {
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
    const parsed = parseSpellEffects(oracleText, name);
    return { known: parsed.effects.length + (parsed.sacrifice ? 1 : 0), unknown: parsed.unknown };
  }
  let known = 0;
  const unknown: string[] = [];
  for (const raw of oracleText.split("\n")) {
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
  for (const raw of oracleText.split("\n")) {
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
      const parsed = parseSpellEffects(line, name);
      const known = parsed.effects.length + (parsed.sacrifice ? 1 : 0);
      const status = known === 0 ? "manual" : parsed.unknown.length === 0 ? "auto" : "partial";
      items.push({ title: parsed.sacrifice && parsed.effects.length === 0 ? "Coût supplémentaire" : "Effet du sort", text: line, status, ...(status === "partial" ? { manual: parsed.unknown } : {}) });
      continue;
    }
    const st = permanentLineStatus(line, typeLine, name);
    items.push({ title: st.title, text: line, status: st.status, ...(st.manual && st.manual.length > 0 ? { manual: st.manual } : {}) });
  }
  return items;
}
