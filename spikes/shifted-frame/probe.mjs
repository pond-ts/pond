// Shifted-frame rolling: accumulate (v - anchor) rather than v, so the
// window mean is carried as anchor + small-offset. The deviation the
// consumer actually wants, (v - mean), is then (v - anchor) - offset —
// a subtraction of two SMALL numbers, which does not cancel.
const R='/Users/peter/Code/pond-ts/.claude/worktrees/unruffled-bardeen-b42902/packages/financial';
const { rollingMeanSd } = await import(R + '/dist/parallel/kernel.js');

/** Current shape: absolute mean + sd. Consumer computes v - mean itself. */
function currentZ(v, P, s, e, out) {
  const m = new Float64Array(v.length), sd = new Float64Array(v.length);
  rollingMeanSd(v, P, s, e, m, sd);
  for (let i = s; i < e; i++) out[i] = sd[i] === 0 ? NaN : (v[i] - m[i]) / sd[i];
}

/** Shifted frame. Same Welford recurrence, run on (v - anchor). */
function shiftedZ(v, P, s, e, out) {
  const warm = Math.max(0, s - P + 1);
  const anchor = v[warm];                 // one per chunk; values near it
  let ws = warm, we = warm, wN = 0, wMean = 0, wM2 = 0;
  for (let i = s; i < e; i++) {
    const lo = i - P + 1 > 0 ? i - P + 1 : 0;
    while (we <= i) {
      const d = v[we] - anchor;           // small, and EXACT when close (Sterbenz)
      if (Number.isFinite(d)) { wN++; const dl = d - wMean; wMean += dl/wN; wM2 += dl*(d-wMean); }
      we++;
    }
    while (ws < lo) {
      const d = v[ws] - anchor;
      if (Number.isFinite(d)) {
        if (wN <= 1) { wN=0; wMean=0; wM2=0; }
        else { const mw=wMean; wN--; if(wN===1){wMean=mw*2-d;wM2=0;}
               else {wMean=mw-(d-mw)/wN; wM2-=(d-wMean)*(d-mw); if(wM2<0)wM2=0;} }
      }
      ws++;
    }
    if (we - ws < P || wN === 0) { out[i] = NaN; continue; }
    const sd = Math.sqrt(wM2/wN > 0 ? wM2/wN : 0);
    // The whole point: both operands are small, so no cancellation.
    out[i] = sd === 0 ? NaN : ((v[i] - anchor) - wMean) / sd;
  }
}

// A reference that is ACTUALLY exact for this data. Summing 20 values of
// ~1e15 gives ~2e16, where ulp is 4 — so a naive two-pass "reference"
// carries ~0.2 of error in the mean, which is 20% of a deviation of ~1.
// It was not a reference at all; it was a third wrong answer.
// Anchoring first makes every term small, and the sum exact.
function exactZ(v, P, i) {
  const lo = i-P+1;
  const a = v[lo];
  let s = 0; for (let k=lo;k<=i;k++) s += (v[k]-a);   // small terms, exact here
  const mo = s/P;                                     // mean, shifted
  let q = 0; for (let k=lo;k<=i;k++){const d=(v[k]-a)-mo; q+=d*d;}
  const sd = Math.sqrt(q/P);
  return sd === 0 ? NaN : ((v[i]-a)-mo)/sd;
}

const P=20, K=4;
for (const [label, gen, N] of [
  ['pathological: 1e15 + (i%7-3)', (i)=>1e15+((i%7)-3), 200000],
  ['benign: random walk ~100',      null,                200000],
]) {
  const N2=N, v=new Float64Array(N2);
  if (gen) for(let i=0;i<N2;i++) v[i]=gen(i);
  else { let p=100,s=0x5eed; for(let i=0;i<N2;i++){s=(s+0x6d2b79f5)>>>0;
    const r=((s*1103515245+12345)&0x7fffffff)/0x7fffffff; p=Math.max(1,p+(r-0.5)*0.4); v[i]=p;} }

  const step=Math.ceil(N2/K);
  const cur=new Float64Array(N2).fill(NaN), shf=new Float64Array(N2).fill(NaN);
  for(let c=0;c<K;c++){ const s0=c*step, e0=Math.min(N2,(c+1)*step);
    currentZ(v,P,s0,e0,cur); shiftedZ(v,P,s0,e0,shf); }

  let curErr=0, shfErr=0, n=0;
  for(let i=P+5;i<N2;i+=97){
    const ex=exactZ(v,P,i); if(!Number.isFinite(ex)||ex===0) continue;
    if(Number.isFinite(cur[i])) curErr=Math.max(curErr,Math.abs((cur[i]-ex)/ex));
    if(Number.isFinite(shf[i])) shfErr=Math.max(shfErr,Math.abs((shf[i]-ex)/ex));
    n++;
  }
  console.log(label);
  console.log('  rows sampled                :', n);
  console.log('  worst rel err, CURRENT      :', curErr.toExponential(2));
  console.log('  worst rel err, SHIFTED FRAME:', shfErr.toExponential(2));
  console.log();
}
