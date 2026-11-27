/**
 * Capacités activées des permanents (« {2}{B}, {T}, Sacrifice this artifact:
 * … », « Equip {2} », « −2: … » des planeswalkers), lues dans le texte Oracle.
 *
 * Le moteur paie le coût (mana, engagement, points de vie, sacrifice,
 * loyauté), met la capacité sur la pile et applique les effets qu'il
 * reconnaît à la résolution ; le reste est rappelé dans le journal. Une
 * capacité de mana (« Add … ») se résout tout de suite, sans la pile.
 */
import { parsePermanentFilterText, parseSpellEffects, permanentLabel, type PermanentFilter, type SpellEffects } from "./effects.js";

export interface ActivationCost {
  /** Coût de mana (« {2}{B}{B} »), vide s'il n'y en a pas. */
  mana: string;
  tap: boolean;
  /** Points de vie à payer. */
  life: number;
  sacrificeSelf: boolean;
  /** Défausser la carte (recyclage). */
  discardSelf?: boolean;
  /** Exiler la carte de son cimetière (encore). */
  exileSelf?: boolean;
  /** Un autre permanent à sacrifier (« Sacrifice a creature »), choisi à l'activation. */
  sacrifice?: PermanentFilter;
  /** Loyauté ajoutée (+1) ou retirée (−2) d'un planeswalker. */
  loyalty?: number;
  /** « This ability costs {1} less to activate for each legendary creature you control » (Otawara). */
  reduction?: { amount: number; per: PermanentFilter };
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
    else if (/^discard (?:this card|~)$/i.test(part)) cost.discardSelf = true;
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
  // « Encore {6}{B}{B} » : depuis le cimetière, une copie par adversaire.
  const encore = /^Encore ((?:\{[^}]+\})+)$/i.exec(line);
  if (encore) {
    return {
      text: line,
      costText: encore[1]!,
      cost: { mana: encore[1]!, tap: false, life: 0, sacrificeSelf: false, exileSelf: true },
      effects: { targets: [], effects: [{ type: "encore" }], unknown: [] },
      zone: "graveyard",
      sorcery: true,
      oncePerTurn: false,
      mana: false,
      equip: false,
    };
  }
  // « Equip {2} », et l'équipement restreint : « Equip Shaman, Warlock, or Wizard {1} », « Equip legendary creature {3} ».
  const equip = /^Equip(?: ([^{]+?))? (\{[^}]+\}(?:\{[^}]+\})*)$/i.exec(line);
  if (equip) {
    const restriction = equip[1] ? equipFilter(equip[1]) : { types: ["creature"], notTypes: [], controller: "you" as const };
    if (!restriction) return null;
    return {
      text: line,
      costText: equip[2]!,
      cost: { mana: equip[2]!.replace(/\{0\}/g, ""), tap: false, life: 0, sacrificeSelf: false },
      effects: {
        targets: [{ label: permanentLabel(restriction), permanent: restriction }],
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
  // Un mot de capacité (« Channel — ») est retiré : il n'a pas d'effet sur les règles.
  const m = /^(?:Channel — )?([^:"]+): (.+)$/.exec(line);
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
  const reduction = /\s*This ability costs \{(\d+)\} less to activate for each ([^.]+)\.?$/i.exec(body);
  if (reduction) {
    const per = parsePermanentFilterText(reduction[2]!);
    if (!per) return null;
    cost.reduction = { amount: parseInt(reduction[1]!, 10), per };
    body = body.slice(0, reduction.index);
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
  // Canalisation (« Discard this card ») : depuis la main.
  const zone = cost.discardSelf ? "hand" : effects.effects.some((e) => e.type === "returnSelf") ? "graveyard" : "battlefield";
  const mana = effects.effects.length > 0 && effects.effects.every((e) => e.type === "mana" || e.type === "manaAny") && effects.targets.length === 0;
  return { text: line, costText, cost, effects, zone, sorcery, oncePerTurn, mana, equip: false, ...(ownTurn ? { ownTurn } : {}), ...(notInCombat ? { notInCombat } : {}) };
}

/**
 * La créature qu'on peut équiper : « Shaman, Warlock, or Wizard » (l'un de ces
 * types de créature), « legendary creature »… ; `null` si ce n'est pas compris.
 */
function equipFilter(text: string): PermanentFilter | null {
  const t = text.trim();
  const words = t.replace(/,? or /g, ",").split(/,\s*/).map((w) => w.trim()).filter(Boolean);
  if (words.length > 0 && words.every((w) => /^[A-Z][a-z]+(?:-[a-z]+)?$/.test(w)) && !/^(Legendary|Creature|Artifact)$/.test(words[0]!)) {
    return words.length === 1
      ? { types: ["creature"], notTypes: [], controller: "you", subtype: words[0]! }
      : { types: ["creature"], notTypes: [], controller: "you", anySubtype: words };
  }
  const filter = parsePermanentFilterText(`${t} you control`);
  if (!filter || filter.types.join() !== "creature") return null;
  return filter;
}

/** Le coût de mana après réduction (« {3}{U} » moins 2 → « {1}{U} ») : seul le générique baisse. */
export function reduceGenericCost(mana: string, by: number): string {
  if (by <= 0) return mana;
  let left = by;
  return mana.replace(/\{(\d+)\}/g, (_, n: string) => {
    const keep = Math.max(0, parseInt(n, 10) - left);
    left -= parseInt(n, 10) - keep;
    return keep > 0 ? `{${keep}}` : "";
  });
}
