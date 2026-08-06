/**
 * **Real measured data** — ESnet's monthly traffic-volume history, 1990-01
 * to 2026-07: 439 months of bytes carried by the US Department of
 * Energy's Energy Sciences Network, the science network that connects the
 * national laboratories to each other and to CERN.
 *
 * Source: ESnet (https://www.es.net/), whose own "Volume History" page is the
 * chart this fixture exists to reproduce. Retrieved 2026-08-04, as the same
 * series their own dashboards draw.
 *
 * **Three inbound series, deliberately staggered.** Everything before a
 * series' first month is `null` — not zero, and not interpolated, because the
 * traffic genuinely did not exist yet:
 *
 * - `total_in` from **1990-01**
 * - `lhcone_in` from **2015-01**
 * - `oscars_in` from **2009-01**
 *
 * That is a real leading-gap case, and it is why the chart's LHCONE and OSCARS
 * lines simply begin partway across the plot.
 *
 * **What was dropped.** The export also carries `total_out`, `lhcone_out` and
 * `oscars_out`. The chart draws the inbound side — and the summary table's
 * arithmetic (normal = total − lhcone − oscars) is what pins it there — so the
 * outbound trio is not kept. Values are rounded to 6 significant figures:
 * the export carries full double precision, which past 2^53 was already noise,
 * and 6 figures reproduces every printed number exactly.
 *
 * **The quirk that matters.** 1.04 × 10^7 growth over 36.5 years — a
 * factor of ten every few years — which is exactly why the y axis is
 * logarithmic. On a linear axis the first two decades are a flat line on the
 * floor.
 *
 * Generated once by `website/scripts/fixtures/esnet-volume.mjs` from
 * `packages/charts/test-data/network/volume.json`, then committed.
 */

/** The first month of the grid, `YYYY-MM`. */
export const VOLUME_START_MONTH = '1990-01';

/** Months in the record — a complete grid, so month `i` is `VOLUME_START_MONTH`
 *  plus `i` calendar months with no holes to skip. */
export const VOLUME_MONTHS = 439;

