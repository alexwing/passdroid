import { describe, expect, it } from "vitest";
import type { SyncConfig } from "../api";
import { encodeQrPayload, parseQrPayload } from "./QrVaultModal";

const base: SyncConfig = {
  enabled: true,
  protocol: "ftps",
  host: "remote.example.invalid",
  port: 21,
  username: "user",
  password: "pw",
  remoteDir: "",
  remoteFile: "icaria.pdvault",
};

/** What a reader before v3.1.9 did with the payload (`||` defaults). */
function legacyParseDir(text: string): string {
  const json = JSON.parse(atob(text.replace("pdvault://", "")));
  return json.remoteDir || "vault";
}

describe("QR payload remoteDir", () => {
  it("an empty remoteDir (the FTP root) survives the round trip as the root", () => {
    const parsed = parseQrPayload(encodeQrPayload(base));
    expect(parsed?.remoteDir.replace(/\//g, "")).toBe("");
    expect(parsed?.remoteFile).toBe("icaria.pdvault");
  });

  it("an older reader also keeps the root (it gets '/', not 'vault')", () => {
    expect(legacyParseDir(encodeQrPayload(base))).toBe("/");
    expect(legacyParseDir(encodeQrPayload({ ...base, remoteDir: "  " }))).toBe("/");
  });

  it("a named directory is kept as is", () => {
    expect(parseQrPayload(encodeQrPayload({ ...base, remoteDir: "vault" }))?.remoteDir).toBe("vault");
    expect(parseQrPayload(encodeQrPayload({ ...base, remoteDir: "a/b" }))?.remoteDir).toBe("a/b");
  });

  it("an old payload without remoteDir still defaults to 'vault'", () => {
    const old = `pdvault://${btoa(JSON.stringify({ type: "passdroid-vault-link", host: "h" }))}`;
    expect(parseQrPayload(old)?.remoteDir).toBe("vault");
  });

  it("an old payload with an empty remoteDir is read as the root", () => {
    const old = `pdvault://${btoa(JSON.stringify({ type: "passdroid-vault-link", host: "h", remoteDir: "" }))}`;
    expect(parseQrPayload(old)?.remoteDir).toBe("");
  });
});
