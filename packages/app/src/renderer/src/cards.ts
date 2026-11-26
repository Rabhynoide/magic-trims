import { cardSupport, creatureStats, stateFromView, isCreature, manaOptions, type CardSupport, type CardData, type CardView, type GameView, type ManaType, type VisibleCardView } from "@magic-trims/core";

export function cardData(view: GameView, card: CardView): CardData | undefined {
  return card.hidden ? undefined : view.cardData[card.cardId];
}

const supportCache = new Map<string, CardSupport>();

/** Ce que le moteur gère de la carte (mis en cache par carte). */
export function supportOf(data: CardData): CardSupport {
  let support = supportCache.get(data.id);
  if (!support) {
    support = cardSupport(data);
    supportCache.set(data.id, support);
  }
  return support;
}

/** Texte d'aide d'une carte que le moteur ne gère pas entièrement. */
export function supportHint(support: CardSupport): string {
  const head =
    support.level === "manual"
      ? "Le moteur ne gère pas cette carte : applique ses effets à la main."
      : "Le moteur gère une partie de cette carte. À faire à la main :";
  return support.level === "manual" ? head : `${head}\n• ${support.unknown.join("\n• ")}`;
}

/** Image de la face visible d'une carte. */
export function cardImage(
  view: GameView,
  card: CardView,
  size: "small" | "normal" | "large" = "normal",
): string | null {
  const data = cardData(view, card);
  if (!data || card.hidden) return null;
  const index = (card as VisibleCardView).faceIndex;
  const localized = data.localized;
  const images = localized
    ? (localized.faces?.[index]?.image ?? localized.image)
    : (data.faces?.[index]?.image ?? data.image);
  return images ? images[size] : null;
}

export function cardName(view: GameView, card: CardView): string {
  const data = cardData(view, card);
  if (!data || card.hidden) return "Carte cachée";
  const index = (card as VisibleCardView).faceIndex;
  const localized = data.localized;
  if (localized) return localized.faces?.[index]?.name ?? localized.name;
  return data.faces?.[index]?.name ?? data.name;
}

/** Texte de la face visible, traduit si possible (pour l'aperçu sans image). */
export function cardText(data: CardData, faceIndex = 0): { name: string; typeLine: string; oracleText: string } {
  const face = data.faces?.[faceIndex];
  const lf = data.localized?.faces?.[faceIndex];
  const l = data.localized;
  return {
    name: lf?.name ?? (face ? face.name : (l?.name ?? data.name)),
    typeLine: lf?.typeLine ?? (face ? face.typeLine : (l?.typeLine ?? data.typeLine)),
    oracleText: lf?.oracleText ?? (face ? face.oracleText : (l?.oracleText ?? data.oracleText)),
  };
}

export function isLand(view: GameView, card: CardView): boolean {
  const data = cardData(view, card);
  const type = data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "";
  return /\bLand\b/.test(type);
}

/**
 * Rangée du champ de bataille où ranger la carte : créatures, autres
 * permanents (artefacts, enchantements, planeswalkers…) ou terrains.
 * On lit le type de la face visible ; une carte face cachée est une créature 2/2.
 */
export function battlefieldRow(view: GameView, card: CardView): "creatures" | "others" | "lands" {
  const data = cardData(view, card);
  if (!data || card.hidden || (card as VisibleCardView).faceDown) return "creatures";
  const type = data.faces?.[(card as VisibleCardView).faceIndex]?.typeLine ?? data.typeLine;
  if (/\bCreature\b/.test(type)) return "creatures";
  if (/\bLand\b/.test(type)) return "lands";
  return "others";
}

/** Mana que la carte peut produire en s'engageant (texte anglais, celui que lit le moteur). */
export function cardManaOptions(view: GameView, card: CardView): ManaType[][] {
  const data = cardData(view, card);
  if (!data || card.hidden) return [];
  const face = data.faces?.[(card as VisibleCardView).faceIndex];
  return manaOptions(face?.typeLine ?? data.typeLine, face?.oracleText ?? data.oracleText);
}

/** Image Scryfall d'un symbole de mana. */
export function manaSymbolUrl(mana: string): string {
  return `https://svgs.scryfall.io/card-symbols/${mana}.svg`;
}

/** Force et endurance actuelles d'une créature sur le champ de bataille (null sinon). */
export function creaturePT(view: GameView, card: CardView): { power: number; toughness: number; base: boolean } | null {
  if (card.hidden || card.zone !== "battlefield") return null;
  const g = stateFromView(view);
  const c = card as VisibleCardView;
  if (!isCreature(g, c)) return null;
  const stats = creatureStats(g, c);
  const data = cardData(view, card);
  const face = data?.faces?.[c.faceIndex];
  const base =
    String(stats.power) === (face?.power ?? data?.power) && String(stats.toughness) === (face?.toughness ?? data?.toughness);
  return { ...stats, base };
}
