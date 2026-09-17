//! Shared training-data adapters.
//!
//! Parsing is pure, network access is behind [`HttpClient`], and credentials
//! are call-scoped values supplied by the runtime. This crate never reads an
//! OS keyring or persists a secret.

mod hevy;
mod intervals;
mod xunji;

use serde_json::Value;

pub use hevy::{HEVY_PARSER_VERSION, HevyPreview, parse_hevy_csv};
pub use intervals::{SyncDateWindow, fetch_intervals, interval_modality, normalize_intervals_activity, sync_date_window};
pub use xunji::{XUNJI_PARSER_VERSION, XUNJI_SYNC_DAYS, XunjiAuthenticationError, fetch_xunji_training, normalize_xunji_training};

pub use athria_core::{AthriaError, AthriaErrorCode, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
}

/// Runtime-provided HTTP adapter. Platform credentials remain outside it.
pub trait HttpClient {
    fn send(&self, request: &HttpRequest) -> std::result::Result<HttpResponse, String>;
}

pub(crate) fn invalid(message: impl Into<String>) -> AthriaError {
    AthriaError::new(AthriaErrorCode::InvalidData, message.into())
}
