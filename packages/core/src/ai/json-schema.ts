/**
 * JSON Schema → Gemini `Schema` projection.
 *
 * ## Why this file exists
 *
 * Gemini does not accept JSON Schema. It accepts a small, OpenAPI-flavoured
 * subset, and it rejects the whole request with HTTP 400 when it meets a
 * keyword it does not know. `z.toJSONSchema()` emits several of those keywords
 * freely — `$ref`/`$defs` for any reused sub-schema, `additionalProperties` for
 * strict objects, `const` for literals, `allOf` for intersections, and numeric
 * `exclusiveMinimum`.
 *
 * The failure mode this prevents is nasty: tool calling works fine through
 * Phase 3 with two flat tools, then someone adds `filesystem.search` with a
 * nested options object in Phase 4 and *every* request starts failing, because
 * one tool's schema poisons the whole `tools` array.
 *
 * ## Allow-list, not deny-list
 *
 * The converter builds its output by copying keywords it understands, rather
 * than deleting keywords it knows are bad. That direction matters: when a
 * future Zod version emits something new, an allow-list silently drops it (and
 * records a warning), whereas a deny-list would forward it to Google and break
 * tool calling at runtime. Losing a validation hint is survivable — the input is
 * re-validated locally against the real Zod schema before the tool ever runs.
 * Losing tool calling is not.
 *
 * ## Nothing here is a security boundary
 *
 * This projection decides what the *model is told*. It never decides what the
 * agent will *do*. Every tool input is validated against `tool.inputSchema` in
 * the executor, so a schema that degrades here cannot widen what a tool
 * accepts.
 */

/** A Gemini-safe schema node. Loose by design — this is a wire format. */
export type GeminiSchema = Record<string, unknown>;

export interface SchemaConversionResult {
  /**
   * The converted schema, or `undefined` when the tool takes no parameters.
   * Gemini rejects a `functionDeclaration` carrying an empty parameter object,
   * so "no input" must be expressed by omitting `parameters` entirely.
   */
  readonly schema: GeminiSchema | undefined;
  /**
   * Everything that was dropped or degraded, in human-readable form. Surfaced
   * in tests and logged once at startup rather than thrown: a lost `format`
   * hint should not stop the agent from booting.
   */
  readonly warnings: readonly string[];
}

/** Formats Gemini recognises, by the type they apply to. Everything else is dropped. */
const FORMATS_BY_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set(['date-time', 'enum']),
  number: new Set(['float', 'double']),
  integer: new Set(['int32', 'int64']),
};

/**
 * Guard against a pathological or cyclic schema producing an enormous payload.
 * Real tool inputs are shallow; anything past this depth is a modelling mistake.
 */
const MAX_DEPTH = 8;

interface Context {
  readonly defs: Record<string, unknown>;
  readonly warnings: string[];
  /** `$ref` pointers currently being expanded, for cycle detection. */
  readonly refStack: string[];
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert a JSON Schema (as produced by `z.toJSONSchema`) into Gemini's subset.
 *
 * The root is required to be an object schema, because that is what a function
 * declaration's `parameters` must be. A non-object root is a programming error
 * in the tool definition, so it warns loudly and yields `undefined` rather than
 * sending Gemini something it will reject.
 */
export function toGeminiSchema(input: unknown): SchemaConversionResult {
  const warnings: string[] = [];

  if (!isRecord(input)) {
    return { schema: undefined, warnings: ['schema root is not an object; no parameters sent'] };
  }

  const defs = collectDefs(input);
  const converted = convert(input, { defs, warnings, refStack: [], path: '' }, 0);

  if (converted === undefined) {
    return { schema: undefined, warnings };
  }
  if (converted['type'] !== 'object') {
    warnings.push(
      `schema root has type "${String(converted['type'])}" but a tool's parameters must be an object; no parameters sent`,
    );
    return { schema: undefined, warnings };
  }

  // Gemini rejects `parameters: { type: "object", properties: {} }`. A tool that
  // genuinely takes no input must omit `parameters` altogether.
  const properties = converted['properties'];
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    return { schema: undefined, warnings };
  }

