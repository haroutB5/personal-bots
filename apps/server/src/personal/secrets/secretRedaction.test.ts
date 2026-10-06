import { assert, describe, it } from "@effect/vitest";

import {
  makeSecretRedactor,
  redactedSecretText,
  secretRedactionEnabled,
  secretVariants,
} from "./secretRedaction.ts";

const KEY = "sk-live-AbCdEf0123456789xyzQ";

const redactorWith = (name = "VERCEL_TOKEN", value = KEY) => {
  const redactor = makeSecretRedactor();
  redactor.set(name, value);
  return redactor;
};

describe("secretRedaction", () => {
  it("masks the raw value and names the key", () => {
    const redactor = redactorWith();
    assert.strictEqual(
      redactor.redactText(`token is ${KEY}, ok`),
      `token is ${redactedSecretText("VERCEL_TOKEN")}, ok`,
    );
  });

  it("leaves text alone when nothing is known or nothing matches", () => {
    assert.strictEqual(makeSecretRedactor().redactText(`x ${KEY}`), `x ${KEY}`);
    assert.strictEqual(redactorWith().redactText("nothing here"), "nothing here");
  });

  it("masks url-encoded, form-encoded, json-escaped, hex and base64 spellings", () => {
    const value = 'p@ss word/with"quote&more=1+2';
    const redactor = redactorWith("ODD_KEY", value);
    const spellings = [
      encodeURIComponent(value),
      encodeURIComponent(value).replaceAll("%20", "+"),
      JSON.stringify(value).slice(1, -1),
      Buffer.from(value).toString("hex"),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
    ];
    for (const spelling of spellings) {
      const out = redactor.redactText(`before ${spelling} after`);
      assert.notInclude(out, spelling.slice(0, 12), spelling);
      assert.include(out, "[secret ODD_KEY]");
    }
  });

  it("masks a value inside a longer base64 string at every alignment", () => {
    const redactor = redactorWith();
    for (const lead of ["", "u", "us", "use", "user:", "Bearer "]) {
      for (const tail of ["", "!", "!!", "tail"]) {
        const encoded = Buffer.from(`${lead}${KEY}${tail}`).toString("base64");
        const out = redactor.redactText(`Authorization: Basic ${encoded}`);
        assert.include(out, "[secret VERCEL_TOKEN]", `${lead}|${tail}`);
        assert.notInclude(out, KEY.slice(0, 10));
      }
    }
  });

  it("does not register values too short to mask safely", () => {
    const redactor = redactorWith("PIN", "1234567");
    assert.strictEqual(redactor.size(), 0);
    assert.strictEqual(redactor.redactText("code 1234567"), "code 1234567");
  });

  it("redacts every string in a structure and keeps the same reference when nothing changed", () => {
    const redactor = redactorWith();
    const clean = { a: ["x", { b: "y" }], n: 1 };
    assert.strictEqual(redactor.redact(clean), clean);
    const dirty = { a: [`k=${KEY}`, { b: KEY }], n: 1, nested: { image: "not an image" } };
    const out = redactor.redact(dirty);
    assert.deepStrictEqual(out, {
      a: ["k=[secret VERCEL_TOKEN]", { b: "[secret VERCEL_TOKEN]" }],
      n: 1,
      nested: { image: "not an image" },
    });
    // The original is untouched.
    assert.strictEqual(dirty.a[0], `k=${KEY}`);
  });

  it("passes an image payload through without scanning it", () => {
    const redactor = redactorWith();
    const image = { mimeType: "image/png", data: `AAAA${KEY}AAAA` };
    assert.strictEqual(redactor.redact(image), image);
  });

  it("two bots' values of one name are both masked, and remove drops them all", () => {
    const redactor = makeSecretRedactor();
    redactor.set("TOKEN", "value-for-bot-a-1234", "key-a");
    redactor.set("TOKEN", "value-for-bot-b-5678", "key-b");
    assert.strictEqual(
      redactor.redactText("a=value-for-bot-a-1234 b=value-for-bot-b-5678"),
      "a=[secret TOKEN] b=[secret TOKEN]",
    );
    redactor.remove("TOKEN");
    assert.strictEqual(redactor.size(), 0);
    assert.strictEqual(redactor.redactText("a=value-for-bot-a-1234"), "a=value-for-bot-a-1234");
  });

  it("kill switch turns every method into a pass-through", () => {
    let on = true;
    const redactor = makeSecretRedactor({ enabled: () => on });
    redactor.set("VERCEL_TOKEN", KEY);
    assert.include(redactor.redactText(KEY), "[secret");
    on = false;
    assert.strictEqual(redactor.redactText(KEY), KEY);
    const value = { a: KEY };
    assert.strictEqual(redactor.redact(value), value);
    const stream = redactor.stream();
    assert.strictEqual(stream.push(KEY), KEY);
  });

  it("reads PERSONAL_SECRET_REDACT, with the T3CODE_ spelling too", () => {
    assert.isTrue(secretRedactionEnabled({}));
    assert.isFalse(secretRedactionEnabled({ PERSONAL_SECRET_REDACT: "off" }));
    assert.isFalse(secretRedactionEnabled({ T3CODE_PERSONAL_SECRET_REDACT: "OFF" }));
    assert.isFalse(secretRedactionEnabled({ PERSONAL_SECRET_REDACT: "0" }));
    assert.isTrue(secretRedactionEnabled({ PERSONAL_SECRET_REDACT: "on" }));
  });

  it("lists spellings of a value, each long enough to be worth masking", () => {
    for (const variant of secretVariants(KEY)) assert.isAtLeast(variant.length, 8);
    assert.include(secretVariants(KEY), KEY);
  });
});

describe("secretRedaction stream", () => {
  const run = (redactor: ReturnType<typeof makeSecretRedactor>, pieces: ReadonlyArray<string>) => {
    const stream = redactor.stream();
    return pieces.map((piece) => stream.push(piece)).join("") + stream.flush();
  };

  it("masks a value split across any two deltas", () => {
    const redactor = redactorWith();
    const text = `prefix ${KEY} suffix`;
    for (let cut = 1; cut < text.length; cut++) {
      const out = run(redactor, [text.slice(0, cut), text.slice(cut)]);
      assert.strictEqual(out, "prefix [secret VERCEL_TOKEN] suffix", `cut ${cut}`);
    }
  });

  it("masks a value delivered one character at a time", () => {
    const redactor = redactorWith();
    const out = run(redactor, [...`say ${KEY} now`]);
    assert.strictEqual(out, "say [secret VERCEL_TOKEN] now");
  });

  it("holds back only what could still grow into a secret, and releases it on flush", () => {
    const redactor = redactorWith();
    const stream = redactor.stream();
    assert.strictEqual(stream.push("hello world"), "hello world");
    assert.isFalse(stream.holding());
    assert.strictEqual(stream.push("sk-live-AbC"), "");
    assert.isTrue(stream.holding());
    // It turned out not to be the secret: it comes out, unchanged.
    assert.strictEqual(stream.push(" is a prefix"), "sk-live-AbC is a prefix");
    assert.isFalse(stream.holding());
    assert.strictEqual(stream.push("sk-live-AbC"), "");
    assert.strictEqual(stream.flush(), "sk-live-AbC");
  });

  it("a stream started before a key was saved still masks it from then on", () => {
    const redactor = makeSecretRedactor();
    const stream = redactor.stream();
    assert.strictEqual(stream.push("one "), "one ");
    redactor.set("LATE_KEY", "late-value-0123456789");
    assert.strictEqual(stream.push("late-value-0123456789") + stream.flush(), "[secret LATE_KEY]");
  });
});
