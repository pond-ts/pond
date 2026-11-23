//! The rows a filter keeps, and the copy of each kind of buffer by them.
//!
//! A [`RowFilter`] holds one bit per row, 64 rows to a word. Every copy
//! reads the words and writes the kept values straight to their place;
//! none goes through a list of row numbers (only [`RowFilter::rows`] makes
//! one, for array columns). There are three kinds of copy.
//!
//! - **Fixed-width values** (times, numbers, decimals, dictionary keys) go
//!   eight rows at a time. A table gives, for each byte of the mask, the
//!   places of its kept rows, so the eight are written kept-rows-first and
//!   the output moves on by the number kept: no branch depends on the
//!   mask, which matters when kept and dropped rows are mixed. A word with
//!   few kept rows is walked bit by bit instead; a word with all of its
//!   rows is one copy, a word with none is skipped.
//! - **Text** goes stretch by stretch. A stretch of kept rows is one
//!   stretch of the source's bytes, so it is one copy, and its offsets are
//!   the source's, moved back by the bytes dropped so far.
//! - **Bits** (true/false values, and the marks that say which rows are
//!   gaps) go stretch by stretch too, each shifted into place.
//!
//! The results are what Arrow's `filter` kernel gives, value for value;
//! the tests below hold each copy to that.

use arrow_array::cast::AsArray;
use arrow_array::types::Int32Type;
use arrow_array::{Array, DictionaryArray, Int32Array, StringArray, new_empty_array};
use arrow_buffer::{BooleanBuffer, Buffer, NullBuffer, OffsetBuffer};

/// The rows to keep: one bit per row of the source.
pub(crate) struct RowFilter {
    /// Row `i` is bit `i % 64` of word `i / 64`. Bits past the last row
    /// are zero.
    words: Vec<u64>,
    /// Rows in the source.
    rows: usize,
    /// Rows kept.
    count: usize,
}

/// A lookup table held at the start of a 64-byte cache line.
///
/// The rows of the tables here are a power of two of bytes, 64 at most, so
/// from the start of a line no row, and no read of several values of one
/// at once, lies across two lines or two memory pages. Where a table lands
/// otherwise is the linker's choice, and a read that lies across two pages
/// is slow: about 10 ns on an M1 (Linux, 4 KB pages), where a read costs a
/// fraction of one. Two builds of the same code once differed by 0.6 ms
/// per million rows on a filter that keeps most rows, because in one the
/// row of [`LANES`] for "all eight kept" lay across the end of a page.
#[repr(align(64))]
struct Aligned<T>(T);

/// Bit `j` alone, for each `j`.
static BIT: Aligned<[u64; 64]> = Aligned({
    let mut b = [0u64; 64];
    let mut j = 0;
    while j < 64 {
        b[j] = 1 << j;
        j += 1;
    }
    b
});

/// Times eight bytes of 0 or 1, this gives their eight bits in the top
/// byte.
const PACK: u64 = 0x0102_0408_1020_4080;

impl RowFilter {
    /// From the words of a mask over `rows` rows (row `i` is bit `i % 64`
    /// of word `i / 64`). Bits past the last row are cleared.
    pub(crate) fn from_words(mut words: Vec<u64>, rows: usize) -> Self {
        assert_eq!(words.len(), rows.div_ceil(64), "one word per 64 rows");
        if !rows.is_multiple_of(64)
            && let Some(last) = words.last_mut()
        {
            *last &= (1u64 << (rows % 64)) - 1;
        }
        let count = words.iter().map(|w| w.count_ones() as usize).sum();
        Self { words, rows, count }
    }

    /// The rows of `v` where `test` holds. Each row's answer is spread over
    /// a whole word and cut down to the row's own bit, and the 64 of a
    /// word are or-ed together: a loop with no branch, which the compiler
    /// runs on several values at a time. `test` is compiled into the loop,
    /// so each caller gets a loop of its own.
    #[inline(always)]
    pub(crate) fn of_numbers(v: &[f64], test: impl Fn(f64) -> bool) -> Self {
        let (chunks, rest) = v.as_chunks::<64>();
        let mut words = Vec::with_capacity(v.len().div_ceil(64));
        words.extend(chunks.iter().map(|c| {
            let mut w = 0u64;
            for j in 0..64 {
                w |= 0u64.wrapping_sub(u64::from(test(c[j]))) & BIT.0[j];
            }
            w
        }));
        if !rest.is_empty() {
            let mut w = 0u64;
            for (j, &x) in rest.iter().enumerate() {
                w |= u64::from(test(x)) << j;
            }
            words.push(w);
        }
        Self::from_words(words, v.len())
    }