  return { schema: converted, warnings };
}

/** Gather `$defs`/`definitions` so `$ref`s can be inlined. */
function collectDefs(root: Record<string, unknown>): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const key of ['$defs', 'definitions']) {
    const section = root[key];
    if (isRecord(section)) Object.assign(defs, section);
  }
  return defs;
}

function convert(node: unknown, ctx: Context, depth: number): GeminiSchema | undefined {
  if (!isRecord(node)) return undefined;

  if (depth > MAX_DEPTH) {
    ctx.warnings.push(`${ctx.path || '<root>'}: nesting deeper than ${MAX_DEPTH} levels was truncated`);
    return undefined;
  }

  // `$ref` is handled here rather than inside a helper so the cycle-detection
  // stack stays held for the whole subtree. Releasing it as soon as the target
  // was looked up would let `Node → child → Node` expand forever, because each
  // level would see an empty stack.
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (ctx.refStack.includes(ref)) {
      // A recursive input schema cannot be expressed in Gemini's subset at all.
      // Dropping the field is the only honest option; inlining one level would
      // describe a shape the tool does not actually accept.
      ctx.warnings.push(`${ctx.path || '<root>'}: recursive $ref "${ref}" cannot be expressed; field omitted`);
      return undefined;
    }
    const target = lookupRef(ref, ctx);
    if (target === undefined) return undefined;

    // Sibling keywords alongside `$ref` (a description, usually) win over the
    // target's, matching JSON Schema 2020-12 semantics.
    const { $ref: _ref, ...siblings } = node;
    ctx.refStack.push(ref);
    try {
      return convert({ ...target, ...siblings }, ctx, depth);
    } finally {
      ctx.refStack.pop();
    }
  }

  const merged = mergeAllOf(node, ctx, depth);

  const out: GeminiSchema = {};
  let nullable = false;

  // ---- type ---------------------------------------------------------------
  // JSON Schema allows `type: ["string", "null"]`; Gemini uses a `nullable` flag.
  let type: string | undefined;
  const rawType = merged['type'];
  if (typeof rawType === 'string') {
    type = rawType;
  } else if (Array.isArray(rawType)) {
    const named = rawType.filter((t): t is string => typeof t === 'string');
    nullable = named.includes('null');
    type = named.find((t) => t !== 'null');
  }
  if (type === 'null') {
    // A bare null-typed field carries no information the model can act on.
    ctx.warnings.push(`${ctx.path || '<root>'}: null-only type dropped`);
    return undefined;
  }

  // ---- unions -------------------------------------------------------------
  // Zod emits `anyOf` for unions and for `.nullable()`. `oneOf` is not part of
  // Gemini's subset at all, so it is folded into the same handling.
  const union = firstArray(merged['anyOf'], merged['oneOf']);
  if (union) {
    const branches = union.filter((branch) => !isNullSchema(branch));
    if (branches.length !== union.length) nullable = true;

    if (branches.length === 0) return undefined;
    if (branches.length === 1) {
      // `.nullable()` and single-member unions collapse to the branch itself.
      const only = convert(branches[0], ctx, depth + 1);
      if (only === undefined) return undefined;
      applyAnnotations(only, merged, ctx);
      if (nullable) only['nullable'] = true;
      return only;
    }

    const converted = branches
      .map((branch, i) => convert(branch, { ...ctx, path: `${ctx.path}/anyOf[${i}]` }, depth + 1))
      .filter((branch): branch is GeminiSchema => branch !== undefined);
    if (converted.length === 0) return undefined;

    out['anyOf'] = converted;
    if (nullable) out['nullable'] = true;
    applyAnnotations(out, merged, ctx);
    return out;
  }

  // ---- literals -----------------------------------------------------------
  // `const` is not in the subset. A string literal survives as a one-value enum,
  // which is both valid and more informative than dropping it.
  if ('const' in merged && !('enum' in merged)) {
    const literal = merged['const'];
    if (typeof literal === 'string') {
      out['type'] = 'string';
      out['enum'] = [literal];
      applyAnnotations(out, merged, ctx);
      if (nullable) out['nullable'] = true;
      return out;
    }
    ctx.warnings.push(
      `${ctx.path || '<root>'}: non-string const (${typeof literal}) cannot be expressed; described instead`,
    );
    type ??= jsonTypeOf(literal);
  }

  // ---- enums --------------------------------------------------------------
  // Gemini only supports `enum` on strings. A numeric enum degrades to a plain
  // number plus a description listing the permitted values, so the model still
  // knows the constraint even though the API cannot enforce it.
  const enumValues = merged['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    if (enumValues.every((v) => typeof v === 'string')) {
      out['type'] = 'string';
      out['enum'] = [...enumValues];
      applyAnnotations(out, merged, ctx);
      if (nullable) out['nullable'] = true;
      return out;
    }
    ctx.warnings.push(
      `${ctx.path || '<root>'}: non-string enum degraded to ${type ?? 'string'} with values in the description`,
    );
    const values = enumValues.map((v) => JSON.stringify(v)).join(', ');
    out['type'] = type ?? 'string';
    applyAnnotations(out, merged, ctx, `One of: ${values}.`);
    if (nullable) out['nullable'] = true;
    return out;
  }

  if (type === undefined) {
    // An unconstrained schema. Gemini needs a type, and guessing `string` would
    // be a lie the model then has to work around.
    ctx.warnings.push(`${ctx.path || '<root>'}: no type could be determined; field omitted`);
    return undefined;
  }

  out['type'] = type;
  if (nullable) out['nullable'] = true;

  // ---- structure ----------------------------------------------------------
  if (type === 'object') {
    const properties = merged['properties'];
    const converted: Record<string, GeminiSchema> = {};
    if (isRecord(properties)) {
      for (const [key, value] of Object.entries(properties)) {
        const child = convert(value, { ...ctx, path: `${ctx.path}/${key}` }, depth + 1);
        if (child !== undefined) converted[key] = child;
        else ctx.warnings.push(`${ctx.path}/${key}: property dropped`);
      }
    }
    out['properties'] = converted;

    // `required` must not name a property that was dropped, or Gemini rejects
    // the declaration for referring to a field it cannot see.
    const required = merged['required'];
    if (Array.isArray(required)) {
      const kept = required.filter((k): k is string => typeof k === 'string' && k in converted);
      if (kept.length > 0) out['required'] = kept;
    }

    // `propertyOrdering` is Gemini's own hint and materially improves output
    // consistency, so it is worth emitting from the declaration order.
    const keys = Object.keys(converted);
    if (keys.length > 1) out['propertyOrdering'] = keys;
  } else if (type === 'array') {
    const items = convert(merged['items'], { ...ctx, path: `${ctx.path}[]` }, depth + 1);
    if (items === undefined) {
      ctx.warnings.push(`${ctx.path || '<root>'}: array items could not be converted; field omitted`);
      return undefined;
    }
    out['items'] = items;
    copyNumber(out, merged, 'minItems', ctx);
    copyNumber(out, merged, 'maxItems', ctx);
  }

  // ---- format -------------------------------------------------------------
  // Zod emits `format: "email" | "uuid" | "uri" | …`, none of which Gemini
  // knows. Rather than discard the constraint, unsupported formats are folded
  // into the description — the model reads that and complies.
  const format = merged['format'];
  let formatNote: string | undefined;
  if (typeof format === 'string') {
    if (FORMATS_BY_TYPE[type]?.has(format)) out['format'] = format;
    else formatNote = `Expected format: ${format}.`;
  }

  applyAnnotations(out, merged, ctx, formatNote);
  return out;
}

