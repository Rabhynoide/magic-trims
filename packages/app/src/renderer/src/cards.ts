import type { CardData, CardView, GameView, VisibleCardView } from "@magic-trims/core";

export function cardData(view: GameView, card: CardView): CardData | undefined {
  return card.hidden ? undefined : view.cardData[card.cardId];
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
