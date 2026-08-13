import { z } from 'zod';

/**
 * Agent operating modes (spec §55).
 *
 * Lives in its own module because both `agent.ts` and `tool.ts` need it, and
 * `agent.ts` already imports from `tool.ts`. Putting it here keeps the import
 * graph acyclic instead of duplicating the literals in two places.
 */

export const AGENT_MODES = ['safe', 'controlled', 'autonomous', 'developer'] as const;
export const AgentModeSchema = z.enum(AGENT_MODES);
export type AgentMode = (typeof AGENT_MODES)[number];
