import type { PersonalBot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  leaderMoveWarning,
  leadersLeaving,
  planTeamMoves,
  teamCreatedMessage,
  teamNameProblem,
} from "./newTeamModel";
import { takeTeamNotice, setTeamNotice } from "./teamNotice";

const bot = (
  id: string,
  name: string,
  extra: { team?: string; lead?: boolean } = {},
): PersonalBot => ({ botId: id, name, ...extra }) as unknown as PersonalBot;

describe("teamNameProblem", () => {
  it("accepts a new name, trimmed", () => {
    expect(teamNameProblem("  Research ", [], [])).toBeNull();
  });

  it("asks for a name", () => {
    expect(teamNameProblem("   ", [], [])).toContain("name");
  });

  it("refuses a registered team whatever the case", () => {
    expect(teamNameProblem("research", ["Research"], [])).toBe(
      "There is already a team called Research.",
    );
    expect(teamNameProblem("RESEARCH", ["Research"], [])).toContain("already");
  });

  it("refuses the built-in teams by key and by label", () => {
    for (const name of ["dev", "Dev team", "assistant", "Assistant's team"]) {
      expect(teamNameProblem(name, [], []), name).toContain("already");
    }
    expect(teamNameProblem("dev team", [], [])).toBe("There is already a team called Dev team.");
  });

  it("refuses a team a bot is already stored on, even if never registered", () => {
    expect(teamNameProblem("ops", [], [bot("b1", "Ada", { team: "Ops" })])).toContain("Ops");
  });

  it("refuses a name past 60 characters", () => {
    expect(teamNameProblem("x".repeat(61), [], [])).toContain("60");
    expect(teamNameProblem("x".repeat(60), [], [])).toBeNull();
  });
});

describe("leaders leaving another team", () => {
  const cto = bot("cto", "CTO", { team: "dev", lead: true });
  const ada = bot("ada", "Ada", { team: "assistant" });

  it("names only the bots that lead a team", () => {
    expect(leadersLeaving([cto, ada])).toEqual([{ botName: "CTO", fromTeam: "dev" }]);
    expect(leadersLeaving([ada])).toEqual([]);
  });

  it("says who moves where and what the old team is left with", () => {
    expect(leaderMoveWarning(leadersLeaving([cto]), " Research ")).toBe(
      "CTO leads Dev team; it will move to Research, and Dev team will have no lead.",
    );
  });
});

describe("planTeamMoves", () => {
  const cto = bot("cto", "CTO", { team: "dev", lead: true });
  const qa = bot("qa", "QA", { team: "dev" });
  const fe = bot("fe", "Frontend", { team: "dev", lead: false });

  it("moves nobody without a leader or members", () => {
    expect(planTeamMoves({ leader: null, members: [], team: "Research" })).toEqual([]);
  });

  it("moves the leader first, as lead, then the members as plain members", () => {
    expect(planTeamMoves({ leader: cto, members: [qa, fe], team: "Research" })).toEqual([
      { botId: "cto", name: "CTO", lead: true },
      { botId: "qa", name: "QA", lead: false },
      { botId: "fe", name: "Frontend", lead: false },
    ]);
  });

  it("clears the lead flag on a member that led another team", () => {
    expect(planTeamMoves({ leader: null, members: [cto], team: "Research" })).toEqual([
      { botId: "cto", name: "CTO", lead: false },
    ]);
  });

  it("never lists the leader twice", () => {
    expect(planTeamMoves({ leader: qa, members: [qa], team: "Research" })).toEqual([
      { botId: "qa", name: "QA", lead: true },
    ]);
  });
});

describe("teamCreatedMessage", () => {
  it("says there is no lead yet", () => {
    expect(teamCreatedMessage({ team: "Research", leaderName: null, memberCount: 0 })).toBe(
      "Team Research created. It has no lead yet.",
    );
  });

  it("names the lead and counts the members", () => {
    expect(teamCreatedMessage({ team: "Research", leaderName: "CTO", memberCount: 1 })).toBe(
      "Team Research created. CTO leads it. 1 bot moved in.",
    );
    expect(teamCreatedMessage({ team: "Research", leaderName: "CTO", memberCount: 3 })).toContain(
      "3 bots moved in.",
    );
  });
});

describe("team notice hand-over", () => {
  it("is taken exactly once", () => {
    setTeamNotice({ message: "Team Research created.", team: "Research" });
    expect(takeTeamNotice()).toEqual({ message: "Team Research created.", team: "Research" });
    expect(takeTeamNotice()).toBeNull();
  });
});