    /// The rows where `flags` is 1: an evaluated true/false expression,
    /// where 0 is false and a negative value a gap.
    pub(crate) fn of_flags(flags: &[i8]) -> Self {
        let (chunks, rest) = flags.as_chunks::<64>();
        let mut words = Vec::with_capacity(flags.len().div_ceil(64));
        words.extend(chunks.iter().map(|c| {
            let mut w = 0u64;
            for (g, c8) in c.as_chunks::<8>().0.iter().enumerate() {
                let ones = u64::from_le_bytes(c8.map(|x| u8::from(x == 1)));
                w |= (ones.wrapping_mul(PACK) >> 56) << (g * 8);
            }
            w
        }));
        if !rest.is_empty() {
            let mut w = 0u64;
            for (j, &x) in rest.iter().enumerate() {
                w |= u64::from(x == 1) << j;
            }
            words.push(w);
        }
        Self::from_words(words, flags.len())
    }

    /// Rows in the source.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.rows
    }

    /// Number of rows kept.
    pub(crate) fn count(&self) -> usize {
        self.count
    }

    /// The rows kept, as row numbers, in order.
    pub(crate) fn rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.words.iter().enumerate().flat_map(|(w, &m)| {
            let mut m = m;
            std::iter::from_fn(move || {
                (m != 0).then(|| {
                    let j = m.trailing_zeros() as usize;
                    m &= m - 1;
                    w * 64 + j
                })
            })
        })
    }

    /// Each row's bit, in order.
    #[cfg(test)]
    pub(crate) fn iter(&self) -> impl Iterator<Item = bool> + '_ {
        (0..self.rows).map(|i| (self.words[i / 64] >> (i % 64)) & 1 == 1)
    }

    /// The values of `v` at the kept rows, in order.
    pub(crate) fn vec<T: Copy>(&self, v: &[T]) -> Vec<T> {
        assert_eq!(v.len(), self.rows, "one value per row");
        // Room for one whole group of eight past the last kept value: a
        // group is appended whole, then the length cut back to its kept
        // rows, so nothing is zeroed first and nothing ever grows.
        let mut out: Vec<T> = Vec::with_capacity(self.count + 8);
        // The last word's rows, when they are not a whole 64, come after.
        let (chunks, rest) = v.as_chunks::<64>();
        let (words, last) = self.words.split_at(chunks.len());
        for (c, &m) in chunks.iter().zip(words) {
            if m == 0 {
                continue;
            }
            if m == u64::MAX {
                out.extend_from_slice(c);
                continue;
            }
            if m.count_ones() <= SPARSE {
                let mut m = m;
                while m != 0 {
                    out.push(c[(m.trailing_zeros() & 63) as usize]);
                    m &= m - 1;
                }
                continue;
            }
            for (g, c8) in c.as_chunks::<8>().0.iter().enumerate() {
                let byte = (m >> (g * 8)) as u8;
                let at = &PLACES.0[usize::from(byte)];
                let len = out.len();
                out.extend_from_slice(&[
                    c8[at[0] as usize],
                    c8[at[1] as usize],
                    c8[at[2] as usize],
                    c8[at[3] as usize],
                    c8[at[4] as usize],
                    c8[at[5] as usize],
                    c8[at[6] as usize],
                    c8[at[7] as usize],
                ]);
                out.truncate(len + byte.count_ones() as usize);
            }
        }
        if let Some(&m) = last.first() {
            for (j, &x) in rest.iter().enumerate() {
                if (m >> j) & 1 == 1 {
                    out.push(x);
                }
            }
        }
        out
    }

    /// The bits of `src` at the kept rows, in order.
    pub(crate) fn bits(&self, src: &BooleanBuffer) -> BooleanBuffer {
        assert_eq!(src.len(), self.rows, "one bit per row");
        // One spare word: a stretch is or-ed into the word it starts in
        // and the next, whether or not it reaches that far.
        let mut out = vec![0u64; self.count.div_ceil(64) + 1];
        let mut k = 0usize;
        // `iter_padded` gives the source 64 rows to a word whatever bit it
        // starts at (a sliced array), with zeros past its end.
        for (s, &m) in src.bit_chunks().iter_padded().zip(&self.words) {
            if m == u64::MAX {
                put_bits(&mut out, k, s);
                k += 64;
                continue;
            }
            for (first, len) in stretches(m) {
                // Under 64 rows: a full word took the branch above.
                put_bits(&mut out, k, (s >> first) & ((1u64 << len) - 1));
                k += len;
            }
        }
        out.truncate(self.count.div_ceil(64));
        BooleanBuffer::new(Buffer::from_vec(out), 0, self.count)
    }

    /// The gap marks of the kept rows; `None` when no kept row is a gap
    /// (as Arrow's `filter` gives).
    pub(crate) fn nulls(&self, nulls: Option<&NullBuffer>) -> Option<NullBuffer> {
        let nulls = nulls.filter(|n| n.null_count() > 0)?;
        let kept = NullBuffer::new(self.bits(nulls.inner()));
        (kept.null_count() > 0).then_some(kept)
    }

    /// The kept rows of a `Utf8` array, in order. A gap's bytes (there are
    /// usually none) are copied like any row's, as Arrow's `filter` does.
    pub(crate) fn text(&self, a: &StringArray) -> StringArray {
        assert_eq!(a.len(), self.rows, "one value per row");
        // The source's offsets are positions in `values` (and need not
        // start at 0: a sliced array).
        let (offsets, values) = (a.value_offsets(), a.value_data());
        let total = self.kept_bytes(offsets);
        // Both outputs are written by position, past their end by a fixed
        // amount: eight offsets and 64 bytes whatever the stretch's length,
        // so that no branch depends on the length. The spare room takes the
        // overshoot of the last stretch; the next stretch overwrites the
        // overshoot of every other.
        let mut out_offsets = vec![0i32; self.count + 1 + 8];
        let mut bytes = vec![0u8; total + 64];
        let (mut k, mut at) = (0usize, 0usize);
        for (w, &m) in self.words.iter().enumerate() {
            for (first, len) in stretches(m) {
                let i = w * 64 + first;
                let (start, end) = (offsets[i] as usize, offsets[i + len] as usize);
                // What the source's offsets are ahead of the output's by,
                // across this stretch: the bytes dropped before it.
                let ahead = (start - at) as i32;
                if len <= 8 && i + 8 <= offsets.len() {
                    let from: &[i32; 8] = offsets[i..i + 8].try_into().expect("8 offsets");
                    let to: &mut [i32; 8] =
                        (&mut out_offsets[k..k + 8]).try_into().expect("8 offsets");
                    *to = from.map(|x| x - ahead);
                } else {
                    for (to, &x) in out_offsets[k..k + len].iter_mut().zip(&offsets[i..i + len]) {
                        *to = x - ahead;
                    }
                }
                if end - start <= 64 && start + 64 <= values.len() {
                    let from: &[u8; 64] = values[start..start + 64].try_into().expect("64 bytes");
                    let to: &mut [u8; 64] = (&mut bytes[at..at + 64]).try_into().expect("64 bytes");
                    *to = *from;
                } else {
                    bytes[at..at + (end - start)].copy_from_slice(&values[start..end]);
                }
                k += len;
                at += end - start;
            }
        }
        debug_assert_eq!((k, at), (self.count, total));
        out_offsets[self.count] = total as i32;
        out_offsets.truncate(self.count + 1);
        bytes.truncate(total);
        StringArray::new(
            OffsetBuffer::new(out_offsets.into()),
            Buffer::from_vec(bytes),
            self.nulls(a.nulls()),
        )
    }

    /// The kept rows of a dictionary array, in order: its keys at the kept
    /// rows, over the same values. When no row is kept the values go too,
    /// as Arrow's `filter` gives.
    pub(crate) fn dictionary(&self, a: &DictionaryArray<Int32Type>) -> DictionaryArray<Int32Type> {
        assert_eq!(a.len(), self.rows, "one key per row");
        if self.count == 0 {
            return new_empty_array(a.data_type())
                .as_dictionary::<Int32Type>()
                .clone();
        }
        let keys = a.keys();
        let kept = Int32Array::new(self.vec(keys.values()).into(), self.nulls(keys.nulls()));
        DictionaryArray::new(kept, a.values().clone())
    }

    /// Bytes of the kept rows of a text column with these `offsets`. Every
    /// row's length is cut to nothing where the row is dropped, and the
    /// lengths are added eight lanes at a time. The lanes wrap; their total
    /// is under 2^31 (the offsets are `i32`), so it comes out exact. When
    /// few rows are kept, their stretches are added up instead, which reads
    /// two offsets per stretch rather than all of them.
    fn kept_bytes(&self, offsets: &[i32]) -> usize {
        if self.count <= self.rows / FEW {
            let mut total = 0usize;
            for (w, &m) in self.words.iter().enumerate() {
                for (first, len) in stretches(m) {
                    let i = w * 64 + first;
                    total += (offsets[i + len] - offsets[i]) as usize;
                }
            }
            return total;
        }
        let (from, from_rest) = offsets[..self.rows].as_chunks::<64>();
        let (to, to_rest) = offsets[1..].as_chunks::<64>();
        let (words, last) = self.words.split_at(from.len());
        let mut sum = [0u32; 8];
        for ((from, to), &m) in from.iter().zip(to).zip(words) {
            let (from, to) = (from.as_chunks::<8>().0, to.as_chunks::<8>().0);
            for ((from, to), byte) in from.iter().zip(to).zip(m.to_le_bytes()) {
                let lanes = &LANES.0[usize::from(byte)];
                for j in 0..8 {
                    sum[j] = sum[j].wrapping_add((to[j].wrapping_sub(from[j]) as u32) & lanes[j]);
                }
            }
        }
        let mut total = sum.iter().fold(0u32, |a, &b| a.wrapping_add(b));
        if let Some(&m) = last.first() {
            for (j, (&from, &to)) in from_rest.iter().zip(to_rest).enumerate() {
                if (m >> j) & 1 == 1 {
                    total = total.wrapping_add(to.wrapping_sub(from) as u32);
                }
            }
        }
        total as usize
    }
}

