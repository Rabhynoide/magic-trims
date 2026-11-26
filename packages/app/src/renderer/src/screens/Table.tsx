import { useEffect, useRef, useState } from "react";
import {
  GAME_MODES,
  starEnemies,
  type CardData,
  type CardView,
  type GameView,
  type PlayerId,
  type PlayerView,
  type VisibleCardView,
  type Zone,
} from "@magic-trims/core";
import { Card, DRAG_TYPE } from "../components/Card";
import { Chat } from "../components/Chat";
import { Modal } from "../components/Modal";
import { Overlays } from "../components/Overlays";
import { cardData, cardImage, cardName, cardText, isLand } from "../cards";
import { CardLanguageSelect } from "../components/CardLanguage";
import { cardMenu, libraryMenu } from "../menus";
import { session, useSession } from "../session";
import { ui, useUi } from "../ui-store";

const act = session.act.bind(session);

type ZoneTarget = { zone: Zone; playerId: PlayerId };

/** Rend une zone capable de recevoir une carte glissée. */
function useDrop(target: ZoneTarget, view: GameView) {
  const [over, setOver] = useState(false);
  return {
    className: over ? "drop-over" : "",
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const cardId = e.dataTransfer.getData(DRAG_TYPE);
        if (!cardId) return;
        e.preventDefault();
        const card = findCard(view, cardId);
        if (!card) return;
        const sameZone =
          card.zone === target.zone && (target.zone !== "battlefield" || card.controllerId === target.playerId);
        if (sameZone) return;
        if (target.zone === "battlefield" && card.zone === "battlefield") {
          void act({ type: "changeControl", cardId, controllerId: target.playerId });
          return;
        }
        void act({
          type: "moveCard",
          cardId,
          to: target.zone,
          ...(target.zone === "battlefield" ? { controllerId: target.playerId } : {}),
        });
      },
    },
  };
}

function findCard(view: GameView, id: string): CardView | undefined {
  for (const p of Object.values(view.players)) {
    for (const cards of Object.values(p.zones)) {
      const found = cards.find((c) => c.instanceId === id);
      if (found) return found;
    }
  }
  return [...view.stack, ...view.plane].find((c) => c.instanceId === id);
}

function openCardMenu(e: React.MouseEvent, view: GameView, card: CardView) {
  const items = cardMenu(view, card);
  if (items.length > 0) ui.openMenu(e.clientX, e.clientY, items);
}

export function Table() {
  const s = useSession();
  const view = s.view!;
  const me = view.viewerId;
  const [zoneViewer, setZoneViewer] = useState<ZoneTarget | null>(null);
  const [tokens, setTokens] = useState(false);

  // Les adversaires, dans l'ordre du tour à partir du joueur suivant.
  const myIndex = view.turnOrder.indexOf(me);
  const others = [...view.turnOrder.slice(myIndex + 1), ...view.turnOrder.slice(0, myIndex)];
  const isActive =
    view.turn.activePlayerId === me ||
    (view.settings.sharedTurns && view.teams.some((t) => t.includes(me) && t.includes(view.turn.activePlayerId)));
  const winners = view.outcome.winners;

  return (
    <div className="table">
      <div className="table-main">
        <div className={`opponents opponents-${others.length}`}>
          {others.map((id) => (
            <PlayerArea key={id} view={view} playerId={id} compact onOpenZone={setZoneViewer} />
          ))}
        </div>
        <PlayerArea view={view} playerId={me} onOpenZone={setZoneViewer} />
        <Hand view={view} />
        <Toolbar view={view} isActive={isActive} onTokens={() => setTokens(true)} />
      </div>

      <aside className="sidebar">
        <Preview view={view} />
        <SharedZones view={view} />
        <Log view={view} />
        <div className="sidebar-chat">
          <Chat />
        </div>
      </aside>

      {winners && (
        <div className="outcome">
          {winners.length === 0
            ? "Tous les joueurs sont éliminés : égalité."
            : `Victoire de ${winners.map((id) => view.players[id]!.name).join(" et ")} !`}
        </div>
      )}
      {zoneViewer && <ZoneViewer view={view} target={zoneViewer} onClose={() => setZoneViewer(null)} />}
      {tokens && <TokenPicker onClose={() => setTokens(false)} />}
      <Overlays />
    </div>
  );
}

