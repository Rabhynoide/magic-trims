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
import { parseSpellEffects, selfToTilde, type SpellEffects } from "./effects.js";
import { joinModes } from "./text.js";
import { parseStaticLine, type StaticAbility } from "./statics.js";
import { areTeammates } from "./modes.js";
import type { TurnStep } from "./turn.js";
import type { CardData, CardInstanceId, GameState, PlayerId, StackAbility, Zone } from "./types.js";

export type TriggerEvent =
  | { type: "enters"; cardId: CardInstanceId; controllerId: PlayerId; creature: boolean }
  /** `granted` : capacités données à la créature jusqu'à la fin du tour (Malakir Rebirth). */
  | { type: "dies"; cardId: CardInstanceId; controllerId: PlayerId; dataId: string; faceIndex: number; isToken: boolean; granted?: string[] }
  /** `nth` : combientième carte piochée par ce joueur ce tour-ci. */
  | { type: "draw"; playerId: PlayerId; nth?: number }
  | { type: "lifeGain"; playerId: PlayerId; amount: number }
  | { type: "lifeLoss"; playerId: PlayerId; amount: number }
  | { type: "step"; step: TurnStep; playerId: PlayerId }
  | { type: "landPlayed"; playerId: PlayerId }
  | { type: "cast"; playerId: PlayerId; cardId: CardInstanceId; typeLine: string }
  | { type: "attacks"; cardId: CardInstanceId }
  | { type: "blocks"; cardId: CardInstanceId }
  | { type: "exploits"; cardId: CardInstanceId }
  /** Un permanent subit des blessures (Body of Knowledge). */
  | { type: "damaged"; cardId: CardInstanceId; amount: number }
  /** Une créature inflige des blessures de combat à un joueur. */
  | { type: "combatDamage"; cardId: CardInstanceId; controllerId: PlayerId; playerId: PlayerId; amount: number }
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
  | { on: "enters"; self: boolean; another: boolean; creature: boolean; whose: Whose }
  /** `batched` : « one or more … die » se déclenche une fois par action, quel que soit le nombre de morts. */
  | { on: "dies"; self: boolean; others: boolean; whose: Whose; batched?: boolean }
  /** `nth` : « draw your second card each turn ». */
  | { on: "draw" | "lifeGain" | "lifeLoss" | "landPlayed"; whose: Whose; nth?: number }
  | { on: "step"; step: "upkeep" | "draw" | "main1" | "end"; whose: Whose }
  | { on: "cast"; whose: Whose; types: string[]; notTypes: string[] }
  /** « Whenever ~ attacks », « … blocks », « … attacks or blocks ». */
  | { on: "combat"; attacks: boolean; blocks: boolean }
  /** « When ~ exploits a creature ». */
  | { on: "exploits" }
  /** « Whenever a creature deals combat damage to one of your opponents », « Whenever ~ deals combat damage to a player ». */
  | { on: "combatDamage"; self: boolean; creature: Whose; player: Whose }
  /** « Whenever ~ is dealt damage ». */
  | { on: "damaged" }
  /** Chapitre d'une saga (« I, II — … »). */
  | { on: "chapter"; chapters: number[] }
  /** « When ~ leaves the battlefield » ; `enchanted` : « When enchanted permanent dies or is put into exile » (`to` : zones visées). */
  | { on: "leaves"; enchanted?: boolean; to?: Zone[] };

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
  /** « This ability triggers only once each turn. » */
  oncePerTurn?: boolean;
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
  const t = text.trim();
  let m: RegExpExecArray | null;
  if (/^~ enters(?: the battlefield)?$/i.test(t)) {
    return { on: "enters", self: true, another: false, creature: false, whose: "you" };
  }
  if ((m = /^(a|another) (creature|permanent)( you control| an opponent controls)? enters(?: the battlefield)?(?: under your control)?$/i.exec(t))) {
    const controls = (m[3] ?? "").trim().toLowerCase();
    return {
      on: "enters",
      self: false,
      another: m[1]!.toLowerCase() === "another",
      creature: m[2]!.toLowerCase() === "creature",
      whose: controls === "you control" || /under your control/i.test(t) ? "you" : controls ? "opponent" : "any",
    };
  }
  if (/^~ dies$/i.test(t)) return { on: "dies", self: true, others: false, whose: "you" };
  if ((m = /^one or more other creatures( you control| an opponent controls)? die$/i.exec(t))) {
    const controls = (m[1] ?? "").trim().toLowerCase();
    return { on: "dies", self: false, others: true, whose: controls === "you control" ? "you" : controls ? "opponent" : "any", batched: true };
  }
  if ((m = /^(~ or another|another|a) creature( you control| an opponent controls)? dies$/i.exec(t))) {
    const controls = (m[2] ?? "").trim().toLowerCase();
    const who: Whose = controls === "you control" ? "you" : controls ? "opponent" : "any";
    return { on: "dies", self: m[1]!.startsWith("~"), others: true, whose: who };
  }
  if ((m = /^(you|an opponent|a player) draws? a card$/i.exec(t))) return { on: "draw", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) draws? (?:your|their|his or her) (second|third) card each turn$/i.exec(t))) {
    return { on: "draw", whose: whose(m[1]!)!, nth: m[2]!.toLowerCase() === "second" ? 2 : 3 };
  }
  if ((m = /^(you|an opponent|a player) gains? life$/i.exec(t))) return { on: "lifeGain", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) loses? life$/i.exec(t))) return { on: "lifeLoss", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) plays? a land$/i.exec(t))) return { on: "landPlayed", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) casts? an? (?:(creature|noncreature|artifact|enchantment|instant|sorcery|instant or sorcery) )?spell$/i.exec(t))) {
    const type = (m[2] ?? "").toLowerCase();
    return {
      on: "cast",
      whose: whose(m[1]!)!,
      types: type === "instant or sorcery" ? ["instant", "sorcery"] : type && !type.startsWith("non") ? [type] : [],
      notTypes: type.startsWith("non") ? [type.slice(3)] : [],
    };
  }
  if ((m = /^~ (attacks|blocks|attacks or blocks)$/i.exec(t))) {
    const what = m[1]!.toLowerCase();
    return { on: "combat", attacks: what.includes("attacks"), blocks: what.includes("blocks") };
  }
  if (/^~ exploits a creature$/i.test(t)) return { on: "exploits" };
  if (/^~ is dealt damage$/i.test(t)) return { on: "damaged" };
  if ((m = /^(~|a creature|a creature you control|a creature an opponent controls) deals combat damage to (a player|an opponent|one of your opponents|you)$/i.exec(t))) {
    const who = m[1]!.toLowerCase();
    const to = m[2]!.toLowerCase();
    return {
      on: "combatDamage",
      self: who === "~",
      creature: who.endsWith("you control") ? "you" : who.endsWith("opponent controls") ? "opponent" : "any",
      player: to === "a player" ? "any" : to === "you" ? "you" : "opponent",
    };
  }
  if (/^~ leaves the battlefield$/i.test(t)) return { on: "leaves" };
  if ((m = /^enchanted (?:permanent|creature) (dies|is put into exile|dies or is put into exile|leaves the battlefield)$/i.exec(t))) {
    const what = m[1]!.toLowerCase();
    const to: Zone[] = what.startsWith("leaves") ? [] : [...(what.includes("dies") ? (["graveyard"] as Zone[]) : []), ...(what.includes("exile") ? (["exile"] as Zone[]) : [])];
    return { on: "leaves", enchanted: true, ...(to.length > 0 ? { to } : {}) };
  }
  if ((m = /^the beginning of (your|each|each player's|each opponent's) (?:first|precombat) main phase$/i.exec(t))) {
    return { on: "step", step: "main1", whose: whose(m[1]!)! };
  }
  if ((m = /^the beginning of (your|each|each player's|each opponent's) (upkeep|draw step|end step)$/i.exec(t))) {
    const step = m[2]!.toLowerCase().startsWith("upkeep") ? "upkeep" : m[2]!.toLowerCase().startsWith("draw") ? "draw" : "end";
    return { on: "step", step, whose: whose(m[1]!)! };
  }
  return null;
}

