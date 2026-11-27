import { useEffect, useState } from "react";
import type { SharedDeck } from "@magic-trims/core";
import { session, useSession } from "../session";
import { storage, type SavedDeck } from "../storage";
import { CardLanguageSelect } from "../components/CardLanguage";
import { DeckImport } from "./DeckImport";
import { DeckBrowser } from "../components/DeckBrowser";
import { CentralPanel } from "../components/CentralPanel";
import { useCommunity } from "../community";

export function Home() {
  const s = useSession();
  const [name, setName] = useState(storage.getName());
  const [code, setCode] = useState(storage.getLastCode());
  const [decks, setDecks] = useState<SavedDeck[]>(storage.getDecks());
  const [importing, setImporting] = useState<SavedDeck | "new" | null>(null);
  const [hasSave, setHasSave] = useState(false);
  const inApp = Boolean(window.magic);
  const community = useCommunity();

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

  /** Copie un deck partagé par le groupe dans mes decks. */
  const copyDeck = (shared: SharedDeck) => {
    const copy: SavedDeck = {
      id: crypto.randomUUID(),
      name: shared.name,
      text: shared.text,
      deck: shared.deck,
      importedAt: Date.now(),
    };
    const next = [...storage.getDecks(), copy];
    storage.setDecks(next);
    setDecks(next);
    session.toast(`« ${shared.name} » est copié dans tes decks.`, "info");
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
          <CardLanguageSelect label="Langue des cartes" />

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

          <CentralPanel community={community} name={cleanName} />
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Mes decks</h2>
            <button onClick={() => setImporting("new")}>Importer un deck</button>
          </div>
          <DeckBrowser
            decks={decks}
            community={{
              status: community.status,
              ...(community.error !== undefined ? { error: community.error } : {}),
              decks: community.decks,
              onRefresh: community.refresh,
              actions: (d) => (
                <>
                  <button className="link" title="Copier dans mes decks" onClick={() => copyDeck(d)}>
                    Copier
                  </button>
                  {community.isMine(d) && (
                    <button
                      className="link danger"
                      title="Ne plus partager ce deck avec le groupe"
                      disabled={community.busy}
                      onClick={() => void community.unshare(d.id)}
                    >
                      Retirer
                    </button>
                  )}
                </>
              ),
            }}
            actions={(d) => (
              <>
                <button className="link" onClick={() => setImporting(d)}>
                  Modifier
                </button>
                {community.status === "ok" &&
                  (community.isSharedByMe(d.id) ? (
                    <button
                      className="link"
                      title="Ne plus partager ce deck avec le groupe"
                      disabled={community.busy}
                      onClick={() => void community.unshare(d.id)}
                    >
                      Ne plus partager
                    </button>
                  ) : (
                    <button className="link" disabled={community.busy} onClick={() => void community.share(d)}>
                      Partager
                    </button>
                  ))}
                <button className="link danger" onClick={() => removeDeck(d)}>
                  Supprimer
                </button>
              </>
            )}
          />
        </section>
      </div>

      {importing && (
        <DeckImport
          {...(importing !== "new" ? { initial: importing } : {})}
          onClose={() => setImporting(null)}
          onSaved={(saved) => {
            setDecks(storage.getDecks());
            setImporting(null);
            // Un deck déjà partagé est mis à jour pour le groupe.
            if (community.isSharedByMe(saved.id)) void community.share(saved);
          }}
        />
      )}
    </div>
  );
}
