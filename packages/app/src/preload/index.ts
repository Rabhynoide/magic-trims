import { contextBridge, ipcRenderer } from "electron";
import type { MagicApi } from "../shared/api.js";

const api: MagicApi = {
  startHost: (options) => ipcRenderer.invoke("host:start", options),
  stopHost: () => ipcRenderer.invoke("host:stop"),
  hasSavedGame: () => ipcRenderer.invoke("host:hasSavedGame"),
  importDeck: (text) => ipcRenderer.invoke("deck:import", text),
  searchCards: (query) => ipcRenderer.invoke("cards:search", query),
  localizeCards: (cards, lang) => ipcRenderer.invoke("cards:localize", cards, lang),
  central: {
    join: (url, code, name) => ipcRenderer.invoke("central:join", url, code, name),
    listDecks: (conn) => ipcRenderer.invoke("central:listDecks", conn),
    shareDeck: (conn, deck) => ipcRenderer.invoke("central:shareDeck", conn, deck),
    unshareDeck: (conn, id) => ipcRenderer.invoke("central:unshareDeck", conn, id),
  },
};

contextBridge.exposeInMainWorld("magic", api);
