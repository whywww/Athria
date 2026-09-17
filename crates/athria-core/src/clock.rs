//! Injectable wall clock.
//!
//! The TypeScript store and application take `now: () => Date` in their
//! constructors. The Rust runtime takes a [`Clock`] so fixtures can pin time
//! and tests stay deterministic.

use std::fmt;

use jiff::Timestamp;

use crate::tz::iso_from_millis;

/// Source of the current instant as an ISO-8601 UTC string.
pub trait Clock: fmt::Debug {
    /// `new Date().toISOString()` equivalent.
    fn now_iso(&self) -> String;
}

/// The host clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_iso(&self) -> String {
        iso_from_millis(Timestamp::now().as_millisecond())
    }
}

/// A clock pinned to one instant, for fixtures and tests.
#[derive(Debug, Clone)]
pub struct FixedClock {
    instant: String,
}

impl FixedClock {
    pub fn new(instant: impl Into<String>) -> Self {
        Self { instant: instant.into() }
    }
}

impl Clock for FixedClock {
    fn now_iso(&self) -> String {
        self.instant.clone()
    }
}
