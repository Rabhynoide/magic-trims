import { useEffect, useRef, useState } from "react";
import {
  GAME_MODES,
  MANA_LABELS,
  MANA_TYPES,
  RESPONSE_STEPS,
  STEP_LABELS,
  abilitiesOf,
  isLegalTarget,
  modesMax,
  parseSpellEffects,
  stackTrigger,
  flattenModes,
  creatureStats,
  hasKeyword,
  stateFromView,
  permanentLabel,
  permanentMatches,
  priorityStopsOf,
  spellMatches,
  type TargetSpec,
  TURN_PHASES,
  starEnemies,
  type CardData,
  type CardView,
  type GameAction,
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
import { battlefieldRow, cardData, cardImage, cardManaOptions, cardName, cardText, manaSymbolUrl } from "../cards";
import { CardLanguageSelect } from "../components/CardLanguage";
import { SoundSettings } from "../components/SoundSettings";
import { prioritySound } from "../sound";
import { CardZoom } from "../components/CardZoom";
import { cardMenu, libraryMenu, manaItems, playItems } from "../menus";
import { session, useSession } from "../session";
import { ui, useUi, type Targeting } from "../ui-store";

const act = session.act.bind(session);

type ZoneTarget = { zone: Zone; playerId: PlayerId };

/** Joueurs adverses encore en lice, dans l'ordre du tour. */
function opponents(view: GameView): PlayerId[] {
  return view.turnOrder.filter(
    (id) => !sameSide(view, view.turn.activePlayerId, id) && !view.outcome.eliminated[id] && !view.players[id]!.hasConceded,
  );
}

/** Joueurs attaqués (ou leurs coéquipiers en tours partagés) qui doivent encore déclarer leurs bloqueurs. */
function pendingBlockers(view: GameView): PlayerId[] {
  const combat = view.combat;
  if (!combat || view.turn.step !== "declareBlockers") return [];
  const side = (id: PlayerId) => (view.settings.sharedTurns ? (view.teams.find((t) => t.includes(id)) ?? [id]) : [id]);
  const attacked = new Set(Object.values(combat.attackers).flatMap(side));
  return [...attacked].filter((id) => !combat.blocksDeclared.includes(id) && !view.players[id]!.hasConceded);
}

interface CombatUi {
  mode: "attack" | "block" | null;
  target: PlayerId | null;
  setTarget: (id: PlayerId) => void;
  attackPlan: Record<string, PlayerId>;
  blockPlan: Record<string, string>;
  blocker: string | null;
  clear: () => void;
  unblock: (blockerId: string) => void;
  /** Props à ajouter à une carte du champ de bataille : étiquette de combat et sélection. */
  cardProps: (card: CardView) => Partial<Parameters<typeof Card>[0]>;
}

/** Préparation des attaques et des blocages avant de les déclarer. */
function useCombatUi(view: GameView, isActive: boolean): CombatUi {
  const me = view.viewerId;
  const combat = view.combat;
  const mode: CombatUi["mode"] =
    combat && view.turn.step === "declareAttackers" && !combat.attackersDeclared && isActive
      ? "attack"
      : pendingBlockers(view).includes(me)
        ? "block"
        : null;
  const [target, setTarget] = useState<PlayerId | null>(null);
  const [attackPlan, setAttackPlan] = useState<Record<string, PlayerId>>({});
  const [blockPlan, setBlockPlan] = useState<Record<string, string>>({});
  const [blocker, setBlocker] = useState<string | null>(null);
  const clear = () => {
    setAttackPlan({});
    setBlockPlan({});
    setBlocker(null);
  };
  useEffect(clear, [view.turn.number, view.turn.step]);
  const foes = opponents(view);
  const currentTarget = target && foes.includes(target) ? target : (foes[0] ?? null);
  const name = (id: string) => {
    const card = findCard(view, id);
    return card ? cardName(view, card) : "?";
  };

  const cardProps = (card: CardView): Partial<Parameters<typeof Card>[0]> => {
    const id = card.instanceId;
    if (!id || card.zone !== "battlefield") return {};
    const props: Partial<Parameters<typeof Card>[0]> = {};
    // Étiquettes : ce qui est déclaré, sinon ce qui est prévu.
    if (combat?.attackers[id]) props.combat = { kind: "attacking", label: `attaque ${view.players[combat.attackers[id]]!.name}` };
    else if (combat?.blockers[id]) props.combat = { kind: "blocking", label: `bloque ${name(combat.blockers[id])}` };
    else if (attackPlan[id]) props.combat = { kind: "attacking", label: `→ ${view.players[attackPlan[id]]!.name}` };
    else if (blockPlan[id]) props.combat = { kind: "blocking", label: `bloquera ${name(blockPlan[id])}` };

    const mine = card.controllerId === me || (mode === "attack" && sameSide(view, card.controllerId, me));
    if (mode === "attack" && mine && !card.tapped) {
      props.selected = Boolean(attackPlan[id]);
      props.onSelect = () =>
        setAttackPlan((plan) => {
          const next = { ...plan };
          // Un clic sur une créature déjà prévue contre la cible courante l'annule ;
          // sinon elle part (ou repart) vers la cible courante.
          if (next[id] && next[id] === currentTarget) delete next[id];
          else if (currentTarget) next[id] = currentTarget;
          else delete next[id];
          return next;
        });
    }
    if (mode === "block") {
      if (card.controllerId === me && !card.tapped) {
        props.selected = blocker === id;
        props.onSelect = () => {
          if (blockPlan[id]) {
            setBlockPlan((plan) => {
              const next = { ...plan };
              delete next[id];
              return next;
            });
          } else setBlocker((b) => (b === id ? null : id));
        };
      } else if (combat?.attackers[id] && sameSide(view, combat.attackers[id], me)) {
        // Seuls les attaquants qui visent mon camp peuvent être bloqués par moi.
        props.onSelect = () => {
          if (!blocker) return session.toast("Choisis d'abord une de tes créatures, puis l'attaquant à bloquer.", "info");
          setBlockPlan((plan) => ({ ...plan, [blocker]: id }));
          setBlocker(null);
        };
      }
    }
    return props;
  };

  return {
    mode,
    target: currentTarget,
    setTarget,
    attackPlan,
    blockPlan,
    blocker,
    clear,
    unblock: (blockerId) =>
      setBlockPlan((plan) => {
        const next = { ...plan };
        delete next[blockerId];
        return next;
      }),
    cardProps,
  };
}

function CombatPanel(props: { view: GameView; isActive: boolean; combat: CombatUi }) {
  const { view, combat: ui } = props;
  const combat = view.combat;
  const name = (id: string) => {
    const card = findCard(view, id);
    return card ? cardName(view, card) : "?";
  };
  if (ui.mode === "attack") {
    const planned = Object.entries(ui.attackPlan);
    return (
      <div className="combat-panel">
        <span className="combat-title">Attaque</span>
        <span className="attack-targets" role="radiogroup" aria-label="Joueur attaqué">
          {opponents(view).map((id) => {
            const count = planned.filter(([, d]) => d === id).length;
            return (
              <button
                key={id}
                role="radio"
                aria-checked={ui.target === id}
                className={`attack-target${ui.target === id ? " active" : ""}`}
                onClick={() => ui.setTarget(id)}
              >
                {view.players[id]!.name}
                {count > 0 && <span className="attack-target-count">{count}</span>}
              </button>
            );
          })}
        </span>
        <span className="hint">
          {opponents(view).length > 1
            ? `Clique sur tes créatures pour qu'elles attaquent ${ui.target ? view.players[ui.target]!.name : "le joueur choisi"}. Change de joueur pour envoyer les suivantes ailleurs.`
            : "Clique sur tes créatures pour les faire attaquer."}
        </span>
        <button
          className="primary"
          disabled={planned.length === 0}
          onClick={() =>
            void act({
              type: "declareAttackers",
              attackers: planned.map(([cardId, defender]) => ({ cardId, defender })),
            })
          }
        >
          Attaquer ({planned.length})
        </button>
        <button onClick={() => void act({ type: "declareAttackers", attackers: [] })}>Pas d'attaque</button>
      </div>
    );
  }
  if (ui.mode === "block") {
    const planned = Object.entries(ui.blockPlan);
    return (
      <div className="combat-panel">
        <span className="combat-title">Blocage</span>
        <span className="hint">
          {ui.blocker
            ? `Clique sur l'attaquant que ${name(ui.blocker)} doit bloquer.`
            : "Clique sur une de tes créatures, puis sur l'attaquant à bloquer."}
        </span>
        <span className="assignments">
          {planned.map(([b, a]) => (
            <span key={b} className="assignment">
              {name(b)} bloque {name(a)}{" "}
              <button className="link small" onClick={() => ui.unblock(b)} aria-label="Retirer">
                ×
              </button>
            </span>
          ))}
        </span>
        <button
          className="primary"
          disabled={planned.length === 0}
          onClick={() =>
            void act({ type: "declareBlockers", blocks: planned.map(([cardId, attackerId]) => ({ cardId, attackerId })) })
          }
        >
          Bloquer ({planned.length})
        </button>
        <button onClick={() => void act({ type: "declareBlockers", blocks: [] })}>Pas de blocage</button>
      </div>
    );
  }
  const waiting = pendingBlockers(view);
  if (combat && waiting.length > 0) {
    return (
      <div className="combat-panel">
        <span className="combat-title">Combat</span>
        <span className="hint">En attente des bloqueurs de {waiting.map((id) => view.players[id]!.name).join(", ")}.</span>
      </div>
    );
  }
  return null;
}

/** Même joueur, ou coéquipiers qui jouent ensemble (tours partagés). */
function sameSide(view: GameView, a: PlayerId, b: PlayerId): boolean {
  return a === b || (view.settings.sharedTurns && view.teams.some((t) => t.includes(a) && t.includes(b)));
}

/** Le joueur (ou son équipe) a la priorité. */
function hasPriority(view: GameView, playerId: PlayerId): boolean {
  return view.priority !== null && sameSide(view, view.priority.playerId, playerId);
}

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
        // Avec les règles : glisser une carte de sa main sur son champ de bataille ou la pile, c'est la jouer.
        const playing =
          view.settings.enforceRules !== false &&
          (card.zone === "hand" || card.zone === "command") &&
          card.ownerId === view.viewerId &&
          (target.zone === "stack" || (target.zone === "battlefield" && target.playerId === view.viewerId));
        if (playing) return playCard(e, view, card);
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

/**
 * Double-clic sur un permanent : s'il produit du mana et qu'il est dégagé, on
 * l'engage pour son mana (avec un menu s'il y a un choix) ; sinon on
 * l'engage ou le dégage simplement.
 */
function tapOrProduce(e: React.MouseEvent, view: GameView, card: CardView) {
  const id = card.instanceId!;
  if (card.zone === "command") return playCard(e, view, card);
  const options = card.tapped || card.controllerId !== view.viewerId ? [] : cardManaOptions(view, card);
  if (options.length === 1) return void act({ type: "tapForMana", cardId: id });
  if (options.length > 1) return ui.openMenu(e.clientX, e.clientY, manaItems(view, card));
  void act({ type: "setTapped", cardIds: [id], tapped: !card.tapped });
}

/** Double-clic dans la main (ou sur son commandant) : jouer le terrain ou lancer le sort. */
/** La carte peut-elle être choisie comme cible ? (le moteur revérifie au lancement) */
function canTargetCard(view: GameView, spec: TargetSpec, card: CardView, sourceId: string): boolean {
  const id = card.instanceId;
  if (!id || id === sourceId) return false;
  const data = card.hidden ? undefined : cardData(view, card);
  const typeLine =
    card.hidden || card.faceDown ? "Creature" : (data?.faces?.[(card as VisibleCardView).faceIndex]?.typeLine ?? data?.typeLine ?? "");
  if (card.zone === "battlefield") {
    if (!spec.permanent) return false;
    const g = stateFromView(view);
    const instance = g.cards[id];
    const has = (k: "Shroud" | "Hexproof") => (instance ? hasKeyword(g, instance, k) : (data?.keywords ?? []).includes(k));
    if (!spec.choice && has("Shroud")) return false;
    if (!spec.choice && has("Hexproof") && !sameSide(view, card.controllerId, view.viewerId)) return false;
    return permanentMatches(
      {
        ...(instance && spec.permanent.maxTotalPT !== undefined ? creatureStats(g, instance) : {}),
        typeLine,
        changeling: !card.hidden && !card.faceDown && /^Changeling\b/m.test(data?.faces?.[(card as VisibleCardView).faceIndex]?.oracleText ?? data?.oracleText ?? ""),
        colors: card.hidden || card.faceDown ? [] : (data?.colors ?? []),
        controllerId: card.controllerId,
        tapped: card.tapped,
        attacking: Boolean(view.combat?.attackers[id]),
        blocking: Boolean(view.combat?.blockers[id]),
      },
      spec.permanent,
      view.viewerId,
    );
  }
  if (card.zone === "stack") return Boolean(spec.spell) && spellMatches(typeLine, spec.spell!);
  if (card.zone === "hand") return Boolean(spec.hand) && card.ownerId === view.viewerId;
  if (card.zone === "graveyard") return Boolean(spec.graveyard) && isLegalTarget(stateFromView(view), spec, { kind: "card", id }, view.viewerId, sourceId);
  return false;
}

/** Toutes les cartes visibles de la partie, par identifiant (pour la fenêtre de choix). */
function visibleCards(view: GameView): Map<string, VisibleCardView> {
  const out = new Map<string, VisibleCardView>();
  const add = (c: CardView) => {
    if (!c.hidden && c.instanceId) out.set(c.instanceId, c);
  };
  for (const p of Object.values(view.players)) for (const zone of Object.values(p.zones)) zone.forEach(add);
  view.stack.forEach(add);
  return out;
}

/**
 * Fenêtre de choix commune : des cartes cachées ou hors de la table
 * (bibliothèque, main révélée, cimetière) ; on clique pour choisir, puis on valide.
 */
function CardPicker(props: {
  view: GameView;
  title: string;
  hint: string;
  options: VisibleCardView[];
  min: number;
  max: number;
  onConfirm: (ids: string[]) => void;
  onCancel?: () => void;
}) {
  const { view, options, min, max } = props;
  const [picked, setPicked] = useState<string[]>([]);
  const key = options.map((c) => c.instanceId).join(",");
  useEffect(() => setPicked([]), [key]);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : max === 1 ? [id] : p.length < max ? [...p, id] : p));
  const ok = picked.length >= min && picked.length <= max;
  return (
    <Modal title={props.title} onClose={props.onCancel ?? (() => {})} wide>
      <p className="hint">{props.hint}</p>
      <div className="zone-grid">
        {options.map((c) => (
          <Card key={c.instanceId} view={view} card={c} size="medium" selected={picked.includes(c.instanceId)} onSelect={() => toggle(c.instanceId)} />
        ))}
      </div>
      <div className="row">
        <button className="primary" disabled={!ok} onClick={() => props.onConfirm(picked)}>
          {picked.length === 0 && min === 0 ? "Ne rien prendre" : "Valider"}
        </button>
        {props.onCancel && <button onClick={props.onCancel}>Annuler</button>}
      </div>
    </Modal>
  );
}