/** `total_in` in **bytes**, one per month from `1990-01`: no gap — it runs the whole record. */
// prettier-ignore
export const TOTAL_IN: readonly number[] = [
  1.9e10, 2.85e10, 4.78e10, 4.99e10, 5.57e10, 7.87e10, 8.9e10, 1.09e11,
  1.2e11, 1.33e11, 1.06e11, 1.13e11, 1.43e11, 1.36e11, 1.62e11, 1.69e11,
  1.73e11, 1.87e11, 2.14e11, 2.28e11, 2.45e11, 3.26e11, 2.95e11, 3.19e11,
  3.14e11, 3.26e11, 3.09e11, 3.07e11, 3.61e11, 4.37e11, 4.14e11, 4.36e11,
  4.62e11, 5.17e11, 5.34e11, 5.35e11, 5.79e11, 5.53e11, 6.73e11, 6.4e11,
  6.42e11, 6.28e11, 7.92e11, 8.63e11, 8e11, 1.19e12, 1.17e12, 1.09e12,
  1.16e12, 1.19e12, 1.43e12, 1.44e12, 1.64e12, 1.72e12, 1.84e12, 1.81e12,
  1.76e12, 2.09e12, 2.28e12, 2.45e12, 2.4e12, 2.45e12, 2.83e12, 2.57e12,
  2.79e12, 2.82e12, 3.17e12, 3.14e12, 3.32e12, 3.55e12, 3.44e12, 3.6e12,
  3.62e12, 3.12e12, 3.41e12, 3.63e12, 3.54e12, 2.81e12, 3.26e12, 3.76e12,
  3.31e12, 3.57e12, 3.85e12, 3.45e12, 3.75e12, 3.62e12, 4.53e12, 4.92e12,
  4.36e12, 4.61e12, 5.22e12, 5.23e12, 5.92e12, 8.26e12, 6.98e12, 8.23e12,
  8.8e12, 8.27e12, 8.65e12, 9.15e12, 9.03e12, 8.83e12, 1.01e13, 1.02e13,
  1.09e13, 1.21e13, 1.29e13, 1.46e13, 1.44e13, 1.52e13, 1.71e13, 1.71e13,
  1.87e13, 1.88e13, 1.89e13, 2.04e13, 2.01e13, 2.66e13, 2.86e13, 2.44e13,
  2.53e13, 2.97e13, 2.81e13, 2.96e13, 3.1e13, 3.57e13, 3.9e13, 3.85e13,
  3.49e13, 4.04e13, 3.97e13, 3.41e13, 4.18e13, 4.14e13, 5.66e13, 4.99e13,
  4.91e13, 4.3e13, 4.98e13, 6.38e13, 6.97e13, 8.6e13, 1.01e14, 1e14,
  1.17e14, 8.61e13, 1.14e14, 9.8e13, 1.03e14, 1.03e14, 1.24e14, 1.31e14,
  1.4e14, 1.58e14, 2.08e14, 1.19e14, 1.21e14, 1.65e14, 1.59e14, 1.46e14,
  1.86e14, 1.66e14, 1.8e14, 1.9e14, 2.05e14, 2.55e14, 2.6e14, 2.48e14,
  2.24e14, 2.5e14, 2.64e14, 2.44e14, 2.64e14, 2.82e14, 2.79e14, 2.62e14,
  3.07e14, 2.76e14, 3.56e14, 3.29e14, 3.48e14, 3.23e14, 4.32e14, 4.8e14,
  5.31e14, 4.7e14, 5.18e14, 4.2e14, 4.58e14, 4.12e14, 7.6e14, 6.38e14,
  7.05e14, 5.37e14, 6.27e14, 1.04e15, 7.73e14, 1.21e15, 1.44e15, 7.19e14,
  7.58e14, 1.08e15, 7.03e14, 6.41e14, 7.87e14, 8.06e14, 1.45e15, 1.67e15,
  2.4e15, 2.67e15, 2.7e15, 2.26e15, 2.21e15, 2.2e15, 2.12e15, 1.89e15,
  2.48402e15, 2.63003e15, 3.24255e15, 2.88244e15, 3.62333e15, 2.7105e15,
  2.94619e15, 3.04719e15, 2.43889e15, 1.93005e15, 1.76521e15, 1.97576e15,
  2.38409e15, 2.57392e15, 2.99694e15, 3.93855e15, 4.19437e15, 4.28167e15,
  2.86507e15, 3.03405e15, 3.16169e15, 4.67948e15, 4.46847e15, 3.56285e15,
  3.85291e15, 4.76427e15, 3.92785e15, 5.69551e15, 8.64027e15, 6.21736e15,
  5.93507e15, 6.92961e15, 5.85636e15, 7.58415e15, 1.06495e16, 8.27325e15,
  7.47625e15, 7.63913e15, 7.58093e15, 6.84513e15, 6.67117e15, 5.62304e15,
  7.43244e15, 6.77115e15, 7.36177e15, 8.96573e15, 8.14294e15, 8.89784e15,
  7.90404e15, 7.69506e15, 1.04231e16, 1.10165e16, 9.93372e15, 9.94058e15,
  1.04646e16, 1.16549e16, 1.18359e16, 1.2017e16, 1.21978e16, 1.20357e16,
  1.39538e16, 1.33078e16, 1.56229e16, 1.18399e16, 1.10358e16, 1.22376e16,
  1.33726e16, 1.14076e16, 1.16709e16, 1.1987e16, 1.71692e16, 1.26783e16,
  1.35516e16, 1.39758e16, 1.6555e16, 1.57762e16, 1.50619e16, 1.38866e16,
  1.60148e16, 1.5852e16, 1.63792e16, 1.71766e16, 1.78266e16, 1.62565e16,
  1.82199e16, 1.66605e16, 2.19074e16, 1.97883e16, 2.23967e16, 2.32317e16,
  2.31642e16, 2.91301e16, 3.37785e16, 3.79669e16, 3.8012e16, 3.83493e16,
  3.94959e16, 4.1698e16, 3.7452e16, 4.35099e16, 4.59464e16, 5.09715e16,
  5.14708e16, 4.25247e16, 3.93275e16, 6.12256e16, 5.67041e16, 6.38506e16,
  5.62228e16, 5.12102e16, 5.89162e16, 6.441e16, 5.81163e16, 5.19647e16,
  5.6226e16, 6.45293e16, 6.53239e16, 5.7281e16, 7.17667e16, 7.77212e16,
  6.60446e16, 6.97176e16, 7.54767e16, 6.77845e16, 6.87806e16, 6.42152e16,
  6.45409e16, 7.4129e16, 8.6986e16, 9.23605e16, 9.1503e16, 8.86573e16,
  8.7234e16, 8.47044e16, 1.0322e17, 9.32601e16, 9.08799e16, 9.03719e16,
  9.57089e16, 8.87616e16, 9.06608e16, 9.56292e16, 9.36326e16, 9.60014e16,
  9.62241e16, 8.79279e16, 9.30814e16, 8.00954e16, 7.88603e16, 7.28663e16,
  7.30216e16, 7.3991e16, 8.42263e16, 7.87221e16, 1.34119e17, 7.38014e16,
  8.12153e16, 7.65829e16, 7.82971e16, 7.73093e16, 9.52497e16, 8.92682e16,
  9.6768e16, 8.41286e16, 8.24115e16, 1.54821e17, 1.22523e17, 1.02984e17,
  1.12097e17, 1.07387e17, 1.07838e17, 1.06885e17, 9.30617e16, 1.06204e17,
  1.02642e17, 1.11424e17, 1.01417e17, 1.27093e17, 1.18521e17, 1.10903e17,
  1.20202e17, 1.29138e17, 1.37348e17, 1.64396e17, 1.85739e17, 1.30497e17,
  1.41643e17, 1.55057e17, 1.49864e17, 1.30482e17, 1.43669e17, 1.23848e17,
  1.08726e17, 2.12747e17, 1.58122e17, 1.35794e17, 1.44189e17, 1.40416e17,
  1.3178e17, 1.09334e17, 1.09763e17, 1.4729e17, 1.8219e17, 1.92807e17,
  1.617e17, 1.64185e17, 1.8736e17, 2.16106e17, 2.61902e17, 2.32093e17,
  2.42165e17, 2.3375e17, 1.89792e17, 2.38391e17, 2.62144e17, 2.02048e17,
  1.79045e17, 1.71565e17, 1.82825e17, 2.24239e17, 2.2579e17, 2.13898e17,
  1.9782e17,
];

