/**
 * Opaque, asynchronous data sources.
 *
 * A request carries only `{ source, params }`. The loader stays on the host,
 * where credentials, URLs, retries and cache policy belong. The canonical
 * source id chooses a long-lived bound graph; `revision` decides whether that
 * graph's source value must be invalidated.
 */

import { ProcessError } from '../errors.js';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import type { ParamValue } from './types.js';

export type SourceParams = Readonly<Record<string, ParamValue>>;

/** JSON-safe source identity carried by a request. */
export interface SourceRef<
  Name extends string = string,
  Params extends SourceParams = SourceParams,
> {
  readonly source: Name;
  readonly params: Params;
}

export interface LoadedSource {
  readonly value: TimeSeries<SeriesSchema>;
  /**
   * Version of the remote value: an ETag, cursor, object version, or another
   * stable token. Equal revisions deliberately preserve every graph cache.
   */
  readonly revision: string;
}

export interface SourceLoadContext {
  readonly previous?: LoadedSource;
}

export interface SourceDef<
  Name extends string = string,
  Params extends SourceParams = SourceParams,
> {
  readonly name: Name;
  readonly load: (
    params: Params,
    context: SourceLoadContext,
  ) => Promise<LoadedSource>;
  ref(params: Params): SourceRef<Name, Params>;
}

/** Defines a typed source token and its host-side loader. */
export function defineSource<
  const Name extends string,
  const Params extends SourceParams,
>(definition: {
  readonly name: Name;
  readonly load: SourceDef<Name, Params>['load'];
}): SourceDef<Name, Params> {
  return {
    ...definition,
    ref: (params) => ({ source: definition.name, params }),
  };
}

export class UnknownSourceError extends ProcessError {}

export class SourceRegistry {
  readonly #sources = new Map<string, SourceDef>();

  define<const Name extends string, const Params extends SourceParams>(
    source: SourceDef<Name, Params>,
  ): this {
    this.#sources.set(source.name, {
      name: source.name,
      ref: (params) => ({ source: source.name, params }),
      load: (params, context) =>
        source.load(params as unknown as Params, context),
    });
    return this;
  }

  async load(ref: SourceRef, previous?: LoadedSource): Promise<LoadedSource> {
    const source = this.#sources.get(ref.source);
    if (source === undefined) {
      const have = [...this.#sources.keys()].map((k) => `'${k}'`).join(', ');
      throw new UnknownSourceError(
        `unknown source '${ref.source}'${have ? ` — have ${have}` : ''}`,
      );
    }
    return source.load(ref.params, {
      ...(previous !== undefined && { previous }),
    });
  }
}

export function createSourceRegistry(): SourceRegistry {
  return new SourceRegistry();
}

/** Canonical, order-independent identity for one source invocation. */
export function sourceId(ref: SourceRef): string {
  const params = Object.keys(ref.params)
    .sort()
    .map((key) => {
      const value = ref.params[key]!;
      return `${encodeURIComponent(key)}=${encodeURIComponent(`${typeof value}:${JSON.stringify(value)}`)}`;
    })
    .join('&');
  return `source:${encodeURIComponent(ref.source)}${params ? `?${params}` : ''}`;
}
