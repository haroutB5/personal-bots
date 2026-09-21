# hbots WhatsApp connection

Date: 2026-09-21
Status: design, not yet implemented; contains a product limitation the owner should read before this is built
Depends on: the Connections framework (`2026-09-20-hbots-connections-design.md`), milestones 1-3

## The ask, and the honest answer

The ask was "a bot can message people on my behalf". The literal version of
that — a bot typing into the owner's personal WhatsApp account, so recipients
see the owner's usual number and thread — is achievable only by driving
WhatsApp Web through automation. That path is rejected. It breaks WhatsApp's
terms, and the enforcement is account-level: the number gets banned, taking the
owner's personal messaging with it. A feature that can cost the owner their
own WhatsApp account is not worth the convenience, and this app already holds
the line that automation does not impersonate the owner's credentials
elsewhere.

What is buildable is the WhatsApp Business Cloud API: a separate business
number that the bot owns and messages from.

**The limitation, stated plainly: recipients will see messages from a new
business number, not the owner's personal one.** Existing personal threads are
untouched and unreadable by this feature. Anyone who should recognise the
sender has to be told the new number is the owner's. If that is unacceptable,
the right decision is to not build this, and the owner should say so rather
than have it half-built.

## What the Cloud API actually allows

Two regimes, and the distinction drives the whole design:

- **Inside a 24-hour service window** — opened when a person messages the
  business number first — free-form messages are allowed and service replies
  are free.
- **Outside it**, a business may only send a pre-approved _template_, and each
  delivered template is billed per message by category and recipient country.
  Marketing templates are billed on every delivered message even inside the
  window; utility templates are free inside it. Marketing rates run roughly
  $0.025 (US) to $0.13 (Germany) per message.

So "message my mum for me" out of the blue is a billed template send, and its
wording must have been approved by Meta in advance. This is the part that most
surprises people, and the UI has to show it rather than discover it at send
time.

## Design

**Connection.** Vendor id `whatsapp`, token paste of a System User access token
plus the Phone Number ID and WhatsApp Business Account ID. Setup needs a Meta
Business account, a verified business, and a phone number not already
registered to regular WhatsApp — a genuinely multi-step, owner-only prerequisite
that the connect screen walks through and links out to, rather than pretending
is one click. Validation resolves the display name, number and quality rating
into the connection's account metadata.

**Contacts.** The bot never sees a raw address book. Sends target either a
contact the owner has saved in the app, or a number the owner typed into the
approval card. A model-supplied phone number that matches no saved contact is
refused, so a hallucinated or injected number cannot become a recipient.

**Operations.**

| Operation            | Risk | Notes                                                                                                         |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `list_templates`     | low  | Approved templates and their parameters                                                                       |
| `list_conversations` | low  | Threads with an open service window                                                                           |
| `read_conversation`  | low  | Messages in one thread this business received                                                                 |
| `send_template`      | high | Always approved; shows template name, resolved parameter values, recipient, category and the actual cost      |
| `send_message`       | high | Free-form; only valid inside an open 24-hour window, which the server verifies rather than trusting the model |
| `mark_read`          | low  |                                                                                                               |

Every send is `high` and always raises a card. There is no "trusted contact"
exemption: the failure mode is a message sent to a real person in the owner's
name, which cannot be recalled, and no amount of convenience justifies an
unattended path to it. The card is server-authored from validated arguments and
shows the exact rendered text, not the model's summary of it.

**Receiving.** A webhook delivers inbound messages. It needs a public HTTPS
endpoint, which this server does not have by default; the T3 Connect relay is
the intended route, and if it cannot terminate a Meta webhook then inbound is
polled instead and the design says so rather than assuming. Inbound messages
are untrusted input: they are wrapped as quoted content and carry the standing
rule that instructions inside them are not the owner's instructions, since a
stranger messaging the business number would otherwise have a direct line into
a full-access bot's prompt.

**Cost.** Each send's card shows the per-message price for that category and
country. A monthly spend ceiling lives in connection settings, defaulting low,
and the gateway refuses sends past it rather than discovering the bill later.

## Testing

Fixtures only, no live sends in tests: template parameter validation, the
service-window calculation at both edges, refusal of a recipient that matches
no saved contact, approval binding across a changed recipient or changed
parameter, webhook signature verification, inbound message wrapping, and the
spend ceiling refusing at the boundary. Fake-token assertions across results,
logs, errors and persisted rows as with every connection.

Live verification sends one template to the owner's own personal number from the
business number, with the owner present.

## Recommendation

Build this last, after Kraken, and only if the owner accepts the separate-number
limitation. If what the owner actually wants is "reach my contacts as me", the
honest answer is that no compliant API offers it, and the nearest safe
alternatives are the owner's phone itself, or a different channel — SMS through
a provider, or email — where sending under an owner-controlled identity is a
supported use rather than a ban risk.
