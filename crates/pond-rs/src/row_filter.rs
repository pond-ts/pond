//! The rows a filter keeps, and the copy of each kind of buffer by them.
//!
//! A [`RowFilter`] holds one bit per row, 64 rows to a word. There are two
//! ways to copy by it.
//!
//! **Straight from the words**, with no list of row numbers:
//!
//! - **Fixed-width values** (times, numbers, decimals, dictionary keys) go
//!   word by word, each word by the way that suits its rows. A word with
//!   none is skipped; a run of words with all of their rows is one copy.
//!   When the mask's kept rows come in stretches, taken as a whole, a word
//!   whose own come in a few long ones is copied a stretch at a time; a
//!   mask whose rows are scattered goes by a second copy of the loop,
//!   compiled without that way through it, which is the faster for it
//!   (see [`RowFilter::vec`]). The rest go eight rows at a time: a table
//!   gives, for each byte of the mask, the places of its kept rows, so the
//!   eight are written kept-rows-first and the output moves on by the
//!   number kept, and no branch depends on the mask, which matters when
//!   kept and dropped rows are mixed. A word with few kept rows, and any
//!   word of values wider than eight bytes that is not copied by its
//!   stretches, is walked bit by bit instead.
//! - **Bits** (true/false values, and the marks that say which rows are
//!   gaps) go a word of 64 rows at a time ([`RowFilter::bits`]). A word
//!   whose kept rows lie in one stretch or two is a shifted write per
//!   stretch. For any other word a table gives, for each eight rows of the
//!   mask and the eight bits under them, the kept bits brought together,
//!   so a word costs the same however its kept rows lie.
//!
//! **By Arrow's `filter` kernel** ([`RowFilter::by_list`]), which first
//! makes a list of the kept rows (of their stretches, when more than four
//! rows in five are kept) and then copies by it. Making the list is a pass
//! of its own, but a column copied by it does not read the mask again, so
//! it pays when the columns that would be copied faster by it gain enough
//! between them (`TimeSeries::filter_copy` adds them up). Which columns
//! those are turns on the mask:
//!
//! - **fixed-width values** where the words give the copy above no quick
//!   way through ([`RowFilter::list_pays`], from how long the stretches of
//!   kept rows are);
//! - **bits** where few rows are kept, a row or two at a time
//!   ([`RowFilter::bits_by_list`]): from the words a column of bits costs
//!   by the words it has, by the list by the rows kept;
//! - **a dictionary column** sooner than a number column, and with no
//!   other column to share the list with on some masks
//!   ([`RowFilter::dictionaries_for_list`]): a dictionary put together
//!   here from its kept keys is checked by Arrow again, key by key (the
//!   way in that does not check is `unsafe`), and the kernel's is not.
//!
//! **Text** is never put together here from bytes. Arrow would check such
//! an array again, byte by byte, as text (the unchecked way in is
//! `unsafe`), and that check costs more than a copy of our own saves for
//! anything but short plain-ASCII strings. Text goes by the kernel, by
//! its list, when its kept rows come in short stretches, and stretch by
//! stretch when they come in long ones (see [`RowFilter::text`]): both
//! copy from an array known to be valid, so neither needs the check.
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

use crate::rows::FILTER_LIST_COLUMNS;

/// The rows to keep: one bit per row of the source.
pub(crate) struct RowFilter {
    /// Row `i` is bit `i % 64` of word `i / 64`. Bits past the last row
    /// are zero.
    words: Vec<u64>,
    /// Rows in the source.
    len: usize,
    /// Rows kept.
    count: usize,
    /// How many stretches of kept rows there are: counted the first time
    /// a rule asks ([`RowFilter::stretch_count`]).
    stretches: OnceLock<usize>,
    /// The mask as Arrow's `filter` kernel takes it, with the kernel's
    /// list of the kept rows: made the first time [`RowFilter::by_list`]
    /// is called, and shared by every column copied that way.
    listed: OnceLock<FilterPredicate>,
}

