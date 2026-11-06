import { p256 } from "@noble/curves/nist";
import * as NodeCrypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    storage.set(key, value);
  },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
  digest: async (_algorithm: string, data: ArrayBuffer) => {
    const digest = NodeCrypto.createHash("sha256").update(Buffer.from(data)).digest();
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
  },
}));

import { createDpopProof, loadOrCreateDpopKey } from "./dpop";

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  storage.clear();
});

describe("loadOrCreateDpopKey", () => {
  it("stores a private key that rebuilds the same public point", async () => {
    const keyPair = await loadOrCreateDpopKey();
    const privateKey = Buffer.from(keyPair.privateJwk.d, "base64url");
    const publicKey = p256.getPublicKey(privateKey, false);
    expect(publicKey.length).toBe(65);
    expect(Buffer.from(publicKey.slice(1, 33)).toString("base64url")).toBe(keyPair.publicJwk.x);
    expect(Buffer.from(publicKey.slice(33, 65)).toString("base64url")).toBe(keyPair.publicJwk.y);
  });
});

describe("createDpopProof", () => {
  it("signs an ES256 proof whose public jwk verifies and whose htu drops the query", async () => {
    const { proof } = await createDpopProof({
      method: "post",
      url: "https://relay.example.test/oauth/token?x=1#fragment",
    });
    const [header, payload, signature] = proof.split(".");
    const decodedHeader = decodePart(header!) as {
      typ: string;
      alg: string;
      jwk: { kty: string; crv: string; x: string; y: string };
    };
    const decodedPayload = decodePart(payload!) as {
      htm: string;
      htu: string;
      jti: string;
      iat: number;
    };

    expect(decodedHeader).toMatchObject({ typ: "dpop+jwt", alg: "ES256" });
    expect(decodedHeader.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(decodedPayload.htm).toBe("POST");
    expect(decodedPayload.htu).toBe("https://relay.example.test/oauth/token");
    expect(decodedPayload.jti).toBe("00000000-0000-4000-8000-000000000001");
    const signatureBytes = new Uint8Array(Buffer.from(signature!, "base64url"));
    const publicKey = new Uint8Array(
      Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(decodedHeader.jwk.x, "base64url"),
        Buffer.from(decodedHeader.jwk.y, "base64url"),
      ]),
    );
    const hash = NodeCrypto.createHash("sha256").update(`${header}.${payload}`).digest();

    expect(
      p256.verify(signatureBytes, hash, publicKey, { prehash: false, format: "compact" }),
    ).toBe(true);
  });

  it("binds a renewal proof to the access token with ath", async () => {
    const { proof } = await createDpopProof({
      method: "POST",
      url: "https://relay.example.test/api/auth/session/renew",
      accessToken: "access-token",
    });
    const payload = decodePart(proof.split(".")[1]!) as { ath: string };
    expect(payload.ath).toBe(
      NodeCrypto.createHash("sha256").update("access-token").digest("base64url"),
    );
  });
});
