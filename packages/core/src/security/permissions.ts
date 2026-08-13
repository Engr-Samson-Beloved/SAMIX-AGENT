import {
  PERMISSION_RANK,
  type AgentMode,
  type AgentTool,
  type AutomationConfig,
  type PermissionLevel,
  type Reversibility,
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
    const { tool, mode, automation, taskApproved } = query;
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

    // 3. Per-task blanket approval. Applies only to what would have been a
    //    prompt, and never to the never-auto-approve floor.
    if (effect === 'confirm' && taskApproved === true && !NEVER_AUTO_APPROVE.has(permission)) {
      return {
        effect: 'allow',
        permission,
        rule: 'task-approval',
        reason: 'You approved the remaining steps of this task.',
      };
    }

    // 4. Hard floor. Re-asserted last so no earlier branch can have bypassed it.
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