/** `lhcone_in` in **bytes**, one per month from `1990-01`: `null` until **2015-01**, when the series starts. */
// prettier-ignore
export const LHCONE_IN: readonly (number | null)[] = [
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  1.69727e15, 1.28914e15, 5.2994e15, 3.81442e15, 4.62522e15, 5.92246e15,
  4.88168e15, 6.29515e15, 8.00019e15, 9.6142e15, 8.73277e15, 9.73012e15,
  1.07939e16, 1.12153e16, 1.05822e16, 1.54199e16, 1.63769e16, 1.75761e16,
  1.84108e16, 1.3704e16, 1.3955e16, 2.55263e16, 2.39844e16, 2.29191e16,
  2.26749e16, 2.08049e16, 2.23732e16, 2.39371e16, 2.42448e16, 2.04946e16,
  2.58861e16, 3.0005e16, 2.86472e16, 2.66208e16, 3.29517e16, 3.73301e16,
  3.13177e16, 3.28202e16, 3.38885e16, 2.78647e16, 2.96054e16, 2.69729e16,
  2.70297e16, 3.18258e16, 3.43289e16, 4.2457e16, 4.66391e16, 4.55766e16,
  4.87853e16, 4.35293e16, 5.48884e16, 5.05155e16, 4.99858e16, 4.88762e16,
  5.1154e16, 4.48918e16, 4.84443e16, 5.12247e16, 4.6606e16, 4.90714e16,
  5.10898e16, 4.7588e16, 4.58426e16, 3.95574e16, 3.8375e16, 3.56981e16,
  3.44196e16, 3.47951e16, 3.65209e16, 3.6997e16, 2.92406e16, 3.43051e16,
  3.66476e16, 3.40787e16, 3.48428e16, 3.26594e16, 4.1397e16, 3.37671e16,
  3.59023e16, 3.06343e16, 3.07804e16, 7.42368e16, 6.27572e16, 5.06247e16,
  5.73408e16, 5.52749e16, 4.6953e16, 5.18972e16, 4.48708e16, 5.14629e16,
  5.26898e16, 5.27467e16, 4.55661e16, 5.37427e16, 5.25949e16, 4.92581e16,
  5.73374e16, 5.29748e16, 5.42178e16, 4.95812e16, 4.50276e16, 5.21885e16,
  5.98059e16, 4.95155e16, 6.96829e16, 5.74683e16, 6.49137e16, 5.75004e16,
  5.2062e16, 1.06992e17, 6.10924e16, 5.42527e16, 5.37489e16, 6.29192e16,
  5.29654e16, 4.34791e16, 4.23477e16, 6.98198e16, 7.03753e16, 6.60253e16,
  5.92751e16, 7.97239e16, 9.13418e16, 9.33409e16, 8.48724e16, 8.38329e16,
  8.94732e16, 9.38409e16, 8.50683e16, 9.65561e16, 9.04271e16, 8.14916e16,
  7.61811e16, 7.24154e16, 7.08485e16, 9.95048e16, 1.04058e17, 9.90956e16,
  9.49738e16,
];

