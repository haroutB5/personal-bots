# hbots 1.66.94: a waiting task is never marked completed on a timer

Three Frontend tasks delegated by the CTO on 25 Oct ended **completed** while their bots were still working. Two rules in the task runner produced that, and both read a mechanical signal rather than the bot's own words:

1. **The 20-minute cap.** The log line `personal task closed with background work still running` fired at 18:01:03 for `dc8d8b95-e459-4b6b-820c-cd5faedc375e` with `backgroundTasks: [ 'bbglsv9qz' ]` still live (the bot's watch on another branch). It fired at 17:35:01 for `bba533d8-0a23-4562-afa2-fd8128349bac` with `bhj41xucq` still live. The cap was meant for a dev server left running; it also closed real work at 20 minutes.
2. **The 60-second follow-up grace.** After tracked work ended, if Claude Code had not started its follow-up turn within a minute, the last reply became the result. `dc8d8b95` attempt 1 ended at 17:22:55 with the reply "Typecheck and lint are queued behind the other job. I'll continue with vitest and the build once they finish." (the turn that merged the result arrived at 17:23:20). `535f09d4-aeb6-4913-b0d0-8d1468ea8181` attempt 1 ended at 17:38:17 on "The Brave proof is running against the fresh build; I'll report when it finishes." Nothing the app tracks was live for that proof (a detached pid), so no wait protected it.

The app could see work it started itself, but had no concept of a bot saying in words that it was still waiting on something the app cannot see (another chat's push, the machine-wide heavy-job lock, a detached proof run). It also closed a task that had tracked work visibly running.

## Changes

- **No time-based closing while a wait is open.** `stepBackgroundWait` holds the task while tracked background work is live, however long it runs. Harout's rule (25 Oct): a task runs until the bot finishes, fails, or the orchestrator stops or steers it.
- **The bot's own words hold it too.** `saysItIsWaiting` (new, pure) reads the newest reply line: "I'll report/merge/continue ... once it finishes", "still running the <work>", "queued behind", "waiting on/for", "watching for", "re-armed the watch". A final report does not match, and a negated phrase ("nothing is still running") never does. When it matches, the reply is held like any other wait and the task stays `running`; Claude Code starts no follow-up turn for work it does not own, so nothing else would keep the task open.
- **A safety net that does not close the task.** After 20 minutes (`PERSONAL_TASK_WAIT_NOTICE_MS`) the delegating lead gets one note per attempt, in its next turn (`notice:waiting:<taskId>:<attempt>` in the resume-notes table): it says the task has been waiting that long, has not been closed, and can be stopped or steered. The note can never wake a task that is waiting for the user (the query excludes the `notice:` prefix, the same way it excludes `steer:`). A root task has no lead; its notice is the log line.
- **One hard cap, for runaway waits only.** At 8 hours (`PERSONAL_TASK_WAIT_HARD_CAP_MS`) a wait that has produced no new turn closes the task with its replies and a note naming the cap. No build, gate or proof takes 8 hours; a dev server left running, or a bot repeating "still waiting" forever, would. This is the only timer that can still end a task, and it is 24 times the old cap.
- **Logs say which wait.** `personal task waiting for its work to finish` now carries `statedWait` and the tracked ids; a runaway close logs `personal task closed after a runaway background command` or `... after a runaway stated wait`.
- **Wording.** `backgroundCapNote` and the new `statedWaitCapNote` name the 8-hour cap; the old 20-minute note is gone.
- No migration, no schema change, no settings change; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Validation

- Unit (`taskPolicies.test.ts`): 10 live reply texts the three tasks ended on match, 9 final reports and negations do not, only the newest line counts; tracked work is held past the notice mark and closes only at the 8-hour cap; a stated wait closes only at the cap; a later waiting reply does not restart the clock; the notice fires once.
- Service (`PersonalTaskService.test.ts`): a follow-up turn that still says it is waiting keeps the task running past the 60-second grace and its later report completes it with every reply; a task whose reply waits on the heavy-job lock stays running, shows the waiting mark, takes a steer and reports; the delegating lead gets exactly one notice and neither task closes; the stated wait survives the notice mark and closes at the cap; a runaway tracked command closes at the cap with its note.
- Gates per the app sheet: server `vp test run src/personal` and `tsc --noEmit`, web `vp test run --project unit src/features/personal`, then `gate-evidence.ps1`. Numbers are in the gate section below.
- Live tasks were not touched and nothing was deployed or restarted; `releases\current.txt` stays at 1.66.92.

## Behaviour that changes for the orchestrator

- A child task that says it is waiting, or has tracked work running, now stays `running` for hours instead of ending at 20 minutes. `list_tasks` shows it with `waitingOnBackgroundSince`; a notice arrives in the lead's next turn after 20 minutes, once. If the work is genuinely stuck, `stop_task` (or `steer_task`) is the decision, not a timer.
- A completed child that the old cap would have closed early now reports later, with the full set of replies in its result.

## Runtime and activation

No migration (112 to 112), so no production backup. Roll back to 1.66.92 `e906462e6c37` (binary only) if the smoke fails. Node stays at 24.22.1.

## Gate evidence

<!-- gate-evidence:begin -->
<!-- gate-evidence:end -->
