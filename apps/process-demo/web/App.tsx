/**
 * Three panels: composer, request, results.
 *
 * M2 is raw only — every panel renders JSON. Charts are M3 and the
 * clickable pipeline is M4, and the discipline of not starting there is
 * the point: the UI cannot decide anything the plan layer has not yet
 * exposed. What this version *does* decide is whether an agent can
 * compose a valid plan from the registry projection alone, and the two
 * things worth looking at are the `skipped` array and the per-node
 * warm/cold badges.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viz, type Fact, type Frames } from './Viz.js';
import { Pipeline, type NodeTiming } from './Pipeline.js';
import { Tune, type ParamDef } from './Tune.js';

interface DatasetInfo {
  id: string;
  rows: number;
  columns: string[];
  nodes: number;
}
interface OpDescriptor {
  name: string;
  family: string;
  summary: string;
  params: Record<string, ParamDef>;
  /** The declared inputs — roles and any demanded unit, not a count. */
  inputs: { role: string; unit?: string }[];
  outputs: { suffix: string; unit: string }[];
}
interface Context {
  datasets: DatasetInfo[];
  ops: OpDescriptor[];
  families: Record<string, string[]>;
  units: Record<string, string>;
  planSchema: unknown;
  composer: { kind: 'anthropic' | 'openai' | 'scripted'; why: string };
}
interface RunResult {
  /** Columns the server did not re-send, because we said we held them. */
  reused?: string[];
  facts: Fact[];
  outputs: Record<string, { column: string; unit: string | null }[]>;
  explain: Record<string, string>;
  skipped: { reason: string; spec?: unknown; select?: unknown }[];
  nodes: NodeTiming[];
  hasSeries: boolean;
  as?: string;
  ms: number;
  frames?: Frames;
  encodeMs?: number;
}
interface Composed {
  envelope: Record<string, unknown>;
  note?: string;
  source: 'anthropic' | 'openai' | 'scripted';
  model?: string;
  ms: number;
  usage?: Record<string, number>;
  warning?: string;
}
/**
 * The agent's reply, and the trips through the engine it rests on.
 *
 * `rounds` is the part worth showing. It is the record of the model
 * looking twice — and of the second look costing nothing, which is the
 * library claim the whole demo exists to test.
 */
interface AnswerBody {
  text: string;
  cites: string[];
  rounds: {
    note?: string;
    ms: number;
    computed: number;
    cached: number;
    reading: { facts: Fact[]; skipped?: unknown[] };
  }[];
  source: 'anthropic' | 'openai' | 'scripted';
  model?: string;
  ms: number;
  usage?: Record<string, number>;
  warning?: string;
}

interface Entry {
  id: number;
  prompt: string;
  composed?: Composed | undefined;
  result?: RunResult | undefined;
  /** The prose reply. Absent until `/api/ask` lands. */
  answer?: AnswerBody | undefined;
  /**
   * The envelope that actually produced `result` — which is not
   * `composed.envelope` once the request panel has been edited. The draw
   * path reads this, so a chart always matches the plan on screen.
   */
  ran?: unknown;
  /**
   * The node the pipeline view has selected, if any. Drawing reads it:
   * with a focus the request asks for that one id, without it for every
   * top-level spec. Addressing an intermediate *by name* is the whole
   * point of M4 — in a fold you would have had to retain and name it
   * yourself.
   */
  focus?: string | undefined;
  /** The columns response, fetched only when the viz tab asks. */
  drawn?: RunResult | undefined;
  /**
   * The drawn response is for a superseded run and should be refetched —
   * but **kept on screen meanwhile**. Clearing it instead made every
   * slider step tear the panel down and rebuild it: figures unmounted,
   * the panel collapsed to a one-line message, then re-expanded. Holding
   * the last good render is what makes tuning read as a value changing
   * rather than a page reloading.
   */
  drawnStale?: boolean | undefined;
  drawing?: boolean | undefined;
  /**
   * The output names the *request* asked for.
   *
   * Drawing adds a `columns` selector per node so the workbook has a
   * chart for every step, and the server names those from their key like
   * any other — so `name !== undefined` cannot separate "what was asked
   * for" from "what we added to show the work". This can.
   */
  asked?: string[] | undefined;
  /**
   * Why the last draw failed. Distinct from `error` so a failed draw
   * does not clobber the run's own message — and load-bearing: without
   * somewhere to record the failure, "needs drawing" flips straight back
   * to true and the tab retries forever behind a "Drawing…" that never
   * clears.
   */
  drawError?: string | undefined;
  error?: string | undefined;
  pending: boolean;
}

