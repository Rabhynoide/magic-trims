import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../shared/api";
import { useSession } from "../session";

const RELEASES_URL = "https://github.com/Rabhynoide/magic-trims/releases/latest";

/**
 * Bandeau affiché quand une nouvelle version de l'appli est publiée, avec un
 * bouton qui la télécharge, l'installe et relance l'appli. Caché pendant une
 * partie pour ne pas la couper par erreur.
 */
export function UpdateBanner() {
  const s = useSession();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const updates = window.magic?.updates;
    if (!updates) return;
    let alive = true;
    void updates.status().then((st) => alive && setStatus(st));
    const off = updates.onStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!status || s.screen === "game") return null;
  const version = "version" in status ? status.version : undefined;
  if (!version || dismissed === version) return null;
  if (status.state !== "available" && status.state !== "downloading" && status.state !== "ready" && status.state !== "error") {
    return null;
  }

  const install = () => {
    if (s.screen === "lobby") {
      const warning = s.isHost
        ? "L'appli va redémarrer : le salon sera fermé pour tout le monde. Continuer ?"
        : "L'appli va redémarrer et tu quitteras le salon (tu pourras revenir avec le même code). Continuer ?";
      if (!confirm(warning)) return;
    }
    void window.magic?.updates.install();
  };

  return (
    <div className={`update-banner${status.state === "error" ? " update-error" : ""}`} role="status">
      {status.state === "available" && (
        <>
          <span>
            Nouvelle version disponible : <strong>{version}</strong>
          </span>
          <button className="primary" onClick={install}>
            Mettre à jour
          </button>
          <button className="link" onClick={() => setDismissed(version)}>
            Plus tard
          </button>
        </>
      )}
      {status.state === "downloading" && (
        <>
          <span>
            Téléchargement de la version {version}… {status.percent} %
          </span>
          <progress max={100} value={status.percent} />
        </>
      )}
      {status.state === "ready" && (
        <>
          <span>Version {version} prête : l'appli va redémarrer.</span>
          <button className="primary" onClick={install}>
            Redémarrer maintenant
          </button>
        </>
      )}
      {status.state === "error" && (
        <>
          <span title={status.message}>La mise à jour vers la version {version} a échoué.</span>
          <button className="primary" onClick={install}>
            Réessayer
          </button>
          <a href={RELEASES_URL} target="_blank" rel="noreferrer">
            Télécharger à la main
          </a>
          <button className="link" onClick={() => setDismissed(version)}>
            Fermer
          </button>
        </>
      )}
    </div>
  );
}
