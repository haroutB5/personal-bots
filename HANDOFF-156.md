# Team screen as constellations (1.56.0)

2026-09-29, Frontend (CTO task 3c203341). Branch feat/team-constellation (worktree C:/Claude/AI/_wt/hbots-156), built on 1.55.0 (main 138b0e9b48; it contains Backend's 1.55 commits). Designer's direction B "Constellation", picked by Harout, with his three behaviours: a confirm before a lead is replaced, an Undo in the toast after any move, and a tap on a "Working now" row opens the receiving bot's task chat. Design: C:/Claude/AI/dev-team/design/hbots/team-screen/ (mockups/b-constellation.html, shots/b-constellation-*, SPEC-a-roster.md for the shared parts).

## What changed (web only; server and contracts untouched, no server change was needed)

- **/bots/team** is a column of team cards. Each card: team name, "12 bots >" (opens the full list), a "..." menu on custom teams (Remove team, enabled only when empty; otherwise "Remove team (move its bots first)"), then the lead as a hub in the middle and the members on an orbit. A spoke runs from the lead to every member it handed work to in the last 7 days, thicker for more (1.25 + 4.5 * sqrt(count / max) px), and a green dashed spoke that flows while a handoff runs. Every spoke starts at the hub, so none cross. No lead: a dashed crown seat, "No lead". The legend and the owner tree are gone; the header has a 44 px "+" (New team, /bots/teams/new, the 1.54 form).
- **Working now** card at the top while a handoff runs (spec A): from arrow to avatars, title, how long. A tap opens the receiving bot's task chat (`/bots/$botId/$threadId`), or the task page (`/tasks/$taskId`) while the task has no chat yet.
- **Moving a bot.** Hold a node for 450 ms (scroll cancels after 10 px). The page zooms out to one small drop card per team: the card is Join, its round seat is Lead, plus "New team with <bot>". The token follows the finger; the banner and the status region read the hover hint ("Let go to move Frontend to the Dev team." / "... make Frontend the Dev team lead."). Let go over nothing and the cards stay up in tap mode (tap a card, or Cancel / Esc). The list's Move button opens the same cards in tap mode, which is also the way to move without holding.
- **Lead confirm** (`TeamLeadConfirm`, role alertdialog, focus on the primary): a Lead drop that replaces someone asks first: "Make Frontend the Dev team lead? CTO stops leading and stays on the Dev team. CTO has 2 handoffs running; they carry on." (plus NewTeamForm's "X leads A; it will move to B, and A will have no lead" when that applies). Nothing is sent until "Make Frontend lead". An empty seat, and joining a team, do not ask. A lead leaving a staffed team is still refused first.
- **Undo** (`TeamMoveToast`, 5 s, waits while the button has focus or a pointer is on it): sends the old state back. A move that took a lead seat first gives the old lead the seat back, then returns the bot to its old team and role (`undoPlan`, tested against a model of the server rule).
- **Optimistic move** as before (`PendingMove`, now `applyTeamUpdate`), scrolls the destination card into view (smooth unless reduced motion), errors stay a `role="alert"` card and the node snaps back.
- **Handoff counts from the last 7 days.** The live task feed carries only unfinished tasks and the newest 20 finished ones, so spokes (and the old dashed lines) undercounted. `useTeamHandoffTasks` pages `personalTasks.history` (100 a page, at most 6 pages) until it reaches back past 7 days, after the feed has arrived, and merges the two. Handoffs whose parent task is older than that window are not counted (as before).

## The two weaknesses Designer flagged

1. **Long names.** A name wraps to two lines under the avatar (76 px column, ellipsis only past two lines, about 26 characters), so "CFO scheduler" reads whole. Every node has `title` and an accessible name with the full name, model label, "working for X" and the week's handoff count. The hub shows the lead's short model label. The "N bots >" list shows every bot with the whole name, title or model label and a Move button. Layout reserves the label's real size (`nodeLabel`: one line as wide as the name, or two lines), so long names get more room and short ones stay tight.
2. **Crowding.** A team of up to about 11 is the mockup's single orbit. Beyond that the layout tries other single orbits, then two staggered orbits, then a packed fallback that is collision-free by construction; 15 to 20 members all draw, on a taller card (about 630 px at 20). Past 20 the 20th seat is "+N / See all" and opens the list. A spoke that would run behind another node is not drawn: that member shows the week's count as a small badge on its avatar instead (so lines never cross a node). Tested: no overlap of hub or nodes for 0 to 40 members at 320, 350, 390 and 430 px with mixed long names.

## Files (apps/web/src/features/personal)

New: teamConstellationModel.ts (+test: layout, spokes, counts, working-now, planDrop, lead confirm copy, move targets, undo, history cutoff), TeamConstellationCard.tsx (+test), TeamMoveOverlay.tsx, TeamLeadConfirm.tsx, TeamMembersSheet.tsx, TeamMoveToast.tsx, TeamWorkingNow.tsx (+test), useTeamHandoffTasks.ts. Changed: TeamScreen.tsx (rebuilt; TeamManager and the diagram are gone), useTeamBotDrag.ts (follows the finger on the window after the lift, so the page can change under it), teamDiagramModel.ts (drawing geometry deleted; kept buildTeamGroups, teamDropOutcome, teamDropHint, deriveDelegationLinks, countTeamMembers), NewTeamForm.tsx (`initialMemberIds`), personal.css (`--personal-scrim`, spoke flow, toast and card motion, reduced-motion rules).

## Not done or different from the mockup

- Reduced motion: the flow is static and the drop cards and toast appear without animation (the app's global reduce rule wins over the 100 ms fade in the spec).
- Handoffs between members, or across teams, are not drawn (B draws the lead's spokes only); they show in Working now while running.
- A short model label is shown on the hub only; members carry it in the accessible name and the list.
- Accessibility of move: the list's Move button and tap mode replace a grip on every node; no drag needed.

## Verification

- Gates on the head: web personal 0 (125 files, 1209 tests), web tsc 0. Server and contracts untouched by this change (1.55 server gates are Backend's).
- Throwaway server (release ca990d35cdc1 = 1.55 server, fake Claude CLI by binaryPath, PERSONAL_SEED_MODEL=claude-sonnet-5-5, cap 5, root deleted; evidence ~/.personal-bots/qa/frontend-156/): compare/compare-{idle,live,move,scrolled}-390-{dark,light}.png and compare-idle-430-{dark,light}.png (design left, build right); build-crowded-{dev,Finance}-{390,430}-{dark,light}.png (17 and 23 bots, long names, "+3"); flow-*.png. flow.mjs checked against the server DB: lead confirm shown and nothing sent before it, Cancel changes nothing, confirm sends, Undo restores the seats; a plain move to Finance and its Undo; tap mode opens with focus inside, Esc closes and returns focus to the node; a Working now tap goes to /bots/bot-designer/thread-live-designer; no page errors other than the fake thread's 404s.
- Not checked: a real iPhone (long press, iOS text selection, the drag over the drop cards).

## Release

Staged without a restart waiter. After it goes live: /version.txt 1.56.0; on the iPhone open Team, hold a bot, drop it on a lead seat and check the confirm and Undo, tap a Working now row.