const EXAMPLES = [
  'How stretched is the price right now versus the last four hours?',
  'Show me an EMA of a 50-bar simple moving average, and where it sits today.',
  'What is annualised volatility over the last day, and its high and low?',
  'Give me bollinger bands and the current upper band.',
];

/** Either request shape counts as something we can draw from. */
function hasPlan(envelope: {
  process?: unknown[];
  nodes?: Record<string, unknown>;
}): boolean {
  return (
    Array.isArray(envelope.process) ||
    (typeof envelope.nodes === 'object' && envelope.nodes !== null)
  );
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // A refused connection surfaced as "Failed to execute 'json' on
    // 'Response'", which tells a reader nothing about what is wrong.
    throw new Error(
      `No response from the API on ${path}. Is the server still running (npm run dev:server)?`,
    );
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const reason = (json as { error?: string } | undefined)?.error;
    throw new Error(reason ?? `${res.status} ${res.statusText}`.trim());
  }
  if (json === undefined) {
    throw new Error(`${path} returned ${res.status} with no JSON body.`);
  }
  return json as T;
}

export function App() {
  const [context, setContext] = useState<Context>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<number>();
  const nextId = useRef(1);

  const [resident, setResident] = useState<number>();
  /**
   * Decoded columns, keyed by name.
   *
   * A column's name is its content-addressed id, so this never goes
   * stale: the same name is always the same data. It is the graph's own
   * cache, mirrored on the client — which is the point of deriving the
   * id rather than assigning it.
   */
  const held = useRef(new Map<string, string>());
  /**
   * The transcript, so a new turn scrolls itself into view.
   *
   * Pinned to the bottom on every change rather than only on a new
   * entry: a turn arrives empty and grows when the answer lands, and
   * scrolling once at the start leaves the reply below the fold.
   */
  const transcript = useRef<HTMLOListElement>(null);
  const refreshContext = useCallback(() => {
    fetch('/api/context')
      .then((r) => r.json())
      .then((c: Context) => {
        setContext(c);
        // How many nodes the host is holding. Under content-addressing
        // this only grows, which is exactly [PND-PROCIDENT]'s point and
        // the reason [PND-PROCCACHE] exists — there is no budget yet.
        setResident(c.datasets.reduce((n, d) => n + d.nodes, 0));
      })
      .catch(() => undefined);
  }, []);
  useEffect(refreshContext, [refreshContext]);

  useEffect(() => {
    const el = transcript.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const current = useMemo(
    () => entries.find((e) => e.id === selected) ?? entries[entries.length - 1],
    [entries, selected],
  );

  async function ask(text: string) {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const id = nextId.current++;
    setEntries((prev) => [...prev, { id, prompt: trimmed, pending: true }]);
    setSelected(id);
    setPrompt('');

    // The whole history goes back with every prompt, so M5's follow-ups
    // ("smoother", "try 50 instead") are an addition rather than a rewrite.
    const history = entries
      .filter((e) => e.composed !== undefined)
      .map((e) => ({ prompt: e.prompt, envelope: e.composed!.envelope }));

    try {
      const body = await post<{
        answer: AnswerBody;
        composed?: Composed;
        result?: RunResult;
      }>('/api/ask', { prompt: trimmed, history });
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                ...body,
                ran: body.composed?.envelope,
                drawn: undefined,
                drawError: undefined,
                pending: false,
              }
            : e,
        ),
      );
    } catch (e) {
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                pending: false,
                error: e instanceof Error ? e.message : String(e),
              }
            : entry,
        ),
      );
    }
  }

  /** Re-runs a hand-edited envelope without going back through the model. */
  async function rerun(
    entry: Entry,
    envelope: unknown,
  ): Promise<RunResult | undefined> {
    if (envelope === undefined) return undefined;
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, pending: true } : e)),
    );
    let returned: RunResult | undefined;
    try {
      const result = await post<RunResult>('/api/run', envelope);
      returned = result;
      // The envelope may have been hand-edited, so anything previously
      // drawn is for a different plan. Dropping it is what makes the viz
      // tab re-fetch rather than render a stale chart.
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? {
                ...e,
                result,
                ran: envelope,
                drawnStale: true,
                drawError: undefined,
                pending: false,
                error: undefined,
              }
            : e,
        ),
      );
    } catch (e) {
      setEntries((prev) =>
        prev.map((en) =>
          en.id === entry.id
            ? {
                ...en,
                pending: false,
                error: e instanceof Error ? e.message : String(e),
              }
            : en,
        ),
      );
    }
    return returned;
  }

  /**
   * Fetches the drawable columns for an entry, on demand.
   *
   * A second request rather than always asking for columns, because a
   * column is ~1.2 MB per study at this dataset size and a reduction is
   * a few bytes. It also makes the cache visible in the best possible
   * way: every node comes back `cached`, and what you pay is purely the
   * materialization and the wire.
   */
  async function draw(entry: Entry) {
    const envelope = (entry.ran ?? entry.composed?.envelope) as
      | {
          process?: unknown[];
          select?: unknown[];
          nodes?: Record<string, unknown>;
          outputs?: Record<string, unknown>;
        }
      | undefined;
    // Nothing to draw from yet — the compose is still in flight. Bailing
    // silently here is what left the tab on "Drawing…" forever; the tab
    // now waits for the plan and draws when it lands.
    if (envelope === undefined || !hasPlan(envelope)) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id ? { ...e, drawing: true, drawError: undefined } : e,
      ),
    );
    try {
      // A focused node is addressed by **id** — a string `SpecRef` the
      // response already named. A nested spec is in the graph as soon as
      // its parent compiled, so this reaches intermediates that never
      // appear in `process`.
      //
      // Unfocused, the original selectors ride along unchanged, so the
      // same response carries the columns *and* the facts the prompt
      // actually asked for. That is the `columns` + `reduce` pairing the
      // library stopped treating as exclusive — the demo exercising its
      // own fix rather than fetching twice.
      // Both request shapes draw the same way, and the difference is only
      // in how a node is addressed: a slot envelope names slots, a nested
      // one restates specs. A focused node is addressed by **id** either
      // way — a string `SpecRef` the response already named, which reaches
      // intermediates that appear nowhere in the request.
      let body: Record<string, unknown>;
      let asked: string[] = [];
      if (envelope.nodes !== undefined) {
        const outputs: Record<string, unknown> =
          entry.focus !== undefined
            ? { focused: { on: entry.focus, columns: true, reduce: 'last' } }
            : {
                ...(envelope.outputs ?? {}),
                ...Object.fromEntries(
                  Object.keys(envelope.nodes).map((slot) => [
                    `${slot}_columns`,
                    { on: slot, columns: true },
                  ]),
                ),
              };
        asked = Object.keys(envelope.outputs ?? {});
        body = { ...envelope, outputs };
      } else {
        const select =
          entry.focus !== undefined
            ? [{ on: entry.focus, columns: true, reduce: 'last' }]
            : [
                ...envelope.process!.map((on) => ({ on, columns: true })),
                ...((envelope.select ?? []) as unknown[]),
              ];
        body = { ...envelope, select };
      }
      // Ask only for what we do not already hold. A node the graph
      // reports `cached` has the same id, hence the same column name,
      // hence data we already decoded — re-sending it would be the one
      // cost this design exists to avoid.
      const drawn = await post<RunResult>('/api/run', {
        ...body,
        have: [...held.current.keys()],
      });
      for (const [name, b64] of Object.entries(drawn.frames?.columns ?? {})) {
        held.current.set(name, b64);
      }
      // The key column too: it is the dataset's, not a study's, and at
      // 150k rows it outweighs the column a tune actually recomputes.
      if (drawn.frames?.key !== undefined) {
        held.current.set(drawn.frames.keyId, drawn.frames.key);
      }
      // Re-attach what the server skipped, so the panel sees one whole
      // set of frames and knows nothing about the negotiation.
      const columns = { ...(drawn.frames?.columns ?? {}) };
      for (const name of drawn.reused ?? []) {
        const b64 = held.current.get(name);
        if (b64 !== undefined) columns[name] = b64;
      }
      const whole =
        drawn.frames === undefined
          ? drawn
          : {
              ...drawn,
              frames: {
                ...drawn.frames,
                key: drawn.frames.key ?? held.current.get(drawn.frames.keyId),
                columns,
              },
            };
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, drawn: whole, asked, drawing: false, drawnStale: false }
            : e,
        ),
      );
    } catch (e) {
      setEntries((prev) =>
        prev.map((en) =>
          en.id === entry.id
            ? {
                ...en,
                drawing: false,
                drawError: e instanceof Error ? e.message : String(e),
              }
            : en,
        ),
      );
    }
  }

  /**
   * Applies a param edit to one slot and re-runs.
   *
   * No model call: this is [PND-PROCSLOT]'s "refinement becomes a patch"
   * literally — the slot is the thing being addressed, and it survives
   * the edit that moves every derived id.
   */
  function tune(entry: Entry, slot: string, params: Record<string, unknown>) {
    const envelope = (entry.ran ?? entry.composed?.envelope) as
      | { nodes?: Record<string, { params?: unknown }> }
      | undefined;
    if (envelope?.nodes?.[slot] === undefined) return;
    const next = {
      ...envelope,
      nodes: {
        ...envelope.nodes,
        [slot]: { ...envelope.nodes[slot], params },
      },
    };
    rerun(entry, next).then((result) => {
      refreshContext();
      // Re-point the selection at the slot's **new** id. Keying the UI on
      // a derived id is precisely the mistake slots exist to prevent, and
      // this panel made it: a param edit moved the id, the lookup failed,
      // and the controls unmounted mid-drag.
      const id = result?.nodes.find((n) => n.slot === slot)?.id;
      if (id === undefined) return;
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, focus: id } : e)),
      );
    });
  }

  /** Selects a pipeline node, and invalidates whatever was drawn for the old one. */
  function focusNode(entry: Entry, id: string | undefined) {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id ? { ...e, focus: id, drawnStale: true } : e,
      ),
    );
  }

  return (
    <div className="app">
      <header>
        <h1>process — plan composer</h1>
        {context && (
          <span className={`badge ${context.composer.kind}`}>
            {context.composer.why}
          </span>
        )}
      </header>

      <main>
        <Composer
          context={context}
          entries={entries}
          prompt={prompt}
          selectedId={current?.id}
          onPrompt={setPrompt}
          onAsk={ask}
          onSelect={setSelected}
          onClear={() => {
            setEntries([]);
            setSelected(undefined);
          }}
          transcript={transcript}
        />
        <RequestPanel
          entry={current}
          context={context}
          resident={resident}
          onRerun={rerun}
          onFocus={focusNode}
          onTune={tune}
        />
        <ResultsPanel entry={current} context={context} onDraw={draw} />
      </main>
    </div>
  );
}

