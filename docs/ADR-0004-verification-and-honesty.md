# ADR-0004: Verification is structural, not conventional

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** 1

## Context

Spec §29 ("verification is mandatory"), §93 ("never hallucinate success") and
development rule 25 ("never pretend an operation succeeded if it was not
verified") all state the same requirement. Stated as a convention, it decays:
the tenth tool author forgets, and the agent starts confidently reporting work
it never did. That is the single worst failure mode for this product — worse
than crashing, because the user acts on the false report.

## Decision

Make verification impossible to skip, at four independent layers.

### 1. The type system

`AgentTool` requires a `verification` field:

- `'explicit'` — the tool supplies `verify()`, which **re-observes real state**.
- `'intrinsic'` — the tool is a pure read whose return value *is* the
  observation.

There is no third option and no default.

### 2. Registration

`ToolRegistry.register()` rejects, at process start:

- `verification: 'explicit'` with no `verify()` function;
- `verification: 'intrinsic'` on any tool whose permission is not `read` —
  nothing that changes the world may claim to be self-verifying.

A malformed tool therefore fails on launch, in every environment, rather than
at the moment a user asks it to do something.

### 3. The state machine

`TRANSITION_TABLE` has **no edge from `executing` to `completed`**, and none
from `observing` or `recovering` either. The only route to `completed` is
through `verifying`. A recovered step must be re-verified before it may claim
success.

### 4. The executor and the report

`StepExecutor` runs the verifier even when the tool reports failure — "the tool
said it failed" and "nothing changed" are different claims, and a partially
applied failure is exactly what a user needs told about.

Three outcomes, kept distinct all the way to the user:

| Verifier says | Step status | User sees |
| --- | --- | --- |
| `verified` | `succeeded` | "Done." |
| `failed` | `failed` (code `VERIFICATION_FAILED`) | the failure — **the world wins over the tool's claim** |
| could not run | `succeeded_unverified` | "…but could not confirm it. I have not assumed that succeeded." |

`succeeded_unverified` exists precisely so the agent has vocabulary for "I did
something and cannot prove it worked." A verifier that throws yields
`unverified`, never `verified`.

## A bug this caught during Phase 1

`Agent.summarise()` originally short-circuited single-step tasks with
`"Done. ${description}."` *before* checking the unverified count — so a one-step
task would report a confident "Done." for work that was never confirmed. The
test written from this ADR failed, and the ordering was fixed: failure and
unverified cases are now checked first, and the shortcut only applies to a
verified step.

That is the argument for structural enforcement in one paragraph: the rule was
understood, written down, and still violated by the person who wrote it down.
