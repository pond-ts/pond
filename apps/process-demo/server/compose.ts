/**
 * The agent seam — prompt in, envelope out.
 *
 * Two implementations behind one interface. `anthropicComposer` is the
 * real experiment: it is handed `registry.toJsonSchema()` as a tool
 * schema and nothing else about the vocabulary, which is precisely the
 * [PND-PROCREG] question. `scriptedComposer` is a keyword matcher that
 * exists so the app runs and can be tested without a key — it proves
 * nothing about the registry and says so in every response it returns.
 *
 * The seam matters beyond convenience: the plan panel, the run path and
 * the UI are all testable without a network call, so a failure is
 * attributable to the model or to us, not to both at once.
 */

import Anthropic from '@anthropic-ai/sdk';
import { openaiComposer } from './compose-openai.js';
import {
  ANALYST,
  ANSWER_TOOL,
  MAX_ROUNDS,
  resultText,
  type Answer,
  type Round,
  type Runner,
} from './agent.js';
import type { DatasetInfo, Envelope, OpDescriptor } from '@pond-ts/process';

export interface ComposerContext {
  readonly datasets: readonly DatasetInfo[];
  readonly ops: readonly OpDescriptor[];
  /** `registry.toJsonSchema({ base })`, already rebased for the tool. */
  readonly planSchema: Record<string, unknown>;
  readonly units: Readonly<Record<string, string>>;
}

export interface Turn {
  readonly prompt: string;
  readonly envelope: Envelope;
}

export interface Composed {
  readonly envelope: Envelope;
  /** The model's one-line account of what it built, for the composer panel. */
  readonly note?: string;
  readonly source: 'anthropic' | 'openai' | 'scripted';
  readonly model?: string;
  readonly ms: number;
  readonly usage?: Readonly<Record<string, number>>;
  /** Set when the composer could not honour the prompt. */
  readonly warning?: string;
}

export interface Composer {
  readonly kind: 'anthropic' | 'openai' | 'scripted';
  readonly why: string;
  compose(
    prompt: string,
    ctx: ComposerContext,
    history: readonly Turn[],
  ): Promise<Composed>;
  /**
   * The same seam, one step further: compose, **read the result back**,
   * and answer. `run` is supplied by the server so the loop never learns
   * what a `Host` is.
   */
  converse(
    prompt: string,
    ctx: ComposerContext,
    history: readonly Turn[],
    run: Runner,
  ): Promise<Answer>;
}

// ── the tool contract ────────────────────────────────────────

/**
 * The envelope as a tool schema.
 *
 * `process` is the registry's own projection with its `$defs` **hoisted
 * to this document's root** — the only arrangement a tool API accepts,
 * since a `$ref` may point at top-level definitions and nothing else.
 *
 * `select.on` reuses the very same `#/$defs/spec`, so a selector names a
 * spec inline. That is deliberate: a caller cannot compute a `specId`,
 * and asking it to invent one would be asking it to reimplement the
 * library's hashing rules. It is also the recursion paying off twice
 * from a single definition.
 */
export function requestSchema(ctx: ComposerContext): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['from', 'as', 'nodes', 'outputs'],
    properties: {
      from: {
        type: 'string',
        enum: ctx.datasets.map((d) => d.id),
        description: 'Which dataset to resolve the plan against.',
      },
      as: {
        type: 'string',
        description:
          'A short snake_case name for this result, so a later prompt can refer back to it. A name, not a time window.',
      },
      nodes: ctx.planSchema,
      outputs: {
        type: 'array',
        minItems: 1,
        description:
          'What to return, each under a name you choose. Prefer a reduction — the caller is reading JSON, not drawing a chart.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'on'],
          properties: {
            name: {
              type: 'string',
              description:
                'A short snake_case name for this result, e.g. "upper_band". The caller reads it back by this name.',
            },
            on: {
              type: 'string',
              description: 'The slot of the node to read.',
            },
            columns: {
              type: 'boolean',
              const: true,
              description:
                'Ask for the full column. Use sparingly: it returns every row.',
            },
            reduce: {
              type: 'string',
              enum: ['last', 'extremes', 'percentileRank', 'shape'],
              description:
                'last: latest defined value. extremes: min and max with timestamps. percentileRank: where the latest value sits in its own history. shape: a bounded sample of the whole series.',
            },
            output: {
              type: 'string',
              description:
                'For a multi-output op, which output — e.g. "Upper". Defaults to the first.',
            },
            points: {
              type: 'integer',
              minimum: 2,
              maximum: 400,
              description: 'For `shape`, roughly how many points to return.',
            },
          },
        },
      },
      note: {
        type: 'string',
        description: 'One sentence on what you built and why.',
      },
    },
  };
}

