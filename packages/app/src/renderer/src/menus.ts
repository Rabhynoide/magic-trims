import type { CardView, GameView, PlayerId, Target, VisibleCardView, Zone } from "@magic-trims/core";
import { formatMana, hasX, parseSpellEffects } from "@magic-trims/core";
import { cardData, cardManaOptions, cardName, creaturePT } from "./cards";
import { session } from "./session";
import { ui, type MenuItem } from "./ui-store";

const act = session.act.bind(session);

function moveItems(view: GameView, card: CardView, from: Zone): MenuItem[] {
  const id = card.instanceId!;
  // Avec les règles, poser une carte de sa main ou de sa zone de commandement
  // sans la jouer est un effet : on le dit, et on force le déplacement.
  const effect =
    view.settings.enforceRules !== false && (from === "hand" || from === "command");
  const to = (
    label: string,
    zone: Zone,
    extra: { position?: "top" | "bottom"; faceDown?: boolean } = {},
  ): MenuItem => {
    const forced = effect && (zone === "battlefield" || zone === "stack");
    return {
      label: forced ? `${label} (effet, sans payer)` : label,
      disabled: from === zone && zone !== "library",
      onClick: () => void act({ type: "moveCard", cardId: id, to: zone, ...extra, ...(forced ? { force: true } : {}) }),
    };
  };
  return [
    to("Sur le champ de bataille", "battlefield"),
    to("Sur la pile", "stack"),
    to("En main", "hand"),
    to("Au cimetière", "graveyard"),
    to("En exil", "exile"),
    to("En exil face cachée", "exile", { faceDown: true }),
    to("Dessus de la bibliothèque", "library", { position: "top" }),
    to("Dessous de la bibliothèque", "library", { position: "bottom" }),
    ...(!card.hidden && (card as VisibleCardView).isCommander ? [to("Zone de commandement", "command")] : []),
  ];
}

async function askCounter(cardId: string) {
  const kind = await ui.ask("Type de marqueur (ex. charge, loyauté, +1/+1)", "charge");
  if (!kind?.trim()) return;
  const n = await ui.askNumber(`Nombre de marqueurs ${kind}`, 1);
  if (n) void act({ type: "adjustCardCounter", cardId, kind: kind.trim(), delta: n });
}

/** Menu d'une carte, selon sa zone et qui la regarde. */
export function cardMenu(view: GameView, card: CardView): MenuItem[] {
  const id = card.instanceId;
  if (!id) return [];
  const me = view.viewerId;
  const items: MenuItem[] = [];
  const zone = card.zone;

  if (zone === "battlefield") {
    const data = cardData(view, card);
    if (!card.tapped) items.push(...manaItems(view, card));
    if (creaturePT(view, card)) {
      items.push({
        label: "Bonus jusqu'à la fin du tour…",
        onClick: async () => {
          const value = await ui.ask("Bonus jusqu'à la fin du tour (ex. +3/+3, -2/-0)", "+1/+1");
          const m = value?.replace(/\s/g, "").match(/^([+-]?\d+)\/([+-]?\d+)$/);
          if (!m) return;
          void act({ type: "boostCreature", cardId: id, power: Number(m[1]), toughness: Number(m[2]) });
        },
      });
    }
    items.push(
      {
        label: card.tapped ? "Dégager" : "Engager",
        onClick: () => void act({ type: "setTapped", cardIds: [id], tapped: !card.tapped }),
      },
      {
        label: card.faceDown ? "Retourner face visible" : "Retourner face cachée",
        onClick: () => void act({ type: "setFaceDown", cardId: id, faceDown: !card.faceDown }),
      },
    );
    if ((data?.faces?.length ?? 0) > 1) {
      items.push({ label: "Transformer", onClick: () => void act({ type: "transform", cardId: id }) });
    }
    items.push(
      { separator: true, label: "" },
      {
        label: "Ajouter un marqueur +1/+1",
        onClick: () => void act({ type: "adjustCardCounter", cardId: id, kind: "+1/+1", delta: 1 }),
      },
      {
        label: "Retirer un marqueur +1/+1",
        disabled: !card.counters["+1/+1"],
        onClick: () => void act({ type: "adjustCardCounter", cardId: id, kind: "+1/+1", delta: -1 }),
      },
      {
        label: "Ajouter un marqueur loyauté",
        onClick: () => void act({ type: "adjustCardCounter", cardId: id, kind: "loyauté", delta: 1 }),
      },
      {
        label: "Retirer un marqueur loyauté",
        disabled: !card.counters["loyauté"],
        onClick: () => void act({ type: "adjustCardCounter", cardId: id, kind: "loyauté", delta: -1 }),
      },
      { label: "Autre marqueur…", onClick: () => void askCounter(id) },
      ...Object.keys(card.counters)
        .filter((k) => k !== "+1/+1" && k !== "loyauté")
        .map((k) => ({
          label: `Retirer un marqueur ${k}`,
          onClick: () => void act({ type: "adjustCardCounter", cardId: id, kind: k, delta: -1 }),
        })),
      { separator: true, label: "" },
    );
    if (card.attachedTo) {
      items.push({ label: "Détacher", onClick: () => void act({ type: "attach", cardId: id, targetId: null }) });
    }
    for (const pid of view.turnOrder) {
      if (pid !== card.controllerId) {
        items.push({
          label: `Donner le contrôle à ${view.players[pid]!.name}`,
          onClick: () => void act({ type: "changeControl", cardId: id, controllerId: pid }),
        });
      }
    }
    items.push({ separator: true, label: "" });
  }

  if ((zone === "hand" || (zone === "command" && (card as VisibleCardView).isCommander)) && card.ownerId === me) {
    const play = playItems(view, card);
    if (play.length > 0) items.push(...play, { separator: true, label: "" });
  }

  if (zone === "hand" && card.ownerId === me) {
    items.push(
      {
        label: "Jouer face cachée",
        onClick: () => void act({ type: "moveCard", cardId: id, to: "battlefield", faceDown: true, force: true }),
      },
      { label: "Révéler à tous", onClick: () => void act({ type: "revealCards", cardIds: [id], to: "all" }) },
      { separator: true, label: "" },
    );
  }

  items.push(...moveItems(view, card, zone));
  return items;
}

