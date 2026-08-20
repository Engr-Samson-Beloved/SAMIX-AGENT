import {
  PERMISSION_RANK,
  type ActionTarget,
  type AgentMode,
  type AgentTool,
  type AutomationConfig,
  type PermissionLevel,
  type Reversibility,
  type SecurityConfig,
} from '@samix/shared';

/**
 * Permission and confirmation engine (spec §31, §32, §55).
 *
 * This is the single choke point every tool invocation passes through. There is
 * no second path to execution — the executor cannot run a tool without a
 * `Decision` from here, and `Decision` is only constructible by this module.
 *
 * The policy is expressed as a data table rather than nested conditionals so it
 * can be read, reviewed and exhaustively tested. Security rules that live in
 * branching code are rules nobody can audit.
 */

export type Effect = 'allow' | 'confirm' | 'deny';

export interface Decision {
  readonly effect: Effect;
  /** Shown to the user in the prompt, and recorded in the audit trail. */
  readonly reason: string;
  readonly permission: PermissionLevel;
  /** Which rule produced this outcome — invaluable when debugging policy. */
  readonly rule: string;
}

export interface PermissionQuery {
  readonly tool: Pick<AgentTool, 'name' | 'permission' | 'reversibility'> & {
    readonly availableInModes?: readonly AgentMode[];
  };
  readonly mode: AgentMode;
  readonly automation: Pick<AutomationConfig, 'alwaysConfirm'>;
  /**
   * Set once the user approves "the rest of this task". Scoped to a single task
   * by the caller; it is never persisted (see ConfirmationResponse).
   */
  readonly taskApproved?: boolean;
  /**
   * What the invocation is aimed at (Phase 7 §5). Absent for every tool that
   * does not act on someone else's user interface, which is most of them.
   */
  readonly target?: ActionTarget;
  /** Supplies `trustedApplications`. Absent means nothing is trusted. */
  readonly security?: Pick<SecurityConfig, 'trustedApplications'>;
}

/**
 * Base policy: permission level × mode → effect.
 *
 * Reading the table:
 *  - `safe` is read-only, full stop (spec §55).
 *  - `controlled` is the default: mutations proceed if reversible, everything
 *    outward-facing or unrecoverable stops for a human.
 *  - `autonomous` relaxes writes fully and *may* relax external/destructive —
 *    but only where config permits (see `alwaysConfirm` below). Spec §32:
 *    "confirmation unless explicitly configured otherwise".
 *  - `developer` is `controlled` plus access to developer-gated tools. It is
 *    deliberately NOT more permissive about confirmation: a programmer wants
 *    more capability, not fewer guardrails.
 */
const BASE_POLICY: Readonly<Record<PermissionLevel, Readonly<Record<AgentMode, Effect>>>> = {
  read: {
    safe: 'allow',
    controlled: 'allow',
    autonomous: 'allow',
    developer: 'allow',
  },
  write: {
    safe: 'deny',
    controlled: 'allow', // refined below by reversibility
    autonomous: 'allow',
    developer: 'allow',
  },
  external: {
    safe: 'deny',
    controlled: 'confirm',
    autonomous: 'confirm',
    developer: 'confirm',
  },
  destructive: {
    safe: 'deny',
    controlled: 'confirm',
    autonomous: 'confirm',
    developer: 'confirm',
  },
  system: {
    safe: 'deny',
    controlled: 'confirm',
    autonomous: 'confirm',
    developer: 'confirm',
  },
};

/**
 * Levels that can never be silently auto-approved, whatever the mode or config
 * says. `system` touches the registry, drivers, firewall and security settings
 * (spec §31); there is no configuration in which the agent should reconfigure
 * the machine's security posture without a human seeing it.
 *
 * This is the floor that `alwaysConfirm` and AUTONOMOUS mode cannot drill
 * through, and it is why the config option is a *widening* switch only.
 */
const NEVER_AUTO_APPROVE: ReadonlySet<PermissionLevel> = new Set(['system']);

/**
 * Element names that always require confirmation, in every mode, including
 * AUTONOMOUS, and regardless of per-task approval (Phase 7 §5).
 *
 * Matched as a case-insensitive **substring**, not on word boundaries. "Resend",
 * "Payment", "Submit form" and "Delete all" must all be caught, and a boundary
 * match misses the first two. The cost of a false positive is one prompt; the
 * cost of a false negative is a message sent, or money moved, that nobody
 * approved. This rule only ever tightens, so the asymmetry is the right way
 * round.
 */
const DANGEROUS_ELEMENT_WORDS = [
  'send',
  'delete',
  'remove',
  'pay',
  'confirm',
  'submit',
  'purchase',
  'discard',
  'transfer',
] as const;

