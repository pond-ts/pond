/**
 * The answer loop — the experiment's actual question, finally asked.
 *
 * Everything before this milestone stopped one step short. The model
 * composed a plan, the engine ran it, and a person read the facts. The
 * model never saw its own results, so nothing tested whether the numbers
 * that come back are *usable* — only whether the schema was expressible.
 *
 * Here the loop closes. The model calls `emit_request`, we run it, and
 * the facts go back as a tool result. It may request again — with
 * different reductions, a different period, a study it now realises it
 * needs — and only when it has enough does it call `answer`.
 *
 * **The second request is the point.** A follow-up re-states nodes it
 * already computed, and those are content-addressed, so the engine
 * recognises them and charges nothing: round two pays only for what is
 * genuinely new. That is the difference between "ask one careful question
 * and hope" and "look, then look again" — and it is a property of the
 * library, not of the prompt. Each round reports `computed` and `cached`
 * so the claim is visible rather than asserted.
 *
 * The reading handed back is **facts only** — no columns. A reduction is
 * a few numbers with a unit and a timestamp; the column behind it is
 * 150,000 points. `select` was built so a consumer could ask the graph a
 * question instead of downloading it, and a model is exactly that
 * consumer, several orders of magnitude more expensive per point.
 */

import type { Envelope } from '@pond-ts/process';

/** What the model is shown after a request runs. Facts, never columns. */
export interface Reading {
  readonly facts: readonly Record<string, unknown>[];
  /** Plans that did not resolve, with the reason — retryable, not fatal. */
  readonly skipped?: readonly unknown[];
}

/** One trip through the engine, with what it cost. */
export interface Round {
  readonly envelope: Envelope;
  readonly note?: string;
  readonly reading: Reading;
  readonly ms: number;
  /** Nodes this round actually built, and nodes it got for free. */
  readonly computed: number;
  readonly cached: number;
}

export interface Answer {
  readonly text: string;
  /** The output names the answer rests on, so a figure is traceable. */
  readonly cites: readonly string[];
  readonly rounds: readonly Round[];
  readonly source: 'anthropic' | 'openai' | 'scripted';
  readonly model?: string;
  readonly ms: number;
  readonly usage?: Readonly<Record<string, number>>;
  /** Set when the loop ended without the model answering. */
  readonly warning?: string;
}

/** Runs one request and reports what it cost. Supplied by the server. */
export type Runner = (envelope: Envelope) => Round;

/**
 * How many times the model may go back to the engine.
 *
 * Not a cost control — the engine rounds are effectively free by round
 * two. It is a termination guarantee for a loop whose exit condition is
 * the model's own judgement, and the last round forces `answer` so the
 * cap can never surface as a missing reply.
 */
export const MAX_ROUNDS = 4;

export const ANSWER_TOOL = {
  name: 'answer',
  description:
    'Answer the person who asked, using the facts you have read back. Call this exactly once, last.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'cites'],
    properties: {
      answer: {
        type: 'string',
        description:
          'Prose for the person who asked. Plain sentences; no headings, no bullet lists unless comparing three or more things.',
      },
      cites: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The output names your answer rests on, e.g. ["annualised_vol", "vol_high_low"].',
      },
    },
  },
};

/**
 * The analyst's brief, layered on the plan-composing rules.
 *
 * The instruction that earns its place is "a follow-up is cheap". Left to
 * itself a model writes one maximal request and reasons from whatever
 * comes back, because in most tools a second call costs what the first
 * did. Here it does not, and saying so is what turns the cache from an
 * efficiency into a licence to look twice.
 */
export const ANALYST = `You answer questions about a price series by building process plans, reading the results back, and then explaining what they mean.

You have two tools:

- \`emit_request\` builds a plan, runs it, and returns the outputs you named.
- \`answer\` ends the turn with prose for the person who asked.

Call \`emit_request\` as many times as the question needs — up to ${MAX_ROUNDS - 1} — then \`answer\` exactly once.

**A follow-up request is nearly free.** Nodes are content-addressed and cached, so re-stating a node you already computed costs nothing and only genuinely new work runs; each result tells you how many nodes were computed versus cached. So prefer looking twice over guessing once: read a first result, then ask the sharper question it suggests. A question like "is this unusual?" needs both the current value and something to compare it against — go and get both.

**The cache outlives the turn.** If a result from an earlier turn in this conversation would help you answer, ask for it again. Re-stating those nodes costs nothing — they are still computed. Never tell the person you cannot compare against something you measured earlier; go and re-read it.

When you answer:

- Answer the question that was asked. Two or three sentences unless more is genuinely warranted, and no preamble.
- Every figure you state must come from a fact you read back, with its unit. Do not estimate.
- Round for a reader: two or three significant figures is almost always right. A fact carries full precision because the engine has it, not because anyone wants to read it.
- A fact may carry a \`note\` saying what its value means — a percentile rank comes back as a fraction with a note giving the percentile. Where a note exists, it is what to say.
- Do not narrate the plan you built. The person can see it.
- Put the output names your answer rests on in \`cites\`.
- If the ops available could not measure something the question needs, say so plainly rather than substituting a proxy in silence.`;

/**
 * The compact view of a run: what the model needs, and nothing it does
 * not.
 *
 * `skipped` is included deliberately. A rejected plan comes back with a
 * reason — a bad unit, an unknown op — and the model is the one party
 * that can act on it, by requesting again. Hiding it would turn a
 * recoverable mistake into a wrong answer.
 */
export function readingOf(wire: {
  facts?: readonly Record<string, unknown>[];
  skipped?: readonly unknown[];
}): Reading {
  return {
    facts: wire.facts ?? [],
    ...(wire.skipped !== undefined &&
      wire.skipped.length > 0 && { skipped: wire.skipped }),
  };
}

/** The tool result text for one round: the facts, plus what they cost. */
export function resultText(round: Round): string {
  const cost = `${round.computed} node${round.computed === 1 ? '' : 's'} computed, ${round.cached} cached, ${round.ms} ms`;
  return `${JSON.stringify(round.reading)}\n\n(${cost})`;
}