/** Un sort ou une capacité attend que je choisisse des cartes (recherche, main révélée). */
function CardChoicePanel(props: { view: GameView }) {
  const { view } = props;
  const waiting = view.stack.find((c): c is VisibleCardView => !c.hidden && Boolean(c.cardChoice));
  if (!waiting) return null;
  const choice = waiting.cardChoice!;
  const name = waiting.ability?.sourceName ?? cardName(view, waiting);
  const chooser = choice.playerId ?? waiting.controllerId;
  if (chooser !== view.viewerId) {
    return (
      <div className="targeting-banner" role="status">
        <span>
          {view.players[chooser]?.name} choisit une carte pour <strong>{name}</strong>.
        </span>
      </div>
    );
  }
  const cards = visibleCards(view);
  const options = choice.options.map((id) => cards.get(id)).filter((c): c is VisibleCardView => Boolean(c));
  return (
    <CardPicker
      view={view}
      title={name}
      hint={`${choice.label}.`}
      options={options}
      min={choice.min}
      max={choice.max}
      onConfirm={(ids) => void act({ type: "chooseCards", cardId: waiting.instanceId!, cardIds: ids })}
    />
  );
}

/** Pendant le choix des cibles, une cible dans un cimetière se choisit dans la fenêtre de choix. */
function GraveyardTargetPicker(props: { view: GameView }) {
  const { view } = props;
  const { targeting } = useUi();
  const spec = targeting?.specs[targeting.chosen.length];
  if (!targeting || !spec?.graveyard) return null;
  const options = [...visibleCards(view).values()].filter((c) => c.zone === "graveyard" && canTargetCard(view, spec, c, targeting.sourceId));
  return (
    <CardPicker
      view={view}
      title={targeting.sourceName}
      hint={options.length > 0 ? `Choisis une cible : ${spec.label}.` : `Aucune ${spec.label} : impossible de cibler.`}
      options={options}
      min={1}
      max={1}
      onConfirm={(ids) => ui.pickTarget({ kind: "card", id: ids[0]! })}
      onCancel={() => ui.cancelTargeting()}
    />
  );
}

