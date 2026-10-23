//! `study_options!`: declares a study's options struct.

/// Declares a study's options: a struct with one setter per field, a
/// setter per column it reads and `output` or `prefix` for the names it
/// writes.
///
/// `Name, output = "x" { field: T = default, … }` gives `Default` (pond-ts's
/// defaults) and reads `column` (default `close`, got with `source()`).
/// `Name(period: usize), …` makes that field required: no `Default`, a
/// `new(period)` instead. `reads [high, low, close]` lists the columns the
/// study reads instead of `column`; each defaults to its own name.
/// `Name(benchmark), …` reads `column` and a second column, `benchmark`,
/// that has no default: `new(benchmark)`.
macro_rules! study_options {
    // A two-column study: reads `column` and a required `benchmark`.
    (
        $(#[$meta:meta])*
        $name:ident(benchmark), $naming:ident = $default_name:literal
        {
            $( $(#[$field_meta:meta])* $field:ident : $ty:ty = $default:expr ),* $(,)?
        }
    ) => {
        study_options! {
            @struct
            $(#[$meta])*
            $name, $naming = $default_name, reads [column, benchmark],
            fields { $( $(#[$field_meta])* $field : $ty ),* }
        }

        impl $name {
            /// The options comparing against the `benchmark` column, every
            /// other setting at pond-ts's default.
            pub fn new(benchmark: &str) -> Self {
                Self {
                    $( $field: $default, )*
                    column: None,
                    benchmark: Some(benchmark.to_string()),
                    $naming: None,
                }
            }

            /// The column the study compares against.
            fn benchmark_name(&self) -> &str {
                self.benchmark.as_deref().unwrap_or_default()
            }
        }
    };
    // Without `reads`: the study reads `column`.
    (
        $(#[$meta:meta])*
        $name:ident $(($($req:ident : $rty:ty),*))?, $naming:ident = $default_name:literal
        $body:tt
    ) => {
        study_options! {
            $(#[$meta])*
            $name $(($($req : $rty),*))?, $naming = $default_name, reads [column]
            $body
        }
    };
    // Every field has a default.
    (
        $(#[$meta:meta])*
        $name:ident, $naming:ident = $default_name:literal, reads [$($src:ident),*]
        {
            $( $(#[$field_meta:meta])* $field:ident : $ty:ty = $default:expr ),* $(,)?
        }
    ) => {
        study_options! {
            @struct
            $(#[$meta])*
            $name, $naming = $default_name, reads [$($src),*],
            fields { $( $(#[$field_meta])* $field : $ty ),* }
        }

        impl Default for $name {
            fn default() -> Self {
                Self {
                    $( $field: $default, )*
                    $( $src: None, )*
                    $naming: None,
                }
            }
        }
    };
    // A required field: `new(value)`, the rest as their defaults.
    (
        $(#[$meta:meta])*
        $name:ident($req:ident : $rty:ty), $naming:ident = $default_name:literal, reads [$($src:ident),*]
        {
            $( $(#[$field_meta:meta])* $field:ident : $ty:ty = $default:expr ),* $(,)?
        }
    ) => {
        study_options! {
            @struct
            $(#[$meta])*
            $name, $naming = $default_name, reads [$($src),*],
            fields { $req : $rty $(, $(#[$field_meta])* $field : $ty )* }
        }

        impl $name {
            #[doc = concat!("The options with `", stringify!($req), "` set and every other setting at pond-ts's default.")]
            pub fn new($req: $rty) -> Self {
                Self {
                    $req,
                    $( $field: $default, )*
                    $( $src: None, )*
                    $naming: None,
                }
            }
        }
    };
    (
        @struct
        $(#[$meta:meta])*
        $name:ident, $naming:ident = $default_name:literal, reads [$($src:ident),*],
        fields { $( $(#[$field_meta:meta])* $field:ident : $ty:ty ),* }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            $( $field: $ty, )*
            $( $src: Option<String>, )*
            $naming: Option<String>,
        }

        impl $name {
            $(
                $(#[$field_meta])*
                pub fn $field(mut self, value: $ty) -> Self {
                    self.$field = value;
                    self
                }
            )*

            $(
                study_options!(@source $src);
            )*

            #[doc = concat!("Name what the study writes with this ", stringify!($naming), " instead of `", $default_name, "`.")]
            pub fn $naming(mut self, name: &str) -> Self {
                self.$naming = Some(name.to_string());
                self
            }

            #[allow(dead_code)]
            fn name(&self) -> &str {
                self.$naming.as_deref().unwrap_or($default_name)
            }
        }
    };
    (@source column) => {
        /// Read this number column instead of `close`.
        pub fn column(mut self, name: &str) -> Self {
            self.column = Some(name.to_string());
            self
        }

        /// The column the study reads.
        #[allow(dead_code)]
        fn source(&self) -> &str {
            self.column.as_deref().unwrap_or(super::DEFAULT_SOURCE)
        }
    };
    (@source benchmark) => {
        /// Compare against this number column instead.
        pub fn benchmark(mut self, name: &str) -> Self {
            self.benchmark = Some(name.to_string());
            self
        }
    };
    (@source volume) => {
        /// Read the volume from this column instead of `volume`.
        pub fn volume(mut self, name: &str) -> Self {
            self.volume = Some(name.to_string());
            self
        }
    };
    (@source $src:ident) => {
        #[doc = concat!("Read the ", stringify!($src), " prices from this column instead of `", stringify!($src), "`.")]
        pub fn $src(mut self, name: &str) -> Self {
            self.$src = Some(name.to_string());
            self
        }
    };
}
