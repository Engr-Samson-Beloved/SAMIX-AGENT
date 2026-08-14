import { z } from 'zod';
import type { AgentMode, AgentTool, ToolDescriptor } from '@samix/shared';
import type { ToolSchema } from '../ai/types.js';

/**
 * Tool registry (spec §11).
 *
 * Responsibilities, in order of importance:
 *
 *  1. **Enforce the tool contract at registration time.** Invariants that the
 *     type system cannot express — "a tool that mutates state must supply a
 *     verifier" — are checked here, when the tool is registered, which is at
 *     process start. A malformed tool therefore fails on launch, in every
 *     environment, rather than at the moment a user asks it to do something.
 *  2. **Be the only source of executable tools.** The executor resolves tools
 *     exclusively through `get`. Nothing else holds a tool reference, so there
 *     is no way to invoke a capability that was never registered and never
 *     permission-checked.
 *  3. **Project tools into LLM schemas** (Phase 3), filtered by mode, so the
 *     model is only ever told about capabilities it is allowed to use.
 */

export class ToolRegistrationError extends Error {
  constructor(toolName: string, problem: string) {
    super(`Cannot register tool "${toolName}": ${problem}`);
    this.name = 'ToolRegistrationError';
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<never, unknown>>();

  /**
   * Register a tool. Rejects, loudly, anything that would weaken a guarantee
   * the rest of the system depends on.
   */
  register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    const { name } = tool;

    if (!NAME_PATTERN.test(name)) {
      throw new ToolRegistrationError(
        name,
        'name must be dot-namespaced lowercase, e.g. "filesystem.copy"',
      );
    }
    if (this.tools.has(name)) {
      // Silent replacement would let a later-loaded module swap a safe tool for
      // a dangerous one under the same name. Refuse instead.
      throw new ToolRegistrationError(name, 'a tool with this name is already registered');
    }
    if (tool.description.trim().length < 20) {
      // The description is the LLM's only guide to when this tool applies. A
      // stub description produces bad tool selection, which reads to the user as
      // the agent being stupid.
      throw new ToolRegistrationError(name, 'description must be at least 20 characters');
    }

    // Spec §29: verification is mandatory. `intrinsic` is only honest for a pure
    // read, whose return value IS the observation. Anything that changes the
    // world must re-observe it, so it must supply `verify`.
    if (tool.verification === 'explicit' && typeof tool.verify !== 'function') {
      throw new ToolRegistrationError(
        name,
        'declares verification "explicit" but provides no verify() function',
      );
    }
    if (tool.verification === 'intrinsic' && tool.permission !== 'read') {
      throw new ToolRegistrationError(
        name,
        `declares verification "intrinsic" but has permission "${tool.permission}"; only read-only tools may be intrinsically verified`,
      );
    }

    // A destructive or external tool must be able to describe what it is about
    // to do, because that sentence is what the user sees in the confirmation
    // prompt (spec §95). Without it the prompt would be uselessly generic.
    if (
      (tool.permission === 'destructive' || tool.permission === 'external') &&
      typeof tool.describeEffect !== 'function'
    ) {
      throw new ToolRegistrationError(
        name,
        `has permission "${tool.permission}" and must implement describeEffect() for confirmation prompts`,
      );
    }

    this.tools.set(name, tool as unknown as AgentTool<never, unknown>);
  }

  registerAll(tools: readonly AgentTool<never, unknown>[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** Resolve a tool by name. Returns undefined rather than throwing. */
  get(name: string): AgentTool<never, unknown> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /** Every registered tool, unfiltered. For diagnostics and tests. */
  all(): readonly AgentTool<never, unknown>[] {
    return [...this.tools.values()];
  }

  /** Tools usable in the given mode. */
  availableIn(mode: AgentMode): readonly AgentTool<never, unknown>[] {
    return this.all().filter((tool) => !tool.availableInModes || tool.availableInModes.includes(mode));
  }

  /** UI-safe projection. Never includes functions. */
  describe(mode?: AgentMode): ToolDescriptor[] {
    const tools = mode ? this.availableIn(mode) : this.all();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      permission: tool.permission,
      reversibility: tool.reversibility,
      verification: tool.verification,
      ...(tool.availableInModes ? { availableInModes: [...tool.availableInModes] } : {}),
    }));
  }

  /**
   * Project tools into provider-neutral schemas for the LLM layer (spec §7),
   * filtered by mode so the model is never told about a capability the current
   * mode forbids.
   *
   * ## Neutral on purpose
   *
   * This emits plain JSON Schema and stops there. It does **not** produce any
   * provider's wire format, because each provider accepts a different subset:
   * Gemini rejects `$ref`/`$defs`, `additionalProperties`, `const` and `allOf`,
   * all of which `z.toJSONSchema()` emits freely, while Anthropic accepts them.
   *
   * The lossy translation therefore belongs in the provider module, where it can
   * be tested against that provider's rules (`ai/json-schema.ts` for Gemini).
   * Doing it here would mean either picking a favourite provider — which is how
   * the Phase 1 version ended up hard-coding Anthropic's shape — or teaching the
   * registry about every API we might ever call.
   *
   * The registry's job is to be the single source of the schemas. Serialising
   * them is somebody else's.
   */
  toLlmSchemas(mode: AgentMode): ToolSchema[] {
    return this.availableIn(mode).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema as z.ZodType, {
        // Tool schemas are sent to a model, not used for local validation, so
        // unrepresentable constructs should degrade rather than throw. The
        // input is re-validated against the real Zod schema before execution.
        unrepresentable: 'any',
        io: 'input',
        // Inline rather than emit `$defs`. Every provider subset we care about
        // either rejects `$ref` outright or handles it inconsistently, and
        // resolving it here means the sanitisers have less to undo.
        cycles: 'ref',
        reused: 'inline',
      }) as Record<string, unknown>,
    }));
  }
}
