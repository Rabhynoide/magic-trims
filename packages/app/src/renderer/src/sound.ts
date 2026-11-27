/**
 * Petit son joué quand ce joueur reçoit la priorité.
 *
 * Le son est synthétisé (Web Audio) : aucun fichier à embarquer. Il n'est
 * joué que sur ce PC, et seulement d'après la vue de la partie que tout le
 * monde voit déjà (qui a la priorité) : il ne révèle rien de la main.
 */

const KEY = "magic-trims.prioritySound";

export interface SoundPrefs {
  enabled: boolean;
  /** Volume de 0 à 1. */
  volume: number;
}

const DEFAULTS: SoundPrefs = { enabled: true, volume: 0.5 };

/** Intervalle minimal entre deux sons, pour les passages de priorité en rafale. */
export const MIN_INTERVAL_MS = 1500;

function load(): SoundPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<SoundPrefs>;
    return {
      enabled: typeof p.enabled === "boolean" ? p.enabled : DEFAULTS.enabled,
      volume: typeof p.volume === "number" ? Math.min(1, Math.max(0, p.volume)) : DEFAULTS.volume,
    };
  } catch {
    return DEFAULTS;
  }
}

class PrioritySound {
  prefs: SoundPrefs = load();
  private listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private lastPlayed = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getPrefs = () => this.prefs;

  setPrefs(patch: Partial<SoundPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.prefs));
    } catch {
      // Stockage indisponible : le réglage vaut pour cette session.
    }
    for (const l of this.listeners) l();
  }

  /** Joue le son, sauf s'il est coupé ou vient d'être joué. */
  notify(now = Date.now()): void {
    if (!this.prefs.enabled || this.prefs.volume <= 0) return;
    if (now - this.lastPlayed < MIN_INTERVAL_MS) return;
    this.lastPlayed = now;
    this.play();
  }

  /** Joue le son tout de suite (essai depuis le réglage). */
  play(volume = this.prefs.volume): void {
    try {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const start = ctx.currentTime + 0.01;
      // Deux notes brèves et douces (mi puis la), façon carillon.
      const notes: [number, number][] = [
        [659.25, 0],
        [880, 0.11],
      ];
      for (const [freq, offset] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const t = start + offset;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.35 * volume), t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
      }
    } catch {
      // Pas d'audio disponible : on reste silencieux.
    }
  }
}

export const prioritySound = new PrioritySound();
