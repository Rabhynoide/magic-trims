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
  const face = data.faces?.[(card as VisibleCardView).faceIndex];
  const images = face?.image ?? data.image;
  return images ? images[size] : null;
}

export function cardName(view: GameView, card: CardView): string {
  const data = cardData(view, card);
  if (!data || card.hidden) return "Carte cachée";
  return data.faces?.[(card as VisibleCardView).faceIndex]?.name ?? data.name;
}

export function isLand(view: GameView, card: CardView): boolean {
  const data = cardData(view, card);
  const type = data?.faces?.[0]?.typeLine ?? data?.typeLine ?? "";
  return /\bLand\b/.test(type);
}
