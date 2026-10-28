# 1.66.103: answered questions and chat-name focus

Based on 1.66.102 (07bc34e859). No migration; schema remains 114.

When an inbound turn is accepted, every open message-mode question in that thread is superseded, with a resolved activity per request. The card says “Answered in the chat” and the thread no longer waits for that input. This includes live task steers, continuations, retries and owner messages. A stale card submission is harmless. Codex emits message-mode questions; synchronous callback questions, including Claude AskUserQuestion, are left open. AskUserQuestion is disabled for bots.

Rename chat primes focus in the settings tap, opens the dialog synchronously and selects the title. New Chat opens its name field synchronously as well. Other text dialogs require separate review.

Verification and release evidence will be added after the gates.
