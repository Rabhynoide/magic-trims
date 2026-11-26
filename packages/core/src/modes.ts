import type { GameModeType, GameSettings, GameState, PlayerId, PlayerState } from "./types.js";

/**
 * Modes de jeu compatibles Commander, jouables de 1 à 5 joueurs.
 *
 * Non retenus, faute de place à la table : Empereur (6 joueurs, 3 contre 3)
 * et Grande Mêlée (10 joueurs et plus).
 * Planechase est une variante qui se combine avec n'importe quel mode.
 */
export interface GameModeInfo {
  type: GameModeType;
  label: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  /** Réglages propres au mode, appliqués avant ceux choisis par l'hôte. */
  defaults: Partial<GameSettings>;
}

export const GAME_MODES: Record<GameModeType, GameModeInfo> = {
  freeForAll: {
    type: "freeForAll",
    label: "Chacun pour soi",
    description: "Tous contre tous, le dernier joueur en lice gagne.",
    minPlayers: 1,
    maxPlayers: 5,
    defaults: {},
  },
  duel: {
    type: "duel",
    label: "Duel",
    description: "Un contre un. 20 points de vie comme en Duel Commander (réglable).",
    minPlayers: 2,
    maxPlayers: 2,
    defaults: { startingLife: 20 },
  },
  teams: {
    type: "teams",
    label: "Équipes",
    description:
      "Deux équipes ou plus (2 contre 2, 2 contre 3…). Chacun garde ses points de vie et son tour ; les équipes alternent autour de la table. La dernière équipe en lice gagne.",
    minPlayers: 4,
    maxPlayers: 5,
    defaults: {},
  },
  twoHeadedGiant: {
    type: "twoHeadedGiant",
    label: "Géant à deux têtes",
    description:
      "Deux équipes de deux. Les coéquipiers jouent leur tour ensemble, partagent leurs points de vie (60), leur poison (15) et les blessures de commandant, et voient la main l'un de l'autre.",
    minPlayers: 4,
    maxPlayers: 4,
    defaults: {
      startingLife: 60,
      poisonLimit: 15,
      sharedTeamLife: true,
      sharedTurns: true,
      teammatesSeeHands: true,
    },
  },
  star: {
    type: "star",
    label: "Étoile (Pentacle)",
    description:
      "Cinq joueurs. Tes deux ennemis sont les joueurs qui ne sont pas assis à côté de toi ; tu gagnes dès qu'ils sont tous les deux éliminés.",
    minPlayers: 5,
    maxPlayers: 5,
    defaults: {},
  },
  archenemy: {
    type: "archenemy",
    label: "Archenemy",
    description:
      "Un joueur seul contre tous, avec une pioche de machinations. Il joue en premier ; ses adversaires jouent leur tour ensemble. Points de vie de l'archenemy réglables (80 par défaut).",
    minPlayers: 3,
    maxPlayers: 5,
    defaults: { sharedTurns: true },
  },
};

export function teamOf(g: GameState, playerId: PlayerId): PlayerId[] {
  return g.teams.find((t) => t.includes(playerId)) ?? [playerId];
}

export function areTeammates(g: GameState, a: PlayerId, b: PlayerId): boolean {
  return teamOf(g, a).includes(b);
}

/** Joueurs dont les points de vie bougent ensemble avec ceux de `playerId`. */
export function lifeSharers(g: GameState, playerId: PlayerId): PlayerState[] {
  const ids = g.settings.sharedTeamLife ? teamOf(g, playerId) : [playerId];
  return ids.map((id) => g.players[id]!);
}

/** Le joueur joue-t-il en ce moment (seul ou avec son équipe) ? */
export function isActivePlayer(g: GameState, playerId: PlayerId): boolean {
  if (g.turn.activePlayerId === playerId) return true;
  return g.settings.sharedTurns && areTeammates(g, g.turn.activePlayerId, playerId);
}

/** En mode Étoile : les deux joueurs non adjacents. */
export function starEnemies(g: GameState, playerId: PlayerId): PlayerId[] {
  const n = g.turnOrder.length;
  const i = g.turnOrder.indexOf(playerId);
  return [g.turnOrder[(i + 2) % n]!, g.turnOrder[(i + 3) % n]!];
}

export interface Outcome {
  /** Joueurs éliminés, avec la raison. */
  eliminated: Record<PlayerId, string>;
  /** Vainqueurs, ou `null` si la partie continue. */
  winners: PlayerId[] | null;
}

/**
 * Qui est éliminé et qui a gagné, d'après les points de vie, le poison, les
 * blessures de commandant et les abandons. En table virtuelle, c'est une
 * indication : les joueurs restent maîtres de la partie.
 */
export function evaluateOutcome(g: GameState): Outcome {
  const eliminated: Record<PlayerId, string> = {};
  for (const id of g.turnOrder) {
    const reason = eliminationReason(g, g.players[id]!);
    if (reason) eliminated[id] = reason;
  }
  const alive = (id: PlayerId) => !(id in eliminated);

  let winners: PlayerId[] | null = null;
  if (g.settings.mode === "star") {
    const winner = g.turnOrder.find((id) => alive(id) && starEnemies(g, id).every((e) => !alive(e)));
    if (winner) winners = [winner];
  } else {
    const teamsAlive = g.teams.filter((team) => team.some(alive));
    if (teamsAlive.length === 1 && g.turnOrder.length > 1) winners = teamsAlive[0]!;
  }
  if (winners === null && g.turnOrder.length > 1 && g.turnOrder.every((id) => !alive(id))) winners = [];
  return { eliminated, winners };
}

export function eliminationReason(g: GameState, p: PlayerState): string | null {
  if (p.lostReason) return p.lostReason;
  if (p.hasConceded) return "abandon";
  if (p.life <= 0) return "points de vie";
  if (p.poison >= g.settings.poisonLimit) return "poison";
  if (Object.values(p.commanderDamage).some((d) => d >= g.settings.commanderDamageLimit)) {
    return "blessures de commandant";
  }
  if (p.drewFromEmpty) return "bibliothèque vide";
  return null;
}
