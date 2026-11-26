import { Client } from "@runonflux/nat-upnp";

export interface PortMapping {
  /** Adresse publique de la box, à donner aux amis. */
  publicIp: string;
  port: number;
  /** Ferme le port quand la partie se termine. */
  close(): Promise<void>;
}

/**
 * Demande à la box d'ouvrir le port (UPnP). Beaucoup de box le permettent,
 * mais pas toutes : en cas d'échec, on retourne la raison et la partie reste
 * jouable via un réseau privé virtuel (Radmin VPN, Tailscale) ou en réseau local.
 */
export async function openPort(
  port: number,
  options: { timeoutMs?: number; description?: string } = {},
): Promise<{ ok: true; mapping: PortMapping } | { ok: false; reason: string }> {
  const client = new Client({ timeout: options.timeoutMs ?? 5000, cacheGateway: true });
  try {
    await client.createMapping({
      public: port,
      private: port,
      protocol: "TCP",
      description: options.description ?? "Magic Trims",
      // Bail de 6 heures : le port se referme tout seul si l'appli plante.
      ttl: 6 * 3600,
    });
    const publicIp = await client.getPublicIp();
    return {
      ok: true,
      mapping: {
        publicIp,
        port,
        async close() {
          try {
            await client.removeMapping({ public: port, protocol: "TCP" });
          } finally {
            client.close();
          }
        },
      },
    };
  } catch (err) {
    client.close();
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
