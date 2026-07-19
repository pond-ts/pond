import type { ReactNode } from 'react';
import { Redirect } from '@docusaurus/router';

/**
 * The API reference now lives inside the docs tree (docstring-first pages
 * rendered from typedoc JSON — see docs/api/). This page survives only so
 * that bookmarked /api URLs keep working.
 */
export default function ApiPage(): ReactNode {
  return <Redirect to="/docs/api/" />;
}
