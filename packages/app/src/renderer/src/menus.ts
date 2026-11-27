import type { CardView, GameView, PlayerId, Target, VisibleCardView, Zone } from "@magic-trims/core";
import {
  abilitiesOf,
  formatMana,
  hasX,
  parseSpellEffects,
  auraTarget,
  evokeOptions,
  chooseTypeOf,
  entersUntappedChoice,
  exilePermissionHolds,
  foretellCost,
  flattenModes,
  modesTargeted,
  mostCommonCreatureType,
  stateFromView,
  sagaChapters,
  permanentLabel,
  type ActivationCost,
  type CardData,
  type ManaType,
  type PermanentFilter,
} from "@magic-trims/core";
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

  const activated = abilityItems(view, card);
  if (activated.length > 0) items.push(...activated, { separator: true, label: "" });

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

  // Rebond, cascade : un sort exilé qu'on peut lancer sans payer son coût.
  if ((zone === "exile" || zone === "graveyard") && card.ownerId === me && !card.hidden) {
    const state = stateFromView(view);
    const instance = id ? state.cards[id] : undefined;
    if (instance && exilePermissionHolds(state, instance)) {
      const permission = instance.castPermission!;
      const how = permission.free ? "gratuit" : permission.foretell ? `pour ${permission.foretell}` : "";
      const play = playItems(view, card).map((item) =>
        item.separator ? item : { ...item, label: permission.foretell ? `Lancer ${cardName(view, card)} présagé ${permission.foretell}` : `${item.label} (${permission.reason}${how ? `, ${how}` : ""})` },
      );
      if (play.length > 0) items.push(play[0]!, { separator: true, label: "" });
    }
  }

  // Présage : {2} pendant son tour, la carte part en exil face cachée.
  const foretell = zone === "hand" && card.ownerId === me && view.settings.enforceRules ? foretellCost(cardData(view, card)) : null;
  if (foretell) {
    items.push({ label: `Présager pour {2} (à lancer plus tard pour ${foretell})`, onClick: () => void act({ type: "foretell", cardId: id }) }, { separator: true, label: "" });
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

/** Demande le permanent à sacrifier pour un coût. `null` si le joueur annule. */
async function chooseSacrifice(sourceName: string, sourceId: string, filter: PermanentFilter): Promise<string | null> {
  const chosen = await ui.chooseTargets(sourceName, sourceId, [{ label: `${permanentLabel(filter)} à sacrifier`, permanent: filter, choice: true }]);
  return chosen?.[0]?.id ?? null;
}

const COLOR_CHOICES: ManaType[] = ["W", "U", "B", "R", "G"];

/** Le coût d'une capacité en français : « {2}{B}, engager, 1 PV, sacrifier ». */
function costLabel(cost: ActivationCost): string {
  const parts = [
    cost.loyalty !== undefined ? `${cost.loyalty > 0 ? "+" : cost.loyalty < 0 ? "−" : ""}${Math.abs(cost.loyalty)} loyauté` : "",
    cost.mana,
    cost.tap ? "engager" : "",
    cost.life > 0 ? `${cost.life} PV` : "",
    cost.sacrificeSelf ? "la sacrifier" : "",
    cost.exileSelf ? "l'exiler" : "",
    cost.discardSelf ? "la défausser" : "",
    cost.sacrifice ? `sacrifier un(e) ${permanentLabel(cost.sacrifice).replace(/ que tu contrôles$/, "")}` : "",
  ].filter(Boolean);
  return parts.join(", ") || "gratuit";
}

/** La ligne de texte en français, quand la traduction a autant de lignes que l'anglais. */
function translateLine(data: CardData, faceIndex: number, text: string): string {
  const lines = (t: string | undefined) => (t ?? "").split("\n").map((l) => l.replace(/\([^)]*\)/g, "").trim()).filter(Boolean);
  const english = lines(data.faces?.[faceIndex]?.oracleText ?? data.oracleText);
  const french = lines(data.localized?.faces?.[faceIndex]?.oracleText ?? data.localized?.oracleText);
  const i = english.indexOf(text);
  return i >= 0 && french.length === english.length ? french[i]! : text;
}

/**
 * « Activer » : une entrée par capacité activée que le moteur sait payer (de
 * mes permanents, ou de mes cartes au cimetière pour celles qui s'y activent).
 */
