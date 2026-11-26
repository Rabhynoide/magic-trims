import { useEffect, type ReactNode } from "react";

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className={`modal ${props.wide ? "modal-wide" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{props.title}</h2>
          <button className="icon-button" onClick={props.onClose} aria-label="Fermer">
            ×
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
