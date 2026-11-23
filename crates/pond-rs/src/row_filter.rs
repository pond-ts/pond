//! The rows a filter keeps, and the copy of each kind of buffer by them.
//!
//! A [`RowFilter`] holds one bit per row, 64 rows to a word. There are two
//! ways to copy by it.
//!
//! **Straight from the words**, with no list of row numbers:
//!
//! - **Fixed-width values** (times, numbers, decimals, dictionary keys) go
//!   eight rows at a time. A table gives, for each byte of the mask, the
//!   places of its kept rows, so the eight are written kept-rows-first and
//!   the output moves on by the number kept: no branch depends on the
//!   mask, which matters when kept and dropped rows are mixed. A word with
//!   few kept rows is walked bit by bit instead; a run of words with all
//!   of their rows is one copy, a word with none is skipped.
//! - **Bits** (true/false values, and the marks that say which rows are
//!   gaps) go stretch by stretch, each stretch shifted into place.
//!
//! **By Arrow's `filter` kernel** ([`RowFilter::by_list`]), which first
//! makes a list of the kept rows and then gathers by it. Making the list
//! is a pass of its own, but each column after that costs less than a copy
//! from the words (about two thirds, for a number column), so it pays when
//! several columns share it; the caller chooses (`TimeSeries::filter_rows`).
//!
//! **Text** is never put together here from bytes. Arrow would check such
//! an array again, byte by byte, as text (the unchecked way in is
//! `unsafe`), and that check costs more than a copy of our own saves for
//! anything but short plain-ASCII strings. Text goes by the kernel when
//! kept rows are scattered, and stretch by stretch when they come in long
//! stretches (see [`RowFilter::text`]): both copy from an array known to
//! be valid, so neither needs the check.
//!
//! Whichever way, the values are the same; the tests below hold each copy
//! to a row-by-row reading or to Arrow's kernel.

use std::sync::OnceLock;

use arrow_array::builder::StringBuilder;
use arrow_array::cast::AsArray;
use arrow_array::types::Int32Type;
use arrow_array::{
    Array, ArrayRef, BooleanArray, DictionaryArray, Int32Array, StringArray, new_empty_array,
};
use arrow_buffer::{BooleanBuffer, Buffer, NullBuffer};
use arrow_select::filter::{FilterBuilder, FilterPredicate};

/// The rows to keep: one bit per row of the source.
pub(crate) struct RowFilter {
    /// Row `i` is bit `i % 64` of word `i / 64`. Bits past the last row
    /// are zero.
    words: Vec<u64>,
    /// Rows in the source.
    len: usize,
    /// Rows kept.
    count: usize,
    /// The mask as Arrow's `filter` kernel takes it, with the kernel's
    /// list of the kept rows: made the first time [`RowFilter::by_list`]
    /// is called, and shared by every column copied that way.
    listed: OnceLock<FilterPredicate>,
}