const cache = new Map<string, PermanentAbilities>();

/** Lit le corps d'une capacité déclenchée : ses effets, et si elle est facultative. */
function parseTriggerBody(text: string): { effects: SpellEffects; optional: boolean; payMana?: string; payLife?: number } | null {
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  // « You may pay 2 life. If you do, … », « its controller may pay 1 life. If they do, they draw a card. »
  const life = /^(?:you|its controller) may pay (\d+) life\. If (?:you|they) do, (?:they )?(.+)$/i.exec(text);
  if (life) return { effects: parseSpellEffects(cap(life[2]!), "~"), optional: true, payLife: parseInt(life[1]!, 10) };
  // Well of Lost Dreams : X au plus égal à la quantité de l'événement.
  const payX = /^you may pay \{X\}, where X is less than or equal to the amount of life you (?:gained|lost)\. If you do, (.+)$/i.exec(text);
  if (payX) return { effects: parseSpellEffects(cap(payX[1]!), "~"), optional: true, payMana: "{X}" };
  const pay = /^you may pay ((?:\{[^}]+\})+)\. If you do, (.+)$/i.exec(text);
  if (pay) return { effects: parseSpellEffects(cap(pay[2]!), "~"), optional: true, payMana: pay[1]! };
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
    const tilde = selfToTilde(line, cardName).trim();
    if (/^exploit$/i.test(line)) {
      result.triggers.push(EXPLOIT);
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
      });
      continue;
    }
    // « When there are nine or more … counters on ~, exile it » : une règle d'état, lue comme un effet statique.
    const stateRule = /^When there are /i.test(tilde) ? parseStaticLine(tilde) : null;
    if (stateRule) {
      result.statics.push(stateRule);
      continue;
    }
    const m = /^(When|Whenever|At) (.+?), (.+)$/.exec(tilde);
    if (m) {
      const condition = parseTriggerCondition(m[2]!);
      let body = m[3]!;
      let oncePerTurn = false;
      if (/\s*This ability triggers only once each turn\.?$/i.test(body)) {
        oncePerTurn = true;
        body = body.replace(/\s*This ability triggers only once each turn\.?$/i, "");
      }
      let ifUntapped = false;
      const untapped = /^if ~ is untapped, (.+)$/i.exec(body);
      if (untapped) {
        ifUntapped = true;
        body = untapped[1]!;
      }
      const parsed = parseTriggerBody(body);
      if (!condition || !parsed || parsed.effects.unknown.length > 0 || (parsed.effects.effects.length === 0 && !parsed.effects.modes)) {
        result.unknown.push(line);
        continue;
      }
      result.triggers.push({
        text: line,
        condition,
        effects: parsed.effects,
        ifUntapped,
        optional: parsed.optional,
        ...(parsed.payMana ? { payMana: parsed.payMana } : {}),
        ...(parsed.payLife ? { payLife: parsed.payLife } : {}),
        ...(oncePerTurn ? { oncePerTurn } : {}),
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
  switch (event.type) {
    case "enters":
      if (c.on !== "enters") return false;
      if (c.self) return event.cardId === source.instanceId;
      if (c.another && event.cardId === source.instanceId) return false;
      if (c.creature && !event.creature) return false;
      return whoseMatches(g, c.whose, source.controllerId, event.controllerId);
    case "dies":
      if (c.on !== "dies") return false;
      if (event.cardId === source.instanceId) return c.self;
      return c.others && whoseMatches(g, c.whose, source.controllerId, event.controllerId);
    case "step":
      return c.on === "step" && c.step === event.step && whoseMatches(g, c.whose, source.controllerId, event.playerId);
    case "cast": {
      if (c.on !== "cast" || !whoseMatches(g, c.whose, source.controllerId, event.playerId)) return false;
      const type = event.typeLine.toLowerCase();
      const has = (t: string) => new RegExp(`\\b${t}\\b`).test(type);
      return (c.types.length === 0 || c.types.some(has)) && !c.notTypes.some(has);
    }
    case "attacks":
    case "blocks":
      return c.on === "combat" && (event.type === "attacks" ? c.attacks : c.blocks) && event.cardId === source.instanceId;
    case "exploits":
      return c.on === "exploits" && event.cardId === source.instanceId;
    case "damaged":
      return c.on === "damaged" && event.cardId === source.instanceId;
    case "combatDamage":
      if (c.on !== "combatDamage") return false;
      if (c.self && event.cardId !== source.instanceId) return false;
      return whoseMatches(g, c.creature, source.controllerId, event.controllerId) && whoseMatches(g, c.player, source.controllerId, event.playerId);
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
    default:
      return c.on === event.type && whoseMatches(g, c.whose, source.controllerId, event.playerId);
  }
}