/** Look a `$ref` up in `$defs`. Cycle detection is the caller's job. */
function lookupRef(ref: string, ctx: Context): Record<string, unknown> | undefined {
  const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)?.[1];
  const target = name ? ctx.defs[decodeURIComponent(name)] : undefined;
  if (!isRecord(target)) {
    ctx.warnings.push(`${ctx.path || '<root>'}: unresolvable $ref "${ref}"; field omitted`);
    return undefined;
  }
  return target;
}

/**
 * Flatten `allOf` by shallow-merging object members.
 *
 * Zod emits `allOf` for intersections. Gemini has no equivalent, and merging is
 * correct for the only shape that occurs in practice — an intersection of
 * object schemas. Anything else warns and keeps the first member, which
 * describes a subset of what is accepted rather than a superset.
 */
function mergeAllOf(node: Record<string, unknown>, ctx: Context, _depth: number): Record<string, unknown> {
  const allOf = node['allOf'];
  if (!Array.isArray(allOf) || allOf.length === 0) return node;

  const { allOf: _drop, ...base } = node;
  const merged: Record<string, unknown> = { ...base };
  const properties: Record<string, unknown> = isRecord(base['properties']) ? { ...base['properties'] } : {};
  const required = new Set<string>(Array.isArray(base['required']) ? (base['required'] as string[]) : []);

  for (const member of allOf) {
    if (!isRecord(member)) continue;
    // One level of indirection is resolved here so an intersection of named
    // schemas still merges. Deeper chains are rare enough that leaving them to
    // the per-property pass is the right trade against another cycle guard.
    const ref = member['$ref'];
    const resolved =
      typeof ref === 'string' && !ctx.refStack.includes(ref)
        ? { ...lookupRef(ref, ctx), ...member, $ref: undefined }
        : member;
    if (!isRecord(resolved)) continue;

    if (resolved['type'] !== undefined && merged['type'] === undefined) merged['type'] = resolved['type'];
    if (isRecord(resolved['properties'])) Object.assign(properties, resolved['properties']);
    if (Array.isArray(resolved['required'])) {
      for (const key of resolved['required']) if (typeof key === 'string') required.add(key);
    }
    if (resolved['anyOf'] !== undefined || resolved['oneOf'] !== undefined) {
      ctx.warnings.push(`${ctx.path || '<root>'}: a union inside allOf was dropped during flattening`);
    }
  }

  if (Object.keys(properties).length > 0) {
    merged['properties'] = properties;
    merged['type'] ??= 'object';
  }
  if (required.size > 0) merged['required'] = [...required];
  return merged;
}

/**
 * Carry `description` and `title` across, appending any note produced while
 * degrading a constraint. The description is the model's only guide to a field,
 * so it is the right place to park information the schema cannot hold.
 */
function applyAnnotations(
  out: GeminiSchema,
  source: Record<string, unknown>,
  _ctx: Context,
  note?: string,
): void {
  const parts: string[] = [];
  const description = source['description'];
  const title = source['title'];
  if (typeof description === 'string' && description.trim() !== '') parts.push(description.trim());
  else if (typeof title === 'string' && title.trim() !== '') parts.push(title.trim());
  if (note) parts.push(note);
  if (parts.length > 0) out['description'] = parts.join(' ');
}

function copyNumber(out: GeminiSchema, source: Record<string, unknown>, key: string, _ctx: Context): void {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
}

function firstArray(...candidates: unknown[]): unknown[] | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** `{ type: "null" }` — the branch Zod adds for `.nullable()`. */
function isNullSchema(node: unknown): boolean {
  if (!isRecord(node)) return false;
  return node['type'] === 'null' || (Array.isArray(node['type']) && node['type'].every((t) => t === 'null'));
}

function jsonTypeOf(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    default:
      return undefined;
  }
}
