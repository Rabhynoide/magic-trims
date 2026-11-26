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
export type Amount = number | "X" | "-X" | "event" | "-event";

/** Qui subit l'effet : « you », une cible, ou le joueur de l'événement déclencheur (« that player », « they »). */
export type Who = "you" | "opponents" | "event" | { target: number };

export type Effect =
  | { type: "draw"; who: Who; count: Amount }
  | { type: "destroy"; target: number }
  | { type: "destroyAll"; filter: PermanentFilter }
  | { type: "exile"; target: number }
  | { type: "exileAll"; filter: PermanentFilter }
  | { type: "bounce"; target: number }
  | { type: "damage"; target: number | "event"; amount: Amount }
  | { type: "damageEach"; who: "opponents" | "players" | "creatures"; amount: Amount }
  | { type: "life"; who: Who; amount: Amount }
  | { type: "token"; count: Amount; token: TokenSpec; tapped: boolean }
  | { type: "counter"; target: number }
  | { type: "mana"; mana: string[] }
  /** Marqueurs sur la source de la capacité (« put a +1/+1 counter on ~ »). */
  | { type: "counterSelf"; kind: string; count: number };

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
const HARMLESS = [/^(it|they) can't be regenerated\.?$/i, /^this spell can't be countered\.?$/i];

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

function permanentLabel(f: PermanentFilter): string {
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
function parseTriggerSentence(s: string, target: (spec: TargetSpec) => number): Effect[] | null {
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
  const names = [cardName, ...cardName.split(" // "), cardName.split(",")[0]!].filter(Boolean);
  let text = oracleText.replace(/\([^)]*\)/g, "");
  for (const n of names) text = text.split(n).join("~");
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

    const triggered = parseTriggerSentence(s, target);
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
export function resolveAmount(a: Amount, x: number, eventAmount = 0): number {
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

const HANDLED_KEYWORDS = new Set([...COMBAT_KEYWORDS, "Flash"].map((k) => k.toLowerCase()));

function faceSupport(typeLine: string, oracleText: string, name: string): { known: number; unknown: string[] } {
  if (/\b(Instant|Sorcery)\b/.test(typeLine)) {
    const parsed = parseSpellEffects(oracleText, name);
    return { known: parsed.effects.length, unknown: parsed.unknown };
  }
  let known = 0;
  const unknown: string[] = [];
  const triggers = new Set(parsePermanentAbilities(oracleText, name).triggers.map((t) => t.text));
  for (const raw of oracleText.split("\n")) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    if (!line) continue;
    const parts = line.split(/,\s*/).map((p) => p.trim().toLowerCase());
    if (parts.every((p) => HANDLED_KEYWORDS.has(p))) {
      known++;
      continue;
    }
    if (/^\{T\}: Add /.test(line) && manaOptions(typeLine, line).length > 0) {
      known++;
      continue;
    }
    if (triggers.has(line)) {
      known++;
      continue;
    }
    unknown.push(line);
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