/// From one true or false per row.
impl FromIterator<bool> for RowFilter {
    fn from_iter<I: IntoIterator<Item = bool>>(rows: I) -> Self {
        let mut words = Vec::new();
        let mut n = 0usize;
        for keep in rows {
            if n.is_multiple_of(64) {
                words.push(0u64);
            }
            if keep {
                words[n / 64] |= 1 << (n % 64);
            }
            n += 1;
        }
        Self::from_words(words, n)
    }
}

/// True when every value is finite. Looks at 64 values at a time, with no
/// branch inside the 64 (so they are tested several at a time), and stops
/// at the first 64 that hold a value that is not.
pub(crate) fn all_finite(v: &[f64]) -> bool {
    v.chunks(64)
        .all(|c| c.iter().fold(true, |ok, x| ok & x.is_finite()))
}

/// A word with this many kept rows or fewer is walked bit by bit.
const SPARSE: u32 = 12;

/// With one row in this many kept, or fewer, the bytes of a text column's
/// kept rows are added up stretch by stretch.
const FEW: usize = 16;

/// A row's place within a group of eight. An enum, not a number, so that
/// reading a group of eight at it needs no bounds check.
#[derive(Clone, Copy)]
#[repr(u8)]
enum Place {
    P0,
    P1,
    P2,
    P3,
    P4,
    P5,
    P6,
    P7,
}

