# 1.66.106: repeated question answers

Based on 1.66.105 via personal-bots/main (12e38e699a). No migration; schema remains 114. When a message-mode question ID is reused, each answer now has a distinct activity and message ID tied to its command. The previous answer remains intact and the next turn references the new message. Existing synchronous question handling is unchanged.

The screen retains only the newest card when an ID is reused. Preserving both needs changes to its request history and resolution matching, beyond this contained server fix.
