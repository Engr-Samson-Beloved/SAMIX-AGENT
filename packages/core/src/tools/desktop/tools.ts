import { z } from 'zod';
import {
  err,
  ok,
  verification,
  type ActionTarget,
  type AgentTool,
  type ToolResult,
  type Verification,
} from '@samix/shared';
import type { DesktopContext } from './context.js';
import { SidecarError, SnapshotSchema, type Snapshot, type SnapshotElement } from './protocol.js';
import type { DesktopSidecar } from './sidecar.js';

/**
 * Reading and driving the controls inside a window (Phase 7 §4, step 3).
 *
 * ## Elements first, coordinates last
 *
 * Everything here addresses a control by identity — its place in a tree the
 * agent has read — never by screen position. A coordinate is a guess about what
 * is under a pixel; an element reference is a claim about a specific button,
 * and it can be checked. Coordinates arrive in step 4 and always confirm.
 *
 * ## The stale-ref guard
 *
 * Every action carries the `tree` hash of the snapshot that produced its `ref`.
 * The sidecar re-reads the window and refuses with `STALE_REF` if the hash has
 * moved. This is enforced there rather than here on purpose: it must hold for
 * every caller, including a future one that does not go through these tools.
 *
 * A `ref` is an index. A UI that has shifted renumbers it, and acting on the old
 * number does not fail — it succeeds, on the wrong control. Nothing downstream
 * catches that: the click worked, the verifier sees a click, and the only
 * evidence is a message sent to the wrong person.
 *
 * ## Why these declare `reversible`
 *
 * This is a deliberate decision and it deserves to be visible rather than
 * buried. §5 requires that these run without a prompt inside a *trusted*
 * application in CONTROLLED mode, and the permission engine only lets `write`
 * through unprompted when it is declared reversible. So `reversible` is what
 * that table means.
 *
 * It is not a claim that every button press can be undone — plainly it cannot.
 * The protection is not this flag; it is the three things layered above it, none
 * of which the flag can weaken:
 *
 *   · an untrusted or unrecognised application confirms, always;
 *   · an element whose name reads as send/delete/pay/submit/… confirms, in every
 *     mode including autonomous, and quotes the element's own words back;
 *   · the agent's own window is refused outright.
 *
 * If that trade is wrong, the fix is to change this to `unknown` — which makes
 * every desktop action confirm everywhere — and not to weaken any of the three.
 */

const HandleInput = {
  handle: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Window handle from window.list. Omit to use the window the user is currently looking at.',
    ),
};

/** Turn a sidecar failure into a tool result the planner can branch on. */
function fromSidecar(cause: unknown): ToolResult<never> {
  if (cause instanceof SidecarError) {
    return err(cause.code, cause.message, {
      recoverable: cause.recoverable,
      ...(cause.details ? { details: cause.details } : {}),
    });
  }
  return err('INTERNAL_ERROR', String(cause), { recoverable: false });
}

// ---------------------------------------------------------------------------
// desktop.snapshot
// ---------------------------------------------------------------------------

const SnapshotInput = z
  .object({
    ...HandleInput,
    maxDepth: z.number().int().min(1).max(64).optional(),
    maxNodes: z.number().int().min(1).max(2000).optional(),
  })
  .strict();
type SnapshotInput = z.infer<typeof SnapshotInput>;

export interface SnapshotResult {
  readonly window: string;
  readonly handle: number;
  readonly application: string;
  /** The staleness token. Every action on this window must carry it back. */
  readonly tree: string;
  readonly elementCount: number;
  readonly truncated: boolean;
  /** The flat, indexed listing. This is what the planner reads. */
  readonly text: string;
}

export function createDesktopSnapshotTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<SnapshotInput, SnapshotResult> {
  return {
    name: 'desktop.snapshot',
    description:
      'Read the controls inside a window — its buttons, text fields, checkboxes and labels — as a ' +
      'numbered list. Use this before acting on anything in a desktop application, because every ' +
      'action needs an element number and the tree hash from this listing. The result may be ' +
      'truncated on a large window, which is normal and is reported. For a web page use the browser ' +
      'tools instead: a browser window exposes its own toolbar here, not the page inside it.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: SnapshotInput,
    verification: 'intrinsic',
    timeoutMs: 30_000,

    async execute(input): Promise<ToolResult<SnapshotResult>> {
      try {
        const raw = await sidecar.call('snapshot', { ...input }, 25_000);
        const snapshot = SnapshotSchema.parse(raw);
        context.remember(snapshot);
        return ok(summarise(snapshot));
      } catch (cause) {
        return fromSidecar(cause);
      }
    },
  };
}