/// For each byte of a mask, the places of its set bits, lowest first. The
/// rest of each row repeats place 0: those slots are written and then cut
/// off (see [`RowFilter::vec`]).
static PLACES: Aligned<[[Place; 8]; 256]> = Aligned({
    const ALL: [Place; 8] = [
        Place::P0,
        Place::P1,
        Place::P2,
        Place::P3,
        Place::P4,
        Place::P5,
        Place::P6,
        Place::P7,
    ];
    let mut table = [[Place::P0; 8]; 256];
    let mut byte = 0;
    while byte < 256 {
        let (mut j, mut k) = (0, 0);
        while j < 8 {
            if (byte >> j) & 1 == 1 {
                table[byte][k] = ALL[j];
                k += 1;
            }
            j += 1;
        }
        byte += 1;
    }
    table
});

/// For each byte of a mask, all ones in the lanes of its set bits.
static LANES: Aligned<[[u32; 8]; 256]> = Aligned({
    let mut table = [[0u32; 8]; 256];
    let mut byte = 0;
    while byte < 256 {
        let mut j = 0;
        while j < 8 {
            if (byte >> j) & 1 == 1 {
                table[byte][j] = u32::MAX;
            }
            j += 1;
        }
        byte += 1;
    }
    table
});

/// The stretches of kept rows in one word of a mask, as (first row, rows),
/// lowest first. The first rows and the last rows of every stretch are
/// found at once, so stepping to the next stretch is one cheap step on
/// each (rather than a search that waits on the stretch before).
fn stretches(m: u64) -> impl Iterator<Item = (usize, usize)> {
    // A stretch starts at a set bit with no set bit below it, and ends at
    // one with no set bit above it.
    let mut firsts = m & !(m << 1);
    let mut lasts = m & !(m >> 1);
    std::iter::from_fn(move || {
        (firsts != 0).then(|| {
            let first = firsts.trailing_zeros() as usize;
            let last = lasts.trailing_zeros() as usize;
            firsts &= firsts - 1;
            lasts &= lasts - 1;
            (first, last + 1 - first)
        })
    })
}