function PlayerArea(props: {
  view: GameView;
  playerId: PlayerId;
  compact?: boolean;
  onOpenZone: (t: ZoneTarget) => void;
}) {
  const { view, playerId } = props;
  const p = view.players[playerId]!;
  const isMe = playerId === view.viewerId;
  const battlefieldDrop = useDrop({ zone: "battlefield", playerId }, view);
  const commandDrop = useDrop({ zone: "command", playerId }, view);
  const graveDrop = useDrop({ zone: "graveyard", playerId }, view);
  const exileDrop = useDrop({ zone: "exile", playerId }, view);
  const libraryDrop = useDrop({ zone: "library", playerId }, view);
  const active =
    view.turn.activePlayerId === playerId ||
    (view.settings.sharedTurns && view.teams.some((t) => t.includes(playerId) && t.includes(view.turn.activePlayerId)));
  const eliminated = view.outcome.eliminated[playerId];
  const size = props.compact ? "tiny" : "small";

  const battlefield = p.zones.battlefield.filter((c) => !c.attachedTo);
  const attachmentsOf = (id: string | null) => (id ? p.zones.battlefield.filter((c) => c.attachedTo === id) : []);
  const lands = battlefield.filter((c) => isLand(view, c));
  const others = battlefield.filter((c) => !isLand(view, c));

  const renderCard = (c: CardView) => (
    <Card
      key={c.instanceId ?? Math.random()}
      view={view}
      card={c}
      size={size}
      draggable
      attachments={attachmentsOf(c.instanceId)}
      onMenu={(e) => openCardMenu(e, view, c)}
      onDoubleClick={() => c.instanceId && void act({ type: "setTapped", cardIds: [c.instanceId], tapped: !c.tapped })}
    />
  );

  return (
    <section
      className={`player-area ${props.compact ? "compact" : "mine"} ${active ? "active" : ""} ${eliminated ? "eliminated" : ""}`}
    >
      <header className="player-header">
        <strong className="player-name">{p.name}</strong>
        {active && <span className="badge badge-turn">son tour</span>}
        <PlayerTags view={view} playerId={playerId} />
        {eliminated && <span className="badge badge-warn">éliminé ({eliminated})</span>}
        <Stepper
          label="PV"
          value={p.life}
          className="life"
          onChange={(delta) => void act({ type: "adjustLife", playerId, delta })}
        />
        <Stepper
          label="Poison"
          value={p.poison}
          onChange={(delta) => void act({ type: "adjustPoison", playerId, delta })}
        />
        {Object.entries(p.counters).map(([kind, n]) => (
          <Stepper
            key={kind}
            label={kind}
            value={n}
            onChange={(delta) => void act({ type: "adjustPlayerCounter", playerId, kind, delta })}
          />
        ))}
        {isMe && (
          <button
            className="link small"
            onClick={async () => {
              const kind = await ui.ask("Marqueur de joueur (ex. énergie, expérience)", "énergie");
              if (kind?.trim()) void act({ type: "adjustPlayerCounter", playerId, kind: kind.trim(), delta: 1 });
            }}
          >
            + marqueur
          </button>
        )}
      </header>

      <CommanderDamage view={view} playerId={playerId} />

      <div className="player-body">
        <div className="side-zones">
          <div
            className={`pile ${libraryDrop.className}`}
            {...libraryDrop.handlers}
            onClick={(e) => {
              const items = libraryMenu(view, playerId);
              if (items.length) ui.openMenu(e.clientX, e.clientY, items);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              const items = libraryMenu(view, playerId);
              if (items.length) ui.openMenu(e.clientX, e.clientY, items);
            }}
            title={isMe ? "Bibliothèque : clic pour piocher, mélanger…" : "Bibliothèque"}
          >
            <div className="card-back pile-back" />
            <span className="pile-label">Bibliothèque {p.zones.library.length}</span>
          </div>
          {isMe && p.zones.library.some((c) => !c.hidden) && (
            <button className="link small" onClick={() => props.onOpenZone({ zone: "library", playerId })}>
              Cartes connues
            </button>
          )}
          {!isMe && <span className="pile-label">Main {p.zones.hand.length}</span>}
          <Pile
            view={view}
            cards={p.zones.graveyard}
            label="Cimetière"
            drop={graveDrop}
            onOpen={() => props.onOpenZone({ zone: "graveyard", playerId })}
          />
          <Pile
            view={view}
            cards={p.zones.exile}
            label="Exil"
            drop={exileDrop}
            onOpen={() => props.onOpenZone({ zone: "exile", playerId })}
          />
        </div>

        <div className={`command-zone ${commandDrop.className}`} {...commandDrop.handlers}>
          <span className="zone-label">Commandement</span>
          {p.zones.command.map((c) => (
            <div key={c.instanceId} className="command-card">
              {renderCard(c)}
              {!c.hidden && (c as VisibleCardView).isCommander && (
                <span className="tax">taxe {2 * (p.commanderCasts[c.instanceId!] ?? 0)}</span>
              )}
            </div>
          ))}
        </div>

        <div className={`battlefield ${battlefieldDrop.className}`} {...battlefieldDrop.handlers}>
          <div className="battlefield-row">{others.map(renderCard)}</div>
          <div className="battlefield-row lands">{lands.map(renderCard)}</div>
          {battlefield.length === 0 && <span className="zone-label">Champ de bataille</span>}
        </div>
      </div>
    </section>
  );
}

