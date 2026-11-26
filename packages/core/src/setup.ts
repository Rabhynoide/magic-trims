import type { ResolvedDeck } from "./deck/resolve.js";
import { emptyPool } from "./mana.js";
import { GAME_MODES } from "./modes.js";
import { log, moveCardTo, newInstance, shuffleZone } from "./reducer.js";
import { randomSeed, shuffleInPlace } from "./rng.js";
import type { CardData, GameModeType, GameSettings, GameState, PlayerId, PlayerState } from "./types.js";

export const DEFAULT_SETTINGS: GameSettings = {
  mode: "freeForAll",
  startingLife: 40,
  archenemyLife: 80,
  commanderDamageLimit: 21,
  poisonLimit: 10,
  freeFirstMulligan: true,
  sharedTeamLife: false,
  sharedTurns: false,
  teammatesSeeHands: false,
  planechase: false,
  autoTurnActions: true,
};

export const MAX_PLAYERS = 5;
export const OPENING_HAND_SIZE = 7;

export interface NewGamePlayer {
  id: PlayerId;
  name: string;
  deck: ResolvedDeck;
  /** Pioche de machinations (mode Archenemy, pour l'archenemy). */
  schemes?: CardData[];
}

export interface NewGameOptions {
  id: string;
  players: NewGamePlayer[];
  /** Mode de jeu (chacun pour soi par défaut). */
  mode?: GameModeType;
  /**
   * Équipes, pour les modes Équipes et Géant à deux têtes. Par défaut, les
   * joueurs sont regroupés par deux dans l'ordre de la liste.
   */
  teams?: PlayerId[][];
  /** L'archenemy (mode Archenemy) ; par défaut le premier joueur de la liste. */
  archenemyId?: PlayerId;
  /** Pioche de plans partagée (variante Planechase). */
  planarDeck?: CardData[];
  /** Réglages choisis par l'hôte ; ils priment sur ceux du mode. */
  settings?: Partial<GameSettings>;
  /** Graine des mélanges ; aléatoire par défaut. */
  seed?: number;
  /** Tirer au sort les places et le premier joueur (vrai par défaut). */
  randomTurnOrder?: boolean;
}

/**
 * Met en place une partie : places autour de la table selon le mode,
 * commandants dans la zone de commandement, pioches mélangées, mains de départ.
 */
