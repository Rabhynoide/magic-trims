/**
 * Capacités activées des permanents (« {2}{B}, {T}, Sacrifice this artifact:
 * … », « Equip {2} », « −2: … » des planeswalkers), lues dans le texte Oracle.
 *
 * Le moteur paie le coût (mana, engagement, points de vie, sacrifice,
 * loyauté), met la capacité sur la pile et applique les effets qu'il
 * reconnaît à la résolution ; le reste est rappelé dans le journal. Une
 * capacité de mana (« Add … ») se résout tout de suite, sans la pile.
 */
import { parsePermanentFilterText, parseSpellEffects, type PermanentFilter, type SpellEffects } from "./effects.js";

export interface ActivationCost {
  /** Coût de mana (« {2}{B}{B} »), vide s'il n'y en a pas. */
  mana: string;
  tap: boolean;
  /** Points de vie à payer. */
  life: number;
  sacrificeSelf: boolean;
  /** Défausser la carte (recyclage). */
  discardSelf?: boolean;
  /** Un autre permanent à sacrifier (« Sacrifice a creature »), choisi à l'activation. */
  sacrifice?: PermanentFilter;
  /** Loyauté ajoutée (+1) ou retirée (−2) d'un planeswalker. */
  loyalty?: number;
}

export interface ActivatedAbility {
  /** Texte de la capacité, tel qu'imprimé. */
  text: string;
  /** Texte du coût (avant « : »). */
  costText: string;
  cost: ActivationCost;
  effects: SpellEffects;
  /** D'où on l'active : le champ de bataille, le cimetière (« Return this card from your graveyard… ») ou la main (recyclage). */
  zone: "battlefield" | "graveyard" | "hand";
  /** Seulement à la vitesse d'un rituel (équipement, loyauté, « Activate only as a sorcery »). */
  sorcery: boolean;
  /** Une fois par tour (« Activate only once each turn », loyauté). */
  oncePerTurn: boolean;
  /** Capacité de mana : elle n'utilise pas la pile. */
  mana: boolean;
  /** Équiper. */
  equip: boolean;
  /** « Activate only during your turn. » */
  ownTurn?: boolean;
  /** « You can't activate this ability during combat. » */
  notInCombat?: boolean;
}

/** Lit un coût (« {2}, {T}, Sacrifice ~ », « Pay 1 life », « −2 ») ; `null` s'il n'est pas compris. */
export function parseActivationCost(text: string): ActivationCost | null {
  const cost: ActivationCost = { mana: "", tap: false, life: 0, sacrificeSelf: false };
  const loyalty = /^([+−-])?(\d+)$/.exec(text.trim());
  if (loyalty) {
    const n = parseInt(loyalty[2]!, 10);
    cost.loyalty = loyalty[1] === "+" ? n : loyalty[1] ? -n : 0;
    return cost;
  }
  for (const raw of text.split(/,\s*/)) {
    const part = raw.trim();
    let m: RegExpExecArray | null;
    if (/^\{T\}$/i.test(part)) cost.tap = true;
    else if (/^(\{[0-9WUBRGCSX/P]+\})+$/i.test(part)) cost.mana += part;
    else if ((m = /^pay (\d+) life$/i.exec(part))) cost.life += parseInt(m[1]!, 10);
    else if (/^sacrifice ~$/i.test(part)) cost.sacrificeSelf = true;
    else if ((m = /^sacrifice (?:a|an|another) (.+)$/i.exec(part))) {
      const filter = parsePermanentFilterText(m[1]!);
      if (!filter) return null;
      cost.sacrifice = { ...filter, controller: "you" };
    } else return null;
  }
  return cost;
}

/**
 * Lit une ligne de capacité activée (le nom de la carte déjà remplacé par
 * « ~ »). `null` si la ligne n'en est pas une ou si son coût n'est pas compris.
 */
export function parseActivatedLine(line: string, isPlaneswalker: boolean): ActivatedAbility | null {
  // « Cycling {3} » : depuis la main, défausser la carte pour piocher.
  const cycling = /^Cycling (\{[^}]+\}(?:\{[^}]+\})*)$/i.exec(line);
  if (cycling) {
    return {
      text: line,
      costText: cycling[1]!,
      cost: { mana: cycling[1]!.replace(/\{0\}/g, ""), tap: false, life: 0, sacrificeSelf: false, discardSelf: true },
      effects: { targets: [], effects: [{ type: "draw", who: "you", count: 1 }], unknown: [] },
      zone: "hand",
      sorcery: false,
      oncePerTurn: false,
      mana: false,
      equip: false,
    };
  }
  const equip = /^Equip (\{[^}]+\}(?:\{[^}]+\})*)$/i.exec(line);
  if (equip) {
    return {
      text: line,
      costText: equip[1]!,
      cost: { mana: equip[1]!.replace(/\{0\}/g, ""), tap: false, life: 0, sacrificeSelf: false },
      effects: {
        targets: [{ label: "créature que tu contrôles", permanent: { types: ["creature"], notTypes: [], controller: "you" } }],
        effects: [{ type: "attach", target: 0 }],
        unknown: [],
      },
      zone: "battlefield",
      sorcery: true,
      oncePerTurn: false,
      mana: false,
      equip: true,
    };
  }
  // « Coût : effet ». Le coût ne contient pas de guillemets (sinon c'est une capacité donnée à une autre carte).
  const m = /^([^:"]+): (.+)$/.exec(line);
  if (!m) return null;
  const costText = m[1]!.trim();
  if (/^(When|Whenever|At|As|If)\b/i.test(costText)) return null;
  const cost = parseActivationCost(costText);
  if (!cost) return null;
  if (cost.loyalty !== undefined && !isPlaneswalker) return null;
  let body = m[2]!.trim();
  let sorcery = cost.loyalty !== undefined;
  let oncePerTurn = cost.loyalty !== undefined;
  if (/\s*Activate only as a sorcery\.?$/i.test(body)) {
    sorcery = true;
    body = body.replace(/\s*Activate only as a sorcery\.?$/i, "");
  }
  if (/\s*Activate only once each turn\.?$/i.test(body)) {
    oncePerTurn = true;
    body = body.replace(/\s*Activate only once each turn\.?$/i, "");
  }
  let ownTurn = false;
  if (/\s*Activate only during your turn\.?$/i.test(body)) {
    ownTurn = true;
    body = body.replace(/\s*Activate only during your turn\.?$/i, "");
  }
  let notInCombat = false;
  if (/\s*You can't activate this ability during combat\.?$/i.test(body)) {
    notInCombat = true;
    body = body.replace(/\s*You can't activate this ability during combat\.?$/i, "");
  }
  const effects = parseSpellEffects(body, "~");
  const zone = effects.effects.some((e) => e.type === "returnSelf") ? "graveyard" : "battlefield";
  const mana = effects.effects.length > 0 && effects.effects.every((e) => e.type === "mana" || e.type === "manaAny") && effects.targets.length === 0;
  return { text: line, costText, cost, effects, zone, sorcery, oncePerTurn, mana, equip: false, ...(ownTurn ? { ownTurn } : {}), ...(notInCombat ? { notInCombat } : {}) };
}