/** Pendant le choix des cibles : les cartes qu'on peut cibler deviennent cliquables. */
function targetProps(view: GameView, targeting: Targeting, card: CardView): Partial<Parameters<typeof Card>[0]> {
  const id = card.instanceId;
  const spec = targeting.specs[targeting.chosen.length];
  const selected = targeting.chosen.some((t) => t.kind === "card" && t.id === id);
  if (!id || !spec || !canTargetCard(view, spec, card, targeting.sourceId)) return { selected };
  return { selected, onSelect: () => ui.pickTarget({ kind: "card", id }) };
}

/**
 * Une de mes capacités déclenchées attend ses cibles : on ouvre le choix des
 * cibles tout seul (Annuler le rouvre au prochain changement de la partie).
 */
function useTriggerTargets(view: GameView): { waitingName: string | null; reopen: () => void } {
  const waiting = view.stack.find(
    (c): c is VisibleCardView => !c.hidden && Boolean(c.ability?.needsTargets) && c.controllerId === view.viewerId,
  );
  const asking = useRef<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!waiting?.instanceId || asking.current === waiting.instanceId) return;
    const ability = waiting.ability!;
    const triggerEffects = stackTrigger(view.cardData[waiting.cardId], ability)?.effects;
    // Modes ciblés (Titan of Industry) : les cibles des modes choisis s'ajoutent.
    const specs = triggerEffects ? flattenModes(triggerEffects, waiting.modes?.chosen).targets : [];
    if (specs.length === 0) return;
    asking.current = waiting.instanceId;
    const id = waiting.instanceId;
    void ui.chooseTargets(`Capacité de ${ability.sourceName}`, id, specs).then((targets) => {
      if (targets) void act({ type: "chooseTargets", cardId: id, targets });
    });
  }, [waiting?.instanceId, retry]);
  return {
    waitingName: waiting?.ability?.sourceName ?? null,
    reopen: () => {
      asking.current = null;
      setRetry((n) => n + 1);
    },
  };
}

