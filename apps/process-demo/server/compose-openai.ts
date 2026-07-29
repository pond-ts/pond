/**
 * The OpenAI composer — a second implementation of the same seam.
 *
 * `compose.ts` stays Claude-shaped; this file is the non-Anthropic path,
 * kept separate so neither gets muddled by the other's conventions.
 *
 * **A second vendor makes [PND-PROCSCHEMA] a stronger result, not a
 * weaker one.** The question is whether `registry.toJsonSchema()` is
 * self-sufficient — and the thing under test is the recursive `$ref`
 * that lets a caller express *EMA of SMA of px*. A finding that holds
 * across two independent function-calling implementations is evidence
 * about the *projection*; a finding from one is evidence about a vendor.
 *
 * Already measured, with no API calls, by running the projection through
 * the SDK's own `toStrictJsonSchema` (`scripts/strict-schema-probe.mts`):
 *
 * - the **recursion passes** — `{$ref: '#/properties/process/items'}`
 *   nested inside `oneOf` is accepted, so M2's rebasing is portable;
 * - `oneOf` passes;
 * - **optionality does not.** Strict mode requires every declared
 *   property to be listed in `required`, and the projection marks both
 *   `params` and each param inside it optional — which is exactly where
 *   the registry's defaults live.
 *
 * That is a real design tension rather than a bug: "params you omit take
 * their declared defaults" is the registry's central affordance, and
 * strict mode says nothing may be omitted. `strictParams()` below
 * resolves it the way strict mode intends — every param **required and
 * nullable**, with `null` meaning "use the declared default" — so the
 * default survives as a value the caller can name rather than a property
 * it can leave out.
 */

import OpenAI from 'openai';
import type { Envelope } from '@pond-ts/process';
import {
  ANALYST,
  ANSWER_TOOL,
  MAX_ROUNDS,
  resultText,
  type Answer,
  type Round,
  type Runner,
} from './agent.js';
import {
  foldSlotRequest,
  opTable,
  requestSchema,
  SYSTEM,
  type Composed,
  type Composer,
  type ComposerContext,
  type Turn,
} from './compose.js';

/**
 * Rewrites the request schema for strict structured outputs.
 *
 * Two rules, both from the SDK's own validator: every declared property
 * must be `required`, and an optional property is expressed as a
 * nullable one instead. Applied recursively, because the projection
 * nests objects several deep.
 */
function strictParams(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(strictParams);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = strictParams(v);
  if (out['type'] === 'object' && out['properties'] !== undefined) {
    const props = out['properties'] as Record<string, unknown>;
    const declared = Object.keys(props);
    const already = new Set((out['required'] as string[] | undefined) ?? []);
    for (const key of declared) {
      if (already.has(key)) continue;
      // Optional becomes required-and-nullable: `null` is the caller
      // saying "use the declared default", which is what omitting it
      // used to mean.
      const prop = props[key] as Record<string, unknown>;
      if (typeof prop['type'] === 'string') {
        prop['type'] = [prop['type'], 'null'];
      }
    }
    out['required'] = declared;
  }
  return out;
}

/** Strips the nulls back out, so the plan layer sees an omitted param. */
function dropNulls(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(dropNulls);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === null) continue;
    out[k] = dropNulls(v);
  }
  return out;
}

