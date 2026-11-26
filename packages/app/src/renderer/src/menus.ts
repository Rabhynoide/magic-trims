import type { CardView, GameView, PlayerId, VisibleCardView, Zone } from "@magic-trims/core";
import { formatMana } from "@magic-trims/core";
import { cardData, cardManaOptions } from "./cards";
import { session } from "./session";
import { ui, type MenuItem } from "./ui-store";

const act = session.act.bind(session);

function moveItems(card: CardView, from: Zone): MenuItem[] {
  const id = card.instanceId!;
  const to = (
    label: string,
    zone: Zone,
    extra: { position?: "top" | "bottom"; faceDown?: boolean } = {},
  ): MenuItem => ({
    label,
    disabled: from === zone && zone !== "library",
    onClick: () => void act({ type: "moveCard", cardId: id, to: zone, ...extra }),
  });
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

  if (zone === "hand" && card.ownerId === me) {
    items.push(
      {
        label: "Jouer face cachée",
        onClick: () => void act({ type: "moveCard", cardId: id, to: "battlefield", faceDown: true }),
      },
      { label: "Révéler à tous", onClick: () => void act({ type: "revealCards", cardIds: [id], to: "all" }) },
      { separator: true, label: "" },
    );
  }

  items.push(...moveItems(card, zone));
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
