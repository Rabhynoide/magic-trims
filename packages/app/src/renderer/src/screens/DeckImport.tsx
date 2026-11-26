import { useState } from "react";
import { Modal } from "../components/Modal";
import { session } from "../session";
import { storage, type SavedDeck } from "../storage";
import type { DeckImportResult } from "../../../shared/api";

const PLACEHOLDER = `Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1 Command Tower
…`;

/** Importer un deck depuis Moxfield : coller la liste, vérifier, enregistrer. */
export function DeckImport(props: { onClose: () => void; onSaved: (deck: SavedDeck) => void; initial?: SavedDeck }) {
  const [text, setText] = useState(props.initial?.text ?? "");
  const [name, setName] = useState(props.initial?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeckImportResult | null>(null);

  const run = async () => {
    const api = window.magic;
    if (!api) return session.toast("L'import de deck n'est possible que dans l'appli Windows.");
    setBusy(true);
    try {
      const r = await api.importDeck(text);
      setResult(r);
      if (!name && r.deck.commanders[0]) setName(r.deck.commanders.map((c) => c.name).join(" & "));
    } catch (err) {
      session.toast(`Import impossible : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!result) return;
    const deck: SavedDeck = {
      id: props.initial?.id ?? crypto.randomUUID(),
      name: name.trim() || "Deck sans nom",
      text,
      deck: result.deck,
      importedAt: Date.now(),
    };
    const others = storage.getDecks().filter((d) => d.id !== deck.id);
    storage.setDecks([...others, deck]);
    props.onSaved(deck);
  };

  const count = result ? result.deck.commanders.length + result.deck.cards.reduce((n, c) => n + c.quantity, 0) : 0;

  return (
    <Modal title="Importer un deck" onClose={props.onClose} wide>
      <p className="hint">
        <strong>Moxfield</strong> : ouvre ton deck puis <strong>Export</strong> → <strong>Copy for Moxfield</strong>.{" "}
        <strong>deckstats.net</strong> : <strong>Exporter</strong> → <strong>Texte</strong>. Colle la liste ici. Le
        commandant doit être dans une section « Commander » (ou marqué « # !Commander » sur deckstats).
      </p>
      <textarea
        className="deck-text"
        value={text}
        placeholder={PLACEHOLDER}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        spellCheck={false}
      />
      <div className="row">
        <button className="primary" disabled={busy || !text.trim()} onClick={run}>
          {busy ? "Recherche des cartes sur Scryfall…" : "Vérifier le deck"}
        </button>
      </div>

      {result && (
        <div className="import-result">
          <p>
            <strong>{count} cartes</strong>
            {result.deck.commanders.length > 0
              ? ` · commandant : ${result.deck.commanders.map((c) => c.name).join(" & ")}`
              : ""}
          </p>
          {result.unresolved.length > 0 && (
            <div className="issue issue-error">
              Introuvables sur Scryfall : {result.unresolved.map((e) => `${e.name} (ligne ${e.line})`).join(", ")}
            </div>
          )}
          {result.parseErrors.length > 0 && (
            <div className="issue issue-warning">
              Lignes ignorées : {result.parseErrors.map((e) => `ligne ${e.line} « ${e.text.trim()} »`).join(", ")}
            </div>
          )}
          {result.issues.map((i) => (
            <div key={i.message} className={`issue issue-${i.level}`}>
              {i.message}
            </div>
          ))}
          {result.issues.length === 0 && result.unresolved.length === 0 && (
            <div className="issue issue-ok">Deck valide pour le Commander.</div>
          )}
          <label className="field">
            Nom du deck
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <div className="row">
            <button className="primary" onClick={save} disabled={result.deck.commanders.length === 0}>
              Enregistrer le deck
            </button>
            {result.deck.commanders.length === 0 && (
              <span className="hint">Ajoute une section « Commander » à la liste pour pouvoir l'enregistrer.</span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
