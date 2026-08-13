import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redact, redactString } from '../dist/index.js';
import { matchObject } from './helpers.ts';

/**
 * Spec §37 forbids logging credentials. These tests are the enforcement: if
 * someone weakens the redactor, the build fails rather than the secret leaking.
 */

describe('redactString', () => {
  it('redacts Anthropic-style keys embedded in free text', () => {
    const input = 'auth failed with key sk-ant-api03-AbCdEf0123456789XyZ while calling the API';
    const output = redactString(input);
    assert.ok(output.includes(REDACTED));
    assert.ok(!output.includes('AbCdEf0123456789XyZ'));
  });

  it('redacts bearer headers, JWTs and AWS key ids', () => {
    assert.ok(redactString('Authorization: Bearer abcdefghijklmnop1234567890').includes(REDACTED));
    assert.ok(
      redactString(
        'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w',
      ).includes(REDACTED),
    );
    assert.ok(redactString('using AKIAIOSFODNN7EXAMPLE now').includes(REDACTED));
  });

  it('leaves ordinary text untouched', () => {
    const clean = 'copied invoice_2026_08_11.pdf to C:\\Users\\Sam\\Desktop';
    assert.equal(redactString(clean), clean);
  });
});

describe('redact', () => {
  it('redacts by key name whatever the value looks like', () => {
    assert.deepStrictEqual(
      redact({ apiKey: 'plainlooking', password: 12345, nested: { authToken: 'x' } }),
      { apiKey: REDACTED, password: REDACTED, nested: { authToken: REDACTED } },
    );
  });

  it('withholds private message content but keeps the shape debuggable', () => {
    const out = redact({ to: 'Charles', message: 'private words here' }) as Record<string, unknown>;
    assert.equal(out['to'], 'Charles');
    assert.equal(out['message'], '[18 chars withheld]');
  });

  it('survives circular references instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    assert.doesNotThrow(() => redact(cyclic));
    matchObject(redact(cyclic), { name: 'root', self: '[circular]' });
  });

  it('bounds strings, arrays and depth so one log line cannot blow up', () => {
    assert.ok(String(redact('x'.repeat(5000))).includes('[+3000 chars]'));

    const arr = redact(Array.from({ length: 250 }, (_, i) => i)) as unknown[];
    assert.equal(arr.length, 101);
    assert.equal(arr[100], '[+150 more]');

    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    assert.ok(JSON.stringify(redact(deep))?.includes('depth-limit'));
  });

  it('reports binary payloads by size rather than contents', () => {
    assert.equal(redact(Buffer.from('secret bytes')), '[binary 12 bytes]');
  });

  it('scrubs error messages and stacks', () => {
    const error = new Error('failed for key sk-ant-api03-SHOULDNOTAPPEAR12345');
    const out = redact(error) as { message: string };
    assert.ok(out.message.includes(REDACTED));
    assert.ok(!out.message.includes('SHOULDNOTAPPEAR'));
  });
});