/**
 * Une de mes capacités facultatives (« you may ») attend ma réponse : Oui ou
 * Non (avec le choix de la créature à sacrifier pour l'exploitation).
 */
function DecisionBanner(props: { view: GameView }) {
  const { view } = props;
  const deciderOf = (c: VisibleCardView) => c.ability?.decider ?? c.controllerId;
  const waiting = view.stack.find(
    (c): c is VisibleCardView => !c.hidden && Boolean(c.ability?.awaitingDecision) && deciderOf(c as VisibleCardView) === view.viewerId,
  );
  const others = view.stack.find(
    (c): c is VisibleCardView => !c.hidden && Boolean(c.ability?.awaitingDecision) && deciderOf(c as VisibleCardView) !== view.viewerId,
  );
  if (!waiting) {
    if (!others) return null;
    return (
      <div className="targeting-banner" role="status">
        <span>
          {view.players[deciderOf(others)]?.name} décide pour la capacité de <strong>{others.ability!.sourceName}</strong>.
        </span>
      </div>
    );
  }
  const ability = waiting.ability!;
  const trigger = stackTrigger(view.cardData[waiting.cardId], ability);
  const sacrifice = trigger?.effects.effects.find((e) => e.type === "sacrifice");
  const id = waiting.instanceId!;
  // « … unless that player pays » : on demande d'abord au payeur.
  const unless = trigger?.unless && ability.unlessPaid === undefined ? trigger.unless : undefined;
  const accept = async () => {
    if (unless?.discard) {
      const chosen = await ui.chooseTargets(ability.sourceName, id, [{ label: "carte de ta main à défausser", hand: true, choice: true }]);
      if (!chosen) return;
      return void act({ type: "decideOptional", cardId: id, accept: true, choice: chosen[0]!.id });
    }
    if (unless) return void act({ type: "decideOptional", cardId: id, accept: true });
    if (sacrifice && sacrifice.type === "sacrifice") {
      const chosen = await ui.chooseTargets(ability.sourceName, id, [
        { label: `${permanentLabel(sacrifice.filter)} à sacrifier`, permanent: sacrifice.filter, choice: true },
      ]);
      if (!chosen) return;
      return void act({ type: "decideOptional", cardId: id, accept: true, choice: chosen[0]!.id });
    }
    // « You may pay {X} » (Well of Lost Dreams) : X au plus égal à la quantité de l'événement.
    if (trigger?.payMana && /\{X\}/i.test(trigger.payMana)) {
      const max = ability.eventAmount ?? 0;
      const value = await ui.ask(`Valeur de X (0 à ${max})`, String(max), "number");
      if (value === null) return;
      return void act({ type: "decideOptional", cardId: id, accept: true, x: Math.max(0, Math.min(max, Math.floor(Number(value) || 0))) });
    }
    void act({ type: "decideOptional", cardId: id, accept: true });
  };
  return (
    <div className="targeting-banner" role="status">
      <span>
        <strong>{ability.sourceName}</strong> :{" "}
        {unless
          ? `« ${ability.text} » : payer ${[unless.mana ? `${unless.mana}${unless.xPower ? ` (X = force de ${ability.sourceName})` : ""}` : "", unless.life ? `${unless.life} PV` : "", unless.discard ? "une carte défaussée" : ""].filter(Boolean).join(", ")}${unless.perAge ? " par marqueur d'âge" : ""} pour l'empêcher ?`
          : ability.text === "Exploit" ? "exploitation, sacrifier une créature ?" : `« ${ability.text} »${trigger?.payMana ? ` (payer ${trigger.payMana})` : ""}${trigger?.payLife ? ` (payer ${trigger.payLife} PV)` : ""}. Tu le fais ?`}
      </span>
      <span className="decision-buttons">
        <button onClick={() => void accept()}>Oui</button>
        <button onClick={() => void act({ type: "decideOptional", cardId: id, accept: false })}>Non</button>
      </span>
    </div>
  );
}

/**
 * Regard (« Scry 2 ») : je range les cartes du dessus de ma bibliothèque,
 * au-dessus (dans l'ordre choisi) ou au-dessous ; les autres voient que j'y réfléchis.
 */
function ScryPanel(props: { view: GameView }) {
  const { view } = props;
  const scrying = view.stack.find((c): c is VisibleCardView => !c.hidden && Boolean(c.scry && !c.scry.done));
  const mine = scrying?.controllerId === view.viewerId;
  const looked = mine ? view.players[view.viewerId]!.zones.library.slice(0, scrying!.scry!.count) : [];
  const ids = looked.map((c) => c.instanceId ?? "").join(",");
  const [top, setTop] = useState<string[]>([]);
  const [bottom, setBottom] = useState<string[]>([]);
  useEffect(() => {
    setTop(ids ? ids.split(",") : []);
    setBottom([]);
  }, [ids]);
  if (!scrying) return null;
  const name = cardName(view, scrying);
  if (!mine) {
    return (
      <div className="targeting-banner" role="status">
        <span>
          {view.players[scrying.controllerId]?.name} range les cartes de son regard (<strong>{name}</strong>).
        </span>
      </div>
    );
  }
  const byId = new Map(looked.map((c) => [c.instanceId ?? "", c]));
  const move = (id: string, to: "top" | "bottom") => {
    setTop((t) => (to === "top" ? [...t.filter((x) => x !== id), id] : t.filter((x) => x !== id)));
    setBottom((b) => (to === "bottom" ? [...b.filter((x) => x !== id), id] : b.filter((x) => x !== id)));
  };
  const shift = (list: string[], set: (l: string[]) => void, i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set(next);
  };
  const row = (list: string[], set: (l: string[]) => void, where: "top" | "bottom") =>
    list.map((id, i) => {
      const card = byId.get(id);
      if (!card) return null;
      return (
        <div key={id} className="scry-card">
          <Card view={view} card={card} size="medium" />
          <div className="scry-buttons">
            <button onClick={() => shift(list, set, i, -1)} disabled={i === 0} aria-label="Plus haut">
              ◀
            </button>
            <button onClick={() => move(id, where === "top" ? "bottom" : "top")}>{where === "top" ? "Dessous" : "Dessus"}</button>
            <button onClick={() => shift(list, set, i, 1)} disabled={i === list.length - 1} aria-label="Plus bas">
              ▶
            </button>
          </div>
        </div>
      );
    });
  return (
    <Modal title={`Regard ${scrying.scry!.count} (${name})`} onClose={() => {}} wide>
      <p className="hint">Range chaque carte au-dessus ou au-dessous de ta bibliothèque. À gauche, la carte la plus haute.</p>
      <h3>Au-dessus</h3>
      <div className="zone-grid">{top.length > 0 ? row(top, setTop, "top") : <p className="hint">Aucune carte.</p>}</div>
      <h3>Au-dessous</h3>
      <div className="zone-grid">{bottom.length > 0 ? row(bottom, setBottom, "bottom") : <p className="hint">Aucune carte.</p>}</div>
      <div className="row">
        <button className="primary" onClick={() => void act({ type: "scry", cardId: scrying.instanceId!, top, bottom })}>
          Valider
        </button>
      </div>
    </Modal>
  );
}

