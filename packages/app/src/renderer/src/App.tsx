import { Home } from "./screens/Home";
import { Lobby } from "./screens/Lobby";
import { Table } from "./screens/Table";
import { useSession } from "./session";

export function App() {
  const s = useSession();
  return (
    <>
      {s.screen === "home" && <Home />}
      {s.screen === "lobby" && <Lobby />}
      {s.screen === "game" && s.view && <Table />}
      <div className="toasts" role="status">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
