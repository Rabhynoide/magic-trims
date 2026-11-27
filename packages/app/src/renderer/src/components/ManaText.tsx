import { manaSymbolUrl } from "../cards";

/**
 * Texte avec les symboles de coût ({B}, {2}, {T}, {B/P}…) remplacés par les
 * icônes de Scryfall, comme sur les cartes.
 */
export function ManaText(props: { text: string }) {
  const parts = props.text.split(/(\{[^}]+\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\{([^}]+)\}$/.exec(part);
        if (!m) return part;
        const symbol = m[1]!.toUpperCase().replace(/\//g, "");
        // Pas de « / » dans les noms de fichiers de Scryfall : {B/P} → BP.svg, {2/W} → 2W.svg.
        return <img key={i} className="mana-symbol" src={manaSymbolUrl(encodeURIComponent(symbol))} alt={part} title={part} />;
      })}
    </>
  );
}
