import type { CardView, GameView } from "@magic-trims/core";
import { cardData, cardImage, cardName, creaturePT, supportHint, supportOf } from "../cards";
import { ui } from "../ui-store";

export const DRAG_TYPE = "application/x-magic-card";

/** Une carte sur la table : image, état engagé, marqueurs. */
export function Card(props: {
  view: GameView;
  card: CardView;
  size?: "tiny" | "small" | "medium";
  onMenu?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  draggable?: boolean;
  attachments?: CardView[];
  /** Menu, choix de cible… d'une carte attachée (Aura, Équipement). */
  attachmentProps?: (a: CardView) => AttachmentProps;
  /** Mode sélection (par exemple pour un mulligan) : un clic choisit la carte. */
  selected?: boolean;
  onSelect?: () => void;
  /** Étiquette de combat (« attaque Bruno », « bloque Ours »…). */
  combat?: { kind: "attacking" | "blocking"; label: string };
}) {
  const { view, card } = props;
  const img = cardImage(view, card, props.size === "medium" ? "normal" : "small");
  const name = cardName(view, card);
  const counters = Object.entries(card.counters);
  const id = card.instanceId;
  return (
    <div
      className={`card card-${props.size ?? "small"} ${card.tapped ? "tapped" : ""} ${props.onSelect ? "selectable" : ""} ${props.selected ? "selected" : ""} ${props.combat ? props.combat.kind : ""}`}
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
      {!card.hidden && card.ability && (
        <span className="card-flag" title={card.ability.text}>
          capacité{card.ability.needsTargets ? " · cible ?" : ""}
        </span>
      )}
      {(() => {
        const data = card.faceDown ? undefined : cardData(view, card);
        const support = data && supportOf(data);
        if (!support || support.level === "full") return null;
        return (
          <span className={`card-support ${support.level}`} title={supportHint(support)}>
            {support.level === "manual" ? "main" : "½"}
          </span>
        );
      })()}
      {props.combat && <span className={`card-combat ${props.combat.kind}`}>{props.combat.label}</span>}
      {/* Marqueurs et force/endurance : calque qui reste à l'endroit même si la carte est engagée. */}
      <div className="card-stats">
        {counters.length > 0 && (
          <div className="card-counters">
            {counters.map(([kind, n]) => {
              const c = counterBadge(kind, n);
              return (
                <span key={kind} className={`counter ${c.tone}`} title={`${n} marqueur${n > 1 ? "s" : ""} ${kind}`}>
                  {c.label}
                </span>
              );
            })}
          </div>
        )}
        {(() => {
          const pt = creaturePT(view, card);
          if (!pt) return null;
          const damage = card.damage ?? 0;
          const toughness = pt.toughness - damage;
          const printedP = Number(pt.printed?.power);
          const printedT = Number(pt.printed?.toughness);
          const tone = (value: number, printed: number) =>
            Number.isNaN(printed) || value === printed ? "" : value > printed ? "up" : "down";
          const title = [
            pt.printed ? `Imprimée : ${pt.printed.power}/${pt.printed.toughness}` : null,
            pt.base ? null : `Actuelle : ${pt.power}/${pt.toughness}`,
            damage > 0 ? `${damage} blessure${damage > 1 ? "s" : ""}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <span className={`card-pt ${pt.base ? "" : "modified"} ${damage > 0 ? "damaged" : ""}`} title={title}>
              <span className={tone(pt.power, printedP)}>{pt.power}</span>/
              <span className={damage > 0 ? "hurt" : tone(pt.toughness, printedT)}>{toughness}</span>
            </span>
          );
        })()}
      </div>
      {props.attachments && props.attachments.length > 0 && (
        <div className="card-attachments">
          {props.attachments.map((a) => (
            <Attachment key={a.instanceId ?? ""} view={view} card={a} host={card} {...props.attachmentProps?.(a)} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface AttachmentProps {
  onMenu?: (e: React.MouseEvent) => void;
  selected?: boolean;
  onSelect?: () => void;
}

/**
 * Étiquette d'une carte attachée, posée sur la carte hôte : le survol agrandit
 * l'Aura ou l'Équipement lui-même (pas l'hôte), le clic droit ouvre son menu,
 * on peut la glisser ailleurs et la choisir comme cible.
 */
function Attachment(props: { view: GameView; card: CardView; host: CardView } & AttachmentProps) {
  const { view, card, host } = props;
  const id = card.instanceId;
  const name = cardName(view, card);
  return (
    <span
      className={`card-attachment ${props.onSelect ? "selectable" : ""} ${props.selected ? "selected" : ""}`}
      title={name}
      draggable={Boolean(id)}
      onDragStart={(e) => {
        e.stopPropagation();
        if (!id) return;
        e.dataTransfer.setData(DRAG_TYPE, id);
        e.dataTransfer.effectAllowed = "move";
        ui.setPreview(null);
        ui.cancelZoom();
      }}
      onMouseEnter={(e) => {
        if (card.hidden) return;
        ui.setPreview(card);
        ui.hoverCard(card, e.currentTarget);
      }}
      onMouseLeave={(e) => {
        ui.cancelZoom();
        // De retour sur la carte hôte : c'est elle qu'on agrandit de nouveau.
        const hostEl = e.currentTarget.closest(".card");
        if (hostEl instanceof HTMLElement && e.relatedTarget instanceof Node && hostEl.contains(e.relatedTarget)) {
          ui.setPreview(host);
          ui.hoverCard(host, hostEl);
        } else ui.setPreview(null);
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        ui.cancelZoom();
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (props.onSelect && e.button === 0) return props.onSelect();
        if (props.onMenu && e.button === 0 && e.altKey) props.onMenu(e);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onMenu?.(e);
      }}
    >
      {card.tapped && <span className="card-attachment-tapped" aria-label="engagée">↷</span>}
      {name}
    </span>
  );
}

/** Pastille compacte d'un type de marqueur : « +3 », « −2 », « 4 charge »… */
function counterBadge(kind: string, n: number): { label: string; tone: string } {
  if (kind === "+1/+1") return { label: `+${n}`, tone: "plus" };
  if (kind === "-1/-1") return { label: `−${n}`, tone: "minus" };
  if (kind === "loyalty" || kind === "loyauté") return { label: `◆${n}`, tone: "loyalty" };
  return { label: `${n} ${kind}`, tone: "" };
}
