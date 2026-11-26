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
import { parseSpellEffects, type SpellEffects } from "./effects.js";
import { areTeammates } from "./modes.js";
import type { TurnStep } from "./turn.js";
import type { CardData, CardInstanceId, GameState, PlayerId } from "./types.js";

export type TriggerEvent =
  | { type: "enters"; cardId: CardInstanceId; controllerId: PlayerId; creature: boolean }
  | { type: "dies"; cardId: CardInstanceId; controllerId: PlayerId; dataId: string; faceIndex: number; isToken: boolean }
  | { type: "draw"; playerId: PlayerId }
  | { type: "lifeGain"; playerId: PlayerId; amount: number }
  | { type: "lifeLoss"; playerId: PlayerId; amount: number }
  | { type: "step"; step: TurnStep; playerId: PlayerId }
  | { type: "landPlayed"; playerId: PlayerId };

/** Qui, par rapport au contrôleur de la capacité. */
type Whose = "you" | "opponent" | "any";

export type TriggerCondition =
  | { on: "enters"; self: boolean; another: boolean; creature: boolean; whose: Whose }
  | { on: "dies"; self: boolean; others: boolean; whose: Whose }
  | { on: "draw" | "lifeGain" | "lifeLoss" | "landPlayed"; whose: Whose }
  | { on: "step"; step: "upkeep" | "draw" | "end"; whose: Whose };

export interface TriggeredAbility {
  /** Texte de la capacité, tel qu'imprimé. */
  text: string;
  condition: TriggerCondition;
  effects: SpellEffects;
  /** « if ~ is untapped » : la capacité ne se déclenche que si la source est dégagée. */
  ifUntapped: boolean;
}

export interface PermanentAbilities {
  triggers: TriggeredAbility[];
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
  if ((m = /^(~ or another|another|a) creature( you control| an opponent controls)? dies$/i.exec(t))) {
    const controls = (m[2] ?? "").trim().toLowerCase();
    const who: Whose = controls === "you control" ? "you" : controls ? "opponent" : "any";
    return { on: "dies", self: m[1]!.startsWith("~"), others: true, whose: who };
  }
  if ((m = /^(you|an opponent|a player) draws? a card$/i.exec(t))) return { on: "draw", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) gains? life$/i.exec(t))) return { on: "lifeGain", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) loses? life$/i.exec(t))) return { on: "lifeLoss", whose: whose(m[1]!)! };
  if ((m = /^(you|an opponent|a player) plays? a land$/i.exec(t))) return { on: "landPlayed", whose: whose(m[1]!)! };
  if ((m = /^the beginning of (your|each|each player's|each opponent's) (upkeep|draw step|end step)$/i.exec(t))) {
    const step = m[2]!.toLowerCase().startsWith("upkeep") ? "upkeep" : m[2]!.toLowerCase().startsWith("draw") ? "draw" : "end";
    return { on: "step", step, whose: whose(m[1]!)! };
  }
  return null;
}

const cache = new Map<string, PermanentAbilities>();

/** Les capacités déclenchées d'une face de permanent. */
export function parsePermanentAbilities(oracleText: string, cardName: string): PermanentAbilities {
  const key = `${cardName}\u0000${oracleText}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result: PermanentAbilities = { triggers: [], unknown: [] };
  for (const raw of oracleText.split("\n")) {
    const line = raw.replace(/\([^)]*\)/g, "").trim();
    const m = /^(When|Whenever|At) (.+?), (.+)$/.exec(line);
    if (!m) continue;
    const shortName = cardName.split(",")[0]!;
    const condition = parseTriggerCondition(m[2]!.split(cardName).join("~").split(shortName).join("~"));
    let body = m[3]!;
    let ifUntapped = false;
    const untapped = new RegExp(`^if ${escape(cardName)} is untapped, (.+)$`, "i").exec(body);
    if (untapped) {
      ifUntapped = true;
      body = untapped[1]!;
    }
    const effects = parseSpellEffects(body.charAt(0).toUpperCase() + body.slice(1), cardName);
    if (!condition || effects.unknown.length > 0 || effects.effects.length === 0 || /\bmay\b/i.test(body)) {
      result.unknown.push(line);
      continue;
    }
    result.triggers.push({ text: line, condition, effects, ifUntapped });
  }
  cache.set(key, result);
  return result;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Capacités déclenchées de la face visible d'une carte. */
export function abilitiesOf(data: CardData | undefined, faceIndex = 0): PermanentAbilities {
  if (!data) return { triggers: [], unknown: [] };
  const face = data.faces?.[faceIndex];
  return parsePermanentAbilities(face?.oracleText ?? data.oracleText, face?.name ?? data.name);
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
    default:
      return c.on === event.type && whoseMatches(g, c.whose, source.controllerId, event.playerId);
  }
}
