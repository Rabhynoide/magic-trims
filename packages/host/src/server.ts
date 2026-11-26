import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DEFAULT_PORT, encodeJoinCode } from "@magic-trims/core";
import { WebSocketServer, type WebSocket } from "ws";
import { GameHost, type HostSnapshot } from "./game-host.js";
import { describeAddress, lanAddresses } from "./network.js";
import { debouncedSaver } from "./persistence.js";
import { openPort, type PortMapping } from "./upnp.js";

export interface HostServerOptions {
  /** Port d'écoute (47474 par défaut ; 0 = n'importe quel port libre). */
  port?: number;
  /** Fichier de sauvegarde automatique de la partie. */
  savePath?: string;
  /** Partie à reprendre. */
  restore?: HostSnapshot;
  /** Tenter d'ouvrir le port de la box (vrai par défaut). */
  upnp?: boolean;
  /** Graine des mélanges (tests). */
  seed?: number;
}

export interface JoinAddress {
  ip: string;
  /** « réseau local », « Radmin VPN », « Tailscale », « internet ». */
  kind: string;
  code: string;
}

export interface HostServer {
  host: GameHost;
  port: number;
  /** Clé à donner au client de l'appli qui héberge, pour qu'il soit reconnu comme hôte. */
  hostKey: string;
  /** Adresses (et codes) à donner aux amis, de la plus utile à la moins utile. */
  addresses: JoinAddress[];
  upnp: { ok: true; publicIp: string } | { ok: false; reason: string } | { ok: false; reason: "désactivé" };
  close(): Promise<void>;
}

/** Messages plus gros refusés (un deck de 100 cartes pèse environ 200 Ko). */
const MAX_PAYLOAD = 8 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

/**
 * Lance le serveur de partie dans l'appli de l'hôte. Les autres joueurs
 * s'y connectent en WebSocket avec l'adresse ou le code affiché.
 */
export async function startHostServer(options: HostServerOptions = {}): Promise<HostServer> {
  const saver = options.savePath ? debouncedSaver(options.savePath) : null;
  const hostKey = options.restore?.hostKey ?? randomBytes(16).toString("hex");
  const hostOptions = {
    hostKey,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(saver ? { onChange: (s: HostSnapshot) => saver.save(s) } : {}),
  };
  const host = options.restore ? GameHost.restore(options.restore, hostOptions) : new GameHost(hostOptions);

  const http: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Magic Trims : serveur de partie.\n");
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (socket) => {
    const connId = randomUUID();
    alive.set(socket, true);
    host.connect(connId, (msg) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(msg));
      if (msg.type === "error" && msg.fatal) socket.close(4000, "fatal");
    });
    socket.on("pong", () => alive.set(socket, true));
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      host.receive(connId, parsed);
    });
    socket.on("close", () => host.disconnect(connId));
    socket.on("error", () => socket.terminate());
  });

  // Détecte les connexions mortes (PC en veille, Wi-Fi coupé…).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  const port = await new Promise<number>((resolve, reject) => {
    http.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Le port ${options.port ?? DEFAULT_PORT} est déjà utilisé. Une autre partie est peut-être ouverte.`)
          : err,
      );
    });
    http.listen(options.port ?? DEFAULT_PORT, () => {
      const address = http.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  let mapping: PortMapping | null = null;
  let upnp: HostServer["upnp"] = { ok: false, reason: "désactivé" };
  if (options.upnp ?? true) {
    const result = await openPort(port);
    if (result.ok) {
      mapping = result.mapping;
      upnp = { ok: true, publicIp: result.mapping.publicIp };
    } else {
      upnp = { ok: false, reason: result.reason };
    }
  }

  const ips = [...(upnp.ok ? [upnp.publicIp] : []), ...lanAddresses()];
  const order = ["internet", "Radmin VPN", "Tailscale", "réseau local"];
  const addresses = ips
    .map((ip) => ({ ip, kind: describeAddress(ip), code: encodeJoinCode(ip, port) }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  return {
    host,
    port,
    hostKey,
    addresses,
    upnp,
    async close() {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.close(1001, "Fin de la partie");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await saver?.flush();
      await mapping?.close().catch(() => {});
    },
  };
}
