import { useSyncExternalStore } from "react";
import { CARD_LANGUAGES } from "@magic-trims/core";
import { localizer } from "../localization";

/** Choix de la langue des cartes, propre à ce joueur. */
export function CardLanguageSelect(props: { label?: string }) {
  const lang = useSyncExternalStore(localizer.subscribe, () => localizer.lang);
  return (
    <label className="inline card-lang" title="Les cartes jamais imprimées dans cette langue restent en anglais.">
      {props.label ?? "Cartes"}
      <select value={lang} onChange={(e) => localizer.setLang(e.target.value)}>
        {CARD_LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
