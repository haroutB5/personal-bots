import { expect, it } from "vite-plus/test";

import { secretNameProblem } from "./SecretAccessSettings";

it("accepts the shape a bot actually reads", () => {
  expect(secretNameProblem("OPENWEATHER_API_KEY")).toBeNull();
  expect(secretNameProblem("  TAVILY_API_KEY  ")).toBeNull();
  expect(secretNameProblem("X")).toBeNull();
});

it("refuses a name no bot could ever read, rather than saving a dead key", () => {
  // Each of these stores fine and is then invisible: the session env is built
  // from PB_SECRET_<NAME>, so the wrong shape is worse than a visible error.
  for (const name of ["openweather_api_key", "OPENWEATHER-API-KEY", "1PASSWORD", "MY KEY"]) {
    expect(secretNameProblem(name), name).not.toBeNull();
  }
});

it("asks for a name rather than complaining about the shape of nothing", () => {
  expect(secretNameProblem("")).toBe("Give the key a name.");
  expect(secretNameProblem("   ")).toBe("Give the key a name.");
});