function PlayerTags(props: { view: GameView; playerId: PlayerId }) {
  const { view, playerId } = props;
  const tags: string[] = [];
  if (view.archenemyId === playerId) tags.push("archenemy");
  const mode = view.settings.mode;
  if (mode === "teams" || mode === "twoHeadedGiant" || mode === "archenemy") {
    const index = view.teams.findIndex((t) => t.includes(playerId));
    if (mode !== "archenemy") tags.push(`équipe ${index + 1}`);
  }
  if (mode === "star" && playerId === view.viewerId) {
    tags.push(
      `ennemis : ${starEnemies(view as never, playerId)
        .map((id) => view.players[id]!.name)
        .join(", ")}`,
    );
  }
  return (
    <>
      {tags.map((t) => (
        <span key={t} className="badge">
          {t}
        </span>
      ))}
    </>
  );
}

function Stepper(props: { label: string; value: number; onChange: (delta: number) => void; className?: string }) {
  return (
    <span className={`stepper ${props.className ?? ""}`} title="Maj+clic : ±5">
      <button onClick={(e) => props.onChange(e.shiftKey ? -5 : -1)} aria-label={`${props.label} moins`}>
        −
      </button>
      <span className="stepper-value">
        {props.value}
        <small>{props.label}</small>
      </span>
      <button onClick={(e) => props.onChange(e.shiftKey ? 5 : 1)} aria-label={`${props.label} plus`}>
        +
      </button>
    </span>
  );
}

/** Blessures reçues de chaque commandant adverse. */
function CommanderDamage(props: { view: GameView; playerId: PlayerId }) {
  const { view, playerId } = props;
  const p = view.players[playerId]!;
  const commanders: VisibleCardView[] = [];
  for (const other of Object.values(view.players)) {
    if (other.id === playerId) continue;
    if (view.settings.sharedTeamLife && view.teams.some((t) => t.includes(other.id) && t.includes(playerId))) continue;
    for (const cards of Object.values(other.zones)) {
      for (const c of cards) if (!c.hidden && c.isCommander) commanders.push(c);
    }
  }
  if (commanders.length === 0) return null;
  return (
    <div className="commander-damage">
      {commanders.map((c) => {
        const dmg = p.commanderDamage[c.instanceId] ?? 0;
        const name = cardName(view, c).split(",")[0];
        return (
          <span
            key={c.instanceId}
            className={`cmd-chip ${dmg >= view.settings.commanderDamageLimit ? "lethal" : ""}`}
            title={`Blessures de ${cardName(view, c)}`}
          >
            <button
              onClick={() =>
                void act({ type: "adjustCommanderDamage", playerId, commanderId: c.instanceId, delta: -1 })
              }
            >
              −
            </button>
            {name} {dmg}
            <button
              onClick={() => void act({ type: "adjustCommanderDamage", playerId, commanderId: c.instanceId, delta: 1 })}
            >
              +
            </button>
          </span>
        );
      })}
    </div>
  );
}

