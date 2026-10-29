# 1.66.104: repeated question answers

Based on 1.66.103 (43d9afcfe7). No migration; schema remains 114. When a message-mode question ID is reused, each answer now has a distinct activity and message ID tied to its command. The previous answer remains intact and the next turn references the new message. Existing synchronous question handling is unchanged.

The screen retains only the newest card when an ID is reused. Preserving both needs changes to its request history and resolution matching, beyond the contained server fix.

Release coordination: the app sheet records 1.66.105 (df18cd043c18) as already live. That release is not an ancestor of this branch; this build must not replace it without incorporating the newer release line and passing the gates again.
