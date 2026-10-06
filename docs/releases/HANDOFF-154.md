# New team from the + menu, with a leader picker (1.54.0)

2026-09-29, Frontend (CTO task 61ca5817). Branch feat/new-team-menu (worktree C:/Claude/AI/_wt/hbots-153), on 1.53.2 (7175ab8e6a, release 504ed790dcbb, live since 14:05). Harout: "add that option next to the plus icon in main bots page too, not just in diagram".

## What changed (web only; server and contracts untouched)

- **Menu.** The "+" on /bots (ChatsScreen.tsx) offers New bot, New group, New team. New team opens `/bots/teams/new` (route `_personal.bots_.teams.new.tsx`, `routeTree.gen.ts` edited by hand in the shape the generator writes; desktop pane layout "form" in personalMode.ts).
- **One shared form**, `NewTeamForm.tsx`, used by `NewTeamScreen.tsx` (the route) and by the diagram's "New team" (`TeamManager` in TeamScreen.tsx, inline, with its own Cancel; the old name-only form is gone).
  - Team name, required. Refused before anything is sent when it matches, case-insensitively, a registered team, a built-in by key or label ("dev", "Dev team", "Assistant's team"), or a team a bot is already stored on: "There is already a team called Dev team." (`teamNameProblem`, newTeamModel.ts).
  - Leader, optional: radio list, "No leader for now" first, then every bot (group-only bots left out, as in the diagram) with avatar, name, the short model label (`botModelShortLabel`) and, for a current lead, "Leads Dev team".
  - Members, optional (kept, it was cheap): a "Members" disclosure with checkboxes for the other bots.
- **What it sends.** `personalProfile.set` teamChange create, then `personalBots.update {botId, team, lead}` per bot: the leader with `lead: true`, members with `lead: false` (the server only clears a team's lead when the incoming bot claims it, so a member who led another team must be sent as `lead: false` or it would become a second lead of the new team). These are the calls the diagram's drag and the bot form already use; the server's rules are the only rules.
- **Leader from another team.** As soon as the pick is made a callout says "CTO leads Dev team; it will move to Research, and Dev team will have no lead." Pressing Create then asks once more (a confirm bar with the same sentence, "Move CTO and create team" / "Back"), and nothing is sent until then. A member who leads a team counts too. The old team is left without a lead, which is allowed.
- **Afterwards.** The New team screen hands `{message, team}` over in memory (`teamNotice.ts`, taken once) and navigates to /bots/team with replace. The Team screen always has a `role="status"` region and fills it after mount ("Team Research created. Updates leads it. 1 bot moved in."), shows it as a card, and scrolls the new team's band (`data-team-band`) into view once the refreshed list draws it (smooth unless reduced motion). The diagram's inline form does the same without a navigation.
- **Back stack.** `/bots/teams/new` looks like a bot chat (`/bots/$botId/$threadId`) to `isPersonalChatPath`, so `teams` is reserved next to `groups` (botsBackStack.ts); otherwise the edge-swipe and the "Bots behind" rewrite would have treated it as a chat.

## Known limits

- The server still accepts a second `create` of the same team name silently (an existing test relies on it); only the form refuses. Two devices creating the same name at the same moment merge into one team.
- Not atomic: the team is registered first, the bots after. If a move fails the form says "Research was created, but Ada couldn't be moved: <reason>", locks the name, and Try again only repeats the moves that did not happen.
- A built-in team with no bots is not drawn in the diagram (Dev after its only bot moved out); unchanged behaviour.

## Verification

- Gates on the head: web personal 0 (122 files, 1183 tests), web tsc 0. Server and contracts untouched, so their gates were not run. New tests: newTeamModel.test.ts (name rules, leaders leaving, move plan, messages, notice hand-over), NewTeamForm.test.tsx (no lead; lead from no team; lead from another team with warning, confirm and back; duplicate refusal incl. built-in; members incl. a member that led; failed move and retry), NewTeamScreen.test.tsx (lands on /bots/team, notice handed over), ChatsScreen.test.tsx (the menu entry), botsBackStack / personalMode / edgeSwipeBack path lists.
- Throwaway server (release 9a5f89ce0f0e, fake Claude CLI by binaryPath, PERSONAL_SEED_MODEL=claude-sonnet-5-5, cap 5, Codex never messaged, root deleted; evidence ~/.personal-bots/qa/frontend-154/, flow.mjs): 390x844 dark and light. menu-, form-empty-, form-duplicate-, form-leader-picker- and form-warning-full- (leader picker and move warning), form-confirm-, diagram- and diagram-top- (after), plus diagram-form- and diagram-after-inline- (dark). Server rows afterwards: Updates on the new team with lead 1, Planner a member, Dev left with no lead, the no-lead team "Empty" registered. No page errors.

## Release

Release 9a5f89ce0f0e (commits 55b3fd55a3 feature, 961944d02e version, 9a5f89ce0f fixes; docs after). An earlier staging 961944d02e1f is superseded (its folder was left in releases/). Rollback 1.53.2 = 504ed790dcbb. After it goes live: /version.txt 1.54.0; on the iPhone open + > New team and check the leader list and the confirm.