/**
 * The top of a column: title and its one action, the run's numbers on
 * their own line, anything the run wants to say, then the views.
 *
 * Shared so the three columns line up — the rules land at the same
 * height whether or not a panel has meta or notes to show, which is what
 * makes them read as one header rather than three.
 */
function PanelTop(props: {
  title: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  notes?: React.ReactNode;
  tabs?: React.ReactNode;
}) {
  return (
    <header className="panel-top">
      <div className="panel-title">
        <h2>{props.title}</h2>
        {props.action}
      </div>
      <p className="panel-meta">{props.meta}</p>
      {props.notes !== undefined && (
        <div className="panel-notes">{props.notes}</div>
      )}
      {props.tabs !== undefined && (
        <nav className="panel-tabs">
          <div className="tabs">{props.tabs}</div>
        </nav>
      )}
    </header>
  );
}

/**
 * One turn's reply: the prose, what it rests on, and what it cost.
 *
 * This lives in the composer rather than in Results because that is
 * where a person looks for it. Results is the *evidence* — the plan, the
 * badges, the charts — and putting the answer there made the reply to a
 * question appear two panels away from the question.
 *
 * The cost line stays attached to the answer rather than moving to a
 * status bar. `5 computed, 4 cached` is the claim this whole app exists
 * to make, and it means something next to the sentence it paid for.
 */
