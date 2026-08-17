# Agent Note: LLM balance query seam and the Session-header balance capsule

Status: implemented

English | [中文](2026-08-17-llm-balance-query-seam.zh.md)

## Problem

The Session Header needed the remaining balance of the API key serving the Session's current model. The harness had no provider-neutral way to interrogate account balance: keys live on the host behind the credentials seam, adapters own their endpoints, and the browser cannot call provider endpoints directly. DeepSeek's platform serves `GET /user/balance` beside chat completions; nothing in the harness spoke it.

## Decision

Three seams, each owned where its authority already lives.

**A balance seam on `LlmRuntime`, keyed by settings namespace.** `registerBalanceQuery(settingsNs, query)` mirrors `registerModelDiscovery`: the namespace names the provider whose endpoint and credential the query resolves, and the query reads stored configuration rather than a caller-supplied draft. Registration is an effect — one offer per namespace (`INVALID_BALANCE_QUERY`/`DUPLICATE_BALANCE_QUERY`), disposed with the calling fiber. `queryBalance(settingsNs, signal?)` validates and detaches every returned entry; an unregistered namespace fails with `NO_BALANCE_QUERY`, and absence of a registration is the unsupported signal consumers surface — never an empty or zero balance.

**The DeepSeek adapter implements it.** `dsh-llm-deepseek` registers the query under its `llm-deepseek` namespace, reusing the plugin's per-operation resolution hooks so the balance request follows the same endpoint/key pairing rule as model requests. `balance_infos` entries map to provider-neutral values; keyless requests, non-200 replies, and unexpected documents fail with the credential seam's codes or `BALANCE_UNAVAILABLE`, never an opaque transport error.

**One trusted RPC and one browser occupant.** The gateway gains `llm.balance({ provider })`: it validates the provider against the configurable-provider directory, resolves the owning settings namespace, and asks `queryBalance`; a missing route or an unregistered query surfaces a structured RPC error the client reads as "unsupported". Because the reply discloses account finances of the host's stored key, `llm.balance` joins the trusted-hosts-only method set — anonymous LAN callers cannot reach it. `@deepseek-ai/dsh-client-ui-balance-indicator` registers one `conversation.session.header.utilities` occupant at order `-10`, left of the `Session log` button: mount resolves the Session's current-model provider through `session.models` and fetches once; a click re-fetches reusing the known provider. Failed and unsupported states render `--`.

## Alternatives considered

**Token-usage projection instead of account balance.** Rejected: the requirement is the key's remaining balance — account-level financial data. Usage projection answers a different question and cannot recover top-ups or other spends.

**Key the seam by provider route.** Rejected: the balance query reads stored configuration, which the settings namespace owns; keying by route would invite drafts and naming races. The model-discovery precedent already fixed the namespace-keyed pattern for the same authority argument.

**Browser-side provider interrogation.** Rejected: the credential never leaves the host, and a browser fetch would pair the key with whatever endpoint the page names.

**Scheduled polling.** Rejected: the balance changes on external top-ups, not on turns. One fetch per mount plus a click refresh keeps provider traffic bounded and gesture-owned.

## Consequences

A future provider adds balance support by registering one query under its own settings namespace — no core or UI change; the capsule and the RPC read the missing registration as "unsupported", never zero. `NO_BALANCE_QUERY` and the structured RPC error are the load-bearing unsupported signals; consumers must not translate them into a zero presentation.

The trusted-hosts-only classification is load-bearing: `llm.balance` answers with the host key's account finances, so carriers must keep it out of anonymous reach, like `credentials.describe`. Surfaces composed onto an untrusted carrier must treat the method as unavailable.

The capsule shows only the first currency entry at two decimals and never polls; multi-currency presentation and scheduled refresh are deferred until a consumer needs them.
