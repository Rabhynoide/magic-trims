import { useEffect, useState } from "react";
import { session, useSession } from "../session";
import { storage, type SavedDeck } from "../storage";
import { DeckImport } from "./DeckImport";

export function Home() {
  const s = useSession();
  const [name, setName] = useState(storage.getName());
  const [code, setCode] = useState(storage.getLastCode());
  const [decks, setDecks] = useState<SavedDeck[]>(storage.getDecks());
  const [importing, setImporting] = useState<SavedDeck | "new" | null>(null);
  const [hasSave, setHasSave] = useState(false);
  const inApp = Boolean(window.magic);

  useEffect(() => {
    void window.magic?.hasSavedGame().then(setHasSave);
  }, []);

  const cleanName = name.trim();
  const updateName = (value: string) => {
    setName(value);
    storage.setName(value.trim());
  };

  const removeDeck = (deck: SavedDeck) => {
    if (!confirm(`Supprimer le deck « ${deck.name} » ?`)) return;
    const next = decks.filter((d) => d.id !== deck.id);
    storage.setDecks(next);
    setDecks(next);
  };

  return (
    <div className="home">
      <header className="home-header">
        <h1>Magic Trims</h1>
        <p>Commander entre amis, jusqu'à 5 joueurs.</p>
      </header>

      <div className="home-grid">
        <section className="panel">
          <h2>Jouer</h2>
          <label className="field">
            Ton nom
            <input value={name} onChange={(e) => updateName(e.target.value)} maxLength={24} placeholder="Pseudo" />
          </label>

          <div className="play-block">
            <h3>Héberger</h3>
            <p className="hint">Ton PC accueille la partie ; tes amis te rejoignent avec un code.</p>
            <div className="row">
              <button
                className="primary"
                disabled={!cleanName || s.connecting || !inApp}
                onClick={() => session.host(cleanName, false)}
              >
                Nouvelle partie
              </button>
              {hasSave && (
                <button disabled={!cleanName || s.connecting} onClick={() => session.host(cleanName, true)}>
                  Reprendre la partie sauvegardée
                </button>
              )}
            </div>
            {!inApp && <p className="hint">L'hébergement n'est disponible que dans l'appli Windows.</p>}
          </div>

          <div className="play-block">
            <h3>Rejoindre</h3>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void session.joinWithCode(cleanName, code);
              }}
            >
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Code (ex. 2J8CS-E5EBJ) ou adresse"
                aria-label="Code de connexion"
              />
              <button type="submit" disabled={!cleanName || !code.trim() || s.connecting}>
                {s.connecting ? "Connexion…" : "Rejoindre"}
              </button>
            </form>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Mes decks</h2>
            <button onClick={() => setImporting("new")}>Importer un deck</button>
          </div>
          {decks.length === 0 && (
            <p className="hint">Aucun deck pour l'instant. Importe une liste depuis Moxfield ou deckstats.net.</p>
          )}
          <ul className="deck-list">
            {decks.map((d) => (
              <li key={d.id}>
                {d.deck.commanders[0]?.image && (
                  <img src={d.deck.commanders[0].image.artCrop ?? d.deck.commanders[0].image.small} alt="" />
                )}
                <div className="deck-list-text">
                  <strong>{d.name}</strong>
                  <span>{d.deck.commanders.map((c) => c.name).join(" & ")}</span>
                </div>
                <button className="link" onClick={() => setImporting(d)}>
                  Modifier
                </button>
                <button className="link danger" onClick={() => removeDeck(d)}>
                  Supprimer
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {importing && (
        <DeckImport
          {...(importing !== "new" ? { initial: importing } : {})}
          onClose={() => setImporting(null)}
          onSaved={() => {
            setDecks(storage.getDecks());
            setImporting(null);
          }}
        />
      )}
    </div>
  );
}
