import { useSyncExternalStore } from "react";
import { prioritySound } from "../sound";

/** Réglage du son joué quand on reçoit la priorité (propre à ce PC). */
export function SoundSettings() {
  const prefs = useSyncExternalStore(prioritySound.subscribe, prioritySound.getPrefs);
  return (
    <span className="inline sound-settings" title="Son joué quand tu reçois la priorité (entendu par toi seul)">
      <label className="inline">
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => {
            prioritySound.setPrefs({ enabled: e.target.checked });
            if (e.target.checked) prioritySound.play();
          }}
        />
        Son priorité
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={prefs.volume}
        disabled={!prefs.enabled}
        aria-label="Volume du son de priorité"
        onChange={(e) => prioritySound.setPrefs({ volume: Number(e.target.value) })}
        onPointerUp={() => prioritySound.play()}
        onKeyUp={() => prioritySound.play()}
      />
    </span>
  );
}