/**
 * Folds the wire arrays into the record shapes the library takes.
 *
 * `nodes` and `outputs` are both caller-keyed maps, and a caller-chosen
 * key cannot be declared in JSON Schema `properties` — which strict
 * structured outputs require alongside `additionalProperties: false`. So
 * they cross as arrays carrying their name as a field, and fold here.
 */
export function foldSlotRequest(raw: Record<string, unknown>): {
  envelope: Record<string, unknown>;
  note?: string;
} {
  const { note, nodes, outputs, ...rest } = raw as {
    note?: string;
    nodes?: { slot: string; op: string; in: string[]; params?: unknown }[];
    outputs?: { name: string; on: string; [k: string]: unknown }[];
  } & Record<string, unknown>;

  const folded: Record<string, unknown> = {};
  for (const n of nodes ?? []) {
    const { slot, ...def } = n;
    folded[slot] = def;
  }
  const surfaced: Record<string, unknown> = {};
  for (const o of outputs ?? []) {
    const { name, ...sel } = o;
    surfaced[name] = sel;
  }
  return {
    envelope: { ...rest, nodes: folded, outputs: surfaced },
    ...(typeof note === 'string' && { note }),
  };
}

/**
 * The op table, rendered for the prompt.
 *
 * This exists because the JSON Schema projection does **not** carry
 * units — neither an output's unit nor an input's required unit. Whether
 * that omission is what trips the agent up is the M2 friction note; the
 * table is here so the finding is about the *projection*, not about a
 * prompt that withheld information the library actually has.
 */
export function opTable(ctx: ComposerContext): string {
  const rows = ctx.ops.map((op) => {
    const outs = op.outputs
      .map((o) => `${o.suffix === '' ? '(single)' : o.suffix}:${o.unit}`)
      .join(' ');
    return `- ${op.name} [${op.family}] → ${outs}`;
  });
  const columns = Object.entries(ctx.units)
    .map(([name, unit]) => `${name}:${unit}`)
    .join(', ');
  return [
    'Ops, with the unit each output carries ("inherit" = same as its input):',
    ...rows,
    '',
    `Raw source columns and their units: ${columns}.`,
  ].join('\n');
}

export const SYSTEM = `You turn a plain-English request about a price series into a process plan.

A plan is a DAG of nodes. Each node gets a **slot** — a short name you choose,
unique within the request — plus an op and its params. A node's \`in\` lists its
inputs in order, and each input is either a source column name or the slot of
another node. That is how you express "EMA of the SMA of px": two nodes, where
the EMA's \`in\` is the SMA's slot. Params you omit take their declared defaults.

Emit exactly one call to \`emit_request\`. Rules that are not in the schema:

- A slot must not be the name of a source column.
- Every \`on\` in \`outputs\` must be a slot you defined in \`nodes\`.
- Name each output for what it *is* ("upper_band", "annualised_vol"), because
  the caller reads results back by that name.
- Prefer a reduction over \`columns\`. The caller reads JSON.
- If the request is ambiguous, choose conventional defaults and say what you
  chose in \`note\` rather than asking.
- If you cannot express the request with the ops available, still emit a
  request for the closest thing you can build, and say what was missing in
  \`note\`.`;

