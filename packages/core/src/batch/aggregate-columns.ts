import { resolveReducer } from '../reducers/index.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  AggregateOutputSpec,
  AggregateReducer,
  ScalarKind,
  SeriesSchema,
} from '../types.js';

/**
 * Normalised column spec used by both batch and live aggregation paths.
 *
 * `output` is the name the column appears under in the produced schema.
 * For `AggregateMap` mappings (`{ existingCol: reducer }`) the output
 * name equals the source column name. For `AggregateOutputMap` mappings
 * (`{ alias: { from, using } }`) the two can differ — multiple specs
 * can read from the same source column with different aliases.
 *
 * Used by `TimeSeries.aggregate` / `rolling`, `LiveAggregation`,
 * `LiveRollingAggregation`, and `LivePartitionedSyncRolling`.
 */
export type AggregateColumnSpec = {
  output: string;
  source: string;
  reducer: AggregateReducer;
  kind: ScalarKind;
};

/**
 * @internal — discriminator between an `AggregateOutputSpec` (`{ from,
 * using, kind? }`) and a bare reducer string/function passed in an
 * `AggregateMap` slot.
 */
export function isAggregateOutputSpec<S extends SeriesSchema>(
  value: unknown,
): value is AggregateOutputSpec<S> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from' in value &&
    'using' in value
  );
}

/**
 * Resolve a user-supplied `mapping` (either `AggregateMap<S>` or
 * `AggregateOutputMap<S>`) against the source `schema` into a flat
 * list of `AggregateColumnSpec`. Walks the mapping once; throws on
 * unknown source columns, non-value source columns, or invalid
 * reducers. The resulting specs drive both the output schema
 * construction and the per-event reducer routing.
 *
 * Shared between the batch operators (`TimeSeries.rolling`,
 * `TimeSeries.aggregate`, `arrayAggregate`) and the live accumulators
 * (`LiveRollingAggregation`, `LiveAggregation`,
 * `LivePartitionedSyncRolling`). Keeping the normalisation in one
 * place ensures the live and batch surfaces stay symmetric — the
 * same `mapping` shape produces the same schema.
 */
export function normalizeAggregateColumns<S extends SeriesSchema>(
  schema: S,
  mapping: AggregateMap<S> | AggregateOutputMap<S>,
): AggregateColumnSpec[] {
  const columnsByName = new Map(
    schema.slice(1).map((column) => [column.name, column] as const),
  );
  const normalized: AggregateColumnSpec[] = [];

  for (const [outputName, raw] of Object.entries(mapping)) {
    const sourceName = isAggregateOutputSpec<S>(raw) ? raw.from : outputName;
    const sourceColumn = columnsByName.get(sourceName);
    if (!sourceColumn) {
      throw new TypeError(
        `aggregate mapping references unknown source column '${sourceName}'`,
      );
    }
    if (
      sourceColumn.kind !== 'number' &&
      sourceColumn.kind !== 'string' &&
      sourceColumn.kind !== 'boolean' &&
      sourceColumn.kind !== 'array'
    ) {
      throw new TypeError(
        `aggregate source column '${sourceName}' must be a value column`,
      );
    }
    const reducer = isAggregateOutputSpec<S>(raw) ? raw.using : raw;
    if (typeof reducer !== 'string' && typeof reducer !== 'function') {
      throw new TypeError(
        `aggregate reducer for '${outputName}' must be a built-in name or function`,
      );
    }
    const explicitKind = isAggregateOutputSpec<S>(raw) ? raw.kind : undefined;
    let resolvedKind: ScalarKind;
    if (explicitKind !== undefined) {
      resolvedKind = explicitKind;
    } else if (typeof reducer === 'string') {
      const builtIn = resolveReducer(reducer);
      if (builtIn.outputKind === 'number') {
        resolvedKind = 'number';
      } else if (builtIn.outputKind === 'array') {
        resolvedKind = 'array';
      } else {
        resolvedKind = sourceColumn.kind;
      }
    } else {
      resolvedKind = sourceColumn.kind;
    }
    normalized.push({
      output: outputName,
      source: sourceName,
      reducer,
      kind: resolvedKind,
    });
  }

  return normalized;
}
