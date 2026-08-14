# ADR-0005: The model proposes, the runtime disposes

- **Status:** Accepted
- **Date:** 2026-08-14
- **Phase:** 3

## Context

Phase 3 puts a language model inside the agent loop. The model is now the thing
that decides what the computer does — which files get touched, which messages
get sent. Everything the earlier ADRs built (the permission table, the path
policy, the verification gate) was written on the assumption that *something*
would eventually propose actions, and that the something would be untrustworthy.

The engine is Google Gemini (the user's choice, and the key we have). But spec
§6 requires the provider to be swappable, and a Flash-class key today may be a
Pro key or a local model tomorrow.

Three decisions were live, and each had a cheap-and-wrong option.

## Decision 1 — the provider boundary is a hard wall

`packages/core/src/ai/` is the only place in the codebase that may know a
provider exists. Outside it there is `LlmProvider`, `LlmRequest`, `LlmResponse`
and `LlmError`, and nothing named "Gemini", "Google" or "functionDeclarations".

The planner class is therefore `LlmPlanner`, not `GeminiPlanner` as TODO.md
originally called it. That rename is the whole point: if the planner had been
named for the provider, provider-shaped assumptions would have leaked into it
within a week.

`createProvider()` **throws** for providers we have not written. The tempting
alternative — fall back to Google — would mean a user selecting "anthropic" in
Settings silently sends their prompts to a different company.

### No SDK

`GoogleProvider` speaks REST over `fetch`. `@google/genai` would have been fewer
lines, but:

- Retry, backoff and cancellation semantics are load-bearing here and must be
  *ours*, not whatever the SDK decides. Cancellation in particular has to be
  checked before every attempt and must never be retried.
- The wire format was verified empirically against the live API by
  `pnpm check:gemini` before a line of the provider was written, so there is no
  documentation risk the SDK is protecting us from.
- Installer size. This ships as a desktop app.

## Decision 2 — the schema projection is an allow-list

Gemini accepts a restricted OpenAPI-flavoured subset of JSON Schema, and rejects
the **entire request** when any single function declaration contains a keyword
it does not know. One bad tool schema does not degrade that tool; it kills tool
calling for every tool at once. With `z.toJSONSchema()` emitting `$ref`, `$defs`
and `additionalProperties` freely, that is a live hazard on every new tool.

`ai/json-schema.ts` therefore **copies keywords it understands** rather than
stripping keywords it knows are bad. The deny-list version is easier to write
and fails in exactly the wrong direction: the day Zod emits something new, a
deny-list ships it to Google and takes down tool calling in production, while an
allow-list drops it and logs a warning.

Degradation is reported, never silent — `runtime.ts` projects every registered
tool at startup and logs each warning, and `pnpm check:llm` asserts that no
forbidden keyword reaches the wire.

## Decision 3 — every model output is re-validated

The model's output is treated as a *proposal from an untrusted source*, which is
what it is. Before any step reaches the executor, `LlmPlanner` checks that:

- the tool exists in the registry (a hallucinated name gets one repair
  round-trip, then an honest give-up);
- the tool is available in the **current mode**, so the model cannot reach a
  developer-mode tool by asking for it in CONTROLLED;
- the arguments parse against the tool's real Zod schema, not the projected
  Gemini one — the projection is lossy by design, so the projection must never
  be the thing that validates.

Two subtler rules, both of which exist because the failure they prevent is a
*silent* one:

- `finishReason === 'max_tokens'` means the plan is truncated. A truncated plan
  is never executed — half of a multi-step plan is not a safe prefix of it.
- During `recover()`, a prose-only answer is a **give-up**, never a `reply`. A
  `reply` drives `Agent.complete()`, so accepting one would let a model talk a
  failed task into being marked complete.

The permission engine, path policy and verification gate all still sit
downstream. The model cannot reach any of them; it can only ask.

## Consequence: the REPORT stage, and where honesty lives

Giving the model the last word is what makes the agent useful — "System: get
info" is not an answer to "what OS am I running". So `Planner.summarise()` was
added to the loop, feeding succeeded steps' results back with **no tools
offered**.

But the model must not be the one deciding whether the work went well, because
"everything worked perfectly!" is exactly the sentence a language model likes to
write. So `Agent.report()` consults `tasks.outcome()` first and only invites a
written summary when `failed === 0 && unverified === 0`. Otherwise the
mechanical summary — the one ADR-0004 built — is used verbatim.

The model is never *asked* to describe work it might be tempted to overstate.
That is the same structural argument as ADR-0004, applied one layer up: a test
asserts the planner's `summarise()` is not called at all when a step is
unverified, so no amount of prompt engineering can weaken it.

## Fallback

`HybridPlanner` picks between `LlmPlanner` and the Phase 1 rule-based planner
per turn, by asking the secret store whether a key exists. Per turn, not at
construction, for two reasons: the composition root is synchronous while the
secret store is not, and a key pasted into Settings should work on the next
instruction rather than after a restart. A secret store that throws degrades to
the rule-based planner instead of taking the agent down.
