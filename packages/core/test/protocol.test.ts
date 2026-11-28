import { describe, expect, it } from "vitest";
import { decodeJoinCode, DEFAULT_PORT, encodeJoinCode, formatAppVersion, sameAppVersion } from "../src/protocol.js";

describe("code de connexion", () => {
  it("encode et décode une adresse et un port", () => {
    for (const [ip, port] of [
      ["192.168.1.20", 47474],
      ["82.64.255.1", 1],
      ["0.0.0.1", 65535],
      ["255.255.255.255", 47474],
    ] as const) {
      const code = encodeJoinCode(ip, port);
      expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      expect(decodeJoinCode(code)).toEqual({ host: ip, port });
    }
  });

  it("tolère minuscules, espaces et lettres ambiguës", () => {
    const code = encodeJoinCode("10.0.0.1", 47474);
    const sloppy = code.toLowerCase().replace("-", " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(decodeJoinCode(sloppy)).toEqual({ host: "10.0.0.1", port: 47474 });
  });

  it("accepte une adresse tapée telle quelle", () => {
    expect(decodeJoinCode("192.168.1.20")).toEqual({ host: "192.168.1.20", port: DEFAULT_PORT });
    expect(decodeJoinCode(" 26.10.20.30:5000 ")).toEqual({ host: "26.10.20.30", port: 5000 });
    expect(decodeJoinCode("localhost:47474")).toEqual({ host: "localhost", port: 47474 });
  });

  it("refuse un code invalide", () => {
    expect(() => decodeJoinCode("ABC")).toThrow("Code de connexion invalide.");
    expect(() => encodeJoinCode("300.1.1.1", 1)).toThrow();
  });
});

describe("versions de l'appli", () => {
  it("compare le commit quand les deux le connaissent, sinon le numéro", () => {
    expect(sameAppVersion({ version: "0.1.0", commit: "abc" }, { version: "0.1.9", commit: "abc" })).toBe(true);
    expect(sameAppVersion({ version: "0.1.9", commit: "abc" }, { version: "0.1.9", commit: "def" })).toBe(false);
    expect(sameAppVersion({ version: "0.1.9", commit: "abc" }, { version: "0.1.9" })).toBe(true);
    expect(sameAppVersion({ version: "0.1.9" }, { version: "0.1.10" })).toBe(false);
  });

  it("affiche le commit en abrégé", () => {
    expect(formatAppVersion({ version: "0.1.9", commit: "3fa9c2e81b" })).toBe("0.1.9 (3fa9c2e)");
    expect(formatAppVersion({ version: "0.1.9" })).toBe("0.1.9");
  });
});