/** Un sort ou une capacité modale attend mes modes : une case à cocher par mode. */
function ModesPanel(props: { view: GameView }) {
  const { view } = props;
  const choosing = view.stack.find((c): c is VisibleCardView => !c.hidden && Boolean(c.modes && !c.modes.chosen));
  const [picked, setPicked] = useState<number[]>([]);
  const key = choosing?.instanceId ?? "";
  useEffect(() => setPicked([]), [key]);
  if (!choosing) return null;
  const name = cardName(view, choosing);
  if (choosing.controllerId !== view.viewerId) {
    return (
      <div className="targeting-banner" role="status">
        <span>
          {view.players[choosing.controllerId]?.name} choisit les modes de <strong>{name}</strong>.
        </span>
      </div>
    );
  }
  const data = view.cardData[choosing.cardId];
  const ability = choosing.ability;
  const effects = ability
    ? stackTrigger(data, ability)?.effects
    : data
      ? parseSpellEffects(data.faces?.[choosing.faceIndex]?.oracleText ?? data.oracleText, data.faces?.[choosing.faceIndex]?.name ?? data.name)
      : undefined;
  const spec = effects?.modes;
  if (!spec) return null;
  // Akroma's Will : les deux modes si je contrôle un commandant.
  const max = modesMax(spec, view.players[view.viewerId]?.zones.battlefield.some((c) => !c.hidden && c.isCommander) ?? false);
  const min = Math.max(1, spec.min);
  const ok = picked.length >= min && picked.length <= max;
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : max === 1 ? [i] : p.length < max ? [...p, i] : p));
  return (
    <Modal title={`Modes de ${ability?.sourceName ?? name}`} onClose={() => {}}>
      <p className="hint">{min === max ? `Choisis ${min} mode${min > 1 ? "s" : ""}.` : `Choisis de ${min} à ${max} modes.`}</p>
      <div className="modes-list">
        {spec.list.map((mode, i) => (
          <label key={i} className="mode-option">
            <input type={max === 1 ? "radio" : "checkbox"} checked={picked.includes(i)} onChange={() => toggle(i)} />
            <span>{mode.label}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" disabled={!ok} onClick={() => void act({ type: "chooseModes", cardId: choosing.instanceId!, modes: picked })}>
          Valider
        </button>
      </div>
    </Modal>
  );
}

/** Les modes d'un sort qu'on lance, avant ses cibles (Ashling's Command). */
function ModesPrompt() {
  const { modes } = useUi();
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => setPicked([]), [modes]);
  if (!modes) return null;
  const min = Math.max(1, modes.min);
  const ok = picked.length >= min && picked.length <= modes.max;
  const toggle = (i: number) =>
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : modes.max === 1 ? [i] : p.length < modes.max ? [...p, i] : p));
  return (
    <Modal title={modes.title} onClose={() => ui.closeModes(null)}>
      <p className="hint">{min === modes.max ? `Choisis ${min} mode${min > 1 ? "s" : ""}.` : `Choisis de ${min} à ${modes.max} modes.`}</p>
      <div className="modes-list">
        {modes.labels.map((label, i) => (
          <label key={i} className="mode-option">
            <input type={modes.max === 1 ? "radio" : "checkbox"} checked={picked.includes(i)} onChange={() => toggle(i)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <button onClick={() => ui.closeModes(null)}>Annuler</button>
        <button className="primary" disabled={!ok} onClick={() => ui.closeModes([...picked].sort((a, b) => a - b))}>
          Valider
        </button>
      </div>
    </Modal>
  );
}

/** Bandeau du choix des cibles, avec Annuler (ou Échap). */
function TargetingBanner() {
  const { targeting } = useUi();
  useEffect(() => {
    if (!targeting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ui.cancelTargeting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [targeting]);
  if (!targeting) return null;
  const index = targeting.chosen.length;
  const spec = targeting.specs[index]!;
  const where = spec.player ? (spec.permanent ? "une carte ou sur « Cibler » à côté d'un joueur" : "« Cibler » à côté d'un joueur") : spec.spell ? "un sort de la pile" : "une carte";
  return (
    <div className="targeting-banner" role="status">
      <span>
        <strong>{targeting.sourceName}</strong> : choisis{" "}
        {spec.choice ? `un(e) ${spec.label}` : spec.label === "n'importe quelle cible" ? "n'importe quelle cible" : `une cible (${spec.label})`}
        {targeting.specs.length > 1 ? `, cible ${index + 1} sur ${targeting.specs.length}` : ""}. Clique sur {where}.
      </span>
      {targeting.specs.slice(index).every((s) => s.upTo) && <button onClick={() => ui.skipTargets()}>Sans cible</button>}
      <button onClick={() => ui.cancelTargeting()}>Annuler</button>
    </div>
  );
}

function playCard(e: React.MouseEvent, view: GameView, card: CardView) {
  if (card.ownerId !== view.viewerId) return;
  const items = playItems(view, card);
  if (items.length === 1) return void items[0]!.onClick?.();
  if (items.length > 1) ui.openMenu(e.clientX, e.clientY, items);
}

function openCardMenu(e: React.MouseEvent, view: GameView, card: CardView) {
  const items = cardMenu(view, card);
  if (items.length > 0) ui.openMenu(e.clientX, e.clientY, items);
}

/**
 * Joue un son quand ce joueur (ou son équipe en tours partagés) reçoit la
 * priorité : seulement au passage de « non » à « oui », jamais à l'ouverture
 * de la table, et pas plus d'une fois par seconde et demie (voir sound.ts).
 * Pas de son non plus quand on la garde juste après sa propre action (lancer
 * un sort donne la priorité à celui qui l'a lancé), sauf si un autre joueur
 * l'avait entre-temps.
 */
function usePrioritySound(view: GameView) {
  const holder: "me" | "other" | null =
    view.priority === null || view.outcome.winners
      ? null
      : hasPriority(view, view.viewerId)
        ? "me"
        : "other";
  const previous = useRef<typeof holder | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = holder;
    if (before === undefined || before === "me" || holder !== "me") return;
    const justActed = Date.now() - session.lastActAt < 2000;
    if (before === "other" || !justActed) prioritySound.notify();
  }, [holder]);
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
  const isActive = sameSide(view, view.turn.activePlayerId, me);
  const combatUi = useCombatUi(view, isActive);
  const winners = view.outcome.winners;
  usePrioritySound(view);
  const { targeting } = useUi();
  const trigger = useTriggerTargets(view);

  return (
    <div className={`table ${targeting ? "targeting" : ""}`}>
      <div className="table-main">
        <TargetingBanner />
        {!targeting && <DecisionBanner view={view} />}
        <ScryPanel view={view} />
        <CardChoicePanel view={view} />
        <GraveyardTargetPicker view={view} />
        <ModesPanel view={view} />
        <ModesPrompt />
        {trigger.waitingName && !targeting && (
          <div className="targeting-banner" role="status">
            <span>
              La capacité de <strong>{trigger.waitingName}</strong> attend ses cibles : la partie ne peut pas continuer avant.
            </span>
            <button onClick={trigger.reopen}>Choisir les cibles</button>
          </div>
        )}
        <div className="board">
          <div className={`opponents opponents-${others.length}`}>
            {others.map((id) => (
              <PlayerArea key={id} view={view} playerId={id} compact onOpenZone={setZoneViewer} combat={combatUi} />
            ))}
          </div>
          <PlayerArea view={view} playerId={me} onOpenZone={setZoneViewer} combat={combatUi} />
          <CenterStack view={view} />
        </div>
        <Hand view={view} />
        <CombatPanel view={view} isActive={isActive} combat={combatUi} />
        <PhaseBar view={view} isActive={isActive} />
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
      <CardZoom view={view} />
      <Overlays />
    </div>
  );
}

function PlayerArea(props: {
  view: GameView;
  playerId: PlayerId;
  compact?: boolean;
  onOpenZone: (t: ZoneTarget) => void;
  combat: CombatUi;
}) {
  const { view, playerId } = props;
  const p = view.players[playerId]!;
  const isMe = playerId === view.viewerId;
  const battlefieldDrop = useDrop({ zone: "battlefield", playerId }, view);
  const commandDrop = useDrop({ zone: "command", playerId }, view);
  const graveDrop = useDrop({ zone: "graveyard", playerId }, view);
  const exileDrop = useDrop({ zone: "exile", playerId }, view);
  const libraryDrop = useDrop({ zone: "library", playerId }, view);
  const active = sameSide(view, view.turn.activePlayerId, playerId);
  const priority = hasPriority(view, playerId);
  const eliminated = view.outcome.eliminated[playerId];
  const size = props.compact ? "tiny" : "small";
  const { targeting } = useUi();
  const playerTarget = targeting?.specs[targeting.chosen.length]?.player && !p.hasConceded;

  // Une Aura ou un Équipement s'affiche sur la carte hôte, même si celle-ci est
  // à un autre joueur (Pacifisme posé sur une créature adverse).
  const allBattlefield = view.turnOrder.flatMap((pid) => view.players[pid]?.zones.battlefield ?? []);
  const onBattlefield = new Set(allBattlefield.map((c) => c.instanceId).filter(Boolean));
  const battlefield = p.zones.battlefield.filter((c) => !c.attachedTo || !onBattlefield.has(c.attachedTo));
  const attachmentsOf = (id: string | null) => (id ? allBattlefield.filter((c) => c.attachedTo === id) : []);
  const creatures = battlefield.filter((c) => battlefieldRow(view, c) === "creatures");
  const others = battlefield.filter((c) => battlefieldRow(view, c) === "others");
  const lands = battlefield.filter((c) => battlefieldRow(view, c) === "lands");

  const renderCard = (c: CardView) => (
    <Card
      key={c.instanceId ?? Math.random()}
      view={view}
      card={c}
      size={size}
      draggable
      attachments={attachmentsOf(c.instanceId)}
      attachmentProps={(a) => ({
        onMenu: (e) => openCardMenu(e, view, a),
        ...(targeting ? targetProps(view, targeting, a) : {}),
      })}
      onMenu={(e) => openCardMenu(e, view, c)}
      onDoubleClick={(e) => c.instanceId && tapOrProduce(e, view, c)}
      {...(targeting ? targetProps(view, targeting, c) : props.combat.cardProps(c))}
    />
  );

  return (
    <section
      className={`player-area ${props.compact ? "compact" : "mine"} ${active ? "active" : ""} ${eliminated ? "eliminated" : ""}`}
    >
      <header className="player-header">
        <strong className="player-name">{p.name}</strong>
        {playerTarget && (
          <button className="primary small" onClick={() => ui.pickTarget({ kind: "player", id: playerId })}>
            Cibler
          </button>
        )}
        {active && <span className="badge badge-turn">son tour · {STEP_LABELS[view.turn.step]}</span>}
        {priority && <span className="badge badge-priority">priorité</span>}
        <PlayerTags view={view} playerId={playerId} />
        {eliminated && <span className="badge badge-warn">éliminé ({eliminated})</span>}
        {p.untilNextTurn?.protection && (
          <span className="badge badge-ok" title="Jusqu'à son prochain tour : ni ciblé, ni blessé">
            protection contre tout
          </span>
        )}
        {p.untilNextTurn?.lifeCantChange && (
          <span className="badge badge-ok" title="Jusqu'à son prochain tour, ses points de vie ne peuvent pas changer">
            PV figés
          </span>
        )}
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
        {!isMe && (
          <span className="hand-count" title={`${p.zones.hand.length} carte(s) en main`}>
            <span className="hand-count-icon" aria-hidden="true" />
            {p.zones.hand.length}
            <small>en main</small>
          </span>
        )}
        <ManaPoolView view={view} playerId={playerId} />
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
          {p.zones.phasedOut?.length > 0 && (
            <Pile
              view={view}
              cards={p.zones.phasedOut}
              label="Hors phase"
              onOpen={() => props.onOpenZone({ zone: "phasedOut", playerId })}
            />
          )}
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
          <div className="battlefield-row creatures" title="Créatures">
            {creatures.map(renderCard)}
          </div>
          <div className="battlefield-row others" title="Artefacts, enchantements, planeswalkers…">
            {others.map(renderCard)}
          </div>
          <div className="battlefield-row lands" title="Terrains">
            {lands.map(renderCard)}
          </div>
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

/**
 * Réserve de mana. La sienne : clic pour ajouter, clic droit pour dépenser.
 * Celle des autres : seulement le mana présent.
 */
function ManaPoolView(props: { view: GameView; playerId: PlayerId }) {
  const { view, playerId } = props;
  const pool = view.players[playerId]!.manaPool;
  if (!pool) return null;
  const reserved = view.players[playerId]!.restrictedMana ?? [];
  const isMe = playerId === view.viewerId;
  const shown = MANA_TYPES.filter((m) => isMe || pool[m] > 0);
  if (shown.length === 0) return null;
  return (
    <span className="mana-pool" title={isMe ? "Réserve de mana : clic pour ajouter, clic droit pour dépenser" : "Réserve de mana"}>
      {shown.map((m) => (
        <button
          key={m}
          className={`mana ${pool[m] > 0 ? "has" : ""}`}
          disabled={!isMe}
          aria-label={`Mana ${MANA_LABELS[m]} : ${pool[m]}`}
          onClick={(e) => void act({ type: "adjustMana", mana: m, delta: e.shiftKey ? 5 : 1 })}
          onContextMenu={(e) => {
            e.preventDefault();
            if (pool[m] > 0) void act({ type: "adjustMana", mana: m, delta: -1 });
          }}
        >
          <img src={manaSymbolUrl(m)} alt={m} />
          {pool[m] > 0 && <span className="mana-count">{pool[m]}</span>}
        </button>
      ))}
      {reserved.length > 0 && (
        <span className="mana-reserved" title="Mana réservé à certains sorts">
          {reserved.map((r) => `{${r.mana}}`).join("")} ({[...new Set(reserved.map((r) => r.subtype))].join(", ")})
        </span>
      )}
    </span>
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
  /** Sans `drop` : on ne peut rien y déposer (zone hors phase). */
  drop?: ReturnType<typeof useDrop>;
  onOpen: () => void;
}) {
  const top = props.cards.at(-1);
  const img = top ? cardImage(props.view, top, "small") : null;
  return (
    <div
      className={`pile ${props.drop?.className ?? ""}`}
      {...(props.drop?.handlers ?? {})}
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
  const { targeting } = useUi();
  const drop = useDrop({ zone: "hand", playerId: view.viewerId }, view);
  // Après un mulligan : choisir les cartes à mettre au-dessous de la bibliothèque.
  // Au nettoyage : choisir les cartes à défausser pour revenir à 7 en main.
  const toBottom = me.mulliganBottom ?? 0;
  const toDiscard = toBottom > 0 ? 0 : (me.handSizeDiscards ?? 0);
  const toChoose = toBottom || toDiscard;
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => setChosen([]), [toBottom, toDiscard, me.mulligans, view.turn.number]);
  const toggle = (id: string) =>
    setChosen((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : list.length < toChoose ? [...list, id] : list,
    );
  const cardsWord = toChoose > 1 ? `les ${toChoose} cartes` : "la carte";
  return (
    <div className={`hand ${drop.className}`} {...drop.handlers}>
      {toBottom > 0 ? (
        <div className="mulligan-bar">
          <span>
            Mulligan : clique sur {cardsWord} à mettre au-dessous de ta bibliothèque ({chosen.length}/{toBottom}).
          </span>
          <button
            className="primary"
            disabled={chosen.length !== toBottom}
            onClick={() => void act({ type: "bottomMulligan", cardIds: chosen })}
          >
            Garder cette main
          </button>
        </div>
      ) : toDiscard > 0 ? (
        <div className="mulligan-bar">
          <span>
            Fin du tour : tu as plus de 7 cartes en main. Clique sur {cardsWord} à défausser ({chosen.length}/
            {toDiscard}).
          </span>
          <button
            className="primary"
            disabled={chosen.length !== toDiscard}
            onClick={() => void act({ type: "discardToHandSize", cardIds: chosen })}
          >
            Défausser
          </button>
        </div>
      ) : (
        <span className="zone-label">Main ({me.zones.hand.length})</span>
      )}
      <div className="hand-cards">
        {me.zones.hand.map((c) => (
          <Card
            key={c.instanceId}
            view={view}
            card={c}
            size="medium"
            draggable={toBottom === 0}
            onMenu={(e) => openCardMenu(e, view, c)}
            {...(toChoose > 0 && c.instanceId
              ? { selected: chosen.includes(c.instanceId), onSelect: () => toggle(c.instanceId!) }
              : targeting
                ? targetProps(view, targeting, c)
                : { onDoubleClick: (e: React.MouseEvent) => playCard(e, view, c) })}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Les phases et étapes du tour. Le joueur actif clique sur une étape plus loin
 * pour y aller directement (les étapes traversées ont lieu quand même).
 */
function PhaseBar(props: { view: GameView; isActive: boolean }) {
  const { view, isActive } = props;
  const current = view.turn.step;
  const order = TURN_PHASES.flatMap((p) => p.steps);
  const currentIndex = order.indexOf(current);
  const stackEmpty = view.stack.length === 0;
  const myPriority = hasPriority(view, view.viewerId);
  // Personne n'attend de réponse : le joueur actif peut avancer.
  const free = stackEmpty && view.priority === null;

  // Entrée : passer la priorité quand on l'a, sinon étape suivante.
  useEffect(() => {
    const action: GameAction | null = myPriority
      ? { type: "passPriority" }
      : isActive && free
        ? { type: "nextStep" }
        : null;
    if (!action) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "Enter" || e.repeat || target?.closest("input, textarea, select, button")) return;
      e.preventDefault();
      void act(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, free, myPriority]);

  return (
    <div className="phase-bar" aria-label="Étapes du tour">
      {TURN_PHASES.map((phase) => (
        <div key={phase.label} className="phase">
          {phase.steps.length > 1 && <span className="phase-label">{phase.label}</span>}
          <div className="phase-steps">
            {phase.steps.map((step) => {
              const index = order.indexOf(step);
              const state = index < currentIndex ? "past" : index === currentIndex ? "current" : "future";
              // Pas de priorité pendant le dégagement : on ne peut pas s'y arrêter.
              const reachable = isActive && free && state === "future" && step !== "untap";
              return (
                <button
                  key={step}
                  className={`phase-step ${state}`}
                  disabled={!reachable}
                  title={reachable ? `Aller à : ${STEP_LABELS[step]}` : undefined}
                  onClick={() => void act({ type: "nextStep", to: step })}
                >
                  {STEP_LABELS[step]}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Les étapes du tour des autres où le joueur s'arrête pour pouvoir répondre.
 * On s'arrête à ces étapes même sans rien à jouer : les autres ne peuvent
 * rien deviner de ta main.
 */
function StopsMenu(props: { view: GameView }) {
  const me = props.view.players[props.view.viewerId]!;
  const stops = priorityStopsOf(me);
  const steps = [...RESPONSE_STEPS];
  const toggle = (step: (typeof steps)[number]) =>
    void act({
      type: "setPriorityStops",
      stops: stops.includes(step) ? stops.filter((s) => s !== step) : [...stops, step],
    });
  return (
    <details className="stops-menu">
      <summary title="Étapes du tour des autres où tu peux répondre">
        Arrêts ({stops.length}/{steps.length})
      </summary>
      <div className="stops-list">
        <p>Pendant le tour des autres, tu reçois la priorité à ces étapes, que tu aies un éphémère ou non.</p>
        {steps.map((step) => (
          <label key={step}>
            <input type="checkbox" checked={stops.includes(step)} onChange={() => toggle(step)} />
            {STEP_LABELS[step]}
          </label>
        ))}
      </div>
    </details>
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
      {view.priority ? (
        <button
          className="primary"
          disabled={!hasPriority(view, view.viewerId)}
          title={
            view.stack.length > 0
              ? "Laisse la pile se résoudre ou les autres joueurs répondre (Entrée)"
              : "Tu ne réponds pas : le tour peut avancer (Entrée)"
          }
          onClick={() => void act({ type: "passPriority" })}
        >
          {hasPriority(view, view.viewerId)
            ? view.stack.length > 0
              ? "Passer la priorité"
              : "Passer (pas de réponse)"
            : view.stack.length > 0
              ? `Priorité : ${view.players[view.priority.playerId]!.name}`
              : `${view.players[view.priority.playerId]!.name} peut répondre…`}
        </button>
      ) : (
        <button
          className="primary"
          disabled={!props.isActive}
          title="Passe à l'étape suivante (Entrée)"
          onClick={() => void act({ type: "nextStep" })}
        >
          Étape suivante
        </button>
      )}
      <button
        disabled={!props.isActive || view.stack.length > 0 || view.priority !== null}
        onClick={() => void act({ type: "passTurn" })}
      >
        Finir le tour
      </button>
      {view.settings.enforceRules && <StopsMenu view={view} />}
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
      <SoundSettings />
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
  const { targeting } = useUi();
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
        <span className="zone-label">
          Pile {view.stack.length > 0 ? `(${view.stack.length})` : ""}
          {view.priority && ` · priorité : ${view.players[view.priority.playerId]!.name}`}
        </span>
        {view.stack.length === 0 && <div className="hint stack-hint">Les sorts lancés s'affichent au centre de la table.</div>}
      </div>
    </div>
  );
}

/** Écart entre deux objets de la pile, réduit quand la pile grandit pour qu'elle reste à l'écran. */
function stackOffset(count: number): number {
  return count <= 6 ? 26 : Math.max(10, Math.floor(156 / (count - 1)));
}

/**
 * La pile, au centre de la table : chaque sort lancé ou capacité activée y arrive par-dessus
 * le précédent (le dernier, en haut de la pile, est au premier plan), jusqu'à sa résolution.
 */
function CenterStack(props: { view: GameView }) {
  const { view } = props;
  const { targeting } = useUi();
  const stackDrop = useDrop({ zone: "stack", playerId: view.viewerId }, view);
  if (view.stack.length === 0) return null;
  const offset = stackOffset(view.stack.length);
  const top = view.stack.at(-1)!;
  const topController = top.controllerId ? view.players[top.controllerId]?.name : undefined;
  const topLabel = top.hidden ? "" : top.ability ? `Capacité de ${cardName(view, top)}` : cardName(view, top);
  // Pendant un ciblage qui ne vise pas un sort, la pile s'efface pour laisser cliquer les cartes dessous.
  const spec = targeting?.specs[targeting.chosen.length];
  const passive = Boolean(targeting && !spec?.spell);
  return (
    <div className={`center-stack ${passive ? "passive" : ""}`} aria-label="Pile">
      <div className={`center-stack-box ${stackDrop.className}`} {...stackDrop.handlers}>
        <div className="center-stack-title">
          Pile ({view.stack.length})
          {view.priority && <> · priorité : {view.players[view.priority.playerId]!.name}</>}
        </div>
        <div
          className="center-stack-cards"
          style={{ width: 118 + offset * (view.stack.length - 1), height: 165 + offset * (view.stack.length - 1) }}
        >
          {view.stack.map((c, i) => (
            <div
              key={c.instanceId ?? i}
              className={`center-stack-item ${c.controllerId === view.viewerId ? "from-me" : "from-other"}`}
              style={{ left: i * offset, top: i * offset, zIndex: i + 1 }}
            >
              <Card
                view={view}
                card={c}
                size="medium"
                draggable
                onMenu={(e) => openCardMenu(e, view, c)}
                {...(targeting ? targetProps(view, targeting, c) : {})}
              />
            </div>
          ))}
        </div>
        <div className="center-stack-caption">
          {topLabel}
          {topController && <span className="center-stack-who"> · {topController}</span>}
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
  phasedOut: "Hors phase (traités comme s'ils n'existaient pas ; ils reviennent avant le dégagement de leur contrôleur)",
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