/// Or `bits` into `out` from bit `k` on: into the word `k` is in and, for
/// what does not fit there, the next.
#[inline(always)]
fn put_bits(out: &mut [u64], k: usize, bits: u64) {
    let (word, shift) = (k / 64, k % 64);
    out[word] |= bits << shift;
    // `bits >> (64 - shift)`, written so that a shift of 0 gives 0.
    out[word + 1] |= (bits >> 1) >> (63 - shift);
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::BooleanArray;
    use arrow_array::cast::AsArray;
    use arrow_select::filter::filter;

    /// A small repeatable source of random numbers.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    const LENGTHS: [usize; 16] = [
        0, 1, 7, 8, 9, 63, 64, 65, 71, 127, 128, 129, 200, 1000, 4096, 4133,
    ];

    /// Masks of every shape the copies branch on: none, all, mixed, sparse,
    /// dense, long stretches, single rows at the edges of a word.
    fn masks(n: usize, rng: &mut Rng) -> Vec<Vec<bool>> {
        let mut out: Vec<Vec<bool>> = vec![
            vec![false; n],
            vec![true; n],
            (0..n).map(|i| i % 2 == 0).collect(),
            (0..n).map(|i| i % 2 == 1).collect(),
            (0..n).map(|i| i % 3 != 0).collect(),
            (0..n).map(|i| i % 64 == 0).collect(),
            (0..n).map(|i| i % 64 == 63).collect(),
            (0..n).map(|i| i % 64 != 63).collect(),
            (0..n).map(|i| i % 64 != 0).collect(),
            (0..n).map(|i| (i / 100) % 2 == 0).collect(),
            (0..n).map(|i| (i / 9) % 2 == 1).collect(),
            (0..n).map(|i| i + 1 == n).collect(),
            (0..n).map(|i| i == 0).collect(),
            (0..n).map(|i| i >= 64).collect(),
        ];
        for percent in [3, 15, 50, 85, 97] {
            out.push((0..n).map(|_| rng.next() % 100 < percent).collect());
        }
        out
    }

    fn each_mask(mut f: impl FnMut(usize, &[bool], &RowFilter)) {
        let mut rng = Rng(0x2545_f491_4f6c_dd1d);
        for n in LENGTHS {
            for m in masks(n, &mut rng) {
                let keep: RowFilter = m.iter().copied().collect();
                assert_eq!(keep.len(), n);
                assert_eq!(keep.count(), m.iter().filter(|&&b| b).count());
                f(n, &m, &keep);
            }
        }
    }

    fn kept<T: Clone>(v: &[T], m: &[bool]) -> Vec<T> {
        v.iter()
            .zip(m)
            .filter(|(_, keep)| **keep)
            .map(|(x, _)| x.clone())
            .collect()
    }

    #[test]
    fn rows_and_bits_read_back() {
        each_mask(|n, m, keep| {
            assert_eq!(keep.iter().collect::<Vec<_>>(), m);
            let rows: Vec<usize> = (0..n).filter(|&i| m[i]).collect();
            assert_eq!(keep.rows().collect::<Vec<_>>(), rows);
        });
    }

    #[test]
    fn from_words_clears_bits_past_the_last_row() {
        let keep = RowFilter::from_words(vec![u64::MAX, u64::MAX], 70);
        assert_eq!(keep.count(), 70);
        assert_eq!(keep.rows().count(), 70);
        assert_eq!(keep.vec(&(0..70).collect::<Vec<i32>>()).len(), 70);
    }

    #[test]
    fn vec_keeps_the_values_of_the_kept_rows() {
        each_mask(|n, m, keep| {
            let times: Vec<i64> = (0..n as i64).map(|i| i * 1000 - 7).collect();
            assert_eq!(keep.vec(&times), kept(&times, m), "i64, n {n}");
            let numbers: Vec<f64> = (0..n).map(|i| i as f64 / 8.0).collect();
            assert_eq!(keep.vec(&numbers), kept(&numbers, m), "f64, n {n}");
            let keys: Vec<i32> = (0..n as i32).map(|i| i % 11).collect();
            assert_eq!(keep.vec(&keys), kept(&keys, m), "i32, n {n}");
            let wide: Vec<i128> = (0..n as i128).map(|i| (i << 70) - i).collect();
            assert_eq!(keep.vec(&wide), kept(&wide, m), "i128, n {n}");
        });
    }

    #[test]
    fn bits_match_arrow_filter() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        each_mask(|n, m, keep| {
            // A source with three spare rows in front, so that the rows
            // under test start part-way through a byte (a sliced array).
            let source: Vec<bool> = (0..n + 3).map(|_| rng.next().is_multiple_of(3)).collect();
            let whole = BooleanBuffer::from_iter(source.iter().copied());
            for skip in [0, 3] {
                let src = whole.slice(skip, n);
                let want: Vec<bool> = kept(&source[skip..skip + n], m);
                let got = keep.bits(&src);
                assert_eq!(got.len(), keep.count());
                assert_eq!(got.iter().collect::<Vec<_>>(), want, "n {n}, skip {skip}");
                let mask = BooleanArray::from(m.to_vec());
                let arrow = filter(&BooleanArray::new(src, None), &mask).unwrap();
                assert_eq!(arrow.as_boolean().values(), &got);
            }
        });
    }

    #[test]
    fn nulls_are_dropped_when_no_kept_row_is_a_gap() {
        let valid = NullBuffer::from(vec![true, false, true, true]);
        let keep: RowFilter = [true, false, true, false].into_iter().collect();
        assert!(keep.nulls(Some(&valid)).is_none());
        let keep: RowFilter = [true, true, false, false].into_iter().collect();
        let kept = keep.nulls(Some(&valid)).unwrap();
        assert_eq!(kept.iter().collect::<Vec<_>>(), [true, false]);
        assert!(keep.nulls(None).is_none());
        assert!(
            keep.nulls(Some(&NullBuffer::new_valid(4))).is_none(),
            "a mask with no gap marked"
        );
    }

    /// Text of every length the copy branches on: empty, short, over 64
    /// bytes (a stretch that takes the long copy), characters of two to
    /// four bytes.
    fn texts(n: usize, rng: &mut Rng) -> Vec<Option<String>> {
        const WORDS: [&str; 8] = [
            "",
            "a",
            "host-3",
            "né",
            "日本語",
            "🙂🙃",
            "x y z",
            "0123456789",
        ];
        (0..n)
            .map(|i| match rng.next() % 16 {
                0 => None,
                1 => Some("long ".repeat(15 + i % 40)),
                r => Some(WORDS[(r % 8) as usize].repeat(1 + (r / 8) as usize)),
            })
            .collect()
    }

    #[test]
    fn text_matches_arrow_filter() {
        let mut rng = Rng(0xdead_beef_cafe_f00d);
        each_mask(|n, m, keep| {
            let mask = BooleanArray::from(m.to_vec());
            let values = texts(n + 5, &mut rng);
            let whole: StringArray = values.iter().map(|v| v.as_deref()).collect();
            // With gaps and without; whole and sliced (offsets that do not
            // start at 0).
            let no_gaps: StringArray = values
                .iter()
                .map(|v| Some(v.as_deref().unwrap_or("gap")))
                .collect();
            for source in [&whole, &no_gaps] {
                for skip in [0, 5] {
                    let a = source.slice(skip, n);
                    let got = keep.text(&a);
                    let arrow = filter(&a, &mask).unwrap();
                    let arrow = arrow.as_string::<i32>();
                    assert_eq!(&got, arrow, "n {n}, skip {skip}");
                    // The same parts, not only the same values. (When every
                    // row is kept Arrow hands back the source's own parts,
                    // which for a slice hold more than its rows.)
                    if keep.count() < n {
                        assert_eq!(got.value_offsets(), arrow.value_offsets());
                        assert_eq!(got.value_data(), arrow.value_data());
                        assert_eq!(got.nulls(), arrow.nulls());
                    } else {
                        assert_eq!(got.value_offsets()[0], 0);
                        assert_eq!(
                            got.value_data().len(),
                            *got.value_offsets().last().unwrap() as usize
                        );
                    }
                }
            }
        });
    }

    #[test]
    fn dictionary_matches_arrow_filter() {
        let mut rng = Rng(0x0123_4567_89ab_cdef);
        each_mask(|n, m, keep| {
            let mask = BooleanArray::from(m.to_vec());
            let values = texts(n + 5, &mut rng);
            let whole: DictionaryArray<Int32Type> = values.iter().map(|v| v.as_deref()).collect();
            // Whole and sliced (keys that do not start at the first row).
            for skip in [0, 5] {
                let a = whole.slice(skip, n);
                let got = keep.dictionary(&a);
                let arrow = filter(&a, &mask).unwrap();
                let arrow = arrow.as_dictionary::<Int32Type>();
                assert_eq!(got.keys(), arrow.keys(), "n {n}, skip {skip}");
                // The same values behind the keys: all of the source's, or
                // none when no row is kept.
                assert_eq!(
                    got.values().as_string::<i32>(),
                    arrow.values().as_string::<i32>(),
                    "n {n}, skip {skip}, {} kept",
                    keep.count()
                );
            }
        });
    }

    #[test]
    fn text_with_no_bytes_at_all() {
        let a: StringArray = vec![Some(""); 130].into_iter().collect();
        let keep: RowFilter = (0..130).map(|i| i % 3 == 0).collect();
        let got = keep.text(&a);
        assert_eq!(got.len(), 44);
        assert!(got.iter().all(|v| v == Some("")));
    }

    #[test]
    fn of_numbers_and_of_flags_test_every_row() {
        let mut rng = Rng(0x1234_5678_9abc_def0);
        for n in LENGTHS {
            let v: Vec<f64> = (0..n).map(|_| (rng.next() % 1000) as f64).collect();
            let keep = RowFilter::of_numbers(&v, |x| x > 500.0);
            let want: Vec<bool> = v.iter().map(|&x| x > 500.0).collect();
            assert_eq!(keep.iter().collect::<Vec<_>>(), want, "n {n}");
            let flags: Vec<i8> = (0..n).map(|_| (rng.next() % 3) as i8 - 1).collect();
            let keep = RowFilter::of_flags(&flags);
            let want: Vec<bool> = flags.iter().map(|&x| x == 1).collect();
            assert_eq!(keep.iter().collect::<Vec<_>>(), want, "n {n}");
        }
    }

    #[test]
    fn all_finite_finds_a_gap_anywhere() {
        for n in [0, 1, 63, 64, 65, 200] {
            let v = vec![1.5; n];
            assert!(all_finite(&v));
            for at in 0..n {
                for gap in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                    let mut v = v.clone();
                    v[at] = gap;
                    assert!(!all_finite(&v), "n {n}, gap at {at}");
                }
            }
        }
    }
}
