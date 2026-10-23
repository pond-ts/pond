// The study catalog as data, for pond-rs (`crates/pond-rs/tests/
// study_catalog.rs`): every descriptor without its `run`, and the 120 bars
// the catalog test runs on (`test/catalog-fixture.ts`, same generator).

/** The catalog test's bars: time, open, high, low, close, volume, sess. */
export function catalogBars() {
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const rows = [];
  let close = 100;
  for (let i = 0; i < 120; i += 1) {
    const open = close;
    close = Math.max(1, open + (next() - 0.5) * 4);
    const high = Math.max(open, close) + next() * 2;
    const low = Math.min(open, close) - next() * 2;
    const volume = Math.round(1000 + next() * 9000);
    rows.push([i * 60_000, open, high, low, close, volume, Math.floor(i / 20)]);
  }
  return rows;
}

export function buildCatalogFixture(catalog) {
  return {
    families: catalog.STUDY_FAMILIES,
    studies: catalog.STUDIES.map(({ run: _run, ...descriptor }) => descriptor),
    bars: catalogBars(),
  };
}
