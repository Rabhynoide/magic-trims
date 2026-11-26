import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { CardCache, CardData } from "@magic-trims/core";

/**
 * Cache Scryfall sur disque : une carte déjà vue n'est plus redemandée,
 * ce qui accélère les imports et permet de rejouer un deck hors ligne.
 */
export class FileCache<T> {
  private map: Map<string, T> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Map<string, T>> {
    if (this.map) return this.map;
    try {
      this.map = new Map(Object.entries(JSON.parse(await readFile(this.path, "utf8")) as Record<string, T>));
    } catch {
      this.map = new Map();
    }
    return this.map;
  }

  async get(key: string) {
    return (await this.load()).get(key);
  }

  async set(key: string, value: T) {
    (await this.load()).set(key, value);
    this.timer ??= setTimeout(() => void this.flush(), 1000);
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.map) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.map)));
    await rename(tmp, this.path);
  }
}

export class FileCardCache extends FileCache<CardData> implements CardCache {}