/** The matched word, so the prompt can say which one triggered. */
export function dangerousWordIn(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const haystack = name.toLowerCase();
  return DANGEROUS_ELEMENT_WORDS.find((word) => haystack.includes(word));
}

/**
 * Is this application one the user has explicitly trusted?
 *
 * Compared case-insensitively against the configured list, allowing either the
 * registry id or the bare process name, because a window reports the latter and
 * the config is documented in terms of the former.
 *
 * Nothing is ever added here at runtime. An agent that trusted an application
 * because it had seen it before would be one prompt away from trusting whatever
 * a malicious page persuaded it to open.
 */
function isTrustedApplication(
  application: string | undefined,
  trusted: readonly string[] | undefined,
): boolean {
  if (!application || !trusted || trusted.length === 0) return false;
  const needle = application.trim().toLowerCase().replace(/\.exe$/, '');
  if (needle === '') return false;
  return trusted.some((entry) => entry.trim().toLowerCase().replace(/\.exe$/, '') === needle);
}

export class PermissionEngine {
  /**
   * Is this tool offered to the planner at all in the current mode?
   *
   * Checked before permission, and before tool schemas are sent to the LLM: a
   * capability the model never hears about is one it cannot try to use. Cheaper
   * and more reliable than denying it after the model has planned around it.
   */
  isAvailable(
    tool: Pick<AgentTool, 'name'> & { readonly availableInModes?: readonly AgentMode[] },
    mode: AgentMode,
  ): boolean {
    if (!tool.availableInModes) return true;
    return tool.availableInModes.includes(mode);
  }

  /** Evaluate one prospective tool invocation. */
  evaluate(query: PermissionQuery): Decision {
    const { tool, mode, automation, taskApproved, target, security } = query;
    const permission = tool.permission;

    // 0. Availability gate. Denied outright rather than confirmed: the tool does
    //    not exist for this mode, so there is nothing to approve.
    if (!this.isAvailable(tool, mode)) {
      return {
        effect: 'deny',
        permission,
        rule: 'mode-availability',
        reason: `"${tool.name}" is not available in ${mode.toUpperCase()} mode.`,
      };
    }

    // 0.5 The agent's own window. DENY, not confirm (Phase 7 §5, rule 8).
    //
    //     Checked before anything else because no later rule should be able to
    //     reach it, and because a prompt is the wrong shape of answer: the agent
    //     asking permission to close the console it is speaking through leaves
    //     nothing able to report the outcome either way.
    if (target?.ownWindow === true) {
      return {
        effect: 'deny',
        permission,
        rule: 'floor:own-window',
        reason:
          `That is the agent's own window. It will not act on itself — ` +
          `name a different window, or ask again once something else is in front.`,
      };
    }

    let effect = BASE_POLICY[permission][mode];
    let rule = `base:${permission}/${mode}`;
    let reason = describeBase(permission, mode, effect);

    // 1. Reversibility refinement (spec §32: "automatic if clearly reversible").
    //    Only ever tightens `allow` → `confirm`; it never loosens.
    if (effect === 'allow' && permission === 'write' && mode !== 'autonomous') {
      if (tool.reversibility !== 'reversible') {
        effect = 'confirm';
        rule = `reversibility:${tool.reversibility}`;
        reason = describeIrreversible(tool.reversibility);
      }
    }

    // 2. Config widening. `alwaysConfirm` can only escalate allow → confirm.
    //    It has no power to turn a confirm into an allow, so a misconfiguration
    //    can make the agent more cautious but never less.
    if (effect === 'allow' && automation.alwaysConfirm.includes(permission)) {
      effect = 'confirm';
      rule = 'config:alwaysConfirm';
      reason = `Settings require confirmation for all ${permission.toUpperCase()} actions.`;
    }

    // Reading someone's window is a read (Phase 7 §5): it observes and transmits
    // nothing. Neither the trust axis nor the element-name floor applies to one,
    // and gating them here rather than at each rule keeps that a single fact
    // rather than three that could drift apart.
    //
    // The own-window rule above is deliberately NOT covered by this: it is a
    // refusal rather than a prompt, and it costs nothing to hold for reads too.
    const acting = permission !== 'read';

    // 3. Application scope (Phase 7 §5). Acting inside an application the user
    //    has explicitly trusted runs as normal; anywhere else, ask.
    //
    //    Only ever allow → confirm. An untrusted application cannot make a
    //    confirmed action automatic, and a trusted one cannot make a confirmed
    //    action skip its prompt — trust widens nothing, it only avoids a
    //    tightening.
    if (acting && effect === 'allow' && target !== undefined && target.application !== undefined) {
      if (!isTrustedApplication(target.application, security?.trustedApplications)) {
        effect = 'confirm';
        rule = 'app-trust:untrusted';
        reason =
          `${target.application} is not in your trusted applications, so acting inside it ` +
          `needs your confirmation.`;
      }
    } else if (acting && effect === 'allow' && target !== undefined) {
      // A target with no application at all. The tool could not tell which
      // program it was aiming at, which is strictly less information than an
      // untrusted name, so it cannot be the safer case.
      effect = 'confirm';
      rule = 'app-trust:unknown';
      reason = 'I could not tell which application this would act on, so it needs your confirmation.';
    }

    // 4. Hard floors that a per-task approval must not pierce.
    //
    //    Computed BEFORE the task-approval rule below, because "approve the rest
    //    of this task" is exactly the answer a user gives once and then stops
    //    reading — and these are the actions that must still stop them.
    const dangerous = acting ? dangerousWordIn(target?.elementName) : undefined;
    const rawCoordinates = acting && target?.rawCoordinates === true;
    const floored =
      NEVER_AUTO_APPROVE.has(permission) || dangerous !== undefined || rawCoordinates;

    // 5. Per-task blanket approval. Applies only to what would have been a
    //    prompt, and never to a floor.
    if (effect === 'confirm' && taskApproved === true && !floored) {
      return {
        effect: 'allow',
        permission,
        rule: 'task-approval',
        reason: 'You approved the remaining steps of this task.',
      };
    }

    // 6. The floors themselves, re-asserted last so no earlier branch can have
    //    bypassed one. Each raises `allow` to `confirm`, in every mode including
    //    AUTONOMOUS.
    //
    //    They never touch a `deny`. A floor exists to stop something running
    //    unattended; turning SAFE mode's outright refusal into a prompt would
    //    make a rule whose entire purpose is to tighten into one that loosens.
    //    An early version did exactly that, and the test for "it confirms in
    //    every mode" is what caught it.
    if (effect === 'deny') return { effect, permission, rule, reason };

    if (dangerous !== undefined) {
      return {
        effect: 'confirm',
        permission,
        rule: 'floor:dangerous-element',
        // The element's own words, verbatim and quoted. A paraphrase is how a
        // user approves "the send button" and discovers it said "Send to all".
        reason:
          `This would act on "${target?.elementName}", which reads as a ${dangerous.toUpperCase()} ` +
          `action. Actions like this always ask, in every mode.`,
      };
    }

    if (rawCoordinates) {
      return {
        effect: 'confirm',
        permission,
        rule: 'floor:raw-coordinates',
        reason:
          'This clicks a screen position rather than a named control, so what it lands on ' +
          'cannot be checked in advance. Coordinate clicks always ask.',
      };
    }

    if (effect === 'allow' && NEVER_AUTO_APPROVE.has(permission)) {
      return {
        effect: 'confirm',
        permission,
        rule: 'floor:never-auto-approve',
        reason: `${permission.toUpperCase()}-level actions always require explicit confirmation.`,
      };
    }

    return { effect, permission, rule, reason };
  }

