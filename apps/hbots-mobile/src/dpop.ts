import { p256 } from "@noble/curves/nist";
import { DpopPublicJwk, normalizeDpopHtu } from "@t3tools/shared/dpopCommon";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const KEY_STORAGE_ID = "hbots.dpop-key.v1";

export interface DpopKeyPair {
  readonly privateJwk: DpopPrivateJwk;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

interface DpopPrivateJwk extends DpopPublicJwk {
  readonly d: string;
}

export interface DpopProof {
  readonly proof: string;
  readonly thumbprint: string;
}

export class DpopError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "DpopError";
  }
}

let cached: DpopKeyPair | null = null;

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Encoding.encodeBase64Url(bytes);
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, copy.buffer);
  return new Uint8Array(digest);
}

async function thumbprintOf(publicJwk: DpopPublicJwk): Promise<string> {
  return bytesToBase64Url(
    await sha256(
      asciiBytes(
        JSON.stringify({
          crv: publicJwk.crv,
          kty: publicJwk.kty,
          x: publicJwk.x,
          y: publicJwk.y,
        }),
      ),
    ),
  );
}

function publicJwkFromPrivateKey(privateKey: Uint8Array): DpopPublicJwk {
  const publicKey = p256.getPublicKey(privateKey, false);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new DpopError("The generated phone key is not a P-256 point.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
  };
}

function decodeStoredKey(raw: string): DpopKeyPair {
  const parsed = JSON.parse(raw) as Partial<DpopPrivateJwk>;
  if (
    parsed.kty !== "EC" ||
    parsed.crv !== "P-256" ||
    typeof parsed.d !== "string" ||
    typeof parsed.x !== "string" ||
    typeof parsed.y !== "string"
  ) {
    throw new DpopError("The saved phone key is invalid.");
  }
  const privateKey = base64UrlToBytes(parsed.d);
  const publicJwk = publicJwkFromPrivateKey(privateKey);
  if (publicJwk.x !== parsed.x || publicJwk.y !== parsed.y) {
    throw new DpopError("The saved phone key does not match its public key.");
  }
  return { privateJwk: { ...publicJwk, d: parsed.d }, publicJwk, thumbprint: "" };
}

export async function loadOrCreateDpopKey(): Promise<DpopKeyPair> {
  if (cached !== null) {
    return cached;
  }
  const stored = await SecureStore.getItemAsync(KEY_STORAGE_ID);
  if (stored !== null) {
    const decoded = decodeStoredKey(stored);
    cached = { ...decoded, thumbprint: await thumbprintOf(decoded.publicJwk) };
    return cached;
  }
  let privateKey: Uint8Array;
  do {
    privateKey = ExpoCrypto.getRandomBytes(p256.CURVE.nByteLength);
  } while (!p256.utils.isValidPrivateKey(privateKey));
  const publicJwk = publicJwkFromPrivateKey(privateKey);
  const keyPair: DpopKeyPair = {
    privateJwk: { ...publicJwk, d: bytesToBase64Url(privateKey) },
    publicJwk,
    thumbprint: await thumbprintOf(publicJwk),
  };
  await SecureStore.setItemAsync(KEY_STORAGE_ID, JSON.stringify(keyPair.privateJwk));
  cached = keyPair;
  return keyPair;
}

export async function createDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}): Promise<DpopProof> {
  const keyPair = await loadOrCreateDpopKey();
  const htu = normalizeDpopHtu(input.url);
  if (htu === null) {
    throw new DpopError("The request address is invalid.");
  }
  const header = bytesToBase64Url(
    asciiBytes(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: keyPair.publicJwk })),
  );
  const payload = bytesToBase64Url(
    asciiBytes(
      JSON.stringify({
        htm: input.method.toUpperCase(),
        htu,
        jti: ExpoCrypto.randomUUID(),
        iat: Math.floor(Date.now() / 1_000),
        ...(input.accessToken === undefined
          ? {}
          : { ath: bytesToBase64Url(await sha256(asciiBytes(input.accessToken))) }),
      }),
    ),
  );
  const signatureInput = await sha256(asciiBytes(`${header}.${payload}`));
  const signature = p256.sign(signatureInput, base64UrlToBytes(keyPair.privateJwk.d), {
    prehash: false,
  });
  return {
    proof: `${header}.${payload}.${bytesToBase64Url(signature.toCompactRawBytes())}`,
    thumbprint: keyPair.thumbprint,
  };
}
