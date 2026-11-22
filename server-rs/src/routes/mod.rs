//! Feature routes. Each feature owns one file here and exports `handle`; to add an endpoint group, add the
//! module and list its `handle` in `all()`. Handlers return `None` when the request is not theirs.
//! The X-Burnrate header, Origin and Host checks already ran before any handler is called.
use crate::State;
use tiny_http::{Method, Request, Response};

pub type Resp = Response<std::io::Cursor<Vec<u8>>>;
pub type Handler = fn(&State, &mut Request, &Method, &str) -> Option<Resp>;

mod accounts_api;
mod alerts_api;
mod budgets_api;
mod defs_api;
mod diagnostics_api;
mod history_api;
mod ingest_api;
mod secrets_api;
mod settings_api;
mod status_api;
pub use accounts_api::provider_list;
pub use status_api::{is_stream_request, serve_stream};
mod themes_api;

pub fn all() -> &'static [Handler] {
    &[
        accounts_api::handle,
        settings_api::handle,
        themes_api::handle,
        defs_api::handle,
        budgets_api::handle,
        history_api::handle,
        alerts_api::handle,
        status_api::handle,
        diagnostics_api::handle,
        secrets_api::handle,
        ingest_api::handle,
    ]
}