export function createGame(options: NewGameOptions): GameState {
  const { players } = options;
  const modeType = options.mode ?? options.settings?.mode ?? "freeForAll";
  const mode = GAME_MODES[modeType];
  if (!mode) throw new Error(`Mode de jeu inconnu : ${modeType}.`);
  if (players.length > MAX_PLAYERS) throw new Error(`Une partie se joue à ${MAX_PLAYERS} joueurs au plus.`);
  if (players.length < mode.minPlayers || players.length > mode.maxPlayers) {
    const range = mode.minPlayers === mode.maxPlayers ? `${mode.minPlayers}` : `${mode.minPlayers} à ${mode.maxPlayers}`;
    throw new Error(`Le mode ${mode.label} se joue à ${range} joueurs.`);
  }
  const ids = players.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error("Deux joueurs ont le même identifiant.");

  const settings: GameSettings = { ...DEFAULT_SETTINGS, ...mode.defaults, ...options.settings, mode: modeType };
  if (options.planarDeck?.length) settings.planechase = options.settings?.planechase ?? true;

  let rngState = options.seed ?? randomSeed();
  const random = options.randomTurnOrder ?? true;
  const shuffle = <T>(items: T[]): T[] => {
    if (random) rngState = shuffleInPlace(items, rngState);
    return items;
  };

  // Équipes et places autour de la table.
  let teams: PlayerId[][];
  let turnOrder: PlayerId[];
  let archenemyId: PlayerId | undefined;
  switch (modeType) {
    case "teams":
    case "twoHeadedGiant": {
      teams = (options.teams ?? pairUp(ids)).map((t) => [...t]);
      validateTeams(teams, ids, modeType);
      shuffle(teams);
      teams.forEach((t) => shuffle(t));
      // Géant à deux têtes : les coéquipiers sont assis côte à côte.
      // Équipes : on alterne les équipes autour de la table.
      turnOrder = modeType === "twoHeadedGiant" ? teams.flat() : interleave(teams);
      break;
    }
    case "archenemy": {
      archenemyId = options.archenemyId ?? ids[0]!;
      if (!ids.includes(archenemyId)) throw new Error("L'archenemy doit être un des joueurs.");
      const others = shuffle(ids.filter((id) => id !== archenemyId));
      // L'archenemy joue toujours en premier.
      turnOrder = [archenemyId, ...others];
      teams = [[archenemyId], others];
      break;
    }
    default: {
      turnOrder = shuffle([...ids]);
      teams = turnOrder.map((id) => [id]);
    }
  }
  // L'ordre à l'intérieur de chaque équipe suit l'ordre du tour.
  teams = teams.map((t) => turnOrder.filter((id) => t.includes(id)));

  const g: GameState = {
    id: options.id,
    version: 0,
    settings,
    turnOrder,
    teams,
    players: {},
    cards: {},
    cardData: {},
    stack: [],
    priority: null,
    planarDeck: [],
    plane: [],
    // La partie commence à l'entretien du premier joueur : il n'y a rien à dégager.
    turn: { number: 1, activePlayerId: turnOrder[0]!, step: "upkeep", planarDieRolls: 0 },
    rngState,
    log: [],
  };
  if (archenemyId) g.archenemyId = archenemyId;

  for (const p of players) {
    const player: PlayerState = {
      id: p.id,
      name: p.name,
      life: p.id === archenemyId ? settings.archenemyLife : settings.startingLife,
      poison: 0,
      commanderDamage: {},
      counters: {},
      zones: { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [], schemes: [] },
      commanderCasts: {},
      mulligans: 0,
      mulliganBottom: 0,
      manaPool: emptyPool(),
      hasConceded: false,
    };
    g.players[p.id] = player;

    for (const commander of p.deck.commanders) {
      g.cardData[commander.id] ??= commander;
      const instance = newInstance(g, commander.id, p.id, "command");
      instance.isCommander = true;
      instance.revealedTo = [...turnOrder];
      player.zones.command.push(instance.instanceId);
    }
    for (const { card, quantity } of p.deck.cards) {
      g.cardData[card.id] ??= card;
      for (let i = 0; i < quantity; i++) {
        player.zones.library.push(newInstance(g, card.id, p.id, "library").instanceId);
      }
    }
    if (p.schemes && p.id === archenemyId) {
      for (const scheme of p.schemes) {
        g.cardData[scheme.id] ??= scheme;
        player.zones.schemes.push(newInstance(g, scheme.id, p.id, "schemes").instanceId);
      }
    }
  }

  for (const id of turnOrder) {
    const player = g.players[id]!;
    shuffleZone(g, player.zones.library);
    shuffleZone(g, player.zones.schemes);
    for (let i = 0; i < OPENING_HAND_SIZE && player.zones.library.length > 0; i++) {
      moveCardTo(g, player.zones.library[0]!, "hand", "top");
    }
  }

  if (settings.planechase && options.planarDeck?.length) {
    // La pioche de plans appartient au premier joueur ; on révèle le premier plan.
    for (const plane of options.planarDeck) {
      g.cardData[plane.id] ??= plane;
      g.planarDeck.push(newInstance(g, plane.id, turnOrder[0]!, "planarDeck").instanceId);
    }
    shuffleZone(g, g.planarDeck);
    moveCardTo(g, g.planarDeck[0]!, "plane", "top");
  }

  const first = settings.sharedTurns ? teams.find((t) => t.includes(turnOrder[0]!))! : [turnOrder[0]!];
  const firstNames = first.map((id) => g.players[id]!.name).join(" et ");
  log(g, null, `Partie en mode ${mode.label}. ${firstNames} ${first.length > 1 ? "jouent" : "joue"} en premier.`);
  return g;
}

/** Regroupe les joueurs par deux : [a, b], [c, d], [e]. */
function pairUp(ids: PlayerId[]): PlayerId[][] {
  const teams: PlayerId[][] = [];
  for (let i = 0; i < ids.length; i += 2) teams.push(ids.slice(i, i + 2));
  // À cinq, le dernier joueur rejoint la dernière équipe (2 contre 3).
  if (teams.length > 1 && teams.at(-1)!.length === 1) teams.at(-2)!.push(...teams.pop()!);
  return teams;
}

function validateTeams(teams: PlayerId[][], ids: PlayerId[], mode: GameModeType): void {
  const flat = teams.flat();
  if (flat.length !== ids.length || new Set(flat).size !== ids.length || !ids.every((id) => flat.includes(id))) {
    throw new Error("Chaque joueur doit faire partie d'une seule équipe.");
  }
  if (teams.length < 2 || teams.some((t) => t.length === 0)) throw new Error("Il faut au moins deux équipes.");
  if (mode === "twoHeadedGiant" && (teams.length !== 2 || teams.some((t) => t.length !== 2))) {
    throw new Error("Le Géant à deux têtes se joue à deux équipes de deux.");
  }
}

/** Alterne les équipes : a1, b1, a2, b2, b3… */
function interleave(teams: PlayerId[][]): PlayerId[] {
  const order: PlayerId[] = [];
  const longest = Math.max(...teams.map((t) => t.length));
  for (let i = 0; i < longest; i++) for (const t of teams) if (t[i]) order.push(t[i]!);
  return order;
}

/**
 * Complète une partie sauvegardée par une version précédente de l'appli
 * (champs ajoutés depuis). Modifie et retourne `g`.
 */
export function upgradeGame(g: GameState): GameState {
  g.settings = { ...DEFAULT_SETTINGS, ...g.settings };
  // Les anciennes parties n'avaient pas d'étapes : on reprend en phase principale.
  g.turn.step ??= "main1";
  for (const p of Object.values(g.players)) {
    p.mulliganBottom ??= 0;
    p.manaPool ??= emptyPool();
  }
  g.priority ??= g.stack.length > 0 ? { playerId: g.turn.activePlayerId, passed: [] } : null;
  return g;
}
