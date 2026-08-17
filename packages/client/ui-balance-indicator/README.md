# @deepseek-ai/dsh-client-ui-balance-indicator

English | [中文](README.zh.md)

Web Session-header balance capsule. The Host half is a no-op; the browser half owns one `conversation.session.header.utilities` occupant presenting the remaining balance of the API key stored for the Session's current-model provider. The balance interrogation itself belongs to the [dsh-llm](../../llm/llm/README.md) `registerBalanceQuery`/`queryBalance` seam, surfaced through `dsh-host-apiproxy`'s `llm.balance`; this package only resolves, presents, and refreshes it.

## Behavior

On mount the capsule resolves the Session's current-model provider through `session.models`, then queries that provider's account balance through `llm.balance`. A click re-fetches the balance, reusing the resolved provider. Concurrent clicks share one in-flight operation per Session; plugin disposal aborts in-flight queries, and late resolutions publish nothing.

The capsule presents three states: `…` while loading; the available balance when the query reports one — the first currency entry, symbol chosen by currency code, amount at two fixed decimals, e.g. `Balance ¥12.34`; and `--` on failure, an empty report, or a provider that registers no balance query. `--` is the explicit unsupported presentation — absence is never rendered as zero.

The balance is account-level financial data of the host's stored key, not per-session token usage: every Session sharing one key shows the same figure. The capsule fetches once on mount and does not poll.

## Composition

```yaml
- id: ui-balance-indicator
  name: '@deepseek-ai/dsh-client-ui-balance-indicator'
```

The Web bundle mounts the package beside `dsh-client-ui-conversation`. The occupant registers with order `-10`, which renders it left of the default-order `Session log` button in the right-aligned utilities list. `llm.balance` is a trusted-hosts-only RPC method: the reply discloses account finances of the host's stored key, so anonymous LAN callers cannot reach it.

## Model Experience

### Balance capsule

#### What the model sees

Nothing. The `session.models` provider resolution and the `llm.balance` interrogation never enter model history.

#### Token effect

Zero. The capsule creates no model turn.

#### KV Cache effect

None. Host-side reads do not change the derived request prefix.

## Known Limitations and Deferred Work

- **Only DeepSeek registers a balance query** — `dsh-llm-deepseek` implements `/user/balance`; Sessions on other providers show `--` until their adapter registers one.
- **Only the first currency entry is shown** — a provider reporting several currencies needs a richer presentation.
- **No scheduled refresh** — the balance updates on mount and on click only; an external top-up becomes visible on the next gesture.
