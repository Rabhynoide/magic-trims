import { contextBridge, ipcRenderer } from "electron";
import type { MagicApi } from "../shared/api.js";

const api: MagicApi = {
  startHost: (options) => ipcRenderer.invoke("host:start", options),
  stopHost: () => ipcRenderer.invoke("host:stop"),
  hasSavedGame: () => ipcRenderer.invoke("host:hasSavedGame"),
  importDeck: (text) => ipcRenderer.invoke("deck:import", text),
  searchCards: (query) => ipcRenderer.invoke("cards:search", query),
};

contextBridge.exposeInMainWorld("magic", api);
