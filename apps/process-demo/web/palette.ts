/**
 * A colour per node, shared by every panel that draws one.
 *
 * The colour is a node's identity across the app: the border of its box
 * in the pipeline, the stroke of its chart in the workbook, and the edge
 * of any card built from its output. Reading the same hue in three
 * places is what ties the panels together — you can point at a curve and
 * find the box that made it without reading either label.
 *
 * **Keyed by slot, not by position and not by id.** Position shifts the
 * moment a node is inserted above another; the id changes on every param
 * edit. Either would repaint the graph while you drag a slider, which is
 * the thing this app has now been taught four separate times not to do.
 *
 * Assignment is a hash, so a given slot lands on the same colour every
 * time, with linear probing so two nodes in one plan never collide —
 * deterministic given the same set, which is what keeps a tune stable.
 */

export const PALETTE = [
  '#6fb3ff',
  '#f0b429',
  '#4fd1a5',
  '#c792ea',
  '#ff7a7a',
  '#5ad1d1',
  '#ffa06f',
  '#9db4ff',
] as const;

/** djb2 — small, stable, and not trying to be a hash function of consequence. */
function hash(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = (h * 33) ^ key.charCodeAt(i);
  return Math.abs(h);
}

/**
 * Assigns each key a colour, preferring its hashed slot and probing
 * forward when that one is taken.
 *
 * Order matters only for collisions, so pass keys in a stable order —
 * dependency order, as `nodes` already arrives.
 */
export function colorsFor(keys: readonly string[]): Map<string, string> {
  const taken = new Set<number>();
  const out = new Map<string, string>();
  for (const key of keys) {
    let slot = hash(key) % PALETTE.length;
    for (let n = 0; n < PALETTE.length && taken.has(slot); n += 1) {
      slot = (slot + 1) % PALETTE.length;
    }
    taken.add(slot);
    out.set(key, PALETTE[slot]!);
  }
  return out;
}

/** The colour map for a response's nodes, keyed by **node id** for lookup. */
export function colorsForNodes(
  nodes: readonly { id: string; slot?: string }[],
): Map<string, string> {
  const bySlot = colorsFor(nodes.map((n) => n.slot ?? n.id));
  return new Map(nodes.map((n) => [n.id, bySlot.get(n.slot ?? n.id)!]));
}