export function abilityItems(view: GameView, card: CardView): MenuItem[] {
  const id = card.instanceId;
  if (!id || card.hidden || card.faceDown || !view.settings.enforceRules) return [];
  const data = cardData(view, card);
  if (!data) return [];
  const faceIndex = (card as VisibleCardView).faceIndex ?? 0;
  const name = cardName(view, card);
  const items: MenuItem[] = [];
  abilitiesOf(data, faceIndex).activated.forEach((ability, index) => {
    const mine =
      ability.zone === "battlefield"
        ? card.zone === "battlefield" && card.controllerId === view.viewerId
        : card.zone === ability.zone && card.ownerId === view.viewerId;
    if (!mine) return;
    const effect = translateLine(data, faceIndex, ability.text);
    const short = effect.slice(effect.indexOf(":") + 1).trim();
    const cost = costLabel(ability.cost);
    const label = ability.equip
      ? `Équiper${ability.effects.targets[0]?.permanent?.anySubtype || ability.effects.targets[0]?.permanent?.subtype || ability.effects.targets[0]?.permanent?.legendary ? ` (${ability.effects.targets[0]!.label.replace(/ que tu contrôles$/, "")})` : ""} ${ability.cost.mana || "{0}"}`
      : `Activer (${cost}) : ${short.length > 60 ? `${short.slice(0, 57)}…` : short}`;
    const activate = async (color?: ManaType) => {
      let sacrifice: string | undefined;
      if (ability.cost.sacrifice) {
        const chosen = await chooseSacrifice(name, id, ability.cost.sacrifice);
        if (!chosen) return;
        sacrifice = chosen;
      }
      let targets;
      if (ability.effects.targets.length > 0) {
        const chosen = await ui.chooseTargets(name, id, ability.effects.targets);
        if (!chosen) return;
        targets = chosen;
      }
      void act({
        type: "activateAbility",
        cardId: id,
        index,
        ...(targets ? { targets } : {}),
        ...(sacrifice ? { sacrifice } : {}),
        ...(color ? { color } : {}),
      });
    };
    if (ability.effects.effects.some((e) => e.type === "manaAny")) {
      for (const color of COLOR_CHOICES) {
        items.push({ label: `Activer (${cost}) : ajouter ${formatMana([color])}`, disabled: card.tapped && ability.cost.tap, onClick: () => void activate(color) });
      }
    } else items.push({ label, disabled: card.tapped && ability.cost.tap, onClick: () => void activate() });
  });
  return items;
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
    .flatMap((f): MenuItem[] => {
      const face = f.face !== undefined ? { face: f.face } : {};
      // « As ~ enters, choose a creature type » : demandé en jouant la carte.
      const askType = async (): Promise<string | null | undefined> => {
        const what = view.settings.enforceRules ? chooseTypeOf(data, f.face ?? 0) : null;
        if (!what) return undefined;
        if (what === "color") return ui.ask("Couleur choisie (W, U, B, R ou G)", "G", "text");
        if (what === "card") return ui.ask("Type choisi (artifact, creature, enchantment, instant ou sorcery)", "creature", "text");
        return ui.ask("Type de créature choisi (en anglais : Elemental, Elf…)", mostCommonCreatureType(stateFromView(view), view.viewerId), "text");
      };
      if (/\bLand\b/.test(f.typeLine)) {
        const play = (untap: boolean) => async () => {
          const chosenType = await askType();
          if (chosenType === null) return;
          void act({ type: "playLand", cardId: id, ...face, ...(chosenType ? { chosenType } : {}), ...(untap ? { untap } : {}) });
        };
        // « You may reveal an Elemental card / pay 2 life. If you don't, it enters tapped. »
        const state = view.settings.enforceRules ? stateFromView(view) : null;
        const instance = state?.cards[id];
        const offer = state && instance ? entersUntappedChoice(state, view.viewerId, instance, f.face ?? 0) : null;
        if (offer) {
          const how = offer.life ? `payer ${offer.life} PV` : `révéler une carte ${offer.reveal}`;
          return [
            { label: `Jouer ${f.name} dégagé (${how})`, disabled: !offer.possible, onClick: play(true) },
            { label: `Jouer ${f.name} engagé`, onClick: play(false) },
          ];
        }
        return [{ label: `Jouer ${f.name}`, onClick: play(false) }];
      }
      const cast = (alternative: boolean, evoke?: true | "granted", exileColor?: string) => async () => {
          let x: number | undefined;
          if (hasX(f.manaCost)) {
            const value = await ui.ask("Valeur de X", "1", "number");
            if (value === null) return;
            x = Math.max(0, Math.floor(Number(value) || 0));
          }
          // Les cibles des effets que le moteur applique (quand l'hôte fait respecter les règles).
          const faceData = faces ? faces[f.face ?? 0] : data;
          const parsed =
            view.settings.enforceRules && /\b(Instant|Sorcery)\b/.test(f.typeLine)
              ? parseSpellEffects(faceData?.oracleText ?? data.oracleText, f.name, { alternative })
              : null;
          // Toxic Deluge : X PV payés en coût supplémentaire.
          if (parsed?.payLifeX && x === undefined) {
            const value = await ui.ask("Valeur de X (PV à payer)", "1", "number");
            if (value === null) return;
            x = Math.max(0, Math.floor(Number(value) || 0));
          }
          // Modes avec des cibles (Ashling's Command) : choisis d'abord, leurs cibles suivent.
          let modes: number[] | undefined;
          if (parsed?.modes && modesTargeted(parsed)) {
            const picked = await ui.chooseModes(`Modes de ${f.name}`, parsed.modes.list.map((m) => m.label), parsed.modes.min, parsed.modes.max);
            if (!picked) return;
            modes = picked;
          }
          const effects = parsed && modes ? flattenModes(parsed, modes) : parsed;
          // Coût supplémentaire : la créature à sacrifier (Village Rites…).
          let sacrifice: string | undefined;
          if (effects?.sacrifice) {
            const chosen = await chooseSacrifice(cardName(view, card), id, effects.sacrifice);
            if (!chosen) return;
            sacrifice = chosen;
          }
          let targets: Target[] | undefined;
          if (effects && effects.targets.length > 0) {
            const chosen = await ui.chooseTargets(cardName(view, card), id, effects.targets);
            if (!chosen) return;
            targets = chosen;
          }
          // Évocation « Exile a green card from your hand » : la carte à exiler.
          let evokeExile: string | undefined;
          if (exileColor) {
            const chosen = await ui.chooseTargets(cardName(view, card), id, [{ label: "carte de ta main à exiler (de la bonne couleur)", hand: true, choice: true }]);
            if (!chosen) return;
            evokeExile = chosen[0]!.id;
          }
          const chosenType = await askType();
          if (chosenType === null) return;
          // Saga avec lecture anticipée : le chapitre de départ.
          let chapter: number | undefined;
          const chapters = view.settings.enforceRules ? sagaChapters(data, f.face ?? 0) : 0;
          if (chapters > 0 && /\bRead ahead\b/i.test(faceData?.oracleText ?? data.oracleText)) {
            const value = await ui.ask(`Lecture anticipée : chapitre de départ (1 à ${chapters})`, "1", "number");
            if (value === null) return;
            chapter = Math.max(1, Math.min(chapters, Math.floor(Number(value) || 1)));
          }
          // Une aura : ce qu'elle va enchanter.
          const aura = view.settings.enforceRules && !effects ? auraTarget(f.typeLine, faceData?.oracleText ?? data.oracleText) : null;
          if (aura?.permanent || aura?.player) {
            const chosen = await ui.chooseTargets(cardName(view, card), id, [aura]);
            if (!chosen) return;
            targets = chosen;
          }
          void act({
            type: "castSpell",
            cardId: id,
            ...face,
            ...(x !== undefined ? { x } : {}),
            ...(targets ? { targets } : {}),
            ...(sacrifice ? { sacrifice } : {}),
            ...(alternative ? { alternative } : {}),
            ...(chapter !== undefined ? { chapter } : {}),
            ...(evoke ? { evoke } : {}),
            ...(evokeExile ? { evokeExile } : {}),
            ...(chosenType ? { chosenType } : {}),
            ...(modes ? { modes } : {}),
          });
      };
      const items: MenuItem[] = [{ label: `Lancer ${f.name}${f.manaCost ? ` ${f.manaCost}` : ""}`, onClick: cast(false) }];
      // Coût alternatif (Baleful Mastery) : une seconde entrée.
      const faceText = (faces ? faces[f.face ?? 0]?.oracleText : data.oracleText) ?? "";
      const alt = view.settings.enforceRules && /\b(Instant|Sorcery)\b/.test(f.typeLine) ? parseSpellEffects(faceText, f.name).alternativeCost : undefined;
      if (alt) items.push({ label: `Lancer ${f.name} pour ${alt} (coût alternatif)`, onClick: cast(true) });
      // Évocation : la sienne, et celle que donne Ashling (sacrifiée en arrivant).
      if (view.settings.enforceRules && card.zone === "hand") {
        const evoke = evokeOptions(stateFromView(view), view.viewerId, data, f.face ?? 0, true);
        const label = (c: { mana: string; exileColor?: string }) => (c.exileColor ? "en exilant une carte de ta main" : `pour ${c.mana}`);
        if (evoke.printed) items.push({ label: `Évoquer ${f.name} ${label(evoke.printed)}`, onClick: cast(false, true, evoke.printed.exileColor) });
        if (evoke.granted && evoke.granted.mana !== evoke.printed?.mana) {
          items.push({ label: `Évoquer ${f.name} pour ${evoke.granted.mana} (donné par un autre permanent)`, onClick: cast(false, "granted") });
        }
      }
      return items;
    });
}
