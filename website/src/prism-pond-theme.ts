import type { PrismTheme } from 'prism-react-renderer';

/**
 * The brand's code-block theme (brand/Pond Brand Spec.html §05 "Components"
 * → CODE BLOCK: "bg #0C1A1A · radius 10–14 · teal keywords"). Code blocks
 * are always this one dark-teal "terminal chip" ground — not a light/dark
 * pair — so this theme is used for both `prism.theme` and `prism.darkTheme`
 * in docusaurus.config.ts.
 *
 * Palette pulled from the spec's dark-theme tokens (the accent teal reads
 * correctly against this ground regardless of the site's own color mode):
 * bg #0C1A1A, ink #E6F2F0, body #9FB4B1, accent #34D3C0.
 */
export const pondCodeTheme: PrismTheme = {
  plain: {
    color: '#E6F2F0',
    backgroundColor: '#0C1A1A',
  },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#6B8180', fontStyle: 'italic' },
    },
    {
      types: ['punctuation'],
      style: { color: '#9FB4B1' },
    },
    {
      types: ['keyword', 'tag', 'operator', 'builtin'],
      style: { color: '#34D3C0' },
    },
    {
      types: ['function', 'class-name', 'maybe-class-name'],
      style: { color: '#7FE6D8' },
    },
    {
      types: ['string', 'attr-value', 'char'],
      style: { color: '#B7E8DF' },
    },
    {
      types: ['number', 'boolean', 'constant', 'symbol'],
      style: { color: '#E8B978' },
    },
    {
      types: ['property', 'attr-name', 'variable'],
      style: { color: '#E6F2F0' },
    },
    {
      types: ['deleted'],
      style: { color: '#E08A7D' },
    },
    {
      types: ['inserted'],
      style: { color: '#34D3C0' },
    },
  ],
};
