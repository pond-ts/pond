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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Viz, type Fact, type Frames } from './Viz.js';
import { Pipeline, type NodeTiming } from './Pipeline.js';

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
interface Entry {
  id: number;
  prompt: string;
  composed?: Composed | undefined;
  result?: RunResult | undefined;
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
  drawing?: boolean | undefined;
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

  useEffect(() => {
    fetch('/api/context')
      .then((r) => r.json())
      .then(setContext)
      .catch(() => undefined);
  }, []);

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
      const body = await post<{ composed: Composed; result: RunResult }>(
        '/api/ask',
        { prompt: trimmed, history },
      );
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? {
                ...e,
                ...body,
                ran: body.composed.envelope,
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
  async function rerun(entry: Entry, envelope: unknown) {
    if (envelope === undefined) return;
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, pending: true } : e)),
    );
    try {
      const result = await post<RunResult>('/api/run', envelope);
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
                drawn: undefined,
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
      | { process?: unknown[]; select?: unknown[] }
      | undefined;
    // Nothing to draw from yet — the compose is still in flight. Bailing
    // silently here is what left the tab on "Drawing…" forever; the tab
    // now waits for the plan and draws when it lands.
    if (envelope?.process === undefined) return;
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
      const select =
        entry.focus !== undefined
          ? [{ on: entry.focus, columns: true, reduce: 'last' }]
          : [
              ...envelope.process.map((on) => ({ on, columns: true })),
              ...((envelope.select ?? []) as unknown[]),
            ];
      const drawn = await post<RunResult>('/api/run', { ...envelope, select });
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id ? { ...e, drawn, drawing: false } : e,
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

  /** Selects a pipeline node, and invalidates whatever was drawn for the old one. */
  function focusNode(entry: Entry, id: string | undefined) {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id ? { ...e, focus: id, drawn: undefined } : e,
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
        />
        <RequestPanel entry={current} onRerun={rerun} onFocus={focusNode} />
        <ResultsPanel entry={current} onDraw={draw} />
      </main>
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
}) {
  const { context } = props;
  return (
    <section className="panel composer">
      <div className="panel-head">
        <h2>Composer</h2>
        <button onClick={props.onClear} disabled={props.entries.length === 0}>
          Clear
        </button>
      </div>

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

      <ol className="history">
        {props.entries.map((entry) => (
          <li
            key={entry.id}
            className={entry.id === props.selectedId ? 'selected' : ''}
          >
            <button className="link" onClick={() => props.onSelect(entry.id)}>
              {entry.prompt}
            </button>
            <span className="meta">
              {entry.pending && '…'}
              {entry.error && <span className="bad">failed</span>}
              {entry.result && `${entry.result.ms} ms`}
              {entry.result?.skipped.length ? (
                <span className="warn">
                  {' '}
                  {entry.result.skipped.length} skipped
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

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
  onRerun: (entry: Entry, envelope: unknown) => void;
  onFocus: (entry: Entry, id: string | undefined) => void;
}) {
  const { entry } = props;
  const [tab, setTab] = useState<'json' | 'graph'>('json');
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
      <div className="panel-head">
        <h2>Request</h2>
        {composed && entry && (
          <>
            <span className="meta">
              {composed.source === 'scripted'
                ? 'scripted'
                : `${composed.model ?? 'model'} · ${Math.round(composed.ms)} ms`}
              {composed.usage && ` · ${composed.usage['output']} out`}
              {edited && ' · edited'}
            </span>
            {/* In the head, not under the JSON: the envelope is long
                enough that a button below it is off-screen, and re-running
                the same plan is how you see the badges flip to cached. */}
            <button
              onClick={() => props.onRerun(entry, parsed.value)}
              disabled={entry.pending || parsed.error !== undefined}
            >
              Re-run
            </button>
          </>
        )}
        <div className="tabs">
          {(['json', 'graph'] as const).map((t) => (
            <button
              key={t}
              className={t === tab ? 'tab on' : 'tab'}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {composed?.warning && <p className="notice warn">{composed.warning}</p>}
      {composed?.note && <p className="notice">{composed.note}</p>}
      {parsed.error && <p className="notice bad">{parsed.error}</p>}
      {tab === 'graph' && entry !== undefined ? (
        <>
          <Pipeline
            nodes={entry.result?.nodes ?? []}
            explain={entry.result?.explain ?? {}}
            selected={entry.focus}
            onSelect={(id) => props.onFocus(entry, id)}
          />
          <p className="muted">
            {entry.focus === undefined
              ? 'Click a node to draw that node’s output — including intermediates the plan never named at its top level.'
              : 'Showing this node in Results. Click the background to go back to the whole plan.'}
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
  onDraw: (entry: Entry) => void;
}) {
  const { entry } = props;
  const [tab, setTab] = useState<'raw' | 'viz'>('raw');
  const result = entry?.result;
  // The badges come from whichever request was last resolved — on the viz
  // tab that is the columns fetch, and its all-cached row is the point.
  const shown = tab === 'viz' ? (entry?.drawn ?? result) : result;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Results</h2>
        {shown && (
          <span className="meta">
            {shown.as ? `${shown.as} · ` : ''}
            {shown.ms} ms
            {shown.encodeMs !== undefined && ` · +${shown.encodeMs} ms encode`}
          </span>
        )}
        <div className="tabs">
          {(['raw', 'viz'] as const).map((t) => (
            <button
              key={t}
              className={t === tab ? 'tab on' : 'tab'}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === 'viz' && entry !== undefined && (
        <VizTab entry={entry} onDraw={props.onDraw} />
      )}

      {tab === 'viz' && shown && (
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
function VizTab(props: { entry: Entry; onDraw: (entry: Entry) => void }) {
  const { entry, onDraw } = props;
  // Three separate states, and conflating them is what got this stuck:
  // there is nothing to draw *from* until the plan lands; a draw is in
  // flight; a draw failed. Only the middle one is "Drawing…".
  const ready =
    (entry.ran ?? entry.composed?.envelope) !== undefined && !entry.pending;
  const needed =
    ready &&
    entry.drawn === undefined &&
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
      frames={entry.drawn?.frames}
      outputs={entry.drawn?.outputs ?? {}}
      explain={entry.drawn?.explain ?? {}}
      facts={entry.drawn?.facts ?? []}
      pending={entry.drawing === true}
      waiting={!ready}
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
