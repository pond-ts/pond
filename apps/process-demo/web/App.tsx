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
  composer: { kind: 'anthropic' | 'scripted'; why: string };
}
interface NodeTiming {
  id: string;
  cached: boolean;
  ms: number;
}
interface RunResult {
  facts: Record<string, unknown>[];
  outputs: Record<string, { column: string; unit: string | null }[]>;
  explain: Record<string, string>;
  skipped: { reason: string; spec?: unknown; select?: unknown }[];
  nodes: NodeTiming[];
  hasSeries: boolean;
  as?: string;
  ms: number;
}
interface Composed {
  envelope: Record<string, unknown>;
  note?: string;
  source: 'anthropic' | 'scripted';
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
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok)
    throw new Error((json as { error?: string }).error ?? res.statusText);
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
        prev.map((e) => (e.id === id ? { ...e, ...body, pending: false } : e)),
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
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, result, pending: false, error: undefined }
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
        <RequestPanel entry={current} onRerun={rerun} />
        <ResultsPanel entry={current} />
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
}) {
  const { entry } = props;
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
              {composed.source === 'anthropic'
                ? `${composed.model ?? 'model'} · ${Math.round(composed.ms)} ms`
                : 'scripted'}
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
      </div>
      {composed?.warning && <p className="notice warn">{composed.warning}</p>}
      {composed?.note && <p className="notice">{composed.note}</p>}
      {parsed.error && <p className="notice bad">{parsed.error}</p>}
      {composed ? (
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

function ResultsPanel(props: { entry: Entry | undefined }) {
  const { entry } = props;
  const result = entry?.result;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Results</h2>
        {result && (
          <span className="meta">
            {result.as ? `${result.as} · ` : ''}
            {result.ms} ms
          </span>
        )}
      </div>

      {result ? (
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
      ) : (
        <Empty entry={entry} what="the response" />
      )}
    </section>
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
