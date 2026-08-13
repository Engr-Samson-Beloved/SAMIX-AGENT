# ADR-0002: Permission model — a data table with a hard floor

- **Status:** Accepted
- **Date:** 2026-08-12
- **Phase:** 1

## Context

The agent can control the user's computer. Spec §31 defines five permission
levels, §32 a confirmation policy, and §55 four operating modes. Those three
axes interact, and the interaction is the safety story of the whole product.

The failure mode to design against is not "a rule is wrong" — it is "nobody can
tell what the rules are." Security logic spread through nested conditionals in
an orchestrator is logic no reviewer can audit and no test can pin down.

## Decision

Express the policy as **data, evaluated in a fixed order, behind a single choke
point**.

1. A `BASE_POLICY` table maps `permission level × mode → allow | confirm | deny`.
2. Refinements apply in a documented sequence, and each may only *tighten*:
   - reversibility (spec §32: automatic if clearly reversible),
   - `alwaysConfirm` configuration,
   - per-task blanket approval,
   - a final re-assertion of the hard floor.
3. `PermissionEngine.evaluate()` is the only producer of a `Decision`, and
   `StepExecutor` cannot run a tool without one.

## The invariants

These are the properties the tests enforce (`test/permissions.test.ts`):

- **SAFE mode is read-only.** Every level above `read` is denied outright, not
  merely confirmed.
- **`system` is never auto-approved, in any mode, under any configuration.**
  Registry, drivers, firewall and security settings always stop for a human.
  This is the floor that `alwaysConfirm` and AUTONOMOUS cannot drill through.
- **Configuration can only widen caution, never narrow it.** Removing a level
  from `alwaysConfirm` cannot turn a base-policy `confirm` into an `allow`. A
  misconfigured agent is over-cautious, never under-cautious.
- **Per-task approval is scoped to one task and never persists.** A durable
  blanket allow belongs in Settings, where it is visible and revocable.
- **Availability is checked before permission.** A tool absent from the current
  mode is never described to the LLM, so the model cannot plan around a
  capability it does not have. Cheaper and more reliable than denying it after
  the fact.
- **DEVELOPER is not a permission escalation.** It unlocks *tools*, not
  *fewer prompts*. A programmer wants more capability, not fewer guardrails.

## Consequences

- Adding a permission level means adding a row, and the compiler finds every
  place that must handle it.
- The policy is reviewable by reading one table.
- `describeEffect()` is mandatory on `external` and `destructive` tools,
  enforced at registration time, so a confirmation prompt can never be generic
  (spec §95).

## Path policy is separate but ordered

`PathPolicy` (spec §39) answers a different question — *where* rather than
*what* — and has its own ordering rule: **deny beats trust, unconditionally**.
An `.env` file on a trusted Desktop is still blocked. Path evaluation resolves
`..` segments before matching, so traversal cannot escape a trusted root.
