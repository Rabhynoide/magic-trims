import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deckColorIdentity,
  deckLegalityByMode,
  GAME_MODES,
  isDeckLegal,
  type DeckIssue,
  type GameModeType,
} from "@magic-trims/core";
import type { SavedDeck } from "../storage";
import { ManaText } from "./ManaText";
import { PreconTable } from "./PreconTable";
import { loadPrecons } from "../precons";

/**
 * Liste des decks en tableau : nom, couleurs, format et légalité pour chaque
 * mode de jeu. Les decks sont rangés en trois catégories : préconstruits
 * officiels (liste embarquée, voir PreconTable), decks importés et communauté.
 */

export type DeckCategory = "official" | "imported" | "community";

const CATEGORIES: { id: DeckCategory; label: string; empty: string; available: boolean }[] = [
  {
    id: "official",
    label: "Préconstruits officiels",
    empty: "",
    available: true,
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
    empty: "Le partage de decks entre joueurs demandera un serveur commun, prévu plus tard.",
    available: false,
  },
];

/** Intitulés courts des colonnes de légalité (le nom complet est en infobulle). */
export const MODE_SHORT: Record<GameModeType, string> = {
  freeForAll: "Chacun pour soi",
  duel: "Duel",
  teams: "Équipes",
  twoHeadedGiant: "2 têtes",
  star: "Étoile",
  archenemy: "Archenemy",
};

export const MODES = Object.keys(GAME_MODES) as GameModeType[];

interface Props {
  decks: SavedDeck[];
  /** Deck choisi, mis en évidence. */
  selectedId?: string | null;
  /** Mode de la partie en cours, dont la colonne est mise en évidence. */
  currentMode?: GameModeType;
  /** Clic sur une ligne : choisir ce deck. */
  onSelect?: (deck: SavedDeck) => void;
  /** Boutons propres à chaque ligne (modifier, supprimer…). */
  actions?: (deck: SavedDeck) => ReactNode;
  /** Préconstruit choisi : il vient d'être ajouté à « Mes decks ». */
  onPrecon?: (deck: SavedDeck) => void;
  /** Intitulé du bouton des préconstruits (« Ajouter à mes decks », « Jouer ce deck »…). */
  preconLabel?: string;
}

export function DeckBrowser(props: Props) {
  const [category, setCategory] = useState<DeckCategory>("imported");
  const [preconCount, setPreconCount] = useState(0);
  useEffect(() => {
    void loadPrecons().then((f) => setPreconCount(f.decks.length));
  }, []);
  const counts: Record<DeckCategory, number> = { official: preconCount, imported: props.decks.length, community: 0 };
  const current = CATEGORIES.find((c) => c.id === category)!;
  const decks = category === "imported" ? props.decks : [];

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
      </div>

      {category === "official" ? (
        <PreconTable
          {...(props.currentMode ? { currentMode: props.currentMode } : {})}
          actionLabel={props.preconLabel ?? "Ajouter à mes decks"}
          onAdded={(deck) => props.onPrecon?.(deck)}
        />
      ) : decks.length === 0 ? (
        <p className="hint deck-empty">{current.empty}</p>
      ) : (
        <div className="deck-table-wrap">
          <table className="deck-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Couleurs</th>
                <th>Format</th>
                {MODES.map((m) => (
                  <th
                    key={m}
                    className={`deck-mode-col ${m === props.currentMode ? "current" : ""}`}
                    title={`${GAME_MODES[m].label} : ${GAME_MODES[m].description}`}
                  >
                    {MODE_SHORT[m]}
                  </th>
                ))}
                {props.actions && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {decks.map((d) => (
                <DeckRow key={d.id} {...props} deck={d} selected={d.id === props.selectedId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DeckRow(props: Props & { deck: SavedDeck; selected: boolean }) {
  const { deck, onSelect } = props;
  const legality = useMemo(() => deckLegalityByMode(deck.deck, MODES), [deck.deck]);
  const colors = deckColorIdentity(deck.deck);
  const commanders = deck.deck.commanders.map((c) => c.name).join(" & ");
  const cardCount = deck.deck.commanders.length + deck.deck.cards.reduce((n, c) => n + c.quantity, 0);

  return (
    <tr
      className={`${props.selected ? "selected" : ""} ${onSelect ? "selectable" : ""}`}
      onClick={onSelect ? () => onSelect(deck) : undefined}
    >
      <td className="deck-name">
        <strong>{deck.name}</strong>
        {commanders && commanders !== deck.name && <span>{commanders}</span>}
      </td>
      <td className="deck-colors">
        <ManaText text={colors.length > 0 ? colors.map((c) => `{${c}}`).join("") : "{C}"} />
      </td>
      <td className="deck-format">
        Commander
        {cardCount !== 100 && <span className="badge badge-warn">{cardCount} cartes</span>}
      </td>
      {MODES.map((m) => (
        <td key={m} className={`deck-mode-col ${m === props.currentMode ? "current" : ""}`}>
          <LegalityMark issues={legality[m] ?? []} mode={m} />
        </td>
      ))}
      {props.actions && (
        <td className="deck-actions" onClick={(e) => e.stopPropagation()}>
          {props.actions(deck)}
        </td>
      )}
    </tr>
  );
}

export function LegalityMark(props: { issues: DeckIssue[]; mode: GameModeType }) {
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
