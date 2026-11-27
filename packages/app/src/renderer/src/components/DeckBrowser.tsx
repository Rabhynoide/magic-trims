import { useMemo, useState, type ReactNode } from "react";
import {
  deckColorIdentity,
  deckLegalityByMode,
  deckSupport,
  deckSupportPercent,
  GAME_MODES,
  isDeckLegal,
  type DeckIssue,
  type DeckSupport,
  type GameModeType,
  type ResolvedDeck,
  type SharedDeck,
} from "@magic-trims/core";
import type { SavedDeck } from "../storage";
import { ManaText } from "./ManaText";

/**
 * Liste des decks en tableau : nom, couleurs, format et légalité pour chaque
 * mode de jeu. Les decks sont rangés en trois catégories : préconstruits
 * officiels (plus tard), decks importés, et decks partagés par le groupe
 * d'amis sur le serveur central facultatif.
 */

export type DeckCategory = "official" | "imported" | "community";

const CATEGORIES: { id: DeckCategory; label: string; empty: string; available: boolean }[] = [
  {
    id: "official",
    label: "Préconstruits officiels",
    empty: "Les decks préconstruits vendus par Wizards of the Coast arriveront plus tard.",
    available: false,
  },
  {
    id: "imported",
    label: "Mes decks importés",
    empty: "Aucun deck pour l'instant. Importe une liste depuis Moxfield, Archidekt ou deckstats.net.",
    available: true,
  },
  {
    id: "community",
    label: "Communauté",
    empty: "Aucun deck partagé dans ton groupe pour l'instant.",
    available: true,
  },
];

/** Intitulés courts des colonnes de légalité (le nom complet est en infobulle). */
const MODE_SHORT: Record<GameModeType, string> = {
  freeForAll: "Chacun pour soi",
  duel: "Duel",
  teams: "Équipes",
  twoHeadedGiant: "2 têtes",
  star: "Étoile",
  archenemy: "Archenemy",
};

const MODES = Object.keys(GAME_MODES) as GameModeType[];

/** Decks partagés par le groupe sur le serveur central (absent : pas de serveur central sur cet écran). */
export interface CommunityDecks {
  /** `off` : pas connecté à un groupe. */
  status: "off" | "loading" | "ok" | "error";
  error?: string;
  decks: SharedDeck[];
  onRefresh?: () => void;
  /** Boutons propres à chaque deck partagé (copier, retirer…). */
  actions?: (deck: SharedDeck) => ReactNode;
}

interface DeckLike {
  id: string;
  name: string;
  deck: ResolvedDeck;
}

interface Props {
  decks: SavedDeck[];
  community?: CommunityDecks;
  /** Deck choisi, mis en évidence. */
  selectedId?: string | null;
  /** Mode de la partie en cours, dont la colonne est mise en évidence. */
  currentMode?: GameModeType;
  /** Clic sur une ligne : choisir ce deck. */
  onSelect?: (deck: SavedDeck) => void;
  /** Boutons propres à chaque ligne (modifier, supprimer…). */
  actions?: (deck: SavedDeck) => ReactNode;
}

