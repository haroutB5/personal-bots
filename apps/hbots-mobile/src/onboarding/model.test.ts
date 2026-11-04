import { describe, expect, it } from "vite-plus/test";

import { RequestFailure } from "../failure";
import type { ServerIdentity } from "../pairing";
import type { PairingTarget } from "../pairingLink";
import { failureCopy, failureFor, reducePairing, type PairingState } from "./model";

const LINK: PairingTarget = {
  httpBaseUrl: "https://relay.example.test/",
  wsBaseUrl: "wss://relay.example.test/",
  credential: "one-time",
};

const SERVER: ServerIdentity = {
  environmentId: "7f3a91c2-4d5e-4f60-8a71-2b3c4d5e6f70",
  label: "Harout's laptop",
  host: "relay.example.test",
  serverVersion: "1.66.117",
  shortId: "7F3A-91C2",
};

function reduceAll(state: PairingState, actions: Parameters<typeof reducePairing>[1][]) {
  return actions.reduce(reducePairing, state);
}

describe("pairing reducer", () => {
  it("walks welcome to pair with the server identity and the typed label", () => {
    const confirmed = reduceAll({ step: "welcome" }, [
      { type: "scan" },
      { type: "submitLink", value: "https://relay.example.test/pair#token=one-time" },
      { type: "checked", server: SERVER },
    ]);
    expect(confirmed).toEqual({ step: "confirm", link: LINK, server: SERVER });

    const labelled = reduceAll(confirmed, [{ type: "confirm", defaultLabel: "Oppo Find X9 Pro" }]);
    expect(labelled).toEqual({
      step: "label",
      link: LINK,
      server: SERVER,
      label: "Oppo Find X9 Pro",
    });

    expect(
      reduceAll(labelled, [{ type: "label", value: "Harout's phone" }, { type: "pair" }]),
    ).toEqual({
      step: "pairing",
      link: LINK,
      server: SERVER,
      label: "Harout's phone",
    });
  });

  it("keeps an unparseable paste on the paste screen with the error flag", () => {
    const state = reduceAll({ step: "welcome" }, [
      { type: "paste" },
      { type: "draft", value: "not a link" },
      { type: "submitPaste" },
    ]);
    expect(state).toEqual({ step: "paste", draft: "not a link", invalid: true });
  });

  it("takes back from the confirm screen to welcome so the token stays unused", () => {
    const confirm: PairingState = { step: "confirm", link: LINK, server: SERVER };
    expect(reducePairing(confirm, { type: "back" })).toEqual({ step: "welcome" });
  });

  it("takes back from the label screen to the same confirm screen", () => {
    const label: PairingState = {
      step: "label",
      link: LINK,
      server: SERVER,
      label: "Find X9 Pro",
    };
    expect(reducePairing(label, { type: "back" })).toEqual({
      step: "confirm",
      link: LINK,
      server: SERVER,
    });
  });

  it("retries the same link after a network failure", () => {
    const failed = reducePairing(
      { step: "checking", link: LINK },
      {
        type: "checkFailed",
        reason: "unreachable",
      },
    );
    expect(failed).toEqual({
      step: "failed",
      reason: "unreachable",
      retry: { kind: "link", link: LINK },
    });
    expect(reducePairing(failed, { type: "retry" })).toEqual({ step: "checking", link: LINK });
  });

  it("refuses to pair with an empty device label", () => {
    const label: PairingState = { step: "label", link: LINK, server: SERVER, label: "  " };
    expect(reducePairing(label, { type: "pair" })).toEqual(label);
  });
});

describe("pairing failures", () => {
  it("uses the SPEC copy for an expired code", () => {
    expect(failureCopy.expired).toEqual({
      headline: "This code expired",
      help: "Codes last 5 minutes. Make a new one on your laptop.",
      action: "Scan again",
    });
  });

  it("reads a spent grant as used and a dead network as unreachable", () => {
    expect(
      failureFor(new RequestFailure({ kind: "http", route: "pair", status: 401, jsonBody: true })),
    ).toBe("used");
    expect(failureFor(new RequestFailure({ kind: "network" }))).toBe("unreachable");
  });

  it("reads a non-json answer as not an hbots server", () => {
    expect(failureFor(new RequestFailure({ kind: "not-json" }))).toBe("not-hbots");
  });
});
