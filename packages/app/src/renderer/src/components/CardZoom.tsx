import type { GameView } from "@magic-trims/core";
import { cardData, cardImage, cardName, cardText } from "../cards";
import { useUi } from "../ui-store";

const WIDTH = 300;
const HEIGHT = Math.round((WIDTH * 680) / 488);
const GAP = 12;

/** La carte survolée, agrandie à côté d'elle. */
export function CardZoom(props: { view: GameView }) {
  const { zoom } = useUi();
  if (!zoom || zoom.card.hidden) return null;
  const { card, rect } = zoom;
  const img = cardImage(props.view, card, "normal");
  const data = cardData(props.view, card);
  if (!img && !data) return null;

  // À droite de la carte s'il y a la place, sinon à gauche ; toujours dans la fenêtre.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.right + GAP;
  if (left + WIDTH > vw - 8) left = rect.left - GAP - WIDTH;
  left = Math.max(8, Math.min(left, vw - WIDTH - 8));
  const top = Math.max(8, Math.min((rect.top + rect.bottom) / 2 - HEIGHT / 2, vh - HEIGHT - 8));
  const text = data ? cardText(data, card.faceIndex) : null;

  return (
    <div className="card-zoom" style={{ left, top, width: WIDTH, height: img ? HEIGHT : "auto" }}>
      {img ? (
        <img src={img} alt={cardName(props.view, card)} />
      ) : (
        text && (
          <div className="preview-text">
            <strong>{text.name}</strong> {data?.manaCost}
            <div>{text.typeLine}</div>
            <p>{text.oracleText}</p>
          </div>
        )
      )}
    </div>
  );
}