/// A lookup table held at the start of a 64-byte cache line.
///
/// The tables' rows are 8 bytes, so from the start of a line no row lies
/// across two lines, and so none across two memory pages. The same goes
/// for a read of two or four of [`BIT`]'s values at once. Left alone, a
/// table lands wherever the linker puts it, and a read that lies across
/// two pages is slow: about 10 ns on an M1 (Linux, 4 KB pages), where a
/// read costs a fraction of one. Two builds of the same code once differed
/// by 0.6 ms per million rows on a filter that keeps most rows, because in
/// one a much-read row of a table like these lay across a page's end.
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
    pub(crate) fn from_words(mut words: Vec<u64>, len: usize) -> Self {
        assert_eq!(words.len(), len.div_ceil(64), "one word per 64 rows");
        if !len.is_multiple_of(64)
            && let Some(last) = words.last_mut()
        {
            *last &= (1u64 << (len % 64)) - 1;
        }
        let count = words.iter().map(|w| w.count_ones() as usize).sum();
        Self {
            words,
            len,
            count,
            listed: OnceLock::new(),
        }
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
            // `j` indexes the values and the table. Clippy 1.97 sees only
            // the first; 1.100 sees both.
            #[allow(clippy::needless_range_loop)]
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
        self.len
    }

    /// Number of rows kept.
    pub(crate) fn count(&self) -> usize {
        self.count
    }

    /// True when kept and dropped rows are mixed through the mask: at least
    /// one word in four holds both. When they are not (long stretches of
    /// rows kept or dropped), a copy straight from the words is mostly
    /// whole words copied or skipped, and no list of rows does better.
    pub(crate) fn is_scattered(&self) -> bool {
        let mixed = self.words.iter().filter(|&&m| m != 0 && m != u64::MAX);
        mixed.count() * 4 >= self.words.len().max(1)
    }

    /// The stretches of kept rows, as (first row, rows), in order. A
    /// stretch runs on from one word into the next.
    fn stretches(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        let mut pieces = self
            .words
            .iter()
            .enumerate()
            .flat_map(|(w, &m)| stretches(m).map(move |(first, rows)| (w * 64 + first, rows)));
        let mut next = pieces.next();
        std::iter::from_fn(move || {
            let (first, mut rows) = next?;
            loop {
                next = pieces.next();
                match next {
                    Some((at, more)) if at == first + rows => rows += more,
                    _ => return Some((first, rows)),
                }
            }
        })
    }

    /// How many stretches of kept rows there are: the kept rows with a
    /// dropped row, or none, before them.
    fn stretch_count(&self) -> usize {
        let mut before = 0u64; // the last row of the word before
        let starts = self.words.iter().map(|&m| {
            let starts = m & !((m << 1) | before);
            before = m >> 63;
            starts.count_ones() as usize
        });
        starts.sum()
    }

    /// True when kept rows come in long stretches: [`TEXT_STRETCH_ROWS`]
    /// rows to a stretch or more, on average. Text is then copied stretch
    /// by stretch ([`RowFilter::text`]).
    fn in_long_stretches(&self) -> bool {
        self.count >= TEXT_STRETCH_ROWS * self.stretch_count()
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
        (0..self.len).map(|i| (self.words[i / 64] >> (i % 64)) & 1 == 1)
    }

    /// The values of `v` at the kept rows, in order.
    pub(crate) fn vec<T: Copy>(&self, v: &[T]) -> Vec<T> {
        assert_eq!(v.len(), self.len, "one value per row");
        // Room for one whole group of eight past the last kept value: a
        // group is appended whole, then the length cut back to its kept
        // rows, so nothing is zeroed first and nothing ever grows.
        let mut out: Vec<T> = Vec::with_capacity(self.count + 8);
        // The last word's rows, when they are not a whole 64, come after.
        let (chunks, rest) = v.as_chunks::<64>();
        let (words, last) = self.words.split_at(chunks.len());
        let mut whole = 0; // words of a run of whole words still to skip
        for (w, (c, &m)) in chunks.iter().zip(words).enumerate() {
            if m == 0 {
                continue;
            }
            if m == u64::MAX {
                // A run of words with every row kept is one copy.
                if whole == 0 {
                    whole = words[w..].iter().take_while(|&&m| m == u64::MAX).count();
                    out.extend_from_slice(chunks[w..w + whole].as_flattened());
                }
                whole -= 1;
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
        assert_eq!(src.len(), self.len, "one bit per row");
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
        BooleanBuffer::new(Buffer::from_vec(as_bitmap(out)), 0, self.count)
    }

    /// The gap marks of the kept rows; `None` when no kept row is a gap
    /// (as Arrow's `filter` gives).
    pub(crate) fn nulls(&self, nulls: Option<&NullBuffer>) -> Option<NullBuffer> {
        let nulls = nulls.filter(|n| n.null_count() > 0)?;
        let kept = NullBuffer::new(self.bits(nulls.inner()));
        (kept.null_count() > 0).then_some(kept)
    }

    /// The kept rows of any Arrow array, in order, by Arrow's `filter`
    /// kernel. The kernel gathers by a list of the kept rows (of their
    /// stretches, when most rows are kept), made here the first time it is
    /// needed and shared by every column copied this way.
    pub(crate) fn by_list(&self, a: &dyn Array) -> ArrayRef {
        assert_eq!(a.len(), self.len, "one value per row");
        let listed = self.listed.get_or_init(|| {
            let mask =
                BooleanBuffer::new(Buffer::from_vec(as_bitmap(self.words.clone())), 0, self.len);
            FilterBuilder::new(&BooleanArray::new(mask, None))
                .optimize()
                .build()
        });
        listed.filter(a).expect("the mask has the array's length")
    }

    /// The kept rows of a `Utf8` array, in order. A gap's bytes (there are
    /// usually none) are copied like any row's.
    ///
    /// Scattered rows go by Arrow's kernel, a row at a time. Long stretches
    /// ([`TEXT_STRETCH_ROWS`] rows or more, on average) go a stretch at a
    /// time: its offsets moved in one loop, its bytes in one copy.
    pub(crate) fn text(&self, a: &StringArray) -> StringArray {
        assert_eq!(a.len(), self.len, "one value per row");
        if !self.in_long_stretches() {
            return self.by_list(a).as_string::<i32>().clone();
        }
        let offsets = a.value_offsets();
        let bytes = self
            .stretches()
            .map(|(first, rows)| (offsets[first + rows] - offsets[first]) as usize);
        let mut out = StringBuilder::with_capacity(self.count, bytes.sum());
        for (first, rows) in self.stretches() {
            out.append_array(&a.slice(first, rows))
                .expect("no more bytes than the source holds");
        }
        out.finish()
    }

    /// The kept rows of a dictionary array, in order: its keys at the kept
    /// rows, over the same values. When no row is kept the values go too,
    /// as Arrow's `filter` gives.
    pub(crate) fn dictionary(&self, a: &DictionaryArray<Int32Type>) -> DictionaryArray<Int32Type> {
        assert_eq!(a.len(), self.len, "one key per row");
        if self.count == 0 {
            return new_empty_array(a.data_type())
                .as_dictionary::<Int32Type>()
                .clone();
        }
        let keys = a.keys();
        let kept = Int32Array::new(self.vec(keys.values()).into(), self.nulls(keys.nulls()));
        DictionaryArray::new(kept, a.values().clone())
    }
}

/// From one true or false per row.
#[cfg(test)]
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

/// Text is copied stretch by stretch when a stretch of kept rows is this
/// many rows or more, on average (see [`RowFilter::text`]). Timed on
/// stretches of 1 to 1,000 rows of 6- to 120-byte strings, on an x86
/// server: stretch by stretch is the faster from about 16 rows a stretch
/// when half the rows are kept, and from 32 to 64 when nearly all are
/// (Arrow's kernel then copies by stretches of its own, and is slower
/// only on long ones).
const TEXT_STRETCH_ROWS: usize = 32;

/// A word with this many kept rows or fewer is walked bit by bit. Timed
/// from 0 to 64 on wide tables, at mixes from 1% to 93% of rows kept. On
/// an M1, 0 (never) and 64 (always) are up to two times slower, where few
/// rows are kept and where most are, and from 4 to 40 the differences are
/// within what two runs differ by. On an x86 server, 20 and 28 are 16 to
/// 28% faster than 12 where a fifth to a quarter of the rows are kept,
/// and 36 is slower than 28 where 56% are.
const SPARSE: u32 = 24;

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

/// The words of a mask as the bytes Arrow reads: row `i` is bit `i % 8` of
/// byte `i / 8`, which is each word written low byte first. Nothing to do
/// on the machines pond-rs is built for (all store a word low byte first).
fn as_bitmap(mut words: Vec<u64>) -> Vec<u64> {
    if cfg!(target_endian = "big") {
        for w in &mut words {
            *w = w.to_le();
        }
    }
    words
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

    /// Text of many lengths: empty, short, long, characters of two to four
    /// bytes.
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
    fn text_keeps_the_rows_of_the_mask() {
        let mut rng = Rng(0xdead_beef_cafe_f00d);
        let (mut by_stretch, mut by_list) = (0, 0);
        each_mask(|n, m, keep| {
            let mask = BooleanArray::from(m.to_vec());
            if keep.in_long_stretches() {
                by_stretch += 1;
            } else {
                by_list += 1;
            }
            // With gaps and without: a source with none marks none.
            for gaps in [true, false] {
                let mut values = texts(n + 5, &mut rng);
                if !gaps {
                    values
                        .iter_mut()
                        .for_each(|v| *v = v.take().or(Some("-".into())));
                }
                let whole: StringArray = values.iter().map(|v| v.as_deref()).collect();
                // Whole and sliced (offsets that do not start at 0).
                for skip in [0, 5] {
                    let a = whole.slice(skip, n);
                    let got = keep.text(&a);
                    let read: Vec<Option<String>> =
                        got.iter().map(|v| v.map(str::to_string)).collect();
                    assert_eq!(read, kept(&values[skip..skip + n], m), "n {n}, skip {skip}");
                    // The same rows as Arrow's kernel gives, with gap marks
                    // only when a kept row is a gap (every row kept, the
                    // kernel hands back the source as it is).
                    let arrow = filter(&a, &mask).unwrap();
                    assert_eq!(&got, arrow.as_string::<i32>(), "n {n}, skip {skip}");
                    if keep.count() < n {
                        assert_eq!(got.nulls().is_some(), got.null_count() > 0, "n {n}");
                    }
                }
            }
        });
        // Both ways of copying were taken.
        assert!(by_stretch > 50 && by_list > 50, "{by_stretch} {by_list}");
    }

    #[test]
    fn stretches_run_on_across_words() {
        each_mask(|n, m, keep| {
            // A stretch starts at a kept row with a dropped row, or none,
            // before it, and runs to the next dropped row.
            let mut want: Vec<(usize, usize)> = Vec::new();
            for i in (0..n).filter(|&i| m[i]) {
                match want.last_mut() {
                    Some((first, rows)) if *first + *rows == i => *rows += 1,
                    _ => want.push((i, 1)),
                }
            }
            assert_eq!(keep.stretches().collect::<Vec<_>>(), want, "n {n}");
            assert_eq!(keep.stretch_count(), want.len(), "n {n}");
            let long = keep.count() >= TEXT_STRETCH_ROWS * want.len();
            assert_eq!(keep.in_long_stretches(), long, "n {n}");
        });
        // One stretch over three words, and what the rule makes of it.
        let keep: RowFilter = (0..200).map(|i| (10..150).contains(&i)).collect();
        assert_eq!(keep.stretches().collect::<Vec<_>>(), [(10, 140)]);
        assert!(keep.in_long_stretches());
        let every_other: RowFilter = (0..200).map(|i| i % 2 == 0).collect();
        assert_eq!(every_other.stretch_count(), 100);
        assert!(!every_other.in_long_stretches());
    }

    #[test]
    fn by_list_gives_what_the_copy_from_the_words_gives() {
        let mut rng = Rng(0x0f1e_2d3c_4b5a_6978);
        each_mask(|n, m, keep| {
            let numbers: Vec<f64> = (0..n).map(|_| (rng.next() % 1000) as f64 / 8.0).collect();
            let listed = keep.by_list(&arrow_array::Float64Array::from(numbers.clone()));
            let listed = listed.as_primitive::<arrow_array::types::Float64Type>();
            assert_eq!(&listed.values()[..], &keep.vec(&numbers)[..], "n {n}");
            assert_eq!(&listed.values()[..], &kept(&numbers, m)[..], "n {n}");
            // A dictionary: the same keys either way, over the same values.
            let values = texts(n, &mut rng);
            let d: DictionaryArray<Int32Type> = values.iter().map(|v| v.as_deref()).collect();
            let listed = keep.by_list(&d);
            let listed = listed.as_dictionary::<Int32Type>();
            let direct = keep.dictionary(&d);
            assert_eq!(listed.keys(), direct.keys(), "n {n}");
            assert_eq!(
                listed.values().as_string::<i32>(),
                direct.values().as_string::<i32>(),
                "n {n}"
            );
        });
    }

    #[test]
    fn scattered_is_one_word_in_four_with_kept_and_dropped_rows() {
        let of = |n: usize, f: &dyn Fn(usize) -> bool| -> bool {
            (0..n).map(f).collect::<RowFilter>().is_scattered()
        };
        assert!(!of(0, &|_| true), "no rows");
        assert!(!of(640, &|_| true), "every row");
        assert!(!of(640, &|_| false), "no row");
        assert!(of(640, &|i| i % 2 == 0), "every other row");
        assert!(of(640, &|i| i % 64 == 7), "one row in each word");
        // Long stretches: only the words a stretch starts or ends in hold both.
        assert!(!of(64_000, &|i| (i / 1000) % 2 == 0), "stretches of 1,000");
        // One word in four, exactly.
        assert!(of(256, &|i| i != 0), "one of four words");
        assert!(!of(320, &|i| i != 0), "one of five words");
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
}