function Reply(props: { entry: Entry }) {
  const { entry } = props;
  if (entry.pending) return <p className="reply working">Working…</p>;
  if (entry.error !== undefined) {
    return <p className="reply notice bad">{entry.error}</p>;
  }
  const answer = entry.answer;
  if (answer === undefined) return null;
  const computed = answer.rounds.reduce((n, r) => n + r.computed, 0);
  const cached = answer.rounds.reduce((n, r) => n + r.cached, 0);
  const engine =
    Math.round(answer.rounds.reduce((n, r) => n + r.ms, 0) * 100) / 100;
  return (
    <div className="reply">
      <p className="reply-text">{answer.text}</p>
      {answer.cites.length > 0 && (
        <p className="reply-cites">
          {answer.cites.map((c) => (
            <code key={c}>{c}</code>
          ))}
        </p>
      )}
      <p className="reply-meta">
        {answer.rounds.length} round{answer.rounds.length === 1 ? '' : 's'} ·{' '}
        {computed} computed, {cached} cached · {engine} ms in the engine of{' '}
        {answer.ms} ms
      </p>
      {answer.warning !== undefined && (
        <p className="notice warn">{answer.warning}</p>
      )}
    </div>
  );
}

function Composer(props: {
  context: Context | undefined;
  entries: Entry[];
  prompt: string;
  selectedId: number | undefined;
  onPrompt: (v: string) => void;
  onAsk: (v: string) => void;
  onSelect: (id: number) => void;
  onClear: () => void;
  transcript: React.RefObject<HTMLOListElement | null>;
}) {
  const { context } = props;
  return (
    <section className="panel composer">
      <PanelTop
        title="Composer"
        action={
          <button onClick={props.onClear} disabled={props.entries.length === 0}>
            Clear
          </button>
        }
      />

      <ol className="chat" ref={props.transcript}>
        {props.entries.map((entry) => (
          <li
            key={entry.id}
            className={`turn${entry.id === props.selectedId ? ' selected' : ''}`}
            onClick={() => props.onSelect(entry.id)}
          >
            <p className="asked">{entry.prompt}</p>
            <Reply entry={entry} />
          </li>
        ))}
      </ol>

      {props.entries.length === 0 && (
        <ul className="examples">
          {EXAMPLES.map((e) => (
            <li key={e}>
              <button className="link" onClick={() => props.onAsk(e)}>
                {e}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onAsk(props.prompt);
        }}
      >
        <textarea
          value={props.prompt}
          rows={3}
          placeholder="Ask for a study in plain English…"
          onChange={(e) => props.onPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              props.onAsk(props.prompt);
            }
          }}
        />
        <button type="submit" disabled={props.prompt.trim() === ''}>
          Compose <kbd>⌘↵</kbd>
        </button>
      </form>

      {context && (
        <details className="vocab">
          <summary>
            {context.ops.length} ops · the agent's whole contract
          </summary>
          {Object.entries(context.families).map(([family, names]) => (
            <div key={family}>
              <strong>{family}</strong>
              <ul>
                {names.map((n) => {
                  const op = context.ops.find((o) => o.name === n)!;
                  return (
                    <li key={n}>
                      <code>{n}</code> — {op.summary}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <p className="muted">
            {context.datasets
              .map((d) => `${d.id}: ${d.rows.toLocaleString()} rows`)
              .join(' · ')}
          </p>
        </details>
      )}
    </section>
  );
}

function RequestPanel(props: {
  entry: Entry | undefined;
  context: Context | undefined;
  resident: number | undefined;
  onRerun: (entry: Entry, envelope: unknown) => void;
  onFocus: (entry: Entry, id: string | undefined) => void;
  onTune: (entry: Entry, slot: string, params: Record<string, unknown>) => void;
}) {
  const { entry } = props;
  // `graph` leads, so it is also the default — a first tab that is not
  // what opens reads as a mistake. Its empty state says so plainly.
  const [tab, setTab] = useState<'graph' | 'raw'>('graph');

  // The selected node, resolved back to the slot and op the envelope
  // declared — `focus` is an id, because that is what the pipeline and
  // the drawing path address by.
  const tuning = useMemo(() => {
    if (entry?.focus === undefined || props.context === undefined) return;
    const slot = entry.result?.nodes.find((n) => n.id === entry.focus)?.slot;
    if (slot === undefined) return;
    const envelope = (entry.ran ?? entry.composed?.envelope) as
      | { nodes?: Record<string, { op: string; params?: unknown }> }
      | undefined;
    const node = envelope?.nodes?.[slot];
    if (node === undefined) return;
    const defs = props.context.ops.find((o) => o.name === node.op)?.params;
    if (defs === undefined) return;
    return {
      slot,
      op: node.op,
      defs,
      params: (node.params ?? {}) as Record<string, unknown>,
    };
  }, [entry, props.context]);
  // The envelope is editable, and that is not a nicety. M2's whole job is
  // finding out what does and does not resolve; being able to change one
  // param and re-run without a round trip through a model is how most of
  // the friction notes below were actually found.
  const composed = entry?.composed;
  const pretty = useMemo(
    () => (composed ? JSON.stringify(composed.envelope, null, 2) : ''),
    [composed],
  );
  const [draft, setDraft] = useState(pretty);
  useEffect(() => setDraft(pretty), [pretty]);

  const parsed = useMemo(() => {
    // An empty panel has an empty draft, and `JSON.parse('')` throws —
    // which surfaced "Unexpected end of JSON input" before anything had
    // been composed at all.
    if (draft.trim() === '') return { value: undefined, error: undefined };
    try {
      return { value: JSON.parse(draft) as unknown, error: undefined };
    } catch (e) {
      return { value: undefined, error: (e as Error).message };
    }
  }, [draft]);
  const edited = draft !== pretty;

  return (
    <section className="panel">
      <PanelTop
        title="Request"
        meta={
          composed && (
            <>
              {composed.source === 'scripted'
                ? 'scripted'
                : `${composed.model ?? 'model'} · ${Math.round(composed.ms)} ms`}
              {composed.usage && ` · ${composed.usage['output']} out`}
              {edited && ' · edited'}
            </>
          )
        }
        action={
          /* Beside the title, not under the JSON: the envelope is long
             enough that a button below it is off-screen, and re-running
             the same plan is how you see the badges flip to cached. */
          composed &&
          entry && (
            <button
              onClick={() => props.onRerun(entry, parsed.value)}
              disabled={entry.pending || parsed.error !== undefined}
            >
              Rerun
            </button>
          )
        }
        notes={
          <>
            {composed?.warning && (
              <p className="notice warn">{composed.warning}</p>
            )}
            {composed?.note && <p className="notice">{composed.note}</p>}
            {parsed.error && <p className="notice bad">{parsed.error}</p>}
          </>
        }
        tabs={
          <>
            {(['graph', 'raw'] as const).map((t) => (
              <button
                key={t}
                className={t === tab ? 'tab on' : 'tab'}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </>
        }
      />
      {tab === 'graph' && entry !== undefined ? (
        <>
          <Pipeline
            nodes={entry.result?.nodes ?? []}
            explain={entry.result?.explain ?? {}}
            selected={entry.focus}
            onSelect={(id) => props.onFocus(entry, id)}
          />
          {tuning !== undefined && (
            <Tune
              op={tuning.op}
              slot={tuning.slot}
              params={tuning.params}
              defs={tuning.defs}
              resident={props.resident}
              onChange={(params) => props.onTune(entry, tuning.slot, params)}
            />
          )}
          <p className="muted">
            {entry.focus === undefined
              ? 'Click a node to draw that node’s output — and, on a slot plan, to tune its params.'
              : 'Showing this node in Results. Tuning re-runs without calling the model. Click the background to go back.'}
          </p>
        </>
      ) : composed ? (
        <textarea
          className="envelope"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <Empty entry={entry} what="the emitted envelope" />
      )}
    </section>
  );
}

function ResultsPanel(props: {
  entry: Entry | undefined;
  context: Context | undefined;
  onDraw: (entry: Entry) => void;
}) {
  const { entry } = props;
  const [tab, setTab] = useState<'output' | 'workbook' | 'raw'>('output');
  const result = entry?.result;
  const drawing = tab !== 'raw';
  // The badges come from whichever request was last resolved — on a
  // drawing tab that is the columns fetch, and its all-cached row is the
  // point. The workbook shows the same data as its own step list.
  const shown = drawing ? (entry?.drawn ?? result) : result;
  const answeredWithoutPlan =
    entry?.answer !== undefined && entry.answer.rounds.length === 0;
  return (
    <section className="panel">
      <PanelTop
        title="Results"
        meta={
          shown && (
            <>
              {shown.as ? `${shown.as} · ` : ''}
              {shown.ms} ms
              {shown.encodeMs !== undefined &&
                ` · +${shown.encodeMs} ms encode`}
            </>
          )
        }
        tabs={
          <>
            {(['output', 'workbook', 'raw'] as const).map((t) => (
              <button
                key={t}
                className={t === tab ? 'tab on' : 'tab'}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </>
        }
      />

      {/* An answer with no plan behind it is a real outcome, not a
          missing one: asked to annualise a price directly, the model
          reads the op table, sees the unit `annualise` demands, and
          declines without running anything. There is nothing to draw,
          and "Waiting for a plan…" would be a lie — the reply itself is
          in the composer, where it says why. */}
      {answeredWithoutPlan && (
        <p className="muted">
          Nothing ran — the model answered from the op table alone.
        </p>
      )}

      {drawing && entry !== undefined && !answeredWithoutPlan && (
        <VizTab
          entry={entry}
          view={tab === 'workbook' ? 'workbook' : 'output'}
          ops={props.context?.ops}
          onDraw={props.onDraw}
        />
      )}

      {/* The badge row belongs to `output`, which otherwise says nothing
          about what it cost. The workbook carries the same information
          per step, so repeating it there would be noise. */}
      {tab === 'output' && shown && (
        <ul className="nodes">
          {shown.nodes.map((n) => (
            <li key={n.id} className={n.cached ? 'cached' : 'computed'}>
              <code title={shown.explain[n.id] ?? n.id}>
                {shown.explain[n.id] ?? n.id}
              </code>
              <span>
                {n.cached ? 'cached' : 'computed'} · {n.ms} ms
              </span>
            </li>
          ))}
        </ul>
      )}

      {tab === 'raw' && result ? (
        <>
          {/* The badge row. Without it the caching is true but invisible,
              which is the failure mode M1 exists to prevent. */}
          <ul className="nodes">
            {result.nodes.map((n) => (
              <li key={n.id} className={n.cached ? 'cached' : 'computed'}>
                <code title={result.explain[n.id] ?? n.id}>
                  {result.explain[n.id] ?? n.id}
                </code>
                <span>
                  {n.cached ? 'cached' : 'computed'} · {n.ms} ms
                </span>
              </li>
            ))}
          </ul>

          {result.skipped.length > 0 && (
            <div className="skipped">
              <h3>Skipped</h3>
              <ul>
                {result.skipped.map((s, i) => (
                  <li key={i}>{s.reason}</li>
                ))}
              </ul>
              <p className="muted">
                These are what an agent retries against. If a reason is not
                enough to self-correct, that is a registry finding.
              </p>
            </div>
          )}

          <pre>
            {JSON.stringify(
              {
                facts: result.facts,
                outputs: result.outputs,
                hasSeries: result.hasSeries,
              },
              null,
              2,
            )}
          </pre>
        </>
      ) : tab === 'raw' ? (
        <Empty entry={entry} what="the response" />
      ) : null}
    </section>
  );
}

/**
 * The viz tab's own fetch trigger.
 *
 * Lives in a component rather than in the tab's `onClick` so that
 * clearing `drawn` — which a re-run does, because the envelope may have
 * been edited — re-fetches while the tab is already open. Handling it
 * only on the click left a chart from the previous plan on screen.
 */
function VizTab(props: {
  entry: Entry;
  view: 'output' | 'workbook';
  ops: OpDescriptor[] | undefined;
  onDraw: (entry: Entry) => void;
}) {
  const { entry, onDraw } = props;
  // Three separate states, and conflating them is what got this stuck:
  // there is nothing to draw *from* until the plan lands; a draw is in
  // flight; a draw failed. Only the middle one is "Drawing…".
  const ready =
    (entry.ran ?? entry.composed?.envelope) !== undefined && !entry.pending;
  const needed =
    ready &&
    (entry.drawn === undefined || entry.drawnStale === true) &&
    entry.drawing !== true &&
    entry.drawError === undefined;
  useEffect(() => {
    if (needed) onDraw(entry);
    // `entry.id` and `needed` are the trigger; `entry` itself changes
    // identity on every keystroke in the envelope editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, needed]);
  return (
    <Viz
      view={props.view}
      asked={entry.asked ?? []}
      ops={Object.fromEntries(
        (props.ops ?? []).map((o) => [o.name, { inputs: o.inputs }]),
      )}
      defs={
        (
          (entry.ran ?? entry.composed?.envelope) as
            | {
                nodes?: Record<
                  string,
                  { op: string; params?: Record<string, unknown> }
                >;
              }
            | undefined
        )?.nodes ?? {}
      }
      nodes={entry.drawn?.nodes ?? entry.result?.nodes ?? []}
      frames={entry.drawn?.frames}
      outputs={entry.drawn?.outputs ?? {}}
      explain={entry.drawn?.explain ?? {}}
      facts={entry.drawn?.facts ?? []}
      // Only a *first* draw blocks the panel. Once there is something on
      // screen, a refresh is reported in place rather than replacing it.
      pending={entry.drawing === true}
      waiting={!ready && entry.drawn === undefined}
      refreshing={
        entry.drawn !== undefined &&
        (entry.drawing === true || entry.drawnStale === true || !ready)
      }
      error={entry.drawError}
      onDraw={() => onDraw(entry)}
    />
  );
}

function Empty(props: { entry: Entry | undefined; what: string }) {
  if (props.entry?.error) {
    return <p className="notice bad">{props.entry.error}</p>;
  }
  if (props.entry?.pending) return <p className="muted">Working…</p>;
  return (
    <p className="muted">Ask for something, and {props.what} lands here.</p>
  );
}
