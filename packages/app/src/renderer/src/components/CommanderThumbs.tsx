import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CardData } from "@magic-trims/core";
import { cardText, dataImage } from "../cards";
import { localizer } from "../localization";
import { ZOOM_DELAY_MS } from "../ui-store";
import { CardAbilities } from "./AbilityPanel";
import { ZOOM_HEIGHT, ZOOM_PANEL, ZOOM_WIDTH, zoomLayout } from "./CardZoom";

type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Miniature du (des) commandant(s) d'un deck, dans la cellule du nom. Elle
 * est placée en absolu dans la cellule : la hauteur des lignes ne bouge pas.
 * Au survol, la carte s'agrandit avec ses capacités, comme sur la table.
 */
export function CommanderThumbs(props: { cards: CardData[] }) {
  useSyncExternalStore(localizer.subscribe, () => localizer.version);
  const [zoom, setZoom] = useState<{ card: CardData; rect: Rect } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setZoom(null);
  };
  useEffect(() => cancel, []);
  // La liste défile sous la souris : la carte agrandie ne suivrait plus.
  useEffect(() => {
    if (!zoom) return;
    window.addEventListener("scroll", cancel, true);
    return () => window.removeEventListener("scroll", cancel, true);
  }, [zoom]);

  const cards = props.cards.map((c) => localizer.card(c));
  const shown = cards.filter((c) => dataImage(c, "small"));
  if (shown.length === 0) return null;

  return (
    <span className="commander-thumbs" aria-hidden>
      {shown.map((card, i) => (
        <img
          key={card.id + i}
          src={dataImage(card, "small")!}
          alt=""
          loading="lazy"
          draggable={false}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              if (!el.isConnected) return;
              const r = el.getBoundingClientRect();
              setZoom({ card, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
            }, ZOOM_DELAY_MS);
          }}
          onMouseLeave={cancel}
          onMouseDown={cancel}
        />
      ))}
      {zoom && createPortal(<ThumbZoom card={zoom.card} rect={zoom.rect} />, document.body)}
    </span>
  );
}

function ThumbZoom(props: { card: CardData; rect: Rect }) {
  const { card } = props;
  const img = dataImage(card, "normal");
  const { left, top, panelLeft } = zoomLayout(props.rect);
  const text = cardText(card);
  return (
    <>
      <CardAbilities data={card} className="zoom-abilities" style={{ left: panelLeft, top, width: ZOOM_PANEL }} />
      <div className="card-zoom" style={{ left, top, width: ZOOM_WIDTH, height: img ? ZOOM_HEIGHT : "auto" }}>
        {img ? (
          <img src={img} alt={text.name} />
        ) : (
          <div className="preview-text">
            <strong>{text.name}</strong> {card.manaCost}
            <div>{text.typeLine}</div>
            <p>{text.oracleText}</p>
          </div>
        )}
      </div>
    </>
  );
}