/** Menu de la bibliothèque d'un joueur (le sien seulement). */
export function libraryMenu(view: GameView, ownerId: PlayerId): MenuItem[] {
  if (ownerId !== view.viewerId) return [];
  return [
    { label: "Piocher une carte", onClick: () => void act({ type: "draw", count: 1 }) },
    {
      label: "Piocher X cartes…",
      onClick: async () => {
        const n = await ui.askNumber("Combien de cartes piocher ?", 2);
        if (n) void act({ type: "draw", count: n });
      },
    },
    { label: "Mélanger", onClick: () => void act({ type: "shuffleLibrary" }) },
    { separator: true, label: "" },
    {
      label: "Regarder les X cartes du dessus…",
      onClick: async () => {
        const n = await ui.askNumber("Combien de cartes regarder ?", 1);
        if (n) void act({ type: "lookAtLibraryTop", count: n });
      },
    },
    { label: "Révéler la carte du dessus", onClick: () => void act({ type: "revealLibraryTop", count: 1 }) },
    {
      label: "Meuler X cartes…",
      onClick: async () => {
        const n = await ui.askNumber("Combien de cartes meuler ?", 1);
        if (n) void act({ type: "moveTopOfLibrary", count: n, to: "graveyard" });
      },
    },
    {
      label: "Exiler la carte du dessus",
      onClick: () => void act({ type: "moveTopOfLibrary", count: 1, to: "exile" }),
    },
    {
      label: "Exiler la carte du dessus face cachée",
      onClick: () => void act({ type: "moveTopOfLibrary", count: 1, to: "exile", faceDown: true }),
    },
  ];
}

/** « Engager pour {G} », un choix par sorte de mana que la carte peut produire. */
export function manaItems(view: GameView, card: CardView): MenuItem[] {
  const id = card.instanceId;
  if (!id) return [];
  const options = cardManaOptions(view, card);
  return options.map((mana, i) => ({
    label: `Engager pour ${formatMana(mana)}`,
    onClick: () => void act({ type: "tapForMana", cardId: id, ...(options.length > 1 ? { choice: i } : {}) }),
  }));
}

/**
 * Jouer la carte avec les règles : « Jouer » pour un terrain, « Lancer » pour
 * un sort (une entrée par face jouable d'une carte scindée ou modale).
 */
export function playItems(view: GameView, card: CardView): MenuItem[] {
  const id = card.instanceId;
  const data = cardData(view, card);
  if (!id || !data) return [];
  const faces = data.faces && data.faces.length > 1 ? data.faces : null;
  const entries = (faces ?? [{ name: data.name, typeLine: data.typeLine, manaCost: data.manaCost }]).map((f, i) => ({
    face: faces ? i : undefined,
    name: f.name,
    typeLine: f.typeLine,
    manaCost: f.manaCost || (faces ? "" : data.manaCost),
  }));
  // Les dos des cartes à transformer ne se lancent pas : seulement les faces avec un coût, ou des terrains.
  return entries
    .filter((f, i) => i === 0 || f.manaCost || /\bLand\b/.test(f.typeLine))
    .map((f) => {
      const face = f.face !== undefined ? { face: f.face } : {};
      if (/\bLand\b/.test(f.typeLine)) {
        return { label: `Jouer ${f.name}`, onClick: () => void act({ type: "playLand", cardId: id, ...face }) };
      }
      return {
        label: `Lancer ${f.name}${f.manaCost ? ` ${f.manaCost}` : ""}`,
        onClick: async () => {
          let x: number | undefined;
          if (hasX(f.manaCost)) {
            const value = await ui.ask("Valeur de X", "1", "number");
            if (value === null) return;
            x = Math.max(0, Math.floor(Number(value) || 0));
          }
          // Les cibles des effets que le moteur applique (quand l'hôte fait respecter les règles).
          const faceData = faces ? faces[f.face ?? 0] : data;
          const effects =
            view.settings.enforceRules && /\b(Instant|Sorcery)\b/.test(f.typeLine)
              ? parseSpellEffects(faceData?.oracleText ?? data.oracleText, f.name)
              : null;
          let targets: Target[] | undefined;
          if (effects && effects.targets.length > 0) {
            const chosen = await ui.chooseTargets(cardName(view, card), id, effects.targets);
            if (!chosen) return;
            targets = chosen;
          }
          void act({ type: "castSpell", cardId: id, ...face, ...(x !== undefined ? { x } : {}), ...(targets ? { targets } : {}) });
        },
      };
    });
}
