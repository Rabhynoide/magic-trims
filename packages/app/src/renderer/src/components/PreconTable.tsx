import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { GAME_MODES, type CardData, type DeckSupport, type GameModeType } from "@magic-trims/core";
import { commanderCards } from "../commander-cards";
import {
  addPrecon,
  loadPreconOracle,
  loadPrecons,
  preconCommanders,
  preconIssues,
  preconSupport,
  savedPrecon,
  type Precon,
} from "../precons";
import { session } from "../session";
import type { SavedDeck } from "../storage";
import { CommanderThumbs } from "./CommanderThumbs";
import { LegalityMark, MODES, MODE_SHORT, SupportMark, thumbClass } from "./DeckBrowser";
import { ManaText } from "./ManaText";

/**
 * Onglet « Préconstruits officiels » : tous les decks Commander vendus par
 * Wizards (liste générée depuis mtg.wtf). Choisir un deck l'ajoute à « Mes
 * decks » (cartes cherchées sur Scryfall), puis le passe au parent.
 */
export function PreconTable(props: {
  currentMode?: GameModeType;
  /** Intitulé du bouton de chaque ligne. */
  actionLabel: string;
  onAdded: (deck: SavedDeck) => void;
}) {
  const [precons, setPrecons] = useState<Precon[] | null>(null);
  /** Colonne « Auto », remplie au fur et à mesure (analyse des 186 decks ≈ 1 s en tout). */
  const [supports, setSupports] = useState<ReadonlyMap<string, DeckSupport>>(new Map());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [, refresh] = useState(0);
  // Miniatures des commandants : cherchées sur Scryfall pour toute la liste d'un coup.
  useSyncExternalStore(commanderCards.subscribe, () => commanderCards.version);

  useEffect(() => {
    let alive = true;
    void loadPrecons().then((file) => {
      if (!alive) return;
      setPrecons(file.decks);
      // Le texte Oracle (colonne « Auto ») arrive après : la liste s'affiche sans
      // l'attendre, puis les decks sont analysés par petits lots pour ne pas figer l'écran.
      void loadPreconOracle().then((oracle) => {
        let next = 0;
        const step = () => {
          if (!alive) return;
          const done = new Map<string, DeckSupport>();
          const until = performance.now() + 12;
          while (next < file.decks.length && performance.now() < until) {
            const p = file.decks[next++]!;
            done.set(p.id, preconSupport(p, oracle));
          }
          setSupports((prev) => new Map([...prev, ...done]));
          if (next < file.decks.length) setTimeout(step, 0);
        };
        step();
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!precons) return [];
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return precons;
    return precons.filter((p) => {
      const haystack = normalize(`${p.name} ${preconCommanders(p)} ${p.setName} ${p.set}`);
      return words.every((w) => haystack.includes(w));
    });
  }, [precons, query]);

  const add = async (p: Precon) => {
    if (busy) return;
    setBusy(p.id);
    try {
      const { deck, missing } = await addPrecon(p);
      if (missing.length > 0) session.toast(`Cartes introuvables sur Scryfall : ${missing.join(", ")}`);
      refresh((n) => n + 1);
      props.onAdded(deck);
    } catch (err) {
      session.toast(`Ajout impossible : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!precons) return <p className="hint deck-empty">Chargement des préconstruits…</p>;

  return (
    <>
      <input
        className="deck-search"
        type="search"
        placeholder="Chercher un deck, un commandant ou une édition…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.length === 0 ? (
        <p className="hint deck-empty">Aucun préconstruit ne correspond à « {query} ».</p>
      ) : (
        <div className="deck-table-wrap">
          <table className="deck-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th className="deck-colors-col">Couleurs</th>
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
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const saved = savedPrecon(p);
                const commanders = p.commanders.flatMap((l) => {
                  const card = commanderCards.get(l);
                  return card ? [card] : ([] as CardData[]);
                });
                return (
                  <tr key={p.id}>
                    <td className={`deck-name ${thumbClass(p.commanders.length)}`} title={p.note}>
                      <CommanderThumbs cards={commanders} />
                      <strong>{p.name}</strong>
                      <span>{preconCommanders(p)}</span>
                      <span className="deck-set">
                        {p.setName}
                        {p.edition === "collector" && (
                          <span className="badge" title="Édition collector : mêmes cartes, illustrations alternatives">
                            collector
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="deck-colors">
                      <ManaText text={p.colors.length > 0 ? p.colors.map((c) => `{${c}}`).join("") : "{C}"} />
                    </td>
                    <td className="deck-auto-col">
                      {supports.has(p.id) ? (
                        <SupportMark support={supports.get(p.id)!} />
                      ) : (
                        <span className="support-mark none" title="Analyse des cartes en cours…">
                          …
                        </span>
                      )}
                    </td>
                    {MODES.map((m) => (
                      <td key={m} className={`deck-mode-col ${m === props.currentMode ? "current" : ""}`}>
                        <LegalityMark issues={preconIssues(p, m)} mode={m} />
                      </td>
                    ))}
                    <td className="deck-actions">
                      <button className="link" disabled={busy !== null} onClick={() => void add(p)}>
                        {busy === p.id ? "Recherche des cartes…" : saved ? `${props.actionLabel} (déjà ajouté)` : props.actionLabel}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