export function DeckBrowser(props: Props) {
  const [category, setCategory] = useState<DeckCategory>("imported");
  const community = props.community;
  const counts: Record<DeckCategory, number> = {
    official: 0,
    imported: props.decks.length,
    community: community?.decks.length ?? 0,
  };
  const current = CATEGORIES.find((c) => c.id === category)!;
  const rows: { deck: DeckLike; subtitle?: string; actions?: ReactNode; onSelect?: () => void }[] =
    category === "imported"
      ? props.decks.map((d) => ({
          deck: d,
          ...(props.actions ? { actions: props.actions(d) } : {}),
          ...(props.onSelect ? { onSelect: () => props.onSelect!(d) } : {}),
        }))
      : category === "community" && community
        ? community.decks.map((d) => ({
            deck: d,
            subtitle: `partagé par ${d.owner.name}`,
            ...(community.actions ? { actions: community.actions(d) } : {}),
          }))
        : [];
  const hasActions = category === "imported" ? Boolean(props.actions) : Boolean(community?.actions);
  const communityMessage =
    category !== "community"
      ? null
      : !community
        ? "Les decks partagés par ton groupe se copient dans tes decks depuis l'accueil."
        : community.status === "off"
          ? "Connecte-toi à un serveur central (facultatif) pour voir les decks partagés par tes amis."
          : community.status === "loading"
            ? "Chargement des decks partagés…"
            : community.status === "error"
              ? `Decks partagés indisponibles : ${community.error ?? "erreur inconnue"}`
              : null;

  return (
    <div className="deck-browser">
      <div className="deck-tabs" role="tablist">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={c.id === category}
            className={`deck-tab ${c.id === category ? "active" : ""} ${c.available ? "" : "soon"}`}
            onClick={() => setCategory(c.id)}
            title={c.available ? undefined : "Bientôt"}
          >
            {c.label}
            {c.available ? <span className="deck-tab-count">{counts[c.id]}</span> : <span className="deck-tab-soon">bientôt</span>}
          </button>
        ))}
        {category === "community" && community?.onRefresh && community.status !== "off" && (
          <button className="link deck-refresh" onClick={community.onRefresh} disabled={community.status === "loading"}>
            Actualiser
          </button>
        )}
      </div>

      {communityMessage ? (
        <p className="hint deck-empty">{communityMessage}</p>
      ) : rows.length === 0 ? (
        <p className="hint deck-empty">{current.empty}</p>
      ) : (
        <div className="deck-table-wrap">
          <table className="deck-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Couleurs</th>
                <th>Format</th>
                <th
                  className="deck-auto-col"
                  title="Part des cartes que le moteur gère entièrement en mode automatique (détail au survol de chaque valeur)"
                >
                  Auto
                </th>
                {MODES.map((m) => (
                  <th
                    key={m}
                    className={`deck-mode-col ${m === props.currentMode ? "current" : ""}`}
                    title={`${GAME_MODES[m].label} : ${GAME_MODES[m].description}`}
                  >
                    {MODE_SHORT[m]}
                  </th>
                ))}
                {hasActions && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <DeckRow
                  key={r.deck.id}
                  deck={r.deck}
                  subtitle={r.subtitle}
                  actions={r.actions}
                  hasActions={hasActions}
                  onSelect={r.onSelect}
                  currentMode={props.currentMode}
                  selected={category === "imported" && r.deck.id === props.selectedId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeckRow(props: {
  deck: DeckLike;
  subtitle?: string | undefined;
  actions?: ReactNode;
  hasActions: boolean;
  onSelect?: (() => void) | undefined;
  currentMode?: GameModeType | undefined;
  selected: boolean;
}) {
  const { deck, onSelect } = props;
  const legality = useMemo(() => deckLegalityByMode(deck.deck, MODES), [deck.deck]);
  const support = useMemo(() => deckSupport(deck.deck), [deck.deck]);
  const colors = deckColorIdentity(deck.deck);
  const commanders = deck.deck.commanders.map((c) => c.name).join(" & ");
  const cardCount = deck.deck.commanders.length + deck.deck.cards.reduce((n, c) => n + c.quantity, 0);

  return (
    <tr
      className={`${props.selected ? "selected" : ""} ${onSelect ? "selectable" : ""}`}
      onClick={onSelect}
    >
      <td className="deck-name">
        <strong>{deck.name}</strong>
        {commanders && commanders !== deck.name && <span>{commanders}</span>}
        {props.subtitle && <span className="deck-owner">{props.subtitle}</span>}
      </td>
      <td className="deck-colors">
        <ManaText text={colors.length > 0 ? colors.map((c) => `{${c}}`).join("") : "{C}"} />
      </td>
      <td className="deck-format">
        Commander
        {cardCount !== 100 && <span className="badge badge-warn">{cardCount} cartes</span>}
      </td>
      <td className="deck-auto-col">
        <SupportMark support={support} />
      </td>
      {MODES.map((m) => (
        <td key={m} className={`deck-mode-col ${m === props.currentMode ? "current" : ""}`}>
          <LegalityMark issues={legality[m] ?? []} mode={m} />
        </td>
      ))}
      {props.hasActions && (
        <td className="deck-actions" onClick={(e) => e.stopPropagation()}>
          {props.actions}
        </td>
      )}
    </tr>
  );
}

function LegalityMark(props: { issues: DeckIssue[]; mode: GameModeType }) {
  const legal = isDeckLegal(props.issues);
  const label = GAME_MODES[props.mode].label;
  const title = legal
    ? `Légal en ${label}`
    : `Non légal en ${label} :\n${props.issues.map((i) => `• ${i.message}`).join("\n")}`;
  return (
    <span className={`legal-mark ${legal ? "ok" : "ko"}`} title={title} aria-label={title}>
      {legal ? "✓" : "✗"}
    </span>
  );
}

/** Noms de cartes pour l'infobulle, sans la rendre interminable. */
function nameList(names: string[], max = 12): string {
  const shown = names.slice(0, max).map((n) => `    ${n}`);
  if (names.length > max) shown.push(`    … et ${names.length - max} autres`);
  return shown.join("\n");
}

/** Pourcentage de cartes entièrement gérées par le moteur, avec le détail au survol. */
export function SupportMark(props: { support: DeckSupport }) {
  const s = props.support;
  const percent = deckSupportPercent(s);
  if (percent === null) {
    return (
      <span className="support-mark none" title="Cartes du deck inconnues">
        —
      </span>
    );
  }
  const withPartial = Math.floor(((s.full + s.partial) / s.total) * 100);
  const lines = [
    `${percent} % des cartes sont entièrement gérées par le moteur.`,
    `✓ ${s.full} automatiques sur ${s.total}`,
  ];
  if (s.partial > 0) lines.push(`½ ${s.partial} en partie (${withPartial} % avec elles) :`, nameList(s.partialNames));
  if (s.manual > 0) lines.push(`✋ ${s.manual} à la main :`, nameList(s.manualNames));
  const title = lines.join("\n");
  const level = percent >= 95 ? "high" : percent >= 80 ? "mid" : "low";
  return (
    <span className={`support-mark ${level}`} title={title} aria-label={title}>
      {percent} %
    </span>
  );
}
