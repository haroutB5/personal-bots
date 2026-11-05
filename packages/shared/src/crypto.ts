/**
 * The platform crypto service the personal layer was built on.
 *
 * Effect 4.0 shipped this interface as `effect/Crypto`; Effect 4.1 removed it
 * in favour of the separate `effect/crypto/*` services. The personal code and
 * the upstream files this fork still carries consume the old shape, so the
 * interface lives here with an identical contract until phase 3 replaces the
 * upstream consumers. The default implementation runs on WebCrypto, available
 * on Node 26, in the browser and in Expo.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

const TypeId = "~effect/Crypto";

/** Digest algorithms supported by the platform crypto service. */
export type DigestAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

/** Platform-agnostic cryptographic operations. */
export interface Crypto {
  readonly [TypeId]: typeof TypeId;
  nextIntUnsafe(): number;
  nextDoubleUnsafe(): number;
  randomBytes(size: number): Effect.Effect<Uint8Array, PlatformError.PlatformError>;
  digest(
    algorithm: DigestAlgorithm,
    data: Uint8Array,
  ): Effect.Effect<Uint8Array, PlatformError.PlatformError>;
  readonly random: Effect.Effect<number>;
  readonly randomBoolean: Effect.Effect<boolean>;
  readonly randomInt: Effect.Effect<number>;
  randomBetween(min: number, max: number): Effect.Effect<number>;
  randomIntBetween(
    min: number,
    max: number,
    options?: { readonly halfOpen?: boolean | undefined },
  ): Effect.Effect<number>;
  randomShuffle<A>(elements: Iterable<A>): Effect.Effect<Array<A>>;
  readonly randomUUIDv4: Effect.Effect<string, PlatformError.PlatformError>;
  readonly randomUUIDv7: Effect.Effect<string, PlatformError.PlatformError>;
}

const formatUuid = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const uuidV4 = (bytes: Uint8Array): string => {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
};

const uuidV7 = (epochMillis: number, bytes: Uint8Array): string => {
  const time = BigInt(epochMillis);
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
};

const readUint53 = (bytes: Uint8Array): number =>
  (bytes[0]! & 0x1f) * 2 ** 48 +
  bytes[1]! * 2 ** 40 +
  bytes[2]! * 2 ** 32 +
  bytes[3]! * 2 ** 24 +
  bytes[4]! * 2 ** 16 +
  bytes[5]! * 2 ** 8 +
  bytes[6]!;

const validateSize = (method: string, size: number) =>
  Number.isSafeInteger(size) && size >= 0
    ? Effect.succeed(size)
    : Effect.fail(
        PlatformError.badArgument({
          module: "Crypto",
          method,
          description: "size must be a non-negative safe integer",
        }),
      );

/** Builds the service from random-byte and digest primitives. */
export const make = (impl: {
  readonly randomBytes: (size: number) => Uint8Array;
  readonly digest: (
    algorithm: DigestAlgorithm,
    data: Uint8Array,
  ) => Effect.Effect<Uint8Array, PlatformError.PlatformError>;
}): Crypto => {
  const randomBytesUnsafe = impl.randomBytes;
  const randomBytes = (size: number) =>
    Effect.map(validateSize("randomBytes", size), randomBytesUnsafe);
  const nextDoubleUnsafe = () => readUint53(randomBytesUnsafe(7)) / 2 ** 53;
  const nextIntUnsafe = () => {
    for (;;) {
      const bytes = randomBytesUnsafe(7);
      const value = readUint53(bytes);
      if ((bytes[0]! & 0x20) === 0) return value + Number.MIN_SAFE_INTEGER;
      if (value < Number.MAX_SAFE_INTEGER) return value + 1;
    }
  };
  return {
    [TypeId]: TypeId,
    randomBytes,
    nextDoubleUnsafe,
    nextIntUnsafe,
    digest: impl.digest,
    random: Effect.sync(() => nextDoubleUnsafe()),
    randomBoolean: Effect.sync(() => nextDoubleUnsafe() > 0.5),
    randomInt: Effect.sync(() => nextIntUnsafe()),
    randomBetween: (min, max) => Effect.sync(() => min + nextDoubleUnsafe() * (max - min)),
    randomIntBetween: (min, max, options) => {
      const extra = options?.halfOpen === true ? 0 : 1;
      return Effect.sync(() => {
        const minInt = Math.ceil(min);
        const maxInt = Math.floor(max);
        return Math.floor(nextDoubleUnsafe() * (maxInt - minInt + extra)) + minInt;
      });
    },
    randomShuffle: (elements) =>
      Effect.sync(() => {
        const buffer = Array.from(elements);
        for (let i = buffer.length - 1; i >= 1; i = i - 1) {
          const index = Math.min(i, Math.floor(nextDoubleUnsafe() * (i + 1)));
          const value = buffer[i]!;
          buffer[i] = buffer[index]!;
          buffer[index] = value;
        }
        return buffer;
      }),
    randomUUIDv4: Effect.sync(() => uuidV4(randomBytesUnsafe(16))),
    randomUUIDv7: Effect.clockWith((clock) =>
      Effect.sync(() => uuidV7(clock.currentTimeMillisUnsafe(), randomBytesUnsafe(16))),
    ),
  };
};

const webCrypto = (): Crypto => {
  const source = globalThis.crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    throw new Error("WebCrypto is unavailable in this runtime");
  }
  return make({
    randomBytes: (size) => {
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 65536) {
        source.getRandomValues(bytes.subarray(offset, Math.min(size, offset + 65536)));
      }
      return bytes;
    },
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () =>
          source.subtle
            .digest(algorithm, new Uint8Array(data))
            .then((buffer) => new Uint8Array(buffer)),
        catch: (cause) =>
          PlatformError.systemError({
            _tag: "Unknown",
            module: "Crypto",
            method: "digest",
            description: "WebCrypto digest failed",
            cause,
          }),
      }),
  });
};

/** Service tag for platform cryptography. */
export const Crypto = Context.Service<Crypto, Crypto>("effect/Crypto");

/** Layer for a runtime with WebCrypto: Node 18+, browsers and Expo. */
export const layer = Layer.sync(Crypto, webCrypto);