export function scriptedComposer(): Composer {
  return {
    kind: 'scripted',
    why: 'No API key — falling back to a keyword matcher.',

    /**
     * One round, and a reading of the facts rather than an answer.
     *
     * A keyword matcher cannot answer a question, and pretending
     * otherwise would put prose on screen that looks like analysis and
     * is not. It restates what came back and says who wrote it.
     */
    async converse(prompt, ctx, history, run: Runner): Promise<Answer> {
      const t0 = performance.now();
      const composed = await this.compose(prompt, ctx, history);
      const round: Round = {
        ...run(composed.envelope),
        ...(composed.note !== undefined && { note: composed.note }),
      };
      const read = round.reading.facts
        .map((f) => `${String(f['name'])} = ${String(f['value'] ?? '—')}`)
        .join('; ');
      return {
        text:
          read === ''
            ? 'The plan produced no facts.'
            : `Read back: ${read}. No model was involved, so this is a restatement rather than an answer.`,
        cites: round.reading.facts.map((f) => String(f['name'])),
        rounds: [round],
        source: 'scripted',
        ms: Math.round((performance.now() - t0) * 1000) / 1000,
        warning:
          'The offline keyword matcher cannot analyse a result — it only echoes the facts the engine returned.',
      };
    },

    async compose(prompt, ctx) {
      const t0 = performance.now();
      const text = prompt.toLowerCase();
      const from =
        ctx.datasets.find((d) => text.includes(d.id.toLowerCase()))?.id ??
        ctx.datasets[0]?.id ??
        'unknown';
      const period = Number(/\b(\d{1,4})\b/.exec(text)?.[1] ?? 20);
      const has = (...words: string[]) => words.some((w) => text.includes(w));

      let nodes: Record<string, unknown>;
      let on: string;
      let as: string;
      if (has('bollinger', 'band')) {
        nodes = { bb: { op: 'bollinger', params: { period }, in: ['px'] } };
        on = 'bb';
        as = 'bands';
      } else if (has('rsi', 'strength')) {
        nodes = { rsi: { op: 'rsi', params: { period }, in: ['px'] } };
        on = 'rsi';
        as = 'rsi';
      } else if (has('volatil', 'annualis', 'annualiz')) {
        nodes = {
          ret: { op: 'roc', params: { period: 1 }, in: ['px'] },
          v: { op: 'variance', params: { period }, in: ['ret'] },
          vol: { op: 'annualise', in: ['v'] },
        };
        on = 'vol';
        as = 'annualised_vol';
      } else if (has('z-score', 'zscore', 'unusual', 'stretched')) {
        nodes = { z: { op: 'zscore', params: { period }, in: ['px'] } };
        on = 'z';
        as = 'zscore';
      } else if (has('smooth', 'smoother', 'double')) {
        nodes = {
          avg: { op: 'sma', params: { period }, in: ['px'] },
          smooth: { op: 'ema', params: { period }, in: ['avg'] },
        };
        on = 'smooth';
        as = 'smoothed';
      } else {
        nodes = { avg: { op: 'sma', params: { period }, in: ['px'] } };
        on = 'avg';
        as = 'average';
      }

      return {
        envelope: {
          from,
          as,
          nodes,
          outputs: { latest: { on, reduce: 'last' } },
          onError: 'collect',
        } as unknown as Envelope,
        note: 'Built by the offline keyword matcher, not by a model.',
        source: 'scripted',
        ms: Math.round((performance.now() - t0) * 1000) / 1000,
        warning:
          'This plan came from a keyword matcher, so it says nothing about whether the registry schema is sufficient for an agent.',
      };
    },
  };
}

/** The plan tool, shared by the one-shot path and the answer loop. */
function emitTool(ctx: ComposerContext): Anthropic.Tool {
  return {
    name: 'emit_request',
    description:
      'Emit the process request that answers the user’s prompt. Call this exactly once.',
    input_schema: requestSchema(ctx) as Anthropic.Tool['input_schema'],
  };
}

/** History and the op table, as the opening messages of either path. */
function opening(
  prompt: string,
  ctx: ComposerContext,
  history: readonly Turn[],
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    messages.push({ role: 'user', content: turn.prompt });
    messages.push({
      role: 'assistant',
      content: `Previous request:\n${JSON.stringify(turn.envelope)}`,
    });
  }
  messages.push({
    role: 'user',
    content: `${opTable(ctx)}\n\nRequest: ${prompt}`,
  });
  return messages;
}

