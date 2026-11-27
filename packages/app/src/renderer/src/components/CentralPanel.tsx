import { useState } from "react";
import type { Community } from "../community";

/**
 * Connexion facultative au serveur central d'un groupe d'amis (partage de
 * decks). Sans elle, tout le reste de l'appli fonctionne pareil.
 */
export function CentralPanel(props: { community: Community; name: string }) {
  const { community, name } = props;
  const [url, setUrl] = useState(community.settings?.url ?? "");
  const [code, setCode] = useState("");
  const settings = community.settings;

  return (
    <div className="play-block central-panel">
      <h3>
        Groupe d'amis <span className="badge">facultatif</span>
      </h3>
      {settings ? (
        <>
          <p className="hint">
            Groupe <strong>« {settings.group.name} »</strong>, en tant que <strong>{settings.member.name}</strong>.
            <br />
            Serveur : {settings.url}
            {community.status === "error" && <span className="central-offline"> (injoignable)</span>}
          </p>
          <div className="row">
            <button className="link danger" onClick={community.disconnect}>
              Quitter le groupe
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            Un serveur central permet de partager vos decks entre amis. Demande l'adresse et le code du groupe à celui qui
            l'héberge.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void community.connect(url, code, name).then((ok) => ok && setCode(""));
            }}
          >
            <label className="field">
              Adresse du serveur
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ex. magic-trims-central.toto.workers.dev" />
            </label>
            <label className="field">
              Code du groupe
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ex. K7Q2M-9XRTA" />
            </label>
            <button type="submit" disabled={!name || !url.trim() || !code.trim() || community.busy}>
              {community.busy ? "Connexion…" : "Rejoindre le groupe"}
            </button>
            {!name && <p className="hint">Choisis d'abord ton nom.</p>}
          </form>
        </>
      )}
    </div>
  );
}
