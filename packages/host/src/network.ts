import { networkInterfaces } from "node:os";

/** Adresses IPv4 de ce PC sur le réseau local (hors boucle locale). */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) result.push(info.address);
    }
  }
  // Les réseaux virtuels (Radmin VPN 26.x, Tailscale 100.x…) sont utiles à afficher aussi.
  return result;
}

/** Réseaux privés virtuels courants, pour aider l'hôte à choisir l'adresse à donner. */
export function describeAddress(ip: string): string {
  if (ip.startsWith("26.")) return "Radmin VPN";
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return "Tailscale";
  if (ip.startsWith("192.168.") || ip.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return "réseau local";
  }
  return "internet";
}