  /**
   * Highest permission level the mode can reach without a prompt. Used by the
   * UI to explain the current mode, and by the planner prompt in Phase 3 to
   * tell the model what will require the user's attention.
   */
  autoApprovedCeiling(mode: AgentMode, automation: Pick<AutomationConfig, 'alwaysConfirm'>): PermissionLevel {
    const levels: PermissionLevel[] = ['read', 'write', 'external', 'destructive', 'system'];
    let ceiling: PermissionLevel = 'read';
    for (const level of levels) {
      const decision = this.evaluate({
        tool: { name: '(probe)', permission: level, reversibility: 'reversible' },
        mode,
        automation,
      });
      if (decision.effect === 'allow' && PERMISSION_RANK[level] >= PERMISSION_RANK[ceiling]) {
        ceiling = level;
      }
    }
    return ceiling;
  }
}

function describeBase(permission: PermissionLevel, mode: AgentMode, effect: Effect): string {
  if (effect === 'deny') {
    return mode === 'safe'
      ? `SAFE mode is read-only, so ${permission.toUpperCase()} actions are refused.`
      : `${permission.toUpperCase()} actions are not permitted in ${mode.toUpperCase()} mode.`;
  }
  if (effect === 'confirm') {
    return `${permission.toUpperCase()} actions require your confirmation.`;
  }
  return `${permission.toUpperCase()} actions run automatically in ${mode.toUpperCase()} mode.`;
}

function describeIrreversible(reversibility: Reversibility): string {
  return reversibility === 'irreversible'
    ? 'This change cannot be undone, so it needs your confirmation.'
    : 'It is unclear whether this change can be undone, so it needs your confirmation.';
}
