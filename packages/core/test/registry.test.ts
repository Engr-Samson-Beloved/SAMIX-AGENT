import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ok, verification, type AgentTool } from '@samix/shared';
import { ToolRegistrationError, ToolRegistry, systemGetInfoTool } from '../dist/index.js';
import { matchObject } from './helpers.ts';

/**
 * The registry enforces the invariants the type system cannot (spec §11, §29).
 * These tests prove a badly-formed tool cannot reach the executor.
 */

function baseTool(overrides: Partial<AgentTool<unknown, unknown>> = {}): AgentTool<unknown, unknown> {
  return {
    name: 'demo.doThing',
    description: 'A perfectly adequate description that comfortably exceeds the minimum length.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: z.object({}),
    verification: 'intrinsic',
    execute: () => Promise.resolve(ok({})),
    ...overrides,
  } as AgentTool<unknown, unknown>;
}

describe('registration rules', () => {
  it('accepts a well-formed tool', () => {
    const registry = new ToolRegistry();
    assert.doesNotThrow(() => registry.register(baseTool()));
    assert.equal(registry.size, 1);
  });

  it('requires a dot-namespaced lowercase name', () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register(baseTool({ name: 'doThing' })), ToolRegistrationError);
    assert.throws(() => registry.register(baseTool({ name: 'Filesystem.Copy' })), ToolRegistrationError);
  });

  it('refuses to silently replace an existing tool', () => {
    const registry = new ToolRegistry();
    registry.register(baseTool());
    assert.throws(() => registry.register(baseTool()), /already registered/);
  });

  it('rejects a stub description that would mislead the planner', () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register(baseTool({ description: 'does stuff' })), /20 characters/);
  });

  /** Spec §29 — the invariant that keeps "verified" honest. */
  it('rejects explicit verification with no verifier', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () =>
        registry.register(
          baseTool({ permission: 'write', reversibility: 'reversible', verification: 'explicit' }),
        ),
      /no verify\(\) function/,
    );
  });

  it('rejects intrinsic verification on anything that mutates state', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.register(baseTool({ permission: 'write', verification: 'intrinsic' })),
      /only read-only tools/,
    );
  });

  it('requires describeEffect on external and destructive tools', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () =>
        registry.register(
          baseTool({
            name: 'demo.destroy',
            permission: 'destructive',
            reversibility: 'irreversible',
            verification: 'explicit',
            verify: () => Promise.resolve(verification('verified', 'checked')),
          }),
        ),
      /describeEffect/,
    );
  });

  it('accepts a mutating tool that supplies a verifier and an effect description', () => {
    const registry = new ToolRegistry();
    assert.doesNotThrow(() =>
      registry.register(
        baseTool({
          name: 'demo.send',
          permission: 'external',
          reversibility: 'irreversible',
          verification: 'explicit',
          verify: () => Promise.resolve(verification('verified', 'confirmed in conversation')),
          describeEffect: () => 'Send a message to Charles',
        }),
      ),
    );
  });
});

describe('mode filtering', () => {
  const registry = new ToolRegistry();
  registry.register(baseTool({ name: 'demo.always' }));
  registry.register(baseTool({ name: 'demo.devOnly', availableInModes: ['developer'] }));

  it('hides mode-gated tools from other modes', () => {
    assert.deepStrictEqual(
      registry.availableIn('controlled').map((t) => t.name),
      ['demo.always'],
    );
    assert.ok(registry.availableIn('developer').map((t) => t.name).includes('demo.devOnly'));
  });

  it('projects LLM schemas only for available tools', () => {
    const schemas = registry.toLlmSchemas('controlled');
    assert.deepStrictEqual(
      schemas.map((s) => s.name),
      ['demo.always'],
    );
    matchObject(schemas[0]?.parameters, { type: 'object' });
  });

  it('emits provider-neutral JSON Schema, leaving the dialect to the provider', () => {
    const [schema] = registry.toLlmSchemas('controlled');
    // The registry is the single source of the schemas; translating them into
    // any one API's subset happens in that provider's module, so nothing here
    // may be shaped like a particular vendor's payload.
    assert.ok(schema && !('input_schema' in schema), 'no Anthropic-specific key');
    assert.ok(schema && !('functionDeclarations' in schema), 'no Gemini-specific key');
    assert.deepStrictEqual(Object.keys(schema!).sort(), ['description', 'name', 'parameters']);
  });
});

describe('descriptors', () => {
  it('produces a UI-safe projection with no functions', () => {
    const registry = new ToolRegistry();
    registry.register(systemGetInfoTool as unknown as AgentTool<never, unknown>);
    const [descriptor] = registry.describe();
    matchObject(descriptor, { name: 'system.getInfo', permission: 'read' });
    assert.ok(!JSON.stringify(descriptor)?.includes('function'));
  });
});
