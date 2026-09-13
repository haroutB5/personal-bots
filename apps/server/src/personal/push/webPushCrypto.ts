import * as NodeCrypto from "node:crypto";

/**
 * Web Push with node:crypto only: RFC 8291 message encryption (aes128gcm,
 * RFC 8188 framing, one record) and RFC 8292 VAPID (ES256 JWT).
 */

export const base64UrlEncode = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

export const base64UrlDecode = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value.replace(/=+$/, ""), "base64url"));

export interface VapidKeyPair {
  /** Uncompressed P-256 point (65 bytes), the browser's applicationServerKey. */
  readonly publicKey: Uint8Array;
  readonly privateJwk: NodeCrypto.JsonWebKey;
}

export function generateVapidKeyPair(): VapidKeyPair {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return vapidKeyPairFromJwk(privateKey.export({ format: "jwk" }));
}

export function vapidKeyPairFromJwk(privateJwk: NodeCrypto.JsonWebKey): VapidKeyPair {
  if (privateJwk.x === undefined || privateJwk.y === undefined || privateJwk.d === undefined) {
    throw new Error("VAPID key is not a private P-256 JWK.");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(base64UrlDecode(privateJwk.x), 1);
  publicKey.set(base64UrlDecode(privateJwk.y), 33);
  return { publicKey, privateJwk };
}

/** ES256 VAPID JWT for one push service origin. */
export function createVapidJwt(input: {
  readonly audience: string;
  readonly subject: string;
  readonly expiresAtSeconds: number;
  readonly privateJwk: NodeCrypto.JsonWebKey;
}): string {
  const encode = (value: object) => base64UrlEncode(Buffer.from(JSON.stringify(value)));
  const signingInput = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: input.audience,
    exp: input.expiresAtSeconds,
    sub: input.subject,
  })}`;
  const key = NodeCrypto.createPrivateKey({ key: input.privateJwk, format: "jwk" });
  // JOSE wants the raw r||s signature, not DER.
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  new Uint8Array(NodeCrypto.hkdfSync("sha256", ikm, salt, info, length));

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const ascii = (value: string) => new Uint8Array(Buffer.from(value, "latin1"));

const RECORD_SIZE = 4096;

/**
 * RFC 8291 section 3.4 + RFC 8188: returns the full request body
 * (salt | rs | idlen | keyid | ciphertext). `senderPrivateKey` and `salt` are
 * injectable for the RFC test vector; production draws both at random.
 */
export function encryptWebPushPayload(input: {
  readonly plaintext: Uint8Array;
  /** Subscription `keys.p256dh`: the user agent's public key. */
  readonly userAgentPublicKey: Uint8Array;
  /** Subscription `keys.auth`. */
  readonly authSecret: Uint8Array;
  readonly senderPrivateKey?: Uint8Array;
  readonly salt?: Uint8Array;
}): Uint8Array {
  if (input.userAgentPublicKey.length !== 65 || input.userAgentPublicKey[0] !== 0x04) {
    throw new Error("The subscription public key is not an uncompressed P-256 point.");
  }
  if (input.authSecret.length !== 16) {
    throw new Error("The subscription auth secret must be 16 bytes.");
  }
  const ecdh = NodeCrypto.createECDH("prime256v1");
  if (input.senderPrivateKey === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(Buffer.from(input.senderPrivateKey));
  }
  const senderPublicKey = new Uint8Array(ecdh.getPublicKey());
  const sharedSecret = new Uint8Array(ecdh.computeSecret(Buffer.from(input.userAgentPublicKey)));
  const salt = input.salt ?? new Uint8Array(NodeCrypto.randomBytes(16));

  const keyInfo = concat(ascii("WebPush: info\0"), input.userAgentPublicKey, senderPublicKey);
  const ikm = hkdf(input.authSecret, sharedSecret, keyInfo, 32);
  const contentKey = hkdf(salt, ikm, ascii("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, ascii("Content-Encoding: nonce\0"), 12);

  // One record: the plaintext plus the 0x02 last-record delimiter, no padding.
  if (input.plaintext.length + 1 + 16 > RECORD_SIZE) {
    throw new Error("Push payload is too large for one record.");
  }
  const cipher = NodeCrypto.createCipheriv("aes-128-gcm", contentKey, nonce);
  const ciphertext = concat(
    new Uint8Array(cipher.update(concat(input.plaintext, new Uint8Array([0x02])))),
    new Uint8Array(cipher.final()),
    new Uint8Array(cipher.getAuthTag()),
  );

  const header = new Uint8Array(16 + 4 + 1 + senderPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublicKey.length;
  header.set(senderPublicKey, 21);
  return concat(header, ciphertext);
}

export interface WebPushRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export function buildWebPushRequest(input: {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly payload: string;
  readonly vapid: VapidKeyPair;
  readonly subject: string;
  readonly nowSeconds: number;
  readonly ttlSeconds: number;
  readonly topic?: string;
}): WebPushRequest {
  const body = encryptWebPushPayload({
    plaintext: new Uint8Array(Buffer.from(input.payload, "utf8")),
    userAgentPublicKey: base64UrlDecode(input.p256dh),
    authSecret: base64UrlDecode(input.auth),
  });
  const jwt = createVapidJwt({
    audience: new URL(input.endpoint).origin,
    subject: input.subject,
    // Push services reject tokens valid for more than 24 hours.
    expiresAtSeconds: input.nowSeconds + 12 * 60 * 60,
    privateJwk: input.vapid.privateJwk,
  });
  return {
    url: input.endpoint,
    headers: {
      Authorization: `vapid t=${jwt}, k=${base64UrlEncode(input.vapid.publicKey)}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(input.ttlSeconds),
      Urgency: "normal",
      ...(input.topic === undefined ? {} : { Topic: input.topic }),
    },
    body,
  };
}

const PUSH_SERVICE_HOSTS = [
  "push.apple.com",
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
] as const;

/**
 * Only known browser push services are accepted as endpoints, so a
 * subscription can never make the server POST to an arbitrary URL.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
