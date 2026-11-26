/**
 * Structure du tour : phases et étapes (règles 500 à 514).
 *
 * Ce fichier ne contient que des données ; la logique (dégagement, pioche…)
 * est dans le réducteur.
 */

/** Les étapes du tour, dans l'ordre. Les phases principales comptent pour une étape. */
export const TURN_STEPS = [
  "untap",
  "upkeep",
  "draw",
  "main1",
  "beginCombat",
  "declareAttackers",
  "declareBlockers",
  "combatDamage",
  "endCombat",
  "main2",
  "end",
  "cleanup",
] as const;
export type TurnStep = (typeof TURN_STEPS)[number];

export interface TurnPhase {
  label: string;
  steps: TurnStep[];
}

/** Les cinq phases du tour et leurs étapes. */
export const TURN_PHASES: TurnPhase[] = [
  { label: "Début", steps: ["untap", "upkeep", "draw"] },
  { label: "Principale 1", steps: ["main1"] },
  { label: "Combat", steps: ["beginCombat", "declareAttackers", "declareBlockers", "combatDamage", "endCombat"] },
  { label: "Principale 2", steps: ["main2"] },
  { label: "Fin", steps: ["end", "cleanup"] },
];

/** Nom court de chaque étape, pour l'interface. */
export const STEP_LABELS: Record<TurnStep, string> = {
  untap: "Dégagement",
  upkeep: "Entretien",
  draw: "Pioche",
  main1: "Principale 1",
  beginCombat: "Début du combat",
  declareAttackers: "Attaquants",
  declareBlockers: "Bloqueurs",
  combatDamage: "Blessures",
  endCombat: "Fin du combat",
  main2: "Principale 2",
  end: "Fin de tour",
  cleanup: "Nettoyage",
};

/** Nom complet, pour le journal (« Alice passe à … »). */
export const STEP_PHRASES: Record<TurnStep, string> = {
  untap: "l'étape de dégagement",
  upkeep: "l'étape d'entretien",
  draw: "l'étape de pioche",
  main1: "la phase principale",
  beginCombat: "l'étape de début de combat",
  declareAttackers: "l'étape de déclaration des attaquants",
  declareBlockers: "l'étape de déclaration des bloqueurs",
  combatDamage: "l'étape des blessures de combat",
  endCombat: "l'étape de fin de combat",
  main2: "la seconde phase principale",
  end: "l'étape de fin",
  cleanup: "l'étape de nettoyage",
};

/** Nombre de cartes maximal en main à la fin du tour (règle 402.2). */
export const MAX_HAND_SIZE = 7;

export function stepIndex(step: TurnStep): number {
  return TURN_STEPS.indexOf(step);
}

export function isTurnStep(value: unknown): value is TurnStep {
  return typeof value === "string" && (TURN_STEPS as readonly string[]).includes(value);
}