export function anthropicComposer(options: {
  model: string;
  fallbacks: boolean;
}): Composer {
  const client = new Anthropic();
  return {
    kind: 'anthropic',
    why: `Composing with ${options.model}.`,

    /**
     * Compose, run, read back, answer.
     *
     * The assistant's content blocks go back verbatim each round —
     * thinking blocks included — because with adaptive thinking the
     * model's reasoning about round one is what makes round two a
     * *sharper* question rather than a differently-worded one.
     */
    async converse(prompt, ctx, history, run: Runner): Promise<Answer> {
      const t0 = performance.now();
      const answerTool: Anthropic.Tool = {
        name: ANSWER_TOOL.name,
        description: ANSWER_TOOL.description,
        input_schema: ANSWER_TOOL.schema as Anthropic.Tool['input_schema'],
      };
      const messages = opening(prompt, ctx, history);
      const rounds: Round[] = [];
      const usage = { input: 0, output: 0, cacheRead: 0 };
      let model: string | undefined;

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        // The last round may only answer, so the cap can never surface
        // as a missing reply.
        const last = round === MAX_ROUNDS - 1;
        const response = await createWithFallbacks(
          client,
          {
            model: options.model,
            max_tokens: 16000,
            system: ANALYST,
            thinking: { type: 'adaptive' },
            tools: last ? [answerTool] : [emitTool(ctx), answerTool],
            tool_choice: last
              ? { type: 'tool', name: ANSWER_TOOL.name }
              : { type: 'any' },
            messages,
          },
          options,
        );
        model = response.model;
        usage.input += response.usage.input_tokens;
        usage.output += response.usage.output_tokens;
        usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;

        if (response.stop_reason === 'refusal') {
          throw new Error(
            `The model declined this prompt (${response.stop_details?.category ?? 'unspecified'}).`,
          );
        }
        messages.push({ role: 'assistant', content: response.content });
        const call = response.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (call === undefined) {
          throw new Error('The model ended its turn without calling a tool.');
        }

        if (call.name === ANSWER_TOOL.name) {
          const { answer, cites } = call.input as {
            answer?: string;
            cites?: string[];
          };
          return {
            text: answer ?? '',
            cites: cites ?? [],
            rounds,
            source: 'anthropic',
            ...(model !== undefined && { model }),
            ms: Math.round((performance.now() - t0) * 1000) / 1000,
            usage,
            ...(rounds.length === 0 && {
              warning: 'The model answered without reading anything back.',
            }),
          };
        }

        const { envelope, note } = foldSlotRequest(
          call.input as Record<string, unknown>,
        );
        const result = run({ ...envelope, onError: 'collect' } as Envelope);
        rounds.push({ ...result, ...(note !== undefined && { note }) });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: resultText(rounds[rounds.length - 1]!),
            },
          ],
        });
      }

      throw new Error(`The model did not answer within ${MAX_ROUNDS} rounds.`);
    },

    async compose(prompt, ctx, history) {
      const t0 = performance.now();
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: options.model,
        max_tokens: 16000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        tools: [emitTool(ctx)],
        tool_choice: { type: 'tool', name: 'emit_request' },
        messages: opening(prompt, ctx, history),
      };

      const response = await createWithFallbacks(client, params, options);

      if (response.stop_reason === 'refusal') {
        throw new Error(
          `The model declined this prompt (${response.stop_details?.category ?? 'unspecified'}).`,
        );
      }
      const call = response.content.find(
        (b): b is Anthropic.ToolUseBlock =>
          b.type === 'tool_use' && b.name === 'emit_request',
      );
      if (call === undefined) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        throw new Error(
          `The model answered in prose instead of calling the tool: ${text.slice(0, 400)}`,
        );
      }

      const { envelope, note } = foldSlotRequest(
        call.input as Record<string, unknown>,
      );
      return {
        // `onError: 'collect'` is not the agent's choice to make — an
        // invalid plan has to come back as readable `skipped` reasons it
        // can retry against, never as an opaque failure.
        envelope: { ...envelope, onError: 'collect' } as Envelope,
        ...(typeof note === 'string' && { note }),
        source: 'anthropic',
        model: response.model,
        ms: Math.round((performance.now() - t0) * 1000) / 1000,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          cacheRead: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * Sends the request with server-side refusal fallbacks, retrying once
 * without them if the API rejects the parameter.
 *
 * Fallbacks are recommended for every Opus 5 caller, but this is a demo
 * whose beta path cannot be exercised here (no key in the environment),
 * and an untestable beta should not be able to brick the app. The retry
 * is the whole hedge.
 */
async function createWithFallbacks(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: { fallbacks: boolean },
): Promise<Anthropic.Message> {
  if (options.fallbacks) {
    try {
      return (await client.beta.messages.create({
        ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming),
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      } as never)) as unknown as Anthropic.Message;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/fallback/i.test(message)) throw e;
      console.warn(`[compose] server-side fallbacks unavailable: ${message}`);
    }
  }
  return client.messages.create(params);
}

/**
 * A key is present only if it is non-empty.
 *
 * `.env.example` ships `ANTHROPIC_API_KEY=` as a placeholder, and
 * `loadEnvFile` faithfully sets it to `''` — which an `!== undefined`
 * check reads as "present", silently routing to a provider with no
 * credential. The same trap the Anthropic docs call out for a stale
 * exported empty key; worth guarding rather than assuming.
 */
function key(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * Picks a composer from the environment, without throwing when there is
 * no key at all.
 *
 * Anthropic first when both are present — `compose.ts` is the reference
 * implementation and the one the rest of the repo is written against.
 */
export function composerFromEnv(): Composer {
  if (
    key('ANTHROPIC_API_KEY') !== undefined ||
    key('ANTHROPIC_AUTH_TOKEN') !== undefined
  ) {
    return anthropicComposer({
      model: process.env['PROCESS_DEMO_MODEL'] ?? 'claude-opus-5',
      fallbacks: process.env['PROCESS_DEMO_NO_FALLBACKS'] !== '1',
    });
  }
  if (key('OPENAI_API_KEY') !== undefined) {
    return openaiComposer({
      model: process.env['PROCESS_DEMO_MODEL'] ?? 'gpt-5.4',
      strict: process.env['PROCESS_DEMO_NO_STRICT'] !== '1',
    });
  }
  return scriptedComposer();
}
