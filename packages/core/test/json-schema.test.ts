import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { z } from 'zod';
import { toGeminiSchema } from '../dist/index.js';
import { matchObject } from './helpers.ts';

/**
 * The Gemini schema projection.
 *
 * These tests matter more than their size suggests. Gemini rejects an entire
 * request when any one function declaration contains a keyword it does not
 * know, so a single bad tool schema takes down tool calling for every tool. The
 * cases below are the constructs Zod actually emits, checked against what
 * Gemini actually accepts.
 */

/** Convert through Zod exactly as the registry does, so the input is realistic. */
function fromZod(schema: z.ZodType): ReturnType<typeof toGeminiSchema> {
  return toGeminiSchema(
    z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input', cycles: 'ref', reused: 'inline' }),
  );
}

describe('toGeminiSchema', () => {
  test('keeps a plain object schema intact', () => {
    const { schema, warnings } = fromZod(
      z.object({
        path: z.string().describe('Absolute path to the file'),
        recursive: z.boolean().optional(),
      }),
    );

    assert.deepEqual(warnings, []);
    matchObject(schema, {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        recursive: { type: 'boolean' },
      },
      required: ['path'],
    });
  });

  test('strips $schema and additionalProperties, which Gemini rejects', () => {
    const { schema } = toGeminiSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
      required: ['name'],
    });

    assert.ok(schema);
    assert.ok(!('$schema' in schema), '$schema must not survive');
    assert.ok(!('additionalProperties' in schema), 'additionalProperties must not survive');
  });

  test('inlines a $ref into $defs', () => {
    const { schema, warnings } = toGeminiSchema({
      type: 'object',
      $defs: { Point: { type: 'object', properties: { x: { type: 'number' } } } },
      properties: { origin: { $ref: '#/$defs/Point' } },
    });

    assert.deepEqual(warnings, []);
    matchObject(schema, {
      properties: { origin: { type: 'object', properties: { x: { type: 'number' } } } },
    });
    assert.ok(!JSON.stringify(schema).includes('$ref'), 'no $ref may remain');
  });

  test('drops a recursive $ref rather than describing a shape the tool rejects', () => {
    const { schema, warnings } = toGeminiSchema({
      type: 'object',
      $defs: {
        Node: {
          type: 'object',
          properties: { child: { $ref: '#/$defs/Node' }, label: { type: 'string' } },
        },
      },
      properties: { root: { $ref: '#/$defs/Node' }, name: { type: 'string' } },
    });

    assert.ok(warnings.some((w) => w.includes('recursive')), 'should warn about the cycle');
    // The non-recursive sibling survives; only the cyclic branch is lost.
    matchObject(schema, { properties: { name: { type: 'string' } } });
    assert.ok(!JSON.stringify(schema).includes('$ref'));
  });

  test('collapses a nullable union into the nullable flag', () => {
    const { schema } = fromZod(z.object({ note: z.string().nullable() }));

    matchObject(schema, { properties: { note: { type: 'string', nullable: true } } });
    assert.ok(!JSON.stringify(schema).includes('anyOf'), 'nullable must not stay a union');
  });

  test('keeps a genuine union as anyOf', () => {
    const { schema } = fromZod(
      z.object({ target: z.union([z.string(), z.object({ id: z.number() })]) }),
    );

    const target = (schema?.['properties'] as Record<string, Record<string, unknown>>)['target'];
    assert.ok(Array.isArray(target?.['anyOf']), 'a real union should survive as anyOf');
    assert.equal((target?.['anyOf'] as unknown[]).length, 2);
  });

  test('turns a string enum into a Gemini enum', () => {
    const { schema } = fromZod(z.object({ sortBy: z.enum(['modified', 'name', 'size']) }));

    matchObject(schema, {
      properties: { sortBy: { type: 'string', enum: ['modified', 'name', 'size'] } },
    });
  });

  test('degrades a numeric enum into a described number, since Gemini only enums strings', () => {
    const { schema, warnings } = toGeminiSchema({
      type: 'object',
      properties: { level: { type: 'integer', enum: [1, 2, 3] } },
    });

    const level = (schema?.['properties'] as Record<string, Record<string, unknown>>)['level'];
    assert.equal(level?.['type'], 'integer');
    assert.ok(!('enum' in (level ?? {})), 'a non-string enum must not be emitted');
    assert.match(String(level?.['description']), /One of: 1, 2, 3/);
    assert.ok(warnings.some((w) => w.includes('non-string enum')));
  });

  test('converts a string literal to a single-value enum', () => {
    const { schema } = fromZod(z.object({ kind: z.literal('copy') }));

    matchObject(schema, { properties: { kind: { type: 'string', enum: ['copy'] } } });
    assert.ok(!JSON.stringify(schema).includes('const'), 'const is not in Gemini’s subset');
  });

  test('flattens allOf produced by an intersection', () => {
    const { schema } = toGeminiSchema({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    });

    matchObject(schema, {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    });
    assert.deepEqual([...(schema?.['required'] as string[])].sort(), ['a', 'b']);
  });

  test('folds an unsupported format into the description instead of discarding it', () => {
    const { schema } = fromZod(z.object({ contact: z.email() }));

    const contact = (schema?.['properties'] as Record<string, Record<string, unknown>>)['contact'];
    assert.equal(contact?.['type'], 'string');
    assert.ok(!('format' in (contact ?? {})), 'Gemini does not know the email format');
    assert.match(String(contact?.['description']), /format: email/i);
  });

  test('keeps a format Gemini does understand', () => {
    const { schema } = toGeminiSchema({
      type: 'object',
      properties: { when: { type: 'string', format: 'date-time' } },
    });

    matchObject(schema, { properties: { when: { type: 'string', format: 'date-time' } } });
  });

  test('carries array items and bounds', () => {
    const { schema } = fromZod(z.object({ paths: z.array(z.string()).min(1).max(10) }));

    matchObject(schema, {
      properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 } },
    });
  });

  test('emits no parameters for a tool that takes no input', () => {
    const { schema } = fromZod(z.object({}));

    // Gemini rejects `parameters: { type: "object", properties: {} }`, so the
    // only correct representation of "no input" is to omit it entirely.
    assert.equal(schema, undefined);
  });

  test('never lists a dropped property as required', () => {
    const { schema } = toGeminiSchema({
      type: 'object',
      properties: {
        good: { type: 'string' },
        // No type and no constraints — nothing Gemini can be told about it.
        bad: {},
      },
      required: ['good', 'bad'],
    });

    assert.deepEqual(schema?.['required'], ['good']);
  });

  test('handles a nested object schema, the Phase 4 shape', () => {
    const { schema, warnings } = fromZod(
      z.object({
        query: z.string().describe('What to search for'),
        options: z
          .object({
            extension: z.string().optional(),
            sortBy: z.enum(['modified', 'created', 'name', 'size']).default('modified'),
            limit: z.number().int().min(1).max(100).default(20),
          })
          .optional(),
      }),
    );

    assert.deepEqual(warnings, []);
    matchObject(schema, {
      type: 'object',
      properties: {
        query: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            extension: { type: 'string' },
            sortBy: { type: 'string', enum: ['modified', 'created', 'name', 'size'] },
          },
        },
      },
      required: ['query'],
    });
  });

  test('rejects a non-object root, because parameters must be an object', () => {
    const { schema, warnings } = toGeminiSchema({ type: 'string' });

    assert.equal(schema, undefined);
    assert.ok(warnings.some((w) => w.includes('must be an object')));
  });

  test('emits nothing Gemini could reject, for any Zod construct thrown at it', () => {
    const gnarly = z.object({
      literal: z.literal('x'),
      nullable: z.string().nullable(),
      optional: z.number().optional(),
      list: z.array(z.object({ nested: z.boolean() })),
      union: z.union([z.literal('a'), z.literal('b')]),
      uuid: z.uuid(),
      record: z.record(z.string(), z.string()),
    });

    const { schema } = fromZod(gnarly);
    const serialised = JSON.stringify(schema);

    for (const forbidden of ['$ref', '$defs', '$schema', 'additionalProperties', 'allOf', 'oneOf', '"const"', 'exclusiveMinimum', 'patternProperties']) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} must never reach Gemini`);
    }
  });
});