/// A lookup table held at the start of a 64-byte cache line.
///
/// The tables' rows are 8 bytes, so from the start of a line no row lies
/// across two lines, and so none across two memory pages. The same goes
/// for a read of two or four of [`BIT`]'s values at once. ([`PACKED`] is
/// read a byte at a time, which lies across nothing.) Left alone, a
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
            stretches: OnceLock::new(),
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

    /// True when a column of values `width` bytes wide is copied faster by
    /// Arrow's list of the kept rows ([`RowFilter::by_list`]) than straight
    /// from the words ([`RowFilter::vec`]), the list being there to share.
    /// It turns on what the list is a list of, and on how many rows the
    /// kept rows come to a stretch, on average.
    ///
    /// With more than four rows in five kept, Arrow lists the stretches,
    /// and a column is one copy per stretch. From the words, values of up
    /// to eight bytes go eight rows a step by the table, which is the
    /// faster while a stretch is under [`LIST_STRETCH_ROWS`] rows. A wider
    /// value has no table to go by, and the list is level or the faster
    /// throughout once enough columns share it (the numbers are with
    /// `FILTER_LIST_COLUMNS` in `rows.rs`).
    ///
    /// With fewer kept, Arrow lists the rows, and a column is one move per
    /// kept row. From the words a stretch is one copy or two, which is the
    /// faster from [`DIRECT_STRETCH_ROWS`] rows a stretch on (from
    /// [`DIRECT_STRETCH_ROWS_WIDE`] for a wider value, which costs more to
    /// move a row at a time).
    pub(crate) fn list_pays(&self, width: usize) -> bool {
        let wide = width > 8;
        if self.keeps_most() {
            wide || self.stretches_of(LIST_STRETCH_ROWS)
        } else if wide {
            !self.stretches_of(DIRECT_STRETCH_ROWS_WIDE)
        } else {
            !self.stretches_of(DIRECT_STRETCH_ROWS)
        }
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
    /// dropped row, or none, before them. Counted once, in a pass over the
    /// words.
    fn stretch_count(&self) -> usize {
        *self.stretches.get_or_init(|| {
            let mut before = 0u64; // the last row of the word before
            let starts = self.words.iter().map(|&m| {
                let starts = m & !((m << 1) | before);
                before = m >> 63;
                starts.count_ones() as usize
            });
            starts.sum()
        })
    }

    /// True when the kept rows come `rows` or more to a stretch, on
    /// average, give or take one stretch. A mask that keeps `rows` rows,
    /// drops some, and so on has stretches of `rows` wherever its series
    /// happens to end; counted exactly, a last stretch cut short would put
    /// its average just under `rows`, and the same pattern on the other
    /// side of every bar from one length of series to the next. A mask
    /// that keeps no row has stretches of any length.
    fn stretches_of(&self, rows: usize) -> bool {
        self.stretches_of_ratio(rows, 1)
    }

    /// [`RowFilter::stretches_of`] for a bar between two whole numbers of
    /// rows: `rows` over `per` to a stretch (3 over 2 is a row and a half).
    fn stretches_of_ratio(&self, rows: usize, per: usize) -> bool {
        // Counted in 64 bits whatever the machine's own count is: a build
        // for the browser counts in 32, which these products could pass
        // on a very long series.
        let (rows, per) = (rows as u64, per as u64);
        per * self.count as u64 + rows > rows * self.stretch_count() as u64
    }

    /// True when bits (true/false values, and the marks for gaps) are
    /// copied faster by Arrow's list of the kept rows
    /// ([`RowFilter::by_list`]) than from the words ([`RowFilter::bits`]),
    /// the list being there to share: when few rows are kept (under
    /// [`BITS_LIST_ROWS`] in 64) and they come a row or two at a time
    /// (under [`BITS_LIST_STRETCH_ROWS`] to a stretch, on average). From
    /// the words a column costs by the words it has, by the list by the
    /// rows kept.
    pub(crate) fn bits_by_list(&self) -> bool {
        // In 64 bits, as in `stretches_of_ratio`: counted in a browser
        // build's 32, `count * 64` would not fit from 67 million kept rows.
        (self.count as u64) * 64 < (self.len as u64) * (BITS_LIST_ROWS as u64)
            && !self.stretches_of(BITS_LIST_STRETCH_ROWS)
    }

    /// How many dictionary columns it takes before Arrow's kernel, its
    /// list of the kept rows made for them alone, copies them faster than
    /// they go straight from the words. `None` where a dictionary's keys go
    /// from the words even with the list there to share
    /// ([`RowFilter::list_pays`] says which, as for any value of four
    /// bytes).
    ///
    /// With four rows in five kept or fewer the kernel lists the rows: one
    /// column is enough while the kept rows come under
    /// [`DICTIONARY_LIST_UNDER`] to a stretch, on average, and two from
    /// there on. With more kept the kernel lists the stretches, and it is
    /// the longer ones that gain: one column from [`DICTIONARY_LIST_FROM`]
    /// rows to a stretch, two from [`DICTIONARY_PAIR_FROM`], and under
    /// that as many as it takes of number columns (`FILTER_LIST_COLUMNS`
    /// in `rows.rs`).
    pub(crate) fn dictionaries_for_list(&self) -> Option<usize> {
        if !self.list_pays(size_of::<i32>()) {
            return None;
        }
        let columns = if self.keeps_most() {
            if self.stretches_of(DICTIONARY_LIST_FROM) {
                1
            } else if self.stretches_of(DICTIONARY_PAIR_FROM) {
                2
            } else {
                FILTER_LIST_COLUMNS
            }
        } else if !self.stretches_of(DICTIONARY_LIST_UNDER) {
            1
        } else {
            2
        };
        Some(columns)
    }

    /// True when the kept rows come mostly one at a time: under
    /// [`SINGLE_STRETCH`] rows to a stretch, on average. A number column
    /// then counts for the most toward a shared list of the kept rows
    /// (`LIST_WEIGHT_SINGLE` in `rows.rs`).
    pub(crate) fn mostly_single(&self) -> bool {
        !self.stretches_of_ratio(SINGLE_STRETCH.0, SINGLE_STRETCH.1)
    }

    /// True when the kept rows are scattered: under [`SCATTERED_STRETCH`]
    /// rows to a stretch, on average. A number column gains more by the
    /// list of kept rows on such a mask, so each counts for more toward
    /// making one (`LIST_WEIGHT_SCATTERED` in `rows.rs`).
    pub(crate) fn scattered(&self) -> bool {
        !self.stretches_of_ratio(SCATTERED_STRETCH.0, SCATTERED_STRETCH.1)
    }

    /// True when text goes by Arrow's kernel and its list of the kept rows
    /// ([`RowFilter::text`]): when the kept rows come under
    /// [`TEXT_STRETCH_ROWS`] to a stretch, on average.
    pub(crate) fn text_by_list(&self) -> bool {
        !self.stretches_of(TEXT_STRETCH_ROWS)
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
    ///
    /// By one of two loops. When the kept rows come in stretches, on
    /// average over the whole mask ([`RowFilter::asks_words`]), each word
    /// is asked whether to copy it a stretch at a time
    /// ([`goes_by_stretch`]). When they do not, no word is asked: the loop
    /// is compiled without that way through it.
    pub(crate) fn vec<T: Copy>(&self, v: &[T]) -> Vec<T> {
        assert_eq!(v.len(), self.len, "one value per row");
        if self.asks_words(size_of::<T>() > 8) {
            self.copy::<T, true>(v)
        } else {
            self.copy::<T, false>(v)
        }
    }

    /// True when the kept rows come in stretches long enough, on average,
    /// for [`RowFilter::vec`] to ask each word about its own:
    /// [`STRETCH_LOOP_ROWS`] rows for values of up to eight bytes,
    /// [`WIDE_STRETCH_ROWS`] for `wide` ones.
    fn asks_words(&self, wide: bool) -> bool {
        self.stretches_of(if wide {
            WIDE_STRETCH_ROWS as usize
        } else {
            STRETCH_LOOP_ROWS
        })
    }

    /// [`RowFilter::vec`], word by word. `BY_STRETCH` says whether a word
    /// may be copied a stretch at a time; without it the compiler leaves
    /// that way out of the loop.
    #[inline(never)]
    fn copy<T: Copy, const BY_STRETCH: bool>(&self, v: &[T]) -> Vec<T> {
        // Room for one whole group of eight past the last kept value: a
        // group is appended whole, then the length cut back to its kept
        // rows, so nothing is zeroed first and nothing ever grows.
        let mut out: Vec<T> = Vec::with_capacity(self.count + 8);
        // A value wider than eight bytes never goes by the table (see
        // `SPARSE`).
        let wide = size_of::<T>() > 8;
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
                    #[cfg(test)]
                    WHOLE_RUNS.set(WHOLE_RUNS.get() + 1);
                    whole = words[w..].iter().take_while(|&&m| m == u64::MAX).count();
                    out.extend_from_slice(chunks[w..w + whole].as_flattened());
                }
                whole -= 1;
                continue;
            }
            let kept = m.count_ones();
            if BY_STRETCH && goes_by_stretch(m, kept, wide) {
                #[cfg(test)]
                count_word(0);
                for (first, rows) in stretches(m) {
                    out.extend_from_slice(&c[first..first + rows]);
                }
                continue;
            }
            if wide || kept <= SPARSE {
                #[cfg(test)]
                count_word(1);
                let mut m = m;
                while m != 0 {
                    out.push(c[(m.trailing_zeros() & 63) as usize]);
                    m &= m - 1;
                }
                continue;
            }
            #[cfg(test)]
            count_word(2);
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

    /// The bits of `src` at the kept rows, in order, a word of 64 rows at
    /// a step. A word whose kept rows lie in one stretch or two is a
    /// shifted write per stretch. Any other word has its kept bits brought
    /// together by [`packed`] and written in one go, at a cost that does
    /// not turn on how the kept rows lie: so rows kept one at a time cost
    /// no more than rows kept in stretches.
    ///
    /// The table could take every word. Timed against that on an x86
    /// server, on 16 true/false columns beside one number column: the
    /// table for every word (two builds of it) over this code, at
    /// 1,000,000 and at 100,000 rows. With rows kept at random, or in
    /// stretches of 1.5 to 8 rows with as many dropped between, the two
    /// were level (0.93 to 1.04). With 8 rows kept and 152 dropped, on
    /// average, the table for every word took 1.10 and 1.12 of the time,
    /// and 1.17 and 1.22; with 20 kept and 20 dropped, 0.91 and 0.98, and
    /// 1.13 and 1.15; with 60 kept and 1.5 dropped, 0.94 and 0.95, and
    /// 1.02 and 1.08; with 200 and 200, 1.02 to 1.05.
    pub(crate) fn bits(&self, src: &BooleanBuffer) -> BooleanBuffer {
        assert_eq!(src.len(), self.len, "one bit per row");
        // One spare word: bits are or-ed into the word they start in and
        // the next, whether or not they reach that far.
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
            // Where the stretches after the first two start: none, in the
            // words a long stretch starts or ends in.
            let starts = m & !(m << 1);
            let third = starts & starts.wrapping_sub(1);
            let third = third & third.wrapping_sub(1);
            if third == 0 {
                #[cfg(test)]
                count_bit_word(0);
                for (first, len) in stretches(m) {
                    // Under 64 rows: a full word took the branch above.
                    put_bits(&mut out, k, (s >> first) & ((1u64 << len) - 1));
                    k += len;
                }
                continue;
            }
            #[cfg(test)]
            count_bit_word(1);
            put_bits(&mut out, k, packed(s, m));
            k += m.count_ones() as usize;
        }
        out.truncate(self.count.div_ceil(64));
        BooleanBuffer::new(Buffer::from_vec(as_bitmap(out)), 0, self.count)
    }

    /// The gap marks of the kept rows; `None` when no kept row is a gap
    /// (as Arrow's `filter` gives).
    ///
    /// They go from the words ([`RowFilter::bits`]), or by Arrow's kernel
    /// when `listed` says its list of the kept rows is there to share and
    /// [`RowFilter::bits_by_list`] that this mask is the faster by it.
    pub(crate) fn nulls(&self, nulls: Option<&NullBuffer>, listed: bool) -> Option<NullBuffer> {
        let nulls = nulls.filter(|n| n.null_count() > 0)?;
        let kept = if listed && self.bits_by_list() {
            let marks = BooleanArray::new(nulls.inner().clone(), None);
            self.by_list(&marks).as_boolean().values().clone()
        } else {
            self.bits(nulls.inner())
        };
        let kept = NullBuffer::new(kept);
        (kept.null_count() > 0).then_some(kept)
    }

    /// The kept rows of any Arrow array, in order, by Arrow's `filter`
    /// kernel. The kernel gathers by a list of the kept rows (of their
    /// stretches, when most rows are kept), made here the first time it is
    /// needed and shared by every column copied this way.
    pub(crate) fn by_list(&self, a: &dyn Array) -> ArrayRef {
        assert_eq!(a.len(), self.len, "one value per row");
        let listed = self
            .listed
            .get_or_init(|| FilterBuilder::new(&self.as_array()).optimize().build());
        listed.filter(a).expect("the mask has the array's length")
    }

    /// True once the list of kept rows has been made
    /// ([`RowFilter::by_list`]): how a test sees which way a copy went,
    /// since the rows that come out are the same either way.
    #[cfg(test)]
    pub(crate) fn has_list(&self) -> bool {
        self.listed.get().is_some()
    }

    /// The mask as Arrow's `filter` kernel takes it.
    fn as_array(&self) -> BooleanArray {
        let mask = BooleanBuffer::new(Buffer::from_vec(as_bitmap(self.words.clone())), 0, self.len);
        BooleanArray::new(mask, None)
    }

    /// True when more than four rows in five are kept. Arrow's kernel then
    /// copies by stretches of kept rows, and row by row when fewer are
    /// kept.
    fn keeps_most(&self) -> bool {
        self.count * 5 > self.len * 4
    }

    /// The kept rows of a `Utf8` array, in order. A gap's bytes (there are
    /// usually none) are copied like any row's.
    ///
    /// Long stretches ([`TEXT_STRETCH_ROWS`] rows or more, on average) go a
    /// stretch at a time: its offsets moved in one loop, its bytes in one
    /// copy. Shorter ones go by Arrow's kernel, by its list of the kept
    /// rows, which every text column of a series then shares.
    pub(crate) fn text(&self, a: &StringArray) -> StringArray {
        assert_eq!(a.len(), self.len, "one value per row");
        if self.text_by_list() {
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
    /// as Arrow's `filter` gives. The keys and their gap marks come
    /// straight from the words. (A dictionary whose keys go faster by the
    /// list is not copied here: `StringColumn::filter` hands it whole to
    /// [`RowFilter::by_list`]. That covers every mask whose bits go by
    /// the list, so the marks never do here; a test holds the two bars to
    /// that.)
    pub(crate) fn dictionary(&self, a: &DictionaryArray<Int32Type>) -> DictionaryArray<Int32Type> {
        assert_eq!(a.len(), self.len, "one key per row");
        if self.count == 0 {
            return new_empty_array(a.data_type())
                .as_dictionary::<Int32Type>()
                .clone();
        }
        let keys = a.keys();
        let kept = Int32Array::new(
            self.vec(keys.values()).into(),
            self.nulls(keys.nulls(), false),
        );
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

/// Where the bars below were set: on an x86 server (Intel Xeon, 2.1 GHz),
/// on tables of 100,000 and of 1,000,000 rows, each time against the same
/// table copied the other way. Unless a bar says otherwise, the masks kept
/// rows at random (each row by a pseudo-random number) or in stretches of
/// random length. A mask with a repeating pattern (every third row, 12 kept
/// and 1 dropped) is a poor guide: the processor learns a pattern that
/// repeats, so a bar set on one favours whichever copy branches on the
/// mask. One line of such a timing moves by 5 to 10% from run to run; the
/// bars rest on what several lines agree on.
///
/// Text is copied stretch by stretch when a stretch of kept rows is this
/// many rows or more, on average (see [`RowFilter::text`]). First set on
/// stretches of one length, of 6-byte strings: stretch by stretch was the
/// faster from about 16 rows a stretch when half the rows were kept, and
/// from 32 to 64 when nearly all were (Arrow's kernel then copies by
/// stretches of its own). Then checked on stretches of random length: 16
/// or 64 in place of 32 moved nothing by more than two runs differ by;
/// 128 took 25 to 100% longer on stretches of 64 rows.
const TEXT_STRETCH_ROWS: usize = 32;

/// A column of values of up to eight bytes is copied by the loop that asks
/// each word about its stretches when the mask's kept rows come this many
/// to a stretch or more, on average ([`RowFilter::vec`]).
///
/// Having that way through the loop costs time even where no word takes
/// it. Timed against the same code without it, in one program, on tables
/// of 1 to 4 number columns with a quarter of the rows kept at random or
/// fewer: one loop that asked every word was 6% slower on the middle line
/// of nine at each table size (from 4% faster to 13% slower), and 4% with
/// half to three quarters kept. Not asking words with under eight kept
/// rows helped only where 5% were kept. So it is not the question that
/// costs: the loop compiles to something slower with the stretch copy in
/// it, and a mask whose rows are not in stretches goes by a loop without
/// it. With the two loops, rows kept at random read level with no rule at
/// all up to 92% kept (the middle lines 0.98 to 1.01 of it).
///
/// Where the loop that asks starts to pay was then timed directly: this
/// code with the bar at 0 (every mask asks) against the bar out of reach
/// (none does), two copies of each, on tables of 1, 2 and 4 number
/// columns with stretches of random length. The loop that asks, to the
/// one that does not, on the middle line of twelve at 100,000 and at
/// 1,000,000 rows: at 8 rows a stretch 1.02 and 1.04; at 10, 1.01 and
/// 1.03; at 12, 0.99 and 1.00; at 14, 0.97 and 1.00; at 16, 0.97 and
/// 0.98; at 18, 0.93 and 0.97; at 20, 0.93 twice; at 24, 0.88 and 0.93;
/// at 32, 0.85 and 0.89. (Single lines went from 0.68 to 1.25; two copies
/// of one source differed by as much on single lines, and by nothing on
/// the middle one.) So the two cross at 12 to 14 rows, and the bar sits
/// where the gain first shows.
const STRETCH_LOOP_ROWS: usize = 16;

/// In the loop that asks, a word of values of up to eight bytes is copied
/// a stretch at a time when its kept rows come in this many stretches or
/// fewer, of [`WORD_STRETCH_ROWS`] rows or more on average
/// ([`goes_by_stretch`]). Otherwise it goes by the table, eight rows a
/// step, which no pattern of kept rows slows down.
///
/// Timed with the number of stretches at 1 to 5 and the rows at 0, 8 and
/// 16, before the two loops were split. On stretches of 20 to 200 rows, 3
/// stretches of 8 rows took up to 29% less time than the table. With rows
/// dropped at random the two seldom hold together until more than nine
/// rows in ten are kept, so at 82 to 90% kept it was level with the table
/// alone, where the rule of the round before (any word of 6 rows to a
/// stretch, however many stretches) was 5 to 48% slower at 85% kept.
/// Without the rows, 3 stretches or fewer was 30 to 60% slower than the
/// table at 5% kept, where a word's three kept rows are three stretches of
/// one.
const WORD_STRETCHES: u32 = 3;

/// See [`WORD_STRETCHES`].
const WORD_STRETCH_ROWS: u32 = 8;

/// A word of values wider than eight bytes (a decimal's 16) is copied a
/// stretch at a time when its kept rows come this many to a stretch or
/// more, on average, however many stretches that is. There is no table
/// for such a value (see [`SPARSE`]): the other way is a move per kept
/// row, and a stretch of six is already one move, not six. On tables of
/// 16 decimal columns with stretches of 16 to 200 rows this took 13 to
/// 27% less time than a row at a time, and from 4% more to 9% less than
/// the rule for narrower values.
///
/// The same number, as the average over the whole mask, picks the loop
/// that asks ([`RowFilter::vec`]). On tables of 1 to 3 decimal columns,
/// against the same code with no stretch copy: one loop that asked every
/// word was 13 to 14% slower on the middle line of twelve where a tenth of
/// the rows or fewer were kept at random, and 7 to 8% faster at 85 to 93%
/// kept (7 to 14 rows a stretch). With the two loops and this bar, the
/// middle lines at 100,000 and at 1,000,000 rows: a tenth kept or fewer,
/// 0.99 and 1.03 of no stretch copy; 25 to 75% kept, 1.03 and 1.02 (0.97
/// in an earlier run; no word is asked there, so this is what two builds
/// differ by); 85 to 93% kept, 0.96 and 0.92; stretches of random length
/// of 4 to 12 rows, 0.93 and 0.95; of 16 to 32 rows, 0.86 and 0.87.
const WIDE_STRETCH_ROWS: u32 = 6;

/// With more than four rows in five kept, a column of values of up to
/// eight bytes goes by Arrow's list (of stretches) when the kept rows come
/// this many to a stretch or more, on average ([`RowFilter::list_pays`]).
/// On tables of 8 to 32 number columns: with 82 to 85% of the rows kept at
/// random (6 to 7 rows a stretch) the copy from the words was 7 to 25%
/// faster than the list; at 88% (8 rows) the two were level; from 90% (10
/// rows) the list was level to 15% faster, and more so the wider the
/// table and the smaller (100,000 rows against 1,000,000). Stretches of
/// random length of 6, 8, 10, 16 and 20 rows agree.
const LIST_STRETCH_ROWS: usize = 8;

/// With four rows in five kept or fewer, a column of values of up to eight
/// bytes goes by Arrow's list (of rows) unless the kept rows come this
/// many to a stretch or more, on average ([`RowFilter::list_pays`]). On
/// tables of 8 to 32 number columns with stretches of random length: at 8
/// to 16 rows a stretch the list was 5 to 30% faster; at 20 to 24 the two
/// were level when half to three quarters of the rows were kept, and the
/// list 5 to 20% faster when a quarter were; from 32 on the copy from the
/// words was level to 25% faster at each share.
const DIRECT_STRETCH_ROWS: usize = 32;

/// [`DIRECT_STRETCH_ROWS`] for values wider than eight bytes. A row at a
/// time is two moves for such a value, so a stretch pays sooner: on
/// tables of 16 decimal columns the copy from the words was level to 14%
/// faster than the list at 16 rows a stretch and 6 to 20% faster from 24
/// on; at 8 the list was level to 7% faster.
const DIRECT_STRETCH_ROWS_WIDE: usize = 16;

/// Bits (true/false values, and the marks for gaps) go by Arrow's list of
/// the kept rows, when it is there to share, only where fewer than this
/// many rows in 64 are kept ([`RowFilter::bits_by_list`]): under one row
/// in twelve.
///
/// Timed on an x86 server, on 16 true/false columns of random values
/// beside one number column, with rows kept at random: Arrow's kernel for
/// every column, against this code with its bits always from the words.
/// The kernel's time over the other's, at 1,000,000 and at 100,000 rows:
/// with 1% of the rows kept, 0.60 and 0.72; 2%, 0.59 and 0.76; 5% (3.2
/// rows in 64), 0.69 and 0.67; one row in 13 (4.9 in 64), 0.84 and 0.86;
/// 10% (6.4 in 64), 0.98 and 1.12; 25%, 1.64 and 1.81; 50%, 2.61 and 2.83;
/// 85%, 6.88 and 7.91. With gaps in the columns, so twice the bits: 1%,
/// 0.48 and 0.62; 5%, 0.56 and 0.67; 10%, 0.97 and 1.11; 25%, 1.94 and
/// 2.00.
const BITS_LIST_ROWS: usize = 5;

/// And only where the kept rows come under this many to a stretch, on
/// average ([`RowFilter::bits_by_list`]): the share of rows kept does not
/// say it all.
///
/// The same 16 columns with about one row in 20 kept, in stretches of
/// random length; the kernel's time over the copy from the words, at
/// 1,000,000 and at 100,000 rows: stretches of 2 rows, 0.70 and 0.91; of
/// 3, 0.78 and 1.03; of 8, 0.88 and 1.16; of 40, 1.14 and 1.28. (And with
/// one row in 8.5 kept, which the other bar leaves to the words, in
/// stretches of 4: 0.96 and 1.35.)
const BITS_LIST_STRETCH_ROWS: usize = 4;

/// A mask's kept rows come mostly one at a time when there are under this
/// many to a stretch on average: a row and three quarters, as rows over
/// stretches ([`RowFilter::mostly_single`]). With rows kept at random that
/// is up to about four rows in ten (a row and two thirds to a stretch at
/// four in ten, two at a half). The timings are with `LIST_WEIGHT_SINGLE`
/// in `rows.rs`, which is what turns on it.
const SINGLE_STRETCH: (usize, usize) = (7, 4);

/// A mask's kept rows are scattered when they come under this many to a
/// stretch on average: two and a quarter, as rows over stretches
/// ([`RowFilter::scattered`]). With rows kept at random that is half the
/// rows or fewer (two rows to a stretch at a half, two and a half at six
/// in ten). The timings are with `LIST_WEIGHT_SCATTERED` in `rows.rs`,
/// which is what turns on it.
const SCATTERED_STRETCH: (usize, usize) = (9, 4);

/// With four rows in five kept or fewer, a dictionary column goes by
/// Arrow's kernel, whatever else the series holds, while the kept rows
/// come under this many to a stretch, on average; from there on it takes
/// two of them ([`RowFilter::dictionaries_for_list`]).
///
/// Timed on an x86 server at 1,000,000 and at 100,000 rows, in stretches
/// of random length with half the rows kept (three quarters where a pair
/// is in brackets): Arrow's kernel for every column, against the copy
/// from the words with its keys checked (round three of this work, which
/// makes no list for tables this narrow). One dictionary column beside
/// the number column the test reads: stretches of 3 rows, 0.97 and 1.02;
/// of 4, 0.92 and 0.94; of 8, 0.99 and 1.05; of 12, 0.96 and 0.95 (1.02
/// and 1.03); of 16, 0.99 and 0.96; of 24, 1.04 and 1.12 (1.03 and 1.11).
/// So on that machine one such column is level either way up to 16 rows a
/// stretch, and from 24 the kernel is the slower at 100,000 rows. On an M1
/// the kernel was the faster where the stretches are short: 0.85 on the
/// benchmark suite's table (56% kept, about 3 rows to a stretch) with its
/// text held as a dictionary.
///
/// Two dictionary columns: stretches of 4 rows, 0.84 and 0.86; of 12, 0.88
/// and 0.86 (0.85 and 0.95); of 16, 0.86 and 0.89; of 24, 0.97 and 0.99
/// (0.93 and 0.99). Three: 0.80 to 0.88 and 0.80 to 0.89 at each of those.
/// Four: 0.73 and 0.68 at 3 rows, 0.78 and 0.76 at 8, 0.86 and 0.87 at 32.
///
/// The list once made, the number columns beside a dictionary go by it
/// too. This code, which makes the list, against round three, which did
/// not, on one dictionary beside four number columns (the fewest that
/// make it): stretches of 16 rows, 0.91 and 0.95; of 24, 1.05 and 1.03
/// (1.03 and 1.09). Beside five, at 24: 1.04 and 1.06 (1.01 and 1.07).
const DICTIONARY_LIST_UNDER: usize = 12;

/// With more than four rows in five kept, a dictionary column goes by
/// Arrow's kernel, whatever else the series holds, when the kept rows come
/// this many to a stretch or more ([`RowFilter::dictionaries_for_list`]).
///
/// Timed as for [`DICTIONARY_LIST_UNDER`], on one dictionary column beside
/// the number column the test reads; the kernel's time over the copy from
/// the words, at 1,000,000 and at 100,000 rows. Rows kept at random: 82%
/// kept (5.6 rows to a stretch), 1.29 and 1.66; 90% (10 rows), 1.13 and
/// 1.30; 93% (14), 0.96 and 1.11; 95% (20), 0.86 and 0.94; 99%, 0.81 and
/// 0.82. Stretches of random length: of 8 rows, 1.13 and 1.40; of 12, 0.99
/// and 1.16; of 14, 0.97 and 1.06; of 16, 0.90 to 0.94 and 0.93 to 0.96;
/// of 20, 0.88 and 0.95; of 24, 0.85 and 0.89; of 32 to 400, 0.78 to 0.84
/// and 0.86 to 0.91.
const DICTIONARY_LIST_FROM: usize = 16;

/// With more than four rows in five kept, two dictionary columns make the
/// kernel's list between them when the kept rows come this many to a
/// stretch or more ([`RowFilter::dictionaries_for_list`]).
///
/// Timed as for [`DICTIONARY_LIST_FROM`], on two dictionary columns, in
/// stretches of random length: of 8 rows, 0.94 and 1.24; of 10, 0.95 and
/// 1.07; of 12, 0.83 and 1.03; of 14, 0.85 and 0.94; of 16, 0.82 and 0.89;
/// of 20, 0.76 and 0.81. Three: of 8 rows, 0.93 and 1.18; of 10, 0.84 and
/// 1.10; of 12, 0.77 and 0.96; of 14, 0.76 and 0.88; of 20, 0.76 and 0.79.
/// So under 12 rows a stretch the kernel is the faster at 1,000,000 rows
/// and the slower at 100,000, and a dictionary column counts there as a
/// number column does.
///
/// This code against round three on one dictionary beside four number
/// columns (the fewest that make the list with it): stretches of 12 rows,
/// 0.89 and 1.08; of 14, 0.84 and 0.98.
const DICTIONARY_PAIR_FROM: usize = 12;

/// A word with this many kept rows or fewer is walked bit by bit. Timed
/// from 0 to 64 on wide tables, at mixes from 1% to 93% of rows kept. On
/// an M1, 0 (never) and 64 (always) are up to two times slower, where few
/// rows are kept and where most are, and from 4 to 40 the differences are
/// within what two runs differ by. On the x86 server, with rows kept at
/// random in tables of 1 to 4 number columns, 20 to 40 are level; 8 is 10
/// to 20% slower where a quarter of the rows are kept.
///
/// That is for values of up to eight bytes. A wider value (a decimal's 16
/// bytes) is walked whatever the count: the table moves eight values to
/// keep some of them, and for values this wide that is more to move than
/// the kept ones alone. On tables of 8 and 16 decimal columns with 45 to
/// 56% of the rows kept, the table was 11 to 26% slower than the walk
/// (x86 server).
const SPARSE: u32 = 24;

#[cfg(test)]
thread_local! {
    /// The words [`RowFilter::copy`] has copied on this thread a stretch
    /// at a time, bit by bit and by the table. The rows that come out are
    /// the same each way, so this is how a test sees which was taken.
    static WORDS_BY_WAY: std::cell::Cell<[usize; 3]> = const { std::cell::Cell::new([0; 3]) };
}

/// One more word copied this way (see [`WORDS_BY_WAY`]).
#[cfg(test)]
fn count_word(way: usize) {
    let mut words = WORDS_BY_WAY.get();
    words[way] += 1;
    WORDS_BY_WAY.set(words);
}

#[cfg(test)]
thread_local! {
    /// The runs of words with every row kept that [`RowFilter::copy`] has
    /// copied on this thread, each run in one copy.
    static WHOLE_RUNS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
thread_local! {
    /// The words [`RowFilter::bits`] has copied on this thread by their
    /// stretches (a word with no kept row among them) and by the table:
    /// what [`WORDS_BY_WAY`] is for values, for bits. A word with every
    /// row kept is neither.
    static BIT_WORDS_BY_WAY: std::cell::Cell<[usize; 2]> = const { std::cell::Cell::new([0; 2]) };
}

/// One more word of bits copied this way (see [`BIT_WORDS_BY_WAY`]).
#[cfg(test)]
fn count_bit_word(way: usize) {
    let mut words = BIT_WORDS_BY_WAY.get();
    words[way] += 1;
    BIT_WORDS_BY_WAY.set(words);
}

/// The words of bits copied from the mask on this thread since the last
/// call ([`BIT_WORDS_BY_WAY`], both ways together), counted from nothing
/// again. It is how a test sees that gap marks went by the list where the
/// list was made for their values anyway.
#[cfg(test)]
pub(crate) fn take_bit_words() -> usize {
    BIT_WORDS_BY_WAY.replace([0; 2]).iter().sum()
}

/// True for a word of the mask that is copied a stretch at a time: for
/// values of up to eight bytes, one whose kept rows come in at most
/// [`WORD_STRETCHES`] stretches of [`WORD_STRETCH_ROWS`] rows or more, on
/// average; for wider values, in any number of stretches of
/// [`WIDE_STRETCH_ROWS`] rows or more. `kept` is the number of rows the
/// word keeps (one or more).
#[inline(always)]
fn goes_by_stretch(m: u64, kept: u32, wide: bool) -> bool {
    // A stretch starts at a kept row with no kept row just below it.
    let starts = (m & !(m << 1)).count_ones();
    if wide {
        kept >= WIDE_STRETCH_ROWS * starts
    } else {
        starts <= WORD_STRETCHES && kept >= WORD_STRETCH_ROWS * starts
    }
}

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

/// For eight rows of a mask (the first index) and the same eight rows of a
/// column of bits (the second): the column's bits at the rows the mask
/// keeps, brought together at the low end, lowest row first.
static PACKED: Aligned<[[u8; 256]; 256]> = Aligned({
    let mut table = [[0u8; 256]; 256];
    // A mask's row follows from the row of the mask without its lowest
    // kept row: those bits move up one place and the lowest kept row's bit
    // goes below them.
    let mut mask = 1usize;
    while mask < 256 {
        let lowest = mask & mask.wrapping_neg();
        let mut bits = 0usize;
        while bits < 256 {
            let above = table[mask ^ lowest][bits];
            table[mask][bits] = (above << 1) | (bits & lowest != 0) as u8;
            bits += 1;
        }
        mask += 1;
    }
    table
});

/// The bits of `s` at the rows `m` keeps, brought together at the low end,
/// lowest row first; the bits above them are 0. Eight rows at a step by
/// [`PACKED`], each step's bits placed after the kept rows below it.
#[inline(always)]
fn packed(s: u64, m: u64) -> u64 {
    // How many rows each byte of the mask keeps, counted in all eight
    // bytes at once; then, in each byte, how many the bytes below it keep.
    let c = m - ((m >> 1) & 0x5555_5555_5555_5555);
    let c = (c & 0x3333_3333_3333_3333) + ((c >> 2) & 0x3333_3333_3333_3333);
    let c = (c + (c >> 4)) & 0x0f0f_0f0f_0f0f_0f0f;
    let below = c.wrapping_mul(0x0101_0101_0101_0101) << 8;
    let mut out = 0u64;
    let mut byte = 0;
    while byte < 64 {
        let (rows, bits) = ((m >> byte) as u8, (s >> byte) as u8);
        let kept = PACKED.0[usize::from(rows)][usize::from(bits)];
        // At most 56 rows are kept below the last byte: the shift is
        // under 64.
        out |= u64::from(kept) << ((below >> byte) & 0xff);
        byte += 8;
    }
    out
}

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
    /// dense, stretches short and long (some that end with a word, some
    /// that run on into the next; two, three and four to a word, of more
    /// and of fewer rows than a word is copied by its stretches for),
    /// single rows at the edges of a word.
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
            (0..n).map(|i| i % 7 != 0).collect(),
            (0..n).map(|i| i % 13 != 5).collect(),
            (0..n).map(|i| (i / 20) % 3 != 1).collect(),
            (0..n).map(|i| i % 32 < 24).collect(),
            (0..n).map(|i| i % 16 < 9).collect(),
            (0..n).map(|i| i % 22 < 7).collect(),
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
            // Each of the two loops, whichever this mask goes by.
            for (by_stretch, got) in [
                (true, keep.copy::<_, true>(&numbers)),
                (false, keep.copy::<_, false>(&numbers)),
            ] {
                assert_eq!(got, kept(&numbers, m), "f64, n {n}, {by_stretch}");
            }
            for (by_stretch, got) in [
                (true, keep.copy::<_, true>(&wide)),
                (false, keep.copy::<_, false>(&wide)),
            ] {
                assert_eq!(got, kept(&wide, m), "i128, n {n}, {by_stretch}");
            }
        });
    }

    #[test]
    fn words_are_asked_when_the_mask_is_in_stretches() {
        // For values of up to eight bytes, and for wider ones.
        let of = |n: usize, f: &dyn Fn(usize) -> bool| -> (bool, bool) {
            let keep: RowFilter = (0..n).map(f).collect();
            (keep.asks_words(false), keep.asks_words(true))
        };
        // From 16 rows a stretch, and from 6.
        assert_eq!(of(640, &|i| i % 32 < 16), (true, true), "16 kept of 32");
        assert_eq!(of(640, &|i| i % 32 < 15), (false, true), "15 kept of 32");
        assert_eq!(of(1700, &|i| i % 17 != 16), (true, true), "16 kept, 1 not");
        assert_eq!(of(1600, &|i| i % 16 != 15), (false, true), "15 kept, 1 not");
        assert_eq!(of(700, &|i| i % 7 != 6), (false, true), "6 kept, 1 not");
        assert_eq!(of(600, &|i| i % 6 != 5), (false, false), "5 kept, 1 not");
        assert_eq!(of(640, &|i| i % 2 == 0), (false, false), "every other row");
        assert_eq!(of(640, &|_| true), (true, true), "every row");
        assert_eq!(of(640, &|_| false), (true, true), "no row");
    }

    /// The words of a mask copied each way (a stretch at a time, bit by
    /// bit, by the table), for a column of 8-byte values or of 16-byte
    /// ones.
    fn ways(n: usize, f: &dyn Fn(usize) -> bool, wide: bool) -> [usize; 3] {
        let keep: RowFilter = (0..n).map(f).collect();
        WORDS_BY_WAY.set([0; 3]);
        let kept = if wide {
            keep.vec(&vec![0i128; n]).len()
        } else {
            keep.vec(&vec![0f64; n]).len()
        };
        assert_eq!(kept, keep.count());
        WORDS_BY_WAY.get()
    }

    /// The same rows come out whichever way a word is copied, so the way
    /// itself is counted: ten words of 64 rows each time.
    #[test]
    fn each_word_is_copied_the_way_the_rules_say() {
        // Scattered rows: no word is asked about its stretches. Values of
        // up to eight bytes go by the table from 25 kept rows a word and
        // bit by bit under that; wider values go bit by bit whatever the
        // count.
        let every_other = |i: usize| i.is_multiple_of(2);
        assert_eq!(ways(640, &every_other, false), [0, 0, 10]);
        assert_eq!(ways(640, &every_other, true), [0, 10, 0]);
        let with_24 = |i: usize| i % 8 < 3;
        assert_eq!(ways(640, &with_24, false), [0, 10, 0]);
        let with_25 = |i: usize| i % 8 < 3 || i % 64 == 7;
        assert_eq!(ways(640, &with_25, false), [0, 0, 10]);
        assert_eq!(ways(640, &with_25, true), [0, 10, 0]);
        // Long stretches: every word is asked, and goes by its stretches.
        let halves = |i: usize| i % 64 < 32;
        assert_eq!(ways(640, &halves, false), [10, 0, 0]);
        assert_eq!(ways(640, &halves, true), [10, 0, 0]);
        // 14 rows to a stretch: under the bar for values of up to eight
        // bytes, whose words go as scattered ones do, and over it for
        // wider ones. At 16, over both.
        let fourteens = |i: usize| i % 32 < 14;
        assert_eq!(ways(640, &fourteens, false), [0, 0, 10]);
        assert_eq!(ways(640, &fourteens, true), [10, 0, 0]);
        let sixteens = |i: usize| i % 32 < 16;
        assert_eq!(ways(640, &sixteens, false), [10, 0, 0]);
        assert_eq!(ways(640, &sixteens, true), [10, 0, 0]);
        // A mask in stretches on the whole (21 rows to a stretch) with
        // words that are not: five with four stretches of 12, which is one
        // too many for values of up to eight bytes, then five with one
        // stretch of 60.
        let mixed = |i: usize| if i < 320 { i % 16 < 12 } else { i % 64 < 60 };
        assert_eq!(ways(640, &mixed, false), [5, 0, 5]);
        assert_eq!(ways(640, &mixed, true), [10, 0, 0]);
        // The same with stretches of 5 in the first five words (11 rows to
        // a stretch on the whole): too short for wider values, whose words
        // then go bit by bit; values of up to eight bytes are not asked.
        let short = |i: usize| if i < 320 { i % 8 < 5 } else { i % 64 < 60 };
        assert_eq!(ways(640, &short, false), [0, 0, 10]);
        assert_eq!(ways(640, &short, true), [5, 5, 0]);
    }

    /// A run of words with every row kept is one copy, however long. The
    /// rows are the same a word at a time, so the copies are counted.
    #[test]
    fn a_run_of_whole_words_is_one_copy() {
        let runs = |f: &dyn Fn(usize) -> bool| {
            let keep: RowFilter = (0..640).map(f).collect();
            WHOLE_RUNS.set(0);
            assert_eq!(keep.vec(&vec![0f64; 640]).len(), keep.count());
            WHOLE_RUNS.get()
        };
        assert_eq!(runs(&|_| true), 1, "ten whole words");
        assert_eq!(runs(&|i| i != 300), 2, "four, one with a row dropped, five");
        assert_eq!(runs(&|i| i >= 64), 1, "nine, after a word with no row");
        assert_eq!(runs(&|i| i % 128 < 64), 5, "every other word");
        assert_eq!(runs(&|i| i % 2 == 0), 0, "no whole word");
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

    /// As `each_word_is_copied_the_way_the_rules_say`, for bits: the words
    /// that went by their stretches and by the table, of ten each time.
    #[test]
    fn each_word_of_bits_goes_by_its_stretches_or_by_the_table() {
        let ways = |f: &dyn Fn(usize) -> bool| -> [usize; 2] {
            let keep: RowFilter = (0..640).map(f).collect();
            BIT_WORDS_BY_WAY.set([0; 2]);
            let kept = keep.bits(&BooleanBuffer::new_set(640));
            assert_eq!(kept.count_set_bits(), keep.count());
            BIT_WORDS_BY_WAY.get()
        };
        // One stretch to a word, or two, whatever their length: a shifted
        // write for each.
        assert_eq!(ways(&|i| i % 64 == 7), [10, 0], "one row a word");
        assert_eq!(ways(&|i| i % 64 < 40), [10, 0], "one stretch of 40");
        assert_eq!(ways(&|i| i % 32 == 0), [10, 0], "two rows a word");
        assert_eq!(ways(&|i| i % 32 < 20), [10, 0], "two stretches of 20");
        // Three or more: the table.
        let three = |i: usize| matches!(i % 64, 0 | 21 | 42);
        assert_eq!(ways(&three), [0, 10], "three rows a word");
        assert_eq!(ways(&|i| i % 16 < 12), [0, 10], "four stretches of 12");
        assert_eq!(ways(&|i| i % 2 == 0), [0, 10], "every other row");
        // A word with every row kept is one write, and neither; a word
        // with none is asked for its stretches and has none.
        assert_eq!(ways(&|_| true), [0, 0], "every row");
        assert_eq!(ways(&|_| false), [10, 0], "no row");
        // Five words of scattered rows, then one stretch of 180 rows: two
        // of its words keep every row, the third is one stretch, and the
        // last two words keep none.
        let mixed = |i: usize| if i < 320 { i % 8 < 5 } else { i < 500 };
        assert_eq!(ways(&mixed), [3, 5], "scattered words, then a run");
    }

    #[test]
    fn packed_brings_the_kept_bits_together() {
        // Row by row: the bit of each kept row, in order.
        let slow = |s: u64, m: u64| -> u64 {
            let (mut out, mut k) = (0u64, 0);
            for row in 0..64 {
                if (m >> row) & 1 == 1 {
                    out |= ((s >> row) & 1) << k;
                    k += 1;
                }
            }
            out
        };
        // Every eight rows of a mask against every eight bits, in the
        // first byte of a word, a middle one and the last, alone and with
        // every other row kept around them.
        for mask in 0..=255u64 {
            for bits in 0..=255u64 {
                for place in [0, 24, 56] {
                    let (s, m) = (bits << place, mask << place);
                    assert_eq!(packed(s, m), slow(s, m), "{mask:#x} {bits:#x} at {place}");
                    let (s, m) = (s | !(255 << place), m | !(255 << place));
                    assert_eq!(packed(s, m), slow(s, m), "{mask:#x} {bits:#x} at {place}");
                }
            }
        }
        // Words at random: masks sparse, even and dense, none and all.
        let mut rng = Rng(0x0dd0_5eed_cafe_f00d);
        for _ in 0..20_000 {
            let (s, a, b) = (rng.next(), rng.next(), rng.next());
            for m in [a, a & b, a | b, a & b & (a >> 7), 0, u64::MAX] {
                assert_eq!(packed(s, m), slow(s, m), "{s:#x} {m:#x}");
                // Nothing above the kept rows.
                let kept = m.count_ones();
                assert!(kept == 64 || packed(s, m) >> kept == 0);
            }
        }
    }

    #[test]
    fn nulls_are_dropped_when_no_kept_row_is_a_gap() {
        let valid = NullBuffer::from(vec![true, false, true, true]);
        // With the list of kept rows to share, and without.
        for listed in [false, true] {
            let keep: RowFilter = [true, false, true, false].into_iter().collect();
            assert!(keep.nulls(Some(&valid), listed).is_none());
            let keep: RowFilter = [true, true, false, false].into_iter().collect();
            let kept = keep.nulls(Some(&valid), listed).unwrap();
            assert_eq!(kept.iter().collect::<Vec<_>>(), [true, false]);
            assert!(keep.nulls(None, listed).is_none());
            take_bit_words();
            assert!(
                keep.nulls(Some(&NullBuffer::new_valid(4)), listed)
                    .is_none(),
                "a mask with no gap marked"
            );
            assert_eq!(take_bit_words(), 0, "and no bit is copied to find it");
        }
    }

    #[test]
    fn nulls_are_the_same_by_the_list_and_from_the_words() {
        let mut rng = Rng(0x7f4a_7c15_9e37_79b9);
        let (mut by_list, mut from_words) = (0, 0);
        each_mask(|n, m, _| {
            // Three spare rows in front, as in `bits_match_arrow_filter`.
            let source: Vec<bool> = (0..n + 3).map(|_| !rng.next().is_multiple_of(4)).collect();
            let whole = BooleanBuffer::from_iter(source.iter().copied());
            for skip in [0, 3] {
                let valid = NullBuffer::new(whole.slice(skip, n));
                let want = kept(&source[skip..skip + n], m);
                let want = want.contains(&false).then_some(want);
                for listed in [false, true] {
                    // A mask made afresh, so that its list shows which way
                    // this copy went.
                    let keep: RowFilter = m.iter().copied().collect();
                    let got = keep.nulls(Some(&valid), listed);
                    let got = got.map(|g| g.iter().collect::<Vec<_>>());
                    assert_eq!(got, want, "n {n}, skip {skip}, listed {listed}");
                    // By the list only when it is there to share, the mask
                    // is the faster by it, and there is a gap to mark.
                    let takes = listed && keep.bits_by_list() && valid.null_count() > 0;
                    assert_eq!(keep.has_list(), takes, "n {n}, skip {skip}");
                    if listed {
                        by_list += usize::from(takes);
                        from_words += usize::from(!takes);
                    }
                }
            }
        });
        // Each way was taken.
        assert!(by_list > 20 && from_words > 50, "{by_list} {from_words}");
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
            if keep.text_by_list() {
                by_list += 1;
            } else {
                by_stretch += 1;
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
        // Each way of copying was taken.
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
            for rows in [1, 2, 8, 16, 32, 100] {
                // `rows` to a stretch with one stretch let off: more than
                // `rows` each for the others.
                let so = want.is_empty() || keep.count() > rows * (want.len() - 1);
                assert_eq!(keep.stretches_of(rows), so, "n {n}, {rows} rows");
                assert_eq!(
                    keep.stretches_of_ratio(rows * 3, 3),
                    so,
                    "n {n}, {rows} rows"
                );
            }
        });
        // One stretch over three words. It is the one stretch let off, so
        // it is long enough for any bar: one copy is the whole of it.
        let keep: RowFilter = (0..200).map(|i| (10..150).contains(&i)).collect();
        assert_eq!(keep.stretches().collect::<Vec<_>>(), [(10, 140)]);
        assert!(keep.stretches_of(140) && keep.stretches_of(1000));
        let every_other: RowFilter = (0..200).map(|i| i % 2 == 0).collect();
        assert_eq!(every_other.stretch_count(), 100);
        assert!(every_other.stretches_of(1) && !every_other.stretches_of(2));
        // No row kept: no stretch falls short.
        let none: RowFilter = (0..200).map(|_| false).collect();
        assert_eq!(none.stretch_count(), 0);
        assert!(none.stretches_of(1000));
    }

    /// A pattern of kept rows is on the same side of a bar wherever its
    /// series happens to end: a last stretch cut short does not count
    /// against it. (On series long enough that one stretch let off is a
    /// small part of the whole: a hundred stretches or so.)
    #[test]
    fn a_short_last_stretch_does_not_move_a_mask_across_a_bar() {
        for n in 6000..6130 {
            let of = |f: &dyn Fn(usize) -> bool| -> RowFilter { (0..n).map(f).collect() };
            // 16 kept, 16 dropped: 16 rows to a stretch, and not 17.
            let sixteens = of(&|i| i % 32 < 16);
            assert!(sixteens.stretches_of(16), "n {n}");
            assert!(!sixteens.stretches_of(17), "n {n}");
            // 32 kept, 32 dropped: text goes stretch by stretch, numbers
            // straight from the words.
            let long = of(&|i| i % 64 < 32);
            assert!(!long.text_by_list() && !long.list_pays(8), "n {n}");
            // 31 kept, 33 dropped: under both bars.
            let shorter = of(&|i| i % 64 < 31);
            assert!(shorter.text_by_list() && shorter.list_pays(8), "n {n}");
            // Runs of 3 rows: over the bars for bits and for scattered
            // rows, however the last run is cut.
            let threes = of(&|i| i % 6 < 3);
            assert!(!threes.bits_by_list() && !threes.scattered(), "n {n}");
        }
    }

    #[test]
    fn the_bars_for_rows_kept_one_or_two_at_a_time() {
        // The kept rows come mostly one at a time under 1.75 rows to a
        // stretch, and are scattered under 2.25.
        let of = |n: usize, f: &dyn Fn(usize) -> bool| -> [bool; 2] {
            let keep: RowFilter = (0..n).map(f).collect();
            [keep.mostly_single(), keep.scattered()]
        };
        let (all, none) = ([true; 2], [false; 2]);
        assert_eq!(of(640, &|i| i % 2 == 0), all, "every other row");
        assert_eq!(of(640, &|i| i % 64 == 7), all, "one row a word");
        // Stretches of 2 and 1 rows: a row and a half.
        let halves = |i: usize| matches!(i % 5, 0 | 1 | 3);
        assert_eq!(of(640, &halves), all, "3 rows in 2 stretches");
        // Stretches of 2, 2 and 1 rows: a row and two thirds.
        let thirds = |i: usize| matches!(i % 8, 0 | 1 | 3 | 4 | 6);
        assert_eq!(of(640, &thirds), all, "5 rows in 3 stretches");
        // Stretches of 2, 2, 2 and 1 rows: a row and three quarters.
        let quarters = |i: usize| matches!(i % 11, 0 | 1 | 3 | 4 | 6 | 7 | 9);
        let scattered = [false, true];
        assert_eq!(of(660, &quarters), scattered, "7 rows in 4 stretches");
        assert_eq!(of(640, &|i| i % 4 < 2), scattered, "2 rows a stretch");
        // Stretches of 2, 2, 2 and 3 rows: two and a quarter.
        let quarters = |i: usize| !matches!(i % 13, 2 | 5 | 8 | 12);
        assert_eq!(of(650, &quarters), none, "9 rows in 4 stretches");
        assert_eq!(of(640, &|i| i % 6 < 3), none, "3 rows a stretch");
        assert_eq!(of(640, &|i| i % 64 != 0), none, "63 rows a stretch");
        assert_eq!(of(640, &|_| true), none, "every row");
        assert_eq!(of(640, &|_| false), none, "no row");
        assert_eq!(of(0, &|_| true), none, "no rows");
    }

    #[test]
    fn bits_go_by_the_list_where_few_rows_are_kept_a_row_or_two_at_a_time() {
        let of = |n: usize, f: &dyn Fn(usize) -> bool| -> bool {
            let keep: RowFilter = (0..n).map(f).collect();
            keep.bits_by_list()
        };
        // Under 5 rows in 64, one at a time.
        assert!(of(6400, &|i| i % 64 == 7), "one row a word");
        assert!(of(6400, &|i| i % 16 == 0), "4 rows in 64");
        assert!(of(6400, &|i| i % 13 == 0), "just under 5 rows in 64");
        assert!(!of(6400, &|i| i % 12 == 0), "just over 5 rows in 64");
        let five = |i: usize| matches!(i % 64, 0 | 13 | 26 | 39 | 52);
        assert!(!of(6400, &five), "5 rows in 64 exactly");
        assert!(!of(6400, &|i| i % 2 == 0), "every other row");
        // And in stretches of under 4 rows.
        assert!(of(6400, &|i| i % 64 < 3), "3 rows a word, together");
        assert!(of(6400, &|i| i % 128 < 3), "3 rows in 128, together");
        assert!(!of(6400, &|i| i % 128 < 4), "4 rows in 128, together");
        assert!(!of(6400, &|i| i % 1280 < 40), "40 rows in 1280, together");
        assert!(!of(6400, &|i| i < 100), "the first 100 rows");
        assert!(!of(6400, &|_| true), "every row");
        assert!(!of(6400, &|_| false), "no row");
        assert!(!of(0, &|_| true), "no rows");
    }

    #[test]
    fn dictionaries_make_the_list_by_how_many_rows_come_to_a_stretch() {
        // How many dictionary columns make the kernel's list between them.
        let of = |n: usize, f: &dyn Fn(usize) -> bool| -> Option<usize> {
            let keep: RowFilter = (0..n).map(f).collect();
            let columns = keep.dictionaries_for_list();
            // Some number of them do wherever their keys go by the list,
            // and nowhere else.
            assert_eq!(columns.is_some(), keep.list_pays(4));
            // Wherever bits go by the list, so do a dictionary's keys: its
            // gap marks go with them, and need no rule of their own.
            assert!(!keep.bits_by_list() || columns.is_some());
            columns
        };
        let as_numbers = Some(FILTER_LIST_COLUMNS);
        // More than four rows in five: one from 16 rows a stretch, two
        // from 12, as many as of number columns from 8, and under 8 the
        // keys go from the words.
        assert_eq!(of(6400, &|i| i % 64 != 63), Some(1), "63 kept, 1 dropped");
        assert_eq!(of(6800, &|i| i % 17 != 16), Some(1), "16 kept, 1 dropped");
        assert_eq!(of(6400, &|i| i % 16 != 15), Some(2), "15 kept, 1 dropped");
        assert_eq!(of(6500, &|i| i % 13 != 12), Some(2), "12 kept, 1 dropped");
        assert_eq!(
            of(6000, &|i| i % 12 != 11),
            as_numbers,
            "11 kept, 1 dropped"
        );
        assert_eq!(of(6300, &|i| i % 9 != 8), as_numbers, "8 kept, 1 dropped");
        assert_eq!(of(6400, &|i| i % 8 != 7), None, "7 kept, 1 dropped");
        assert_eq!(of(640, &|_| true), Some(1), "every row");
        assert_eq!(of(6400, &|i| i < 6000), Some(1), "most rows in one stretch");
        // Four in five or fewer: one under 12 rows a stretch, two under
        // 32, and from 32 the keys go from the words.
        assert_eq!(of(640, &|i| i % 2 == 0), Some(1), "every other row");
        assert_eq!(of(6000, &|i| i % 20 < 11), Some(1), "11 kept, 9 dropped");
        assert_eq!(of(6000, &|i| i % 20 < 12), Some(2), "12 kept, 8 dropped");
        assert_eq!(of(6000, &|i| i % 20 < 16), Some(2), "16 kept, 4 dropped");
        assert_eq!(of(6000, &|i| i % 40 < 20), Some(2), "20 kept, 20 dropped");
        assert_eq!(of(6400, &|i| i % 64 < 31), Some(2), "31 kept, 33 dropped");
        assert_eq!(of(6400, &|i| i % 64 < 32), None, "32 kept, 32 dropped");
        assert_eq!(of(6400, &|i| i % 64 < 48), None, "48 kept, 16 dropped");
        assert_eq!(of(640, &|i| i < 320), None, "the first half");
        assert_eq!(of(640, &|_| false), None, "no row");
        assert_eq!(of(0, &|_| true), None, "no rows");
    }

    /// The kernel's list is made once, the first time a column goes by it,
    /// and each column after that copies by the list as made. Left as Arrow
    /// first builds it, the kernel would walk the mask again for every
    /// column, and the rows that come out would be the same: so this reads
    /// what Arrow prints of its list, which is the only view of it there is.
    /// (If a later Arrow names these differently, the names here change;
    /// what must hold is that the list is made.)
    #[test]
    fn by_list_makes_its_list_once() {
        let made = |f: &dyn Fn(usize) -> bool| -> String {
            let keep: RowFilter = (0..640).map(f).collect();
            assert!(!keep.has_list());
            keep.by_list(&arrow_array::Float64Array::from(vec![0.0; 640]));
            format!("{:?}", keep.listed.get().expect("the list is made"))
        };
        // Half the rows: a list of rows. Nine in ten: a list of stretches.
        let rows = made(&|i| i % 2 == 0);
        assert!(rows.contains("Indices(["), "{rows:.200}");
        let stretches = made(&|i| i % 10 != 9);
        assert!(stretches.contains("Slices(["), "{stretches:.200}");
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
    fn a_word_goes_by_stretch_in_few_long_stretches() {
        let narrow = |m: u64| goes_by_stretch(m, m.count_ones(), false);
        let wide = |m: u64| goes_by_stretch(m, m.count_ones(), true);
        // Values of up to eight bytes: three stretches at most, of eight
        // rows or more on average.
        assert!(narrow(0xff), "eight rows");
        assert!(!narrow(0x7f), "seven rows");
        assert!(narrow(0xff << 56), "eight rows at the top");
        assert!(narrow(0x00ff_00ff), "eight and eight");
        assert!(!narrow(0x00ff_007f), "eight and seven");
        assert!(narrow(0x01ff_007f), "nine and seven: eight on average");
        assert!(narrow(0x00ff_00ff_00ff), "three stretches of eight");
        assert!(!narrow(0x00ff_00ff_007f), "three stretches, 23 rows");
        assert!(!narrow(0x00ff_00ff_00ff_00ff), "four stretches of eight");
        assert!(!narrow(0x0fff_0fff_0fff_0fff), "four stretches of twelve");
        assert!(narrow(u64::MAX ^ (1 << 20)), "all but one row");
        assert!(narrow(u64::MAX ^ (1 << 20) ^ (1 << 40)), "all but two rows");
        let all_but_three = u64::MAX ^ (1 << 10) ^ (1 << 30) ^ (1 << 50);
        assert!(!narrow(all_but_three), "all but three rows: four stretches");
        assert!(!narrow(1 << 63), "the top row alone");
        assert!(!narrow(0x5555_5555_5555_5555), "every other row");
        // Wider values: six rows or more to a stretch, on average, in any
        // number of stretches.
        assert!(wide(0b11_1111), "six rows");
        assert!(!wide(0b1_1111), "five rows");
        assert!(wide(0b11_1111 << 58), "six rows at the top");
        assert!(wide(0b11_1111_0011_1111), "six and six");
        assert!(!wide(0b11_1111_0001_1111), "six and five");
        assert!(wide(0b10_1111_1111_1111), "twelve and one");
        assert!(wide(0x0fff_0fff_0fff_0fff), "four stretches of twelve");
        assert!(wide(all_but_three), "all but three rows");
        assert!(!wide(1 << 63), "the top row alone");
        assert!(!wide(0x5555_5555_5555_5555), "every other row");
    }

    #[test]
    fn the_list_pays_by_the_share_kept_and_the_rows_to_a_stretch() {
        // For values of 8 bytes, and of 16.
        let of = |n: usize, f: &dyn Fn(usize) -> bool| -> (bool, bool) {
            let keep: RowFilter = (0..n).map(f).collect();
            assert_eq!(keep.list_pays(4), keep.list_pays(8), "up to 8 bytes");
            (keep.list_pays(8), keep.list_pays(16))
        };
        // More than four rows in five kept: values of up to eight bytes
        // from 8 rows a stretch on, wider values always.
        assert_eq!(of(900, &|i| i % 9 != 8), (true, true), "8 kept, 1 dropped");
        assert_eq!(of(800, &|i| i % 8 != 7), (false, true), "7 kept");
        assert_eq!(of(640, &|_| true), (true, true), "every row");
        // Four in five or fewer: unless there are 32 rows to a stretch (16
        // for wider values).
        assert_eq!(of(640, &|i| i % 2 == 0), (true, true), "every other row");
        assert_eq!(of(640, &|i| i % 64 == 7), (true, true), "one row a word");
        assert_eq!(of(640, &|i| i % 32 < 15), (true, true), "15 kept of 32");
        assert_eq!(of(640, &|i| i % 32 < 16), (true, false), "16 kept of 32");
        assert_eq!(of(6400, &|i| i % 64 < 31), (true, false), "31 kept of 64");
        assert_eq!(of(6400, &|i| i % 64 < 32), (false, false), "32 kept of 64");
        assert_eq!(of(640, &|i| i < 320), (false, false), "the first half");
        assert_eq!(of(640, &|_| false), (false, false), "no row");
        assert_eq!(of(0, &|_| true), (false, false), "no rows");
        // Four rows in five, exactly, and one row more: in stretches of 4
        // the list pays until it is a list of stretches.
        assert_eq!(of(1000, &|i| i % 5 < 4), (true, true), "four in five");
        assert_eq!(
            of(1000, &|i| i % 5 < 4 || i == 999),
            (false, true),
            "one more"
        );
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
                let arrow = filter(&a, &mask).unwrap();
                let arrow = arrow.as_dictionary::<Int32Type>();
                let got = keep.dictionary(&a);
                assert_eq!(got.keys(), arrow.keys(), "n {n}, skip {skip}");
                // The same values behind the keys: all of the source's,
                // or none when no row is kept.
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
