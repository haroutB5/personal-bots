import { p256 } from "@noble/curves/nist";
import { normalizeDpopHtu } from "@t3tools/shared/dpopCommon";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

export interface DpopPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface DpopKeyPair {
  readonly privateKey: Uint8Array;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

const KEY_STORAGE_ID = "hbots.spike.dpop.key.v1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function publicJwkFromKey(publicKey: Uint8Array): DpopPublicJwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("DPoP public key is not an uncompressed P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
  };
}

async function sha256Base64Url(data: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    data as unknown as ArrayBuffer,
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function thumbprintFor(jwk: DpopPublicJwk): Promise<string> {
  const input = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return sha256Base64Url(new TextEncoder().encode(input));
}

export async function generateDpopKeyPair(): Promise<DpopKeyPair> {
  let privateKey: Uint8Array;
  do {
    privateKey = Crypto.getRandomBytes(p256.CURVE.nByteLength);
  } while (!p256.utils.isValidPrivateKey(privateKey));
  const publicJwk = publicJwkFromKey(p256.getPublicKey(privateKey, false));
  return {
    privateKey,
    publicJwk,
    thumbprint: await thumbprintFor(publicJwk),
  };
}

interface StoredKey {
  readonly d: string;
  readonly publicJwk: DpopPublicJwk;
}

export async function loadOrCreateDpopKeyPair(): Promise<DpopKeyPair> {
  const stored = await SecureStore.getItemAsync(KEY_STORAGE_ID);
  if (stored !== null) {
    const parsed = JSON.parse(stored) as StoredKey;
    const privateKey = base64UrlDecode(parsed.d);
    const publicJwk = publicJwkFromKey(p256.getPublicKey(privateKey, false));
    return { privateKey, publicJwk, thumbprint: await thumbprintFor(publicJwk) };
  }
  const generated = await generateDpopKeyPair();
  const payload: StoredKey = {
    d: base64UrlEncode(generated.privateKey),
    publicJwk: generated.publicJwk,
  };
  await SecureStore.setItemAsync(KEY_STORAGE_ID, JSON.stringify(payload));
  return generated;
}

export async function createDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly key: DpopKeyPair;
  readonly accessToken?: string;
}): Promise<string> {
  const htu = normalizeDpopHtu(input.url);
  if (htu === null) {
    throw new Error("DPoP URL is invalid.");
  }
  const header = encodeJson({ typ: "dpop+jwt", alg: "ES256", jwk: input.key.publicJwk });
  const payload: Record<string, string | number> = {
    htm: input.method.toUpperCase(),
    htu,
    jti: Crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  };
  if (input.accessToken !== undefined) {
    payload.ath = await sha256Base64Url(new TextEncoder().encode(input.accessToken));
  }
  const encodedPayload = encodeJson(payload);
  const input_ = new TextEncoder().encode(`${header}.${encodedPayload}`);
  const hash = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    input_ as unknown as ArrayBuffer,
  );
  const signature = p256
    .sign(new Uint8Array(hash), input.key.privateKey, {
      prehash: false,
    })
    .toCompactRawBytes();
  return `${header}.${encodedPayload}.${base64UrlEncode(signature)}`;
}
