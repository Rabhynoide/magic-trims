import { useEffect, useMemo, useState } from "react";
import { GAME_MODES, type CardData, type GameModeType, type LobbyConfig, type PlayerId } from "@magic-trims/core";
import { Chat } from "../components/Chat";
import { session, useSession } from "../session";
import { storage, type SavedDeck } from "../storage";
import { DeckImport } from "./DeckImport";

const MODE_ORDER: GameModeType[] = ["freeForAll", "duel", "teams", "twoHeadedGiant", "star", "archenemy"];

export function Lobby() {
  const s = useSession();
  const lobby = s.lobby!;
  const me = lobby.players.find((p) => p.id === s.playerId);
  const [decks, setDecks] = useState<SavedDeck[]>(storage.getDecks());
  const [selected, setSelected] = useState<string | null>(storage.getSelectedDeck());
  const [importing, setImporting] = useState(false);
  const [loadingExtras, setLoadingExtras] = useState(false);
  const config = lobby.config;
  const mode = GAME_MODES[config.mode];

  const configure = (patch: Partial<LobbyConfig>, planarDeck?: CardData[]) => {
    const next: LobbyConfig = { ...config, ...patch };
    session.client?.configure(next, planarDeck);
  };

  const chooseDeck = (id: string) => {
    const deck = storage.getDecks().find((d) => d.id === id);
    if (!deck) return;
    setSelected(id);
    storage.setSelectedDeck(id);
    session.client?.setDeck(deck.deck);
  };

  // Renvoie automatiquement le dernier deck choisi en arrivant dans le salon.
  useEffect(() => {
    if (selected && me && !me.deck) chooseDeck(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  const teamsFor = (count: number): PlayerId[][] => {
    if (config.teams && config.teams.flat().length === lobby.players.length) return config.teams;
    const ids = lobby.players.map((p) => p.id);
    const teams: PlayerId[][] = [];
    for (let i = 0; i < ids.length; i += 2) teams.push(ids.slice(i, i + 2));
    if (teams.length > 1 && teams.at(-1)!.length === 1) teams.at(-2)!.push(...teams.pop()!);
    return teams.slice(0, count);
  };
  const teamMode = config.mode === "teams" || config.mode === "twoHeadedGiant";
  const teams = teamMode ? teamsFor(3) : [];
  const setTeam = (playerId: PlayerId, index: number) => {
    const next = teams.map((t) => t.filter((id) => id !== playerId));
    while (next.length <= index) next.push([]);
    next[index]!.push(playerId);
    configure({ teams: next.filter((t) => t.length > 0) });
  };

  const loadPlanes = async () => {
    if (!window.magic) return;
    setLoadingExtras(true);
    try {
      const planes = await window.magic.searchCards("(t:plane or t:phenomenon) -is:digital");
      if (planes.length === 0) return session.toast("Aucun plan trouvé sur Scryfall.");
      configure({ settings: { ...config.settings, planechase: true } }, planes);
    } catch (err) {
      session.toast(`Plans introuvables : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingExtras(false);
    }
  };

  const loadSchemes = async () => {
    const deck = decks.find((d) => d.id === selected);
    if (!window.magic || !deck) return session.toast("Choisis d'abord ton deck.");
    setLoadingExtras(true);
    try {
      const schemes = await window.magic.searchCards("t:scheme -is:digital");
      session.client?.setDeck(deck.deck, schemes);
    } catch (err) {
      session.toast(`Machinations introuvables : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingExtras(false);
    }
  };

  const playerCountOk = lobby.players.length >= mode.minPlayers && lobby.players.length <= mode.maxPlayers;
  const allDecks = lobby.players.every((p) => p.deck);
  const illegal = lobby.players.filter((p) => p.deck && !p.deck.legal);
  const blockedByLegality = config.allowIllegalDecks === false && illegal.length > 0;
  const canStart = s.isHost && playerCountOk && allDecks && !blockedByLegality;
  const startingLife = config.settings?.startingLife ?? mode.defaults.startingLife ?? 40;
  const amArchenemy = config.mode === "archenemy" && (config.archenemyId ?? lobby.players[0]?.id) === s.playerId;

  const playerCountText = useMemo(
    () => (mode.minPlayers === mode.maxPlayers ? `${mode.minPlayers}` : `${mode.minPlayers} à ${mode.maxPlayers}`),
    [mode],
  );

  return (
    <div className="lobby">
      <header className="lobby-header">
        <h1>Salon</h1>
        <button
          className="link"
          onClick={() => {
            if (!s.isHost || confirm("Quitter fermera la partie pour tout le monde. Continuer ?")) session.leave();
          }}
        >
          Quitter
        </button>
      </header>

      <div className="lobby-grid">
        <section className="panel">
          <h2>
            Joueurs ({lobby.players.length}/{lobby.maxPlayers})
          </h2>
          <ul className="player-list">
            {lobby.players.map((p) => (
              <li key={p.id} className={p.connected ? "" : "disconnected"}>
                <div className="player-line">
                  <strong>{p.name}</strong>
                  {p.isHost && <span className="badge">hôte</span>}
                  {p.id === s.playerId && <span className="badge badge-me">toi</span>}
                  {!p.connected && <span className="badge badge-warn">déconnecté</span>}
                  {s.isHost && !p.isHost && (
                    <button className="link danger" onClick={() => session.client?.kick(p.id)}>
                      Exclure
                    </button>
                  )}
                </div>
                {p.deck ? (
                  <div className="player-deck">
                    <span>
                      {p.deck.commanders.join(" & ")} · {p.deck.cardCount} cartes
                      {p.schemeCount > 0 ? ` · ${p.schemeCount} machinations` : ""}
                    </span>
                    <span
                      className={`badge ${p.deck.legal ? "badge-ok" : "badge-warn"}`}
                      title={p.deck.issues.map((i) => i.message).join("\n")}
                    >
                      {p.deck.legal ? "légal" : `non légal (${p.deck.issues.length})`}
                    </span>
                  </div>
                ) : (
                  <div className="player-deck hint">Choisit son deck…</div>
                )}
                {teamMode && s.isHost && (
                  <select
                    aria-label={`Équipe de ${p.name}`}
                    value={teams.findIndex((t) => t.includes(p.id))}
                    onChange={(e) => setTeam(p.id, Number(e.target.value))}
                  >
                    {[0, 1, 2].map((i) => (
                      <option key={i} value={i}>
                        Équipe {i + 1}
                      </option>
                    ))}
                  </select>
                )}
                {teamMode && !s.isHost && (
                  <span className="hint">Équipe {teams.findIndex((t) => t.includes(p.id)) + 1}</span>
                )}
              </li>
            ))}
          </ul>

          <h3>Mon deck</h3>
          <div className="row">
            <select value={selected ?? ""} onChange={(e) => chooseDeck(e.target.value)} aria-label="Mon deck">
              <option value="" disabled>
                Choisir un deck…
              </option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button onClick={() => setImporting(true)}>Importer</button>
          </div>
          {me?.deck && !me.deck.legal && (
            <ul className="issues">
              {me.deck.issues.map((i) => (
                <li key={i.message} className={`issue issue-${i.level}`}>
                  {i.message}
                </li>
              ))}
            </ul>
          )}
          {amArchenemy && (
            <div className="row">
              <button disabled={loadingExtras} onClick={loadSchemes}>
                {me?.schemeCount ? "Recharger les machinations" : "Charger les machinations (Scryfall)"}
              </button>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Partie</h2>
          {s.isHost && s.host && (
            <div className="join-codes">
              <h3>Codes à donner à tes amis</h3>
              {s.host.addresses.map((a) => (
                <div key={a.ip} className="join-code">
                  <code>{a.code}</code>
                  <span className="hint">
                    {a.ip}:{s.host!.port} · {a.kind}
                  </span>
                  <button className="link" onClick={() => void navigator.clipboard.writeText(a.code)}>
                    Copier
                  </button>
                </div>
              ))}
              {!s.host.upnp.ok && (
                <p className="issue issue-warning">
                  La box n'a pas ouvert le port automatiquement. Pour jouer par internet, ouvre le port {s.host.port}{" "}
                  dans ta box, ou utilisez tous Radmin VPN ou Tailscale.
                </p>
              )}
            </div>
          )}

          <label className="field">
            Mode de jeu
            <select
              value={config.mode}
              disabled={!s.isHost}
              onChange={(e) => {
                const { teams: _t, archenemyId: _a, ...rest } = config;
                configure({ ...rest, mode: e.target.value as GameModeType, settings: {} }, undefined);
              }}
            >
              {MODE_ORDER.map((m) => (
                <option key={m} value={m}>
                  {GAME_MODES[m].label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{mode.description}</p>
          {!playerCountOk && <p className="issue issue-warning">Ce mode se joue à {playerCountText} joueurs.</p>}

          {config.mode === "archenemy" && (
            <label className="field">
              Archenemy
              <select
                value={config.archenemyId ?? lobby.players[0]?.id}
                disabled={!s.isHost}
                onChange={(e) => configure({ archenemyId: e.target.value })}
              >
                {lobby.players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            Points de vie de départ
            <input
              type="number"
              min={1}
              max={999}
              value={startingLife}
              disabled={!s.isHost}
              onChange={(e) =>
                configure({ settings: { ...config.settings, startingLife: Number(e.target.value) || 1 } })
              }
            />
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={config.allowIllegalDecks !== false}
              disabled={!s.isHost}
              onChange={(e) => configure({ allowIllegalDecks: e.target.checked })}
            />
            Autoriser les decks non légaux pour ce mode
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={config.settings?.autoTurnActions !== false}
              disabled={!s.isHost}
              onChange={(e) => configure({ settings: { ...config.settings, autoTurnActions: e.target.checked } })}
            />
            Dégagement et pioche automatiques
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={config.settings?.enforceRules !== false}
              disabled={!s.isHost}
              onChange={(e) => configure({ settings: { ...config.settings, enforceRules: e.target.checked } })}
            />
            Faire respecter les règles pour jouer les cartes (moment, coût, un terrain par tour)
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(config.settings?.planechase) && lobby.planeCount > 0}
              disabled={!s.isHost || loadingExtras}
              onChange={(e) => {
                if (e.target.checked && lobby.planeCount === 0) void loadPlanes();
                else configure({ settings: { ...config.settings, planechase: e.target.checked } });
              }}
            />
            Variante Planechase {lobby.planeCount > 0 ? `(${lobby.planeCount} plans)` : ""}
          </label>

          {s.isHost ? (
            <button className="primary big" disabled={!canStart} onClick={() => session.client?.start()}>
              Lancer la partie
            </button>
          ) : (
            <p className="hint">L'hôte lancera la partie quand tout le monde sera prêt.</p>
          )}
          {s.isHost && !allDecks && <p className="hint">En attente des decks de tous les joueurs.</p>}
          {blockedByLegality && (
            <p className="issue issue-warning">Decks non légaux : {illegal.map((p) => p.name).join(", ")}.</p>
          )}
        </section>

        <section className="panel chat-panel">
          <h2>Discussion</h2>
          <Chat />
        </section>
      </div>

      {importing && (
        <DeckImport
          onClose={() => setImporting(false)}
          onSaved={(deck) => {
            setDecks(storage.getDecks());
            setImporting(false);
            chooseDeck(deck.id);
          }}
        />
      )}
    </div>
  );
}