function Pile(props: {
  view: GameView;
  cards: CardView[];
  label: string;
  drop: ReturnType<typeof useDrop>;
  onOpen: () => void;
}) {
  const top = props.cards.at(-1);
  const img = top ? cardImage(props.view, top, "small") : null;
  return (
    <div
      className={`pile ${props.drop.className}`}
      {...props.drop.handlers}
      onClick={props.onOpen}
      title={`${props.label} : clic pour voir`}
    >
      {img ? <img src={img} alt="" /> : <div className="pile-empty" />}
      <span className="pile-label">
        {props.label} {props.cards.length}
      </span>
    </div>
  );
}

function Hand(props: { view: GameView }) {
  const { view } = props;
  const me = view.players[view.viewerId]!;
  const drop = useDrop({ zone: "hand", playerId: view.viewerId }, view);
  return (
    <div className={`hand ${drop.className}`} {...drop.handlers}>
      <span className="zone-label">Main ({me.zones.hand.length})</span>
      <div className="hand-cards">
        {me.zones.hand.map((c) => (
          <Card
            key={c.instanceId}
            view={view}
            card={c}
            size="medium"
            draggable
            onMenu={(e) => openCardMenu(e, view, c)}
            onDoubleClick={() =>
              c.instanceId && void act({ type: "moveCard", cardId: c.instanceId, to: "battlefield" })
            }
          />
        ))}
      </div>
    </div>
  );
}

function Toolbar(props: { view: GameView; isActive: boolean; onTokens: () => void }) {
  const { view } = props;
  const me = view.players[view.viewerId]!;
  return (
    <div className="toolbar">
      <span className="turn-info">
        Tour {view.turn.number} · {GAME_MODES[view.settings.mode].label}
      </span>
      <button className="primary" disabled={!props.isActive} onClick={() => void act({ type: "passTurn" })}>
        Passer le tour
      </button>
      <button onClick={() => void act({ type: "untapAll" })}>Tout dégager</button>
      <button onClick={() => void act({ type: "draw", count: 1 })}>Piocher</button>
      <button
        onClick={() => {
          if (confirm("Prendre un mulligan ? Ta main repart dans la bibliothèque.")) void act({ type: "mulligan" });
        }}
      >
        Mulligan{me.mulligans > 0 ? ` (${me.mulligans})` : ""}
      </button>
      <button onClick={props.onTokens}>Jeton…</button>
      <button onClick={() => void act({ type: "rollDie", sides: 6 })}>Dé 6</button>
      <button onClick={() => void act({ type: "rollDie", sides: 20 })}>Dé 20</button>
      {view.settings.planechase && (
        <>
          <button onClick={() => void act({ type: "rollPlanarDie" })}>Dé planaire</button>
          <button onClick={() => void act({ type: "planeswalk" })}>Planeswalk</button>
        </>
      )}
      {view.archenemyId === view.viewerId && (
        <button onClick={() => void act({ type: "setSchemeInMotion" })}>Machination ({me.zones.schemes.length})</button>
      )}
      <span className="spacer" />
      <CardLanguageSelect />
      <button
        className="link danger"
        onClick={() => {
          if (!me.hasConceded && confirm("Abandonner la partie ?")) void act({ type: "concede" });
        }}
      >
        Abandonner
      </button>
      <button
        className="link"
        onClick={() => {
          const host = session.state.isHost;
          if (
            confirm(
              host
                ? "Quitter fermera la partie pour tout le monde (elle reste sauvegardée). Continuer ?"
                : "Quitter la partie ? Tu pourras la rejoindre avec le même code.",
            )
          )
            session.leave();
        }}
      >
        Quitter
      </button>
    </div>
  );
}