function summarise(snapshot: Snapshot): SnapshotResult {
  return {
    window: snapshot.window.title,
    handle: snapshot.window.handle,
    application: snapshot.window.processName,
    tree: snapshot.tree,
    elementCount: snapshot.nodeCount,
    truncated: snapshot.truncated,
    text: snapshot.text,
  };
}

// ---------------------------------------------------------------------------
// desktop.findElement
// ---------------------------------------------------------------------------

const FindInput = z
  .object({
    ...HandleInput,
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Text to look for in a control’s name or value, e.g. "Send" or "Search".'),
    role: z
      .string()
      .min(1)
      .optional()
      .describe('Restrict to one kind of control, e.g. "Button", "Edit", "CheckBox", "ListItem".'),
    actionableOnly: z
      .boolean()
      .optional()
      .describe('Only controls that can be pressed, toggled, selected or typed into.'),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
type FindInput = z.infer<typeof FindInput>;

const FindResultSchema = z.object({
  tree: z.string(),
  window: SnapshotSchema.shape.window,
  truncated: z.boolean(),
  matchCount: z.number().int(),
  exactCount: z.number().int(),
  elements: z.array(SnapshotSchema.shape.elements.element),
});

export interface FindResult {
  readonly tree: string;
  readonly handle: number;
  readonly application: string;
  readonly matchCount: number;
  readonly exactCount: number;
  readonly matches: ReadonlyArray<{
    readonly ref: number;
    readonly role: string;
    readonly name: string;
    readonly value: string | null;
    readonly enabled: boolean;
    readonly can: readonly string[];
  }>;
}

export function createDesktopFindElementTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<FindInput, FindResult> {
  return {
    name: 'desktop.findElement',
    description:
      'Find controls inside a window by name, by kind, or both — a quicker and much smaller answer ' +
      'than reading the whole window when you already know what you are looking for. Returns element ' +
      'numbers and the tree hash needed to act on them. Exact name matches are listed first.',
    permission: 'read',
    reversibility: 'reversible',
    inputSchema: FindInput,
    verification: 'intrinsic',
    timeoutMs: 30_000,

    async execute(input): Promise<ToolResult<FindResult>> {
      try {
        const raw = await sidecar.call('findElement', { ...input }, 25_000);
        const found = FindResultSchema.parse(raw);

        // Remembered so a following action can be judged without another read.
        // Only the matches are known here, which is enough: an action can only
        // name a ref this search returned.
        context.remember({ window: found.window, tree: found.tree, elements: found.elements });

        return ok({
          tree: found.tree,
          handle: found.window.handle,
          application: found.window.processName,
          matchCount: found.matchCount,
          exactCount: found.exactCount,
          matches: found.elements.map((element: SnapshotElement) => ({
            ref: element.ref,
            role: element.role,
            name: element.name,
            value: element.value,
            enabled: element.enabled,
            can: element.patterns,
          })),
        });
      } catch (cause) {
        return fromSidecar(cause);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// desktop.invoke
// ---------------------------------------------------------------------------

const ActionInput = {
  ...HandleInput,
  ref: z
    .number()
    .int()
    .positive()
    .describe('The element number from desktop.snapshot or desktop.findElement.'),
  tree: z
    .string()
    .min(1)
    .describe(
      'The tree hash from the same listing that gave you the element number. Required: it proves ' +
        'the window has not changed since you read it.',
    ),
};

const InvokeInput = z.object(ActionInput).strict();
type InvokeInput = z.infer<typeof InvokeInput>;

const InvokeResultSchema = z.object({
  ref: z.number().int(),
  name: z.string(),
  role: z.string(),
  runtimeId: z.string(),
  how: z.string(),
  toggleBefore: z.string().nullable(),
  toggleAfter: z.string().nullable(),
  treeBefore: z.string(),
  treeAfter: z.string(),
  treeChanged: z.boolean(),
  newWindows: z.array(z.number().int()),
});
type InvokeRaw = z.infer<typeof InvokeResultSchema>;

export interface InvokeResult extends InvokeRaw {
  readonly handle: number;
}

export function createDesktopInvokeTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<InvokeInput, InvokeResult> {
  return {
    name: 'desktop.invoke',
    description:
      'Press a control inside a window — a button, a menu item, a checkbox, a list or tab item. ' +
      'Needs the element number and tree hash from a listing you have just taken. Prefer this over ' +
      'clicking a position: it targets the control itself, so it cannot land on the wrong thing if ' +
      'the window has moved.',
    permission: 'write',
    // See the note at the top of this file. This is what §5's table requires,
    // and the real protection is the trust axis and the dangerous-name floor.
    reversibility: 'reversible',
    inputSchema: InvokeInput,
    verification: 'explicit',
    timeoutMs: 30_000,

    describeTarget(input): ActionTarget {
      return context.describe(input.handle, input.ref);
    },

    describeEffect(input): string {
      const element = context.window(input.handle)?.elements.get(input.ref);
      const where = context.window(input.handle)?.title;
      if (!element) return 'Press a control in a window I have not read recently.';
      const name = element.name === '' ? `an unnamed ${element.role}` : `"${element.name}"`;
      return `Press ${name}${where ? ` in ${where}` : ''}.`;
    },

    async execute(input): Promise<ToolResult<InvokeResult>> {
      try {
        const raw = await sidecar.call('invoke', { ...input }, 25_000);
        const result = InvokeResultSchema.parse(raw);
        const handle = context.window(input.handle)?.handle ?? input.handle ?? 0;
        // Whatever was pressed, the listing that produced this ref is now
        // suspect. Forgetting it forces a fresh read before the next action
        // rather than letting a second action ride on a pre-click view.
        if (handle) context.forget(handle);
        return ok({ ...result, handle });
      } catch (cause) {
        return fromSidecar(cause);
      }
    },

    /**
     * Re-observe, and accept only the deltas §6 names.
     *
     * Three signals, because one is not enough: pressing a checkbox flips its
     * state without changing the structure hash at all — measured, not assumed —
     * and opening a dialog creates a window rather than altering this one.
     *
     * No detectable delta is `unverified`. Never `failed`: plenty of buttons do
     * something real that leaves no trace in this window. Never `verified`
     * either — the whole point is that we did not see it happen.
     */
    async verify(input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was pressed.');
      }
      const { name, role, toggleBefore, toggleAfter, treeBefore, newWindows } = result.data;
      const what = name === '' ? `the ${role}` : `"${name}"`;

      if (toggleBefore !== null && toggleAfter !== null && toggleBefore !== toggleAfter) {
        return verification('verified', `${what} is now ${toggleAfter}.`);
      }
      if (newWindows.length > 0) {
        return verification('verified', `Pressing ${what} opened a new window.`);
      }

      // Read the window again now, rather than trusting the reading the sidecar
      // took immediately after the click: a slow dialog may have appeared since.
      try {
        const raw = await sidecar.call('snapshot', { handle: input.handle }, 15_000);
        const fresh = SnapshotSchema.parse(raw);
        if (fresh.tree !== treeBefore) {
          return verification('verified', `Pressing ${what} changed what is on screen.`);
        }
        return verification(
          'unverified',
          `Pressed ${what}. Nothing about the window changed, so I cannot confirm it did anything.`,
        );
      } catch (cause) {
        return verification('unverified', `Pressed ${what}, but could not re-read the window: ${String(cause)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// desktop.setValue
// ---------------------------------------------------------------------------

const SetValueInput = z
  .object({
    ...ActionInput,
    text: z.string().describe('The text to put in the field. Replaces whatever is there.'),
  })
  .strict();
type SetValueInput = z.infer<typeof SetValueInput>;

const SetValueResultSchema = z.object({
  ref: z.number().int(),
  name: z.string(),
  role: z.string(),
  runtimeId: z.string(),
  requested: z.string(),
  valueBefore: z.string().nullable(),
  valueAfter: z.string().nullable(),
  matches: z.boolean(),
});
type SetValueRaw = z.infer<typeof SetValueResultSchema>;

export type SetValueResult = SetValueRaw;

export function createDesktopSetValueTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<SetValueInput, SetValueResult> {
  return {
    name: 'desktop.setValue',
    description:
      'Put text into a field inside a window, replacing what is there. Needs the element number and ' +
      'tree hash from a listing you have just taken. This sets the field directly rather than typing ' +
      'into it, so it cannot be interleaved with what the user is typing and cannot half-complete.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: SetValueInput,
    verification: 'explicit',
    timeoutMs: 30_000,

    describeTarget(input): ActionTarget {
      return context.describe(input.handle, input.ref);
    },

    describeEffect(input): string {
      const element = context.window(input.handle)?.elements.get(input.ref);
      const name = element?.name ? `"${element.name}"` : 'a field';
      const preview = input.text.length > 60 ? `${input.text.slice(0, 59)}…` : input.text;
      return `Replace the contents of ${name} with "${preview}".`;
    },

    async execute(input): Promise<ToolResult<SetValueResult>> {
      try {
        const raw = await sidecar.call('setValue', { ...input }, 25_000);
        return ok(SetValueResultSchema.parse(raw));
      } catch (cause) {
        return fromSidecar(cause);
      }
    },

    /**
     * The expected delta is exact and stated in advance: that element's value is
     * now the text we asked for. Anything else is not a success.
     */
    async verify(input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was typed.');
      }
      const { name, valueAfter, requested } = result.data;
      const where = name === '' ? 'The field' : `"${name}"`;

      if (valueAfter === requested) {
        return verification('verified', `${where} now contains "${truncate(requested)}".`);
      }
      if (valueAfter === null) {
        return verification('unverified', `${where} would not report its value back.`);
      }
      // The field took something other than what was asked for — a length cap, a
      // format mask, an application rewriting the input. The tool said success;
      // the world disagrees, and the world wins.
      return verification(
        'failed',
        `${where} contains "${truncate(valueAfter)}", not "${truncate(requested)}".`,
      );
    },
  };
}

function truncate(text: string, limit = 60): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// desktop.click / desktop.type / desktop.pressKey (step 4)
// ---------------------------------------------------------------------------
//
// `invoke` and `setValue` above drive a control through the pattern it
// advertises — exact, and needs no cursor motion at all. These three exist for
// the control that advertises none: nothing to Invoke, nothing to set,
// sometimes not even a name — a custom-drawn button, most games, a canvas.
// Prefer an element ref wherever one exists; a raw coordinate is a guess about
// what is under a pixel, which is exactly why it always confirms (see the note
// at the top of this file, and `permissions.ts`'s `floor:raw-coordinates`).
//
// All three count against `automation.desktop.maxActionsPerTask`
// (`consumesActionBudget: true`) — see the field's doc comment in
// `@samix/shared` for why `invoke` and `setValue` do not.

const ClickElementInput = z
  .object({
    ...ActionInput,
    button: z.enum(['left', 'right', 'middle']).optional(),
    doubleClick: z.boolean().optional(),
  })
  .strict();

const ClickPointInput = z
  .object({
    x: z.number().int().describe('Physical-pixel X coordinate on the screen.'),
    y: z.number().int().describe('Physical-pixel Y coordinate on the screen.'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    doubleClick: z.boolean().optional(),
  })
  .strict();

const ClickInput = z.union([ClickElementInput, ClickPointInput]);
type ClickInput = z.infer<typeof ClickInput>;

const ClickElementResultSchema = z.object({
  ref: z.number().int(),
  name: z.string(),
  role: z.string(),
  runtimeId: z.string(),
  how: z.string(),
  point: z.tuple([z.number(), z.number()]),
  toggleBefore: z.string().nullable(),
  toggleAfter: z.string().nullable(),
  treeBefore: z.string(),
  treeAfter: z.string(),
  treeChanged: z.boolean(),
  newWindows: z.array(z.number().int()),
});
type ClickElementResult = z.infer<typeof ClickElementResultSchema>;

const ClickPointResultSchema = z.object({
  point: z.tuple([z.number(), z.number()]),
  how: z.string(),
  newWindows: z.array(z.number().int()),
});
type ClickPointResult = z.infer<typeof ClickPointResultSchema>;

export type ClickResult = (ClickElementResult & { readonly handle: number }) | ClickPointResult;

function isElementClick(input: ClickInput): input is z.infer<typeof ClickElementInput> {
  return 'ref' in input;
}

export function createDesktopClickTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<ClickInput, ClickResult> {
  return {
    name: 'desktop.click',
    description:
      'Click a control inside a window — a last resort for the control that has nothing prefer ' +
      'to press (see desktop.invoke first). Give an element ref and tree from a recent listing ' +
      'wherever one exists; a raw (x, y) screen point always asks for confirmation, because what is ' +
      'under a pixel cannot be checked in advance.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: ClickInput,
    verification: 'explicit',
    timeoutMs: 30_000,
    consumesActionBudget: true,

    describeTarget(input): ActionTarget {
      if (isElementClick(input)) return context.describe(input.handle, input.ref);
      return { rawCoordinates: true };
    },

    describeEffect(input): string {
      if (isElementClick(input)) {
        const element = context.window(input.handle)?.elements.get(input.ref);
        const where = context.window(input.handle)?.title;
        const name = element ? (element.name === '' ? `an unnamed ${element.role}` : `"${element.name}"`) : 'a control';
        return `Click ${name}${where ? ` in ${where}` : ''}.`;
      }
      return `Click the screen at (${input.x}, ${input.y}).`;
    },

    async execute(input): Promise<ToolResult<ClickResult>> {
      try {
        const raw = await sidecar.call('click', { ...input }, 25_000);
        if (isElementClick(input)) {
          const result = ClickElementResultSchema.parse(raw);
          const handle = context.window(input.handle)?.handle ?? input.handle ?? 0;
          // Whatever was clicked, the listing that produced this ref is now
          // suspect — same reasoning as `invoke`.
          if (handle) context.forget(handle);
          return ok({ ...result, handle });
        }
        return ok(ClickPointResultSchema.parse(raw));
      } catch (cause) {
        return fromSidecar(cause);
      }
    },

    /** Same three signals as `invoke` for an element click. A raw-point click
     * has no window to re-read, so the only evidence available at all is
     * whether a new window appeared. */
    async verify(input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was clicked.');
      }

      if (!isElementClick(input)) {
        const { newWindows, point } = result.data as ClickPointResult;
        if (newWindows.length > 0) {
          return verification('verified', `Clicking (${point[0]}, ${point[1]}) opened a new window.`);
        }
        return verification(
          'unverified',
          `Clicked (${point[0]}, ${point[1]}). There is no element to re-check, so I cannot confirm ` +
            `what it did.`,
        );
      }

      const { name, role, toggleBefore, toggleAfter, treeBefore, newWindows, handle } =
        result.data as ClickElementResult & { handle: number };
      const what = name === '' ? `the ${role}` : `"${name}"`;

      if (toggleBefore !== null && toggleAfter !== null && toggleBefore !== toggleAfter) {
        return verification('verified', `${what} is now ${toggleAfter}.`);
      }
      if (newWindows.length > 0) {
        return verification('verified', `Clicking ${what} opened a new window.`);
      }
      try {
        const raw = await sidecar.call('snapshot', { handle }, 15_000);
        const fresh = SnapshotSchema.parse(raw);
        if (fresh.tree !== treeBefore) {
          return verification('verified', `Clicking ${what} changed what is on screen.`);
        }
        return verification(
          'unverified',
          `Clicked ${what}. Nothing about the window changed, so I cannot confirm it did anything.`,
        );
      } catch (cause) {
        return verification('unverified', `Clicked ${what}, but could not re-read the window: ${String(cause)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// desktop.type
// ---------------------------------------------------------------------------

const TypeInput = z
  .object({
    ...HandleInput,
    ref: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Element to click into first, from a recent listing. Omit to type into whatever already ' +
          'has keyboard focus.',
      ),
    tree: z.string().min(1).optional().describe('Required together with ref, from the same listing.'),
    text: z.string().describe('The text to type, one keystroke at a time.'),
  })
  .strict()
  .refine((v) => (v.ref === undefined) === (v.tree === undefined), {
    message: 'ref and tree must be given together, or not at all.',
  });
type TypeInput = z.infer<typeof TypeInput>;

const TypeElementResultSchema = z.object({
  ref: z.number().int(),
  name: z.string(),
  role: z.string(),
  runtimeId: z.string(),
  requested: z.string(),
  sent: z.number().int(),
  cancelled: z.boolean(),
});
const TypeFocusedResultSchema = z.object({
  requested: z.string(),
  sent: z.number().int(),
  cancelled: z.boolean(),
});
export type TypeResult = z.infer<typeof TypeElementResultSchema> | z.infer<typeof TypeFocusedResultSchema>;

export function createDesktopTypeTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<TypeInput, TypeResult> {
  return {
    name: 'desktop.type',
    description:
      'Type text by sending real keystrokes — a last resort for the field that has no value to set ' +
      '(see desktop.setValue first, which is atomic and cannot be interleaved with the user’s own ' +
      'typing). Give a ref and tree to click into a field first, or omit both to type into whatever ' +
      'already has keyboard focus.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: TypeInput,
    verification: 'explicit',
    timeoutMs: 30_000,
    consumesActionBudget: true,

    describeTarget(input): ActionTarget {
      return context.describe(input.handle, input.ref);
    },

    describeEffect(input): string {
      const preview = truncate(input.text);
      if (input.ref !== undefined) {
        const element = context.window(input.handle)?.elements.get(input.ref);
        const name = element?.name ? `"${element.name}"` : 'a control';
        return `Click ${name} and type "${preview}".`;
      }
      return `Type "${preview}" into whatever currently has keyboard focus.`;
    },

    async execute(input): Promise<ToolResult<TypeResult>> {
      try {
        const raw = await sidecar.call('type', { ...input }, 25_000);
        if (input.ref !== undefined) {
          const result = TypeElementResultSchema.parse(raw);
          const handle = context.window(input.handle)?.handle ?? input.handle ?? 0;
          if (handle) context.forget(handle);
          return ok(result);
        }
        return ok(TypeFocusedResultSchema.parse(raw));
      } catch (cause) {
        return fromSidecar(cause);
      }
    },

    /**
     * There is no readback: typing exists precisely because the field has no
     * Value pattern to read from either. `verified` is therefore never a
     * possible answer — only whether every character was actually sent.
     */
    async verify(_input, result): Promise<Verification> {
      if (!result.success || !result.data) {
        return verification('not-applicable', 'Nothing was typed.');
      }
      const { sent, requested, cancelled } = result.data;
      if (cancelled) {
        return verification(
          'unverified',
          `Cancelled after sending ${sent} of ${requested.length} characters.`,
        );
      }
      return verification(
        'unverified',
        `Sent all ${sent} character(s). There is no way to read the field back to confirm it stuck.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// desktop.pressKey
// ---------------------------------------------------------------------------

const PressKeyInput = z
  .object({
    keys: z
      .string()
      .min(1)
      .describe('A key or chord, e.g. "Enter", "Tab", "Escape", "Ctrl+A", "Alt+F4".'),
  })
  .strict();
type PressKeyInput = z.infer<typeof PressKeyInput>;

const PressKeyResultSchema = z.object({
  chord: z.string(),
  parts: z.array(z.string()),
});
type PressKeyResult = z.infer<typeof PressKeyResultSchema>;

export function createDesktopPressKeyTool(
  sidecar: DesktopSidecar,
  context: DesktopContext,
): AgentTool<PressKeyInput, PressKeyResult> {
  return {
    name: 'desktop.pressKey',
    description:
      'Send a key or key combination — "Enter", "Tab", "Escape", "Ctrl+A", "Alt+F4" — to whatever ' +
      'currently has keyboard focus. There is no element to target: use desktop.click or ' +
      'desktop.type first if focus needs to move somewhere specific.',
    permission: 'write',
    reversibility: 'reversible',
    inputSchema: PressKeyInput,
    verification: 'explicit',
    timeoutMs: 15_000,
    consumesActionBudget: true,

    // No ref to name — a key press has no element of its own — but the most
    // recently remembered window is still the best available answer to "which
    // application", and `describe()` already treats a total miss as `{}`,
    // which the engine reads as the least trusted case. Without this, `target`
    // would be `undefined` rather than `{}`, and the app-trust axis would skip
    // this tool entirely instead of falling back to that safe default.
    describeTarget(): ActionTarget {
      return context.describe(undefined, undefined);
    },

    describeEffect(input): string {
      return `Press ${input.keys}.`;
    },

    async execute(input): Promise<ToolResult<PressKeyResult>> {
      try {
        const raw = await sidecar.call('pressKey', { ...input }, 10_000);
        return ok(PressKeyResultSchema.parse(raw));
      } catch (cause) {
        return fromSidecar(cause);
      }
    },

    /** No target, so no evidence — same honesty rule as `desktop.type`. */
    async verify(input): Promise<Verification> {
      return verification(
        'unverified',
        `Sent ${input.keys}. There is nothing to re-check without knowing what it was aimed at.`,
      );
    },
  };
}
