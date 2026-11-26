import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostSnapshot } from "./game-host.js";

/** Écrit la sauvegarde de façon atomique (fichier temporaire puis renommage). */
export async function saveSnapshot(path: string, snapshot: HostSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot), "utf8");
  await rename(tmp, path);
}

export async function loadSnapshot(path: string): Promise<HostSnapshot> {
  const snapshot = JSON.parse(await readFile(path, "utf8")) as HostSnapshot;
  if (snapshot.format !== 1) throw new Error("Sauvegarde dans un format inconnu.");
  return snapshot;
}

/**
 * Regroupe les sauvegardes rapprochées : au plus une écriture toutes les
 * `delayMs`, et toujours la plus récente.
 */
export function debouncedSaver(path: string, delayMs = 500) {
  let pending: HostSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const snapshot = pending;
    pending = null;
    if (snapshot) writing = writing.then(() => saveSnapshot(path, snapshot)).catch(() => {});
    await writing;
  };

  return {
    save(snapshot: HostSnapshot) {
      pending = snapshot;
      timer ??= setTimeout(() => void flush(), delayMs);
    },
    flush,
  };
}
