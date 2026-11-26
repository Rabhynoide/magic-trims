import type { CardView, GameView } from "@magic-trims/core";
import { cardImage, cardName } from "../cards";
import { ui } from "../ui-store";

export const DRAG_TYPE = "application/x-magic-card";

/** Une carte sur la table : image, état engagé, marqueurs. */
export function Card(props: {
  view: GameView;
  card: CardView;
  size?: "tiny" | "small" | "medium";
  onMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  draggable?: boolean;
  attachments?: CardView[];
  /** Mode sélection (par exemple pour un mulligan) : un clic choisit la carte. */
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { view, card } = props;
  const img = cardImage(view, card, props.size === "medium" ? "normal" : "small");
  const name = cardName(view, card);
  const counters = Object.entries(card.counters);
  const id = card.instanceId;
  return (
    <div
      className={`card card-${props.size ?? "small"} ${card.tapped ? "tapped" : ""} ${props.onSelect ? "selectable" : ""} ${props.selected ? "selected" : ""}`}
      draggable={Boolean(props.draggable && id)}
      onDragStart={(e) => {
        if (!id) return;
        e.dataTransfer.setData(DRAG_TYPE, id);
        e.dataTransfer.effectAllowed = "move";
        ui.setPreview(null);
        ui.cancelZoom();
      }}
      onContextMenu={(e) => {
        if (!props.onMenu) return;
        e.preventDefault();
        props.onMenu(e);
      }}
      onClick={(e) => {
        if (props.onSelect && e.button === 0) return props.onSelect();
        if (props.onMenu && e.button === 0 && e.altKey) props.onMenu(e);
      }}
      onDoubleClick={props.onDoubleClick}
      onMouseEnter={(e) => {
        if (card.hidden) return;
        ui.setPreview(card);
        ui.hoverCard(card, e.currentTarget);
      }}
      onMouseLeave={() => {
        ui.setPreview(null);
        ui.cancelZoom();
      }}
      onMouseDown={() => ui.cancelZoom()}
      data-card-name={name}
    >
      {img ? (
        <img src={img} alt={name} draggable={false} loading="lazy" />
      ) : (
        <div className="card-back">{card.hidden ? "" : name}</div>
      )}
      {card.faceDown && !card.hidden && <span className="card-flag">face cachée</span>}
      {counters.length > 0 && (
        <div className="card-counters">
          {counters.map(([kind, n]) => (
            <span key={kind} className="counter" title={kind}>
              {kind === "+1/+1" || kind === "-1/-1" ? `${kind} ×${n}` : `${n} ${kind}`}
            </span>
          ))}
        </div>
      )}
      {props.attachments && props.attachments.length > 0 && (
        <div className="card-attachments">
          {props.attachments.map((a) => (
            <span key={a.instanceId ?? ""}>{cardName(view, a)}</span>
          ))}
        </div>
      )}
    </div>
  );
}
