import { useEffect, useRef, useState } from "react";
import { ui, useUi, type MenuItem } from "../ui-store";
import { Modal } from "./Modal";

/** Menu contextuel et invites de saisie, affichés au-dessus de la table. */
export function Overlays() {
  const { menu, prompt } = useUi();
  return (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} />}
      {prompt && <Prompt key={prompt.title} />}
    </>
  );
}

function ContextMenu(props: { x: number; y: number; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({
        left: Math.min(props.x, window.innerWidth - r.width - 8),
        top: Math.min(props.y, window.innerHeight - r.height - 8),
      });
    }
    const close = () => ui.closeMenu();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [props.x, props.y]);
  return (
    <div className="context-menu" ref={ref} style={pos} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {props.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu-separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              ui.closeMenu();
              item.onClick?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

function Prompt() {
  const { prompt } = useUi();
  const [value, setValue] = useState(prompt?.initial ?? "");
  if (!prompt) return null;
  return (
    <Modal title={prompt.title} onClose={() => ui.closePrompt(null)}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          ui.closePrompt(value);
        }}
      >
        <input
          autoFocus
          type={prompt.kind === "number" ? "number" : "text"}
          min={prompt.kind === "number" ? 1 : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
        <button className="primary" type="submit">
          OK
        </button>
      </form>
    </Modal>
  );
}
