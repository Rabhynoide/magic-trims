import type { GameView } from "@magic-trims/core";
import { cardData, cardImage, cardName, cardText } from "../cards";
import { useUi } from "../ui-store";
import { AbilityPanel } from "./AbilityPanel";

const WIDTH = 300;
const HEIGHT = Math.round((WIDTH * 680) / 488);
const GAP = 12;
const PANEL = 250;

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
  const onRight = left + WIDTH + GAP + PANEL <= vw - 8;
  if (!onRight) left = rect.left - GAP - WIDTH;
  left = Math.max(8, Math.min(left, vw - WIDTH - 8));
  // L'encart des capacités, du côté où il y a de la place.
  const panelLeft = left + WIDTH + GAP + PANEL <= vw - 8 ? left + WIDTH + GAP : Math.max(8, left - GAP - PANEL);
  const top = Math.max(8, Math.min((rect.top + rect.bottom) / 2 - HEIGHT / 2, vh - HEIGHT - 8));
  const text = data ? cardText(data, card.faceIndex) : null;

  return (
    <>
      <AbilityPanel view={props.view} card={card} className="zoom-abilities" style={{ left: panelLeft, top, width: PANEL }} />
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
    </>
  );
}
