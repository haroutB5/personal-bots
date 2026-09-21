# hbots WhatsApp connection

Date: 2026-09-21 (rewritten the same day after the owner's decision)
Status: design, approved for implementation
Depends on: the Connections framework (`2026-09-20-hbots-connections-design.md`), and the shared browser in `apps/server/src/personal/browser/`

## The decision, and what it costs

The first draft of this spec proposed the WhatsApp Business Cloud API and
rejected driving the owner's own account. The owner overruled that on
2026-09-21, twice asked, with the risk stated: **regular WhatsApp, their own
number, their own contacts.**

That is the right call for what they actually want — messages that arrive from
them, in the thread the recipient already has — and it is their account to
risk. The cost is real and is not softened here:

- Driving web.whatsapp.com with automation is against WhatsApp's terms.
- Enforcement is account-level. The penalty is the owner's personal number
  being banned, taking their real messaging with it, not a failed API call.
- The risk scales with volume and with how unlike a person the traffic looks.
  A handful of human-paced messages a day to existing contacts is a very
  different signal from bulk or burst sending, and the design below is built to
  keep it in the first category. That lowers the risk; it does not remove it.

Everything in this design that looks like friction — the per-send approval, the
daily cap, the refusal to message strangers — is there because the failure mode
is the owner losing their own WhatsApp, and because a message sent in someone's
name cannot be recalled.

## How it connects

No token exists for a personal account, so this vendor's auth kind is neither
paste nor device flow. It is a **browser session**, and it reuses the rails
this app already has for logging into sites as the owner.

1. The owner taps Connect on the WhatsApp row in Settings > Connections.
2. The server opens web.whatsapp.com in the shared browser and hands the owner
   control (`PersonalBrowser.takeControl`), exactly as the existing
   "Needs your help" takeover does.
3. The owner scans the QR with their phone, as they would on any computer.
4. Control returns to the server. The logged-in session lives in the browser
   profile on the owner's own machine — the same place and the same protection
   as every other saved login. **No credential is stored by this feature**,
   because there is none to store: WhatsApp Web's session is the credential,
   and it never leaves the machine.
5. Validation reads the owner's own display name and number from the logged-in
   page and records them as the connection's account metadata, so the
   Connections screen can show _which_ WhatsApp is connected.

A session that has expired or been logged out elsewhere moves the connection to
`needs_reauth` — a normal path here, since WhatsApp expires Web sessions — and
the screen offers the QR again.

## Operations

| Operation         | Risk | Notes                                                                                     |
| ----------------- | ---- | ----------------------------------------------------------------------------------------- |
| `list_chats`      | low  | Recent conversations: display name, whether unread, last message time. No message bodies. |
| `read_chat`       | low  | Messages in one conversation, most recent first, capped                                   |
| `search_contacts` | low  | Resolve a name to the contacts the owner actually has                                     |
| `send_message`    | high | Always approved, always                                                                   |
| `mark_read`       | low  |                                                                                           |

There is no group-creation, no broadcast, no media send, and no contact-adding
operation in this design. Each is a plausible next request and each raises the
traffic's profile; they are deliberate future decisions rather than omissions.

## The rails that matter

**Every send is approved. There is no exemption.** Not for a "trusted" contact,
not for a reply inside an active conversation, not for the second message in a
row. The card is server-authored from validated arguments and shows the
resolved recipient — display name _and_ the number it will actually go to —
alongside the exact text. The owner is agreeing to a specific message to a
specific person, which is the only unit of consent that makes sense when the
artefact is a message their friend will read as theirs.

**A recipient is never model-supplied.** The bot names a contact; the server
resolves it against the owner's real chat list and refuses anything that
matches zero contacts, and anything that matches more than one. A phone number
the bot typed that is not already a conversation is refused outright. This is
the rule that stops a hallucinated or prompt-injected number becoming a
recipient, and it is why there is no "message this number" operation.

**Pacing, enforced server-side.** A per-day send cap (default low, owner-visible
in connection settings), a minimum gap between sends, and a typing delay
proportional to message length. The gateway refuses past the cap rather than
queueing — a run that silently spends tomorrow's budget is how volume becomes a
ban. Sends are serialized per connection.

**Inbound is untrusted input.** Messages the owner receives are wrapped as
quoted third-party content carrying the standing rule that instructions inside
them are not the owner's instructions. Anyone who can message the owner can
otherwise write directly into a full-access bot's prompt, and unlike the
business API, _anyone with their number can_. This is the sharpest difference
between this route and the one the first draft proposed, and it is the reason
`read_chat` is a separate low-risk operation a bot must deliberately call
rather than a feed pushed into context.

**Egress.** The existing sensitive-site guard covers the browsing this feature
does, so WhatsApp content cannot be carried out to another site by the same
turn that read it.

## Implementation notes

The shared browser drives the page; there is no third-party WhatsApp library in
the dependency tree. That is a deliberate trade: a library like
`whatsapp-web.js` or Baileys would be less brittle against UI changes, but it
would either reimplement the protocol (a much louder signal to WhatsApp, and a
much larger supply-chain surface) or run its own browser beside the one this
app already guards. Reusing the shared browser keeps one session, one profile,
one egress guard and one takeover path.

Page automation is therefore the fragile part, and the design says so: selectors
will break when WhatsApp ships UI changes. Operations fail closed with a clear
"WhatsApp's page has changed" refusal rather than clicking something else.
Nothing retries a send it cannot confirm.

## Testing

Fixtures only, no live sends in tests: recipient resolution including the zero-
match and multi-match refusals, the daily cap and minimum gap at their
boundaries, approval binding across a changed recipient or changed text,
inbound wrapping, session-expiry to `needs_reauth`, and a page-shape change
refusing rather than proceeding. Fake-token assertions do not apply — there is
no token — but the session must never be exported, copied or logged, and that
is asserted.

Live verification: one message to the owner's own second device, with the owner
present.

## What would make this safer, if the risk ever bites

If the account is ever restricted, the fallback is the Business Cloud API
design in this file's previous revision (git history), which is compliant but
sends from a separate business number. Keeping the operation surface small and
the gateway boundary identical means that swap is an adapter change, not a
rewrite.