export function openaiComposer(options: {
  model: string;
  strict: boolean;
}): Composer {
  const client = new OpenAI();

  const emitTool = (ctx: ComposerContext): OpenAI.Responses.Tool => ({
    type: 'function',
    name: 'emit_request',
    description:
      'Emit the process request that answers the user’s prompt. Call this exactly once.',
    parameters: options.strict
      ? (strictParams(requestSchema(ctx)) as Record<string, unknown>)
      : requestSchema(ctx),
    strict: options.strict,
  });

  const opening = (
    prompt: string,
    ctx: ComposerContext,
    history: readonly Turn[],
  ): OpenAI.Responses.ResponseInput => {
    const input: OpenAI.Responses.ResponseInput = [];
    for (const turn of history) {
      input.push({ role: 'user', content: turn.prompt });
      input.push({
        role: 'assistant',
        content: `Previous request:\n${JSON.stringify(turn.envelope)}`,
      });
    }
    input.push({
      role: 'user',
      content: `${opTable(ctx)}\n\nRequest: ${prompt}`,
    });
    return input;
  };

  return {
    kind: 'openai',
    why: `Composing with ${options.model}${options.strict ? ' (strict)' : ''}.`,

    /**
     * Compose, run, read back, answer.
     *
     * Every output item goes back into `input` verbatim — including
     * reasoning items, which the Responses API expects to see again on
     * the next turn and which are the model's own account of what round
     * one told it.
     */
    async converse(
      prompt,
      ctx: ComposerContext,
      history: readonly Turn[],
      run: Runner,
    ): Promise<Answer> {
      const t0 = performance.now();
      const answerTool: OpenAI.Responses.Tool = {
        type: 'function',
        name: ANSWER_TOOL.name,
        description: ANSWER_TOOL.description,
        parameters: ANSWER_TOOL.schema as unknown as Record<string, unknown>,
        strict: options.strict,
      };
      const input = opening(prompt, ctx, history);
      const rounds: Round[] = [];
      const usage = { input: 0, output: 0, cacheRead: 0 };
      let model: string | undefined;

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const last = round === MAX_ROUNDS - 1;
        const response = await client.responses.create({
          model: options.model,
          instructions: ANALYST,
          input,
          tools: last ? [answerTool] : [emitTool(ctx), answerTool],
          tool_choice: last
            ? { type: 'function', name: ANSWER_TOOL.name }
            : 'required',
        });
        model = response.model;
        usage.input += response.usage?.input_tokens ?? 0;
        usage.output += response.usage?.output_tokens ?? 0;
        usage.cacheRead +=
          response.usage?.input_tokens_details?.cached_tokens ?? 0;
        // Output items are echoed back as input for the next turn; the
        // SDK types the two sides separately, and only the tool-call
        // variants this loop can actually produce overlap cleanly.
        input.push(
          ...(response.output as unknown as OpenAI.Responses.ResponseInput),
        );

        const call = response.output.find((i) => i.type === 'function_call');
        if (call === undefined || call.type !== 'function_call') {
          throw new Error(
            `The model ended its turn without calling a tool: ${response.output_text.slice(0, 300)}`,
          );
        }
        const raw = JSON.parse(call.arguments) as Record<string, unknown>;
        const args = options.strict
          ? (dropNulls(raw) as Record<string, unknown>)
          : raw;

        if (call.name === ANSWER_TOOL.name) {
          return {
            text: typeof args['answer'] === 'string' ? args['answer'] : '',
            cites: Array.isArray(args['cites'])
              ? (args['cites'] as string[])
              : [],
            rounds,
            source: 'openai',
            ...(model !== undefined && { model }),
            ms: Math.round((performance.now() - t0) * 1000) / 1000,
            usage,
            ...(rounds.length === 0 && {
              warning: 'The model answered without reading anything back.',
            }),
          };
        }

        const { envelope, note } = foldSlotRequest(args);
        const result = run({ ...envelope, onError: 'collect' } as Envelope);
        rounds.push({ ...result, ...(note !== undefined && { note }) });
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: resultText(rounds[rounds.length - 1]!),
        });
      }

      throw new Error(`The model did not answer within ${MAX_ROUNDS} rounds.`);
    },

    async compose(prompt, ctx: ComposerContext, history: readonly Turn[]) {
      const t0 = performance.now();
      // The Responses API is what this SDK version presents as current.
      // Note the shapes differ from Chat Completions: the tool is flat
      // (no nested `function`), `strict` is required rather than
      // optional, and `tool_choice` is `{type, name}` without nesting.
      const response = await client.responses.create({
        model: options.model,
        instructions: SYSTEM,
        input: opening(prompt, ctx, history),
        tools: [emitTool(ctx)],
        tool_choice: { type: 'function', name: 'emit_request' },
      });

      const call = response.output.find(
        (item) => item.type === 'function_call' && item.name === 'emit_request',
      );
      if (call === undefined || call.type !== 'function_call') {
        throw new Error(
          `The model answered without calling the tool: ${response.output_text.slice(0, 400)}`,
        );
      }

      const raw = JSON.parse(call.arguments) as Record<string, unknown>;
      const { envelope, note } = foldSlotRequest(
        options.strict ? (dropNulls(raw) as Record<string, unknown>) : raw,
      );

      return {
        // Not the model's choice to make: an invalid plan has to come
        // back as readable `skipped` reasons it can retry against.
        envelope: { ...envelope, onError: 'collect' } as Envelope,
        ...(typeof note === 'string' && { note }),
        source: 'openai',
        model: response.model,
        ms: Math.round((performance.now() - t0) * 1000) / 1000,
        usage: {
          input: response.usage?.input_tokens ?? 0,
          output: response.usage?.output_tokens ?? 0,
          cacheRead: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        },
      } satisfies Composed;
    },
  };
}
