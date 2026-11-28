import { abilityReport, type AbilityReportItem, type CardData, type CardView, type GameView, type VisibleCardView } from "@magic-trims/core";
import { cardData } from "../cards";
import { ManaText } from "./ManaText";

const ICONS: Record<AbilityReportItem["status"], { icon: string; label: string }> = {
  auto: { icon: "✓", label: "automatique" },
  partial: { icon: "½", label: "en partie" },
  manual: { icon: "✋", label: "à la main" },
};

/** Lignes de texte d'une carte, sans le texte de rappel. */
function lines(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\([^)]*\)/g, "").trim())
    .filter(Boolean);
}

/**
 * Ce que le moteur fait de chaque capacité de la carte : automatique, en
 * partie ou à la main (comme les encarts de mots-clés d'Arena).
 */
export function AbilityPanel(props: { view: GameView; card: CardView; className?: string; style?: React.CSSProperties }) {
  const { view, card } = props;
  if (card.hidden || card.faceDown) return null;
  const data = cardData(view, card);
  if (!data) return null;
  return (
    <CardAbilities
      data={data}
      faceIndex={(card as VisibleCardView).faceIndex}
      rulesOff={!view.settings.enforceRules}
      {...(props.className ? { className: props.className } : {})}
      {...(props.style ? { style: props.style } : {})}
    />
  );
}

/** Même encart pour une carte hors partie (liste des decks…). */
export function CardAbilities(props: {
  data: CardData;
  faceIndex?: number;
  rulesOff?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { data } = props;
  const faceIndex = props.faceIndex ?? 0;
  const items = abilityReport(data, faceIndex);
  if (items.length === 0) return null;

  // Texte français ligne à ligne, quand la traduction a le même nombre de lignes que l'anglais.
  const english = lines(data.faces?.[faceIndex]?.oracleText ?? data.oracleText);
  const french = lines(data.localized?.faces?.[faceIndex]?.oracleText ?? data.localized?.oracleText);
  const translate = (text: string) => {
    if (french.length !== english.length) return text;
    const i = english.indexOf(text);
    return i >= 0 ? french[i]! : text;
  };
  const rulesOff = Boolean(props.rulesOff);

  return (
    <div className={`ability-panel ${props.className ?? ""}`} style={props.style}>
      {rulesOff && <div className="ability-note">L'hôte n'applique pas les règles : tout est à faire à la main.</div>}
      {items.map((item, i) => {
        const status = rulesOff ? "manual" : item.status;
        const keyword = item.title !== "Effet du sort" && !item.title.startsWith("Capacité");
        return (
          <div key={i} className={`ability-item ${status}`}>
            <div className="ability-head">
              <span className="ability-icon" aria-hidden>
                {ICONS[status].icon}
              </span>
              <strong>{item.title}</strong>
              <span className="ability-status">{ICONS[status].label}</span>
            </div>
            <div className="ability-text" title={keyword ? undefined : item.text}>
              <ManaText text={keyword ? item.text : translate(item.text)} />
            </div>
            {!rulesOff && item.manual && item.manual.length > 0 && (
              <div className="ability-manual">
                À la main : <ManaText text={item.manual.join(" ")} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