/** `oscars_in` in **bytes**, one per month from `1990-01`: `null` until **2009-01**, when the series starts. */
// prettier-ignore
export const OSCARS_IN: readonly (number | null)[] = [
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null,
  6.73193e14, 1.52612e15, 9.66296e14, 1.14127e15, 1.49219e15, 2.39592e15,
  9.82897e14, 1.14101e15, 1.11533e15, 2.05969e15, 2.55122e15, 1.30875e15,
  1.88578e15, 3.05297e15, 1.85294e15, 3.01177e15, 4.39146e15, 2.18851e15,
  2.27354e15, 3.22063e15, 2.45973e15, 3.62401e15, 5.82719e15, 3.53004e15,
  2.48263e15, 2.37159e15, 3.22646e15, 2.70697e15, 2.40766e15, 2.3438e15,
  3.84811e15, 2.5602e15, 2.76263e15, 3.69564e15, 2.97972e15, 3.45639e15,
  2.77835e15, 2.56454e15, 5.12341e15, 4.0202e15, 3.9402e15, 4.19511e15,
  4.09933e15, 6.03315e15, 5.34039e15, 4.9266e15, 8.68403e15, 6.92427e15,
  5.48299e15, 4.70495e15, 6.40873e15, 5.91486e15, 2.97214e15, 4.03249e15,
  3.48621e15, 4.27352e15, 3.95522e15, 4.45213e15, 6.78935e15, 4.25621e15,
  3.88173e15, 4.21351e15, 3.80403e15, 3.83052e15, 3.3616e15, 2.55051e15,
  4.09344e15, 3.42939e15, 3.81254e15, 3.43792e15, 5.74046e15, 7.69834e15,
  9.57078e15, 4.21768e15, 4.10803e15, 4.30889e15, 4.20493e15, 5.15216e15,
  6.04668e15, 9.36957e15, 1.18123e16, 1.25526e16, 1.33939e16, 1.23327e16,
  1.04565e16, 1.0458e16, 6.86865e15, 8.26706e15, 9.69828e15, 1.4017e16,
  1.23174e16, 1.12172e16, 8.49382e15, 1.22148e16, 1.1193e16, 1.26867e16,
  9.42759e15, 9.87716e15, 1.28757e16, 1.76493e16, 1.11798e16, 8.89352e15,
  8.33819e15, 1.12688e16, 1.16173e16, 9.62783e15, 1.38626e16, 1.14776e16,
  1.01495e16, 9.59073e15, 9.57652e15, 8.36163e15, 9.21588e15, 1.63194e16,
  1.16491e16, 9.50736e15, 1.31845e16, 1.38176e16, 1.52496e16, 1.53162e16,
  9.02462e15, 1.07272e16, 1.29937e16, 1.12973e16, 1.13532e16, 1.18622e16,
  1.12082e16, 1.16414e16, 1.23101e16, 1.30586e16, 1.40267e16, 1.57842e16,
  1.34258e16, 1.01131e16, 1.19155e16, 1.06809e16, 1.18126e16, 9.88547e15,
  1.04592e16, 1.04997e16, 9.96243e15, 9.56541e15, 9.27277e15, 7.58163e15,
  9.44663e15, 9.16298e15, 9.0593e15, 9.6784e15, 1.08491e16, 1.13624e16,
  1.32445e16, 8.65829e15, 9.88854e15, 2.2891e16, 1.35885e16, 1.58538e16,
  1.58386e16, 1.4635e16, 1.32108e16, 1.38303e16, 1.12929e16, 1.0943e16,
  1.25258e16, 1.33948e16, 1.10243e16, 1.49439e16, 1.66576e16, 1.26787e16,
  1.32843e16, 1.19836e16, 1.66294e16, 1.56536e16, 2.03233e16, 1.77647e16,
  2.04183e16, 1.40445e16, 1.71603e16, 1.20573e16, 7.41556e15, 6.03904e15,
  8.90026e14, 3.2117e16, 2.2322e16, 1.95763e16, 2.31629e16, 1.68795e16,
  2.25519e16, 1.98609e16, 1.97378e16, 2.15733e16, 2.37098e16, 1.54697e16,
  1.75345e16, 2.06332e16, 2.68844e16, 3.33452e16, 3.06647e16, 3.10429e16,
  4.07618e16, 4.55948e16, 2.99217e16, 3.8746e16, 6.81549e16, 2.23517e16,
  1.55112e16, 1.70593e16, 2.7518e16, 3.19605e16, 3.41494e16, 3.43785e16,
  1.66347e16,
];
