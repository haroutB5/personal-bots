# 1.66.104: switch back to a bot's own model at the next turn

Based on 1.66.103 (d10ff68edf2a). No migration; schema remains 114.

The usage-limit model fallback only switched a bot back to its own model from its 30-second idle sweep, and the sweep required no turn and no task to be running. A bot that stayed busy on a long delegated task therefore kept the fallback row long past its reset time.

Now, when a usage-limit fallback row's reset has passed, or the sweep's two-minute provider re-probe proves the limit reset early, the next turn started on a chat that is between turns ends the row first, so that turn runs on the bot's own model. The check sits in the shared bot-model selection every server-started turn uses (delegated tasks, retries, resumes, group rounds, lead posts, release notices, voice calls and owner turns) and goes through the ordinary switch-back path: the reswitch cooldown, the wakeup of rate-limited tasks and scheduled chat resumes, the one chat line, and the provider switch that carries the chat over to the new session. A chat with a turn still running is left alone, so a steer and the running turn keep the model they started on and nothing changes mid-turn. A re-hit of the limit falls back again, with the existing 60-second cooldown preventing a bounce.

Schedule and DeepSeek-peak rows are not touched by the boundary check and keep their idle-gated switch back. `list_bots` and the chat's fallback label stop showing the fallback model as soon as the row ends.
