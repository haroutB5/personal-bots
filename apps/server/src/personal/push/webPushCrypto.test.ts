import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import {
  base64UrlDecode,
  base64UrlEncode,
  createVapidJwt,
  encryptWebPushPayload,
  generateVapidKeyPair,
  isAllowedPushEndpoint,
} from "./webPushCrypto.ts";

const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  new Uint8Array(NodeCrypto.hkdfSync("sha256", ikm, salt, info, length));

/** The user agent's side of RFC 8291, independent of the sender code. */
function decrypt(body: Uint8Array, uaPrivateKey: Uint8Array, authSecret: Uint8Array): string {
  const ua = NodeCrypto.createECDH("prime256v1");
  ua.setPrivateKey(Buffer.from(uaPrivateKey));
  const uaPublic = new Uint8Array(ua.getPublicKey());
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const secret = new Uint8Array(ua.computeSecret(Buffer.from(senderPublic)));
  const info = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, senderPublic]);
  const ikm = hkdf(authSecret, secret, new Uint8Array(info), 32);
  const key = hkdf(salt, ikm, new Uint8Array(Buffer.from("Content-Encoding: aes128gcm\0")), 16);
  const nonce = hkdf(salt, ikm, new Uint8Array(Buffer.from("Content-Encoding: nonce\0")), 12);
  const decipher = NodeCrypto.createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(ciphertext.slice(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.slice(0, -16)), decipher.final()]);
  expect(padded.at(-1)).toBe(0x02);
  return padded.subarray(0, -1).toString("utf8");
}

describe("RFC 8291 aes128gcm", () => {
  it("reproduces the RFC 8291 Appendix A message", () => {
    const body = encryptWebPushPayload({
      plaintext: new Uint8Array(Buffer.from("When I grow up, I want to be a watermelon")),
      userAgentPublicKey: base64UrlDecode(
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      ),
      authSecret: base64UrlDecode("BTBZMqHH6r4Tts7J_aSIgg"),
      senderPrivateKey: base64UrlDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      salt: base64UrlDecode("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    expect(base64UrlEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips with a fresh sender key and salt", () => {
    const ua = NodeCrypto.createECDH("prime256v1");
    ua.generateKeys();
    const authSecret = new Uint8Array(NodeCrypto.randomBytes(16));
    const payload = JSON.stringify({
      title: "Planner finished",
      body: "Weekly review",
      url: "/tasks/x",
    });
    const body = encryptWebPushPayload({
      plaintext: new Uint8Array(Buffer.from(payload)),
      userAgentPublicKey: new Uint8Array(ua.getPublicKey()),
      authSecret,
    });
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
    expect(decrypt(body, new Uint8Array(ua.getPrivateKey()), authSecret)).toBe(payload);
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT that verifies with the advertised public key", () => {
    const keys = generateVapidKeyPair();
    expect(keys.publicKey.length).toBe(65);
    const jwt = createVapidJwt({
      audience: "https://web.push.apple.com",
      subject: "mailto:someone@example.com",
      expiresAtSeconds: 1_900_000_000,
      privateJwk: keys.privateJwk,
    });
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      aud: "https://web.push.apple.com",
      exp: 1_900_000_000,
      sub: "mailto:someone@example.com",
    });
    const publicKey = NodeCrypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(keys.publicKey.slice(1, 33)),
        y: base64UrlEncode(keys.publicKey.slice(33)),
      },
      format: "jwk",
    });
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });
});

describe("push endpoint allowlist", () => {
  it.each([
    "https://web.push.apple.com/QGuk8",
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://evil.example.com/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/x",
    "https://user:pass@fcm.googleapis.com/x",
    "https://127.0.0.1/push",
    "not a url",
  ])("rejects %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});
