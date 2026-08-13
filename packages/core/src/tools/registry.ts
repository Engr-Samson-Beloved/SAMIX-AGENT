import { z } from 'zod';
import type { AgentMode, AgentTool, ToolDescriptor } from '@samix/shared';

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
   * Project tools into the JSON-Schema shape LLM tool-calling APIs expect
   * (spec §7). Filtered by mode so the model is never told about a capability
   * the current mode forbids.
   *
   * Phase 3 consumes this. It lives here rather than in the AI layer because the
   * registry owns the schemas, and duplicating the projection per provider is how
   * providers drift out of sync.
   *
   * ## Provider caveat — read before wiring Gemini
   *
   * The `{ name, description, input_schema }` shape below is Anthropic's.
   * Gemini expects `functionDeclarations` with a `parameters` object, and
   * accepts only a restricted OpenAPI-style subset of JSON Schema — it rejects
   * `$ref`/`$defs`, `additionalProperties` and some `anyOf` positions that
   * `z.toJSONSchema()` emits happily.
   *
   * Phase 3 must therefore make this method provider-aware and add a sanitiser,
   * rather than assuming this output is portable. Keep the projection here (one
   * place, testable against every registered tool) and the wire format inside
   * the provider module.
   */
  toLlmSchemas(mode: AgentMode): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return this.availableIn(mode).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.inputSchema as z.ZodType, {
        // Tool schemas are sent to a model, not used for local validation, so
        // unrepresentable constructs should degrade rather than throw.
        unrepresentable: 'any',
        io: 'input',
      }) as Record<string, unknown>,
    }));
  }
}
