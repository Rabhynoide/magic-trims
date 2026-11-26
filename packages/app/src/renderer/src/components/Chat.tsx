import { useEffect, useRef, useState } from "react";
import { session, useSession } from "../session";

export function Chat() {
  const { chat } = useSession();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [chat.length]);
  return (
    <div className="chat">
      <div className="chat-lines">
        {chat.map((c, i) => (
          <div key={i} className="chat-line">
            <strong>{c.fromName}</strong> {c.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          session.client?.chat(text);
          setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" maxLength={500} />
      </form>
    </div>
  );
}