function Preview(props: { view: GameView }) {
  const { preview } = useUi();
  const card = preview;
  const img = card ? cardImage(props.view, card, "normal") : null;
  const data = card ? cardData(props.view, card) : undefined;
  const text = data && card && !card.hidden ? cardText(data, card.faceIndex) : undefined;
  return (
    <div className="preview">
      {img ? (
        <img src={img} alt={card ? cardName(props.view, card) : ""} />
      ) : data && text ? (
        <div className="preview-text">
          <strong>{text.name}</strong> {data.manaCost}
          <div>{text.typeLine}</div>
          <p>{text.oracleText}</p>
        </div>
      ) : (
        <div className="preview-empty">Survole une carte pour l'agrandir</div>
      )}
    </div>
  );
}

function SharedZones(props: { view: GameView }) {
  const { view } = props;
  const stackDrop = useDrop({ zone: "stack", playerId: view.viewerId }, view);
  return (
    <div className="shared-zones">
      {view.plane.length > 0 && (
        <div className="plane">
          <span className="zone-label">Plan actif</span>
          {view.plane.map((c) => (
            <Card key={c.instanceId} view={view} card={c} size="small" />
          ))}
        </div>
      )}
      <div className={`stack ${stackDrop.className}`} {...stackDrop.handlers}>
        <span className="zone-label">Pile {view.stack.length > 0 ? `(${view.stack.length})` : ""}</span>
        <div className="stack-cards">
          {[...view.stack].reverse().map((c) => (
            <Card
              key={c.instanceId}
              view={view}
              card={c}
              size="tiny"
              draggable
              onMenu={(e) => openCardMenu(e, view, c)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Log(props: { view: GameView }) {
  const end = useRef<HTMLDivElement>(null);
  const last = props.view.log.at(-1)?.seq;
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [last]);
  return (
    <div className="log">
      {props.view.log.map((e) => (
        <div key={e.seq} className="log-line">
          {e.message}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

const ZONE_TITLES: Partial<Record<Zone, string>> = {
  graveyard: "Cimetière",
  exile: "Exil",
  library: "Cartes connues de la bibliothèque (dessus en premier)",
};

function ZoneViewer(props: { view: GameView; target: ZoneTarget; onClose: () => void }) {
  const { view, target } = props;
  const player: PlayerView = view.players[target.playerId]!;
  const cards = (player.zones[target.zone as keyof PlayerView["zones"]] ?? []).filter(
    (c) => !c.hidden || target.zone !== "library",
  );
  const shown = target.zone === "graveyard" ? [...cards].reverse() : cards;
  return (
    <Modal title={`${ZONE_TITLES[target.zone] ?? target.zone} de ${player.name}`} onClose={props.onClose} wide>
      {shown.length === 0 && <p className="hint">Aucune carte.</p>}
      <p className="hint">Clic droit sur une carte pour la déplacer.</p>
      <div className="zone-grid">
        {shown.map((c, i) => (
          <Card key={c.instanceId ?? i} view={view} card={c} size="medium" onMenu={(e) => openCardMenu(e, view, c)} />
        ))}
      </div>
    </Modal>
  );
}

function TokenPicker(props: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CardData[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(1);
  const search = async () => {
    if (!window.magic) return session.toast("La recherche de jetons n'est possible que dans l'appli Windows.");
    setBusy(true);
    try {
      setResults(await window.magic.searchCards(`t:token ${query}`));
    } catch (err) {
      session.toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Créer un jeton" onClose={props.onClose} wide>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ex. soldier, treasure, zombie"
        />
        <label className="inline">
          Nombre
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Recherche…" : "Chercher"}
        </button>
      </form>
      {results && results.length === 0 && <p className="hint">Aucun jeton trouvé.</p>}
      <div className="zone-grid">
        {results?.slice(0, 60).map((t) => (
          <button
            key={t.id}
            className="token-choice"
            onClick={() => {
              void act({ type: "createToken", card: t, count });
              props.onClose();
            }}
            title={`${t.name} — ${t.typeLine}`}
          >
            {t.image ? <img src={t.image.small} alt={t.name} /> : <span>{t.name}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
