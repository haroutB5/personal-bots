# hbots Kraken connection

Date: 2026-09-21
Status: design, not yet implemented
Depends on: the Connections framework (`2026-09-20-hbots-connections-design.md`), milestones 1-3

## What this is for

A bot that can answer "what is my portfolio worth", "how has BTC moved this
week", "what did I buy in March" without the owner opening the Kraken app, and
— behind a deliberate second switch — can place an order the owner approves.

## Decisions

**Read-only is the default, and it is a separate connection from trading.**
Kraken API keys carry granular permissions (Query Funds, Query Open/Closed
Orders, Create & Modify Orders, Withdraw Funds). The catalog therefore carries
two vendor entries sharing one adapter:

- `kraken` — the normal connection. The connect screen tells the owner to tick
  Query Funds and Query Ledger Entries only. Validation refuses a key that can
  trade, naming what to untick, so the low-risk connection cannot silently be a
  high-risk one.
- `kraken-trading` — opt-in, connected separately, with its own key. Every
  order-placing operation is `high` risk and always raises an approval card.

The split exists because the access model is "every bot gets every enabled
connection". Without it, enabling portfolio reads for a research bot would hand
order placement to every bot in the roster.

**Withdrawal is not implemented at all.** No withdraw operation exists in the
adapter, so no prompt injection can reach one. The connect screen states that a
key with Withdraw Funds enabled should never be pasted here, and validation
refuses one outright rather than merely warning. This is the single control
that makes a stolen or leaked token a loss of privacy rather than a loss of
funds.

**Auth.** A key pair, not a bearer token: `requiredCredentialFields` is
`["apiKey", "privateKey"]`, and both are sealed under the connection credential
prefix like any other. Private endpoints sign with HMAC-SHA512 over a nonce and
the POST body. Nonces must increase per key; the adapter therefore holds a
monotonic per-connection counter server-side and serializes calls per key, since
two concurrent calls with the same key are the ordinary cause of "invalid
nonce". A Nonce Window is configured on the key as belt and braces.

## Operations

| Operation                      | Risk   | Notes                                     |
| ------------------------------ | ------ | ----------------------------------------- |
| `balance`                      | low    | Account balances by asset                 |
| `trade_balance`                | low    | Equity, margin, unrealized P/L            |
| `ticker`                       | low    | Public market data; no credential needed  |
| `ohlc`                         | low    | Public candles for a pair and interval    |
| `open_orders`, `closed_orders` | low    | Requires Query Orders                     |
| `ledgers`                      | low    | Deposits, withdrawals, trades as recorded |
| `add_order`                    | high   | `kraken-trading` only; always approved    |
| `cancel_order`                 | medium | `kraken-trading` only; always approved    |

Approval cards for `add_order` are server-authored from validated arguments —
pair, side, order type, volume, limit price, and the notional value computed
from the current ticker — so the owner reads what will actually execute rather
than the model's description of it. A market order card says plainly that the
fill price is not knowable in advance.

`validate` on connect resolves the account tier and the key's permission set,
which becomes the connection's `verifiedCapabilities`.

## Result handling

Balances, orders and ledger rows go back through the gateway's allowlist.
Nothing returns the API key, and Kraken error bodies are scrubbed before they
reach a transcript. Amounts are returned as strings exactly as Kraken sends
them; converting a balance to a float in this path would be a rounding bug with
money attached.

## Rate limits

Kraken meters private endpoints by a per-tier counter that decays over time, and
the trading endpoints have their own budget. The adapter tracks the counter per
connection and refuses locally with a clear message rather than burning the
allowance, because a burst of refusals can escalate to a temporary lockout that
affects the owner's real account, not just this app.

## Testing

Fixture-driven against recorded Kraken response shapes: a signing test with
known key material and a fixed nonce proving the signature matches Kraken's
documented algorithm; permission-refusal tests for a trade-capable key on the
read-only connection and for any key carrying Withdraw Funds; nonce
monotonicity under concurrent calls; approval binding for an order, including
that changing the volume after approval invalidates it. No live calls in tests.

Live verification uses the owner's own account with a read-only key first, and a
single minimum-size order for the trading path, deliberately and with the owner
present.

## Open question for the owner

Two-factor on the API key. Kraken can require a second factor on private
endpoints, which would break unattended reads. Recommendation: leave it off for
the read-only key and rely on the key's permissions being narrow, and accept
that the trading key's protection is the approval card rather than a factor the
server would have to hold anyway.
