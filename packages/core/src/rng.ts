/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 * L'état tient dans un entier stocké dans la partie : une partie rejouée
 * avec les mêmes actions donne exactement les mêmes mélanges.
 */
export function nextRandom(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: next };
}

/** Mélange de Fisher-Yates. Retourne le nouvel état du générateur. */
export function shuffleInPlace<T>(items: T[], rngState: number): number {
  let state = rngState;
  for (let i = items.length - 1; i > 0; i--) {
    const r = nextRandom(state);
    state = r.state;
    const j = Math.floor(r.value * (i + 1));
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return state;
}

/** Graine aléatoire pour une nouvelle partie. */
export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
