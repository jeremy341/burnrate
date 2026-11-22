//! `burnrate` — a tiny, GUI-free CLI for the Burnrate loopback daemon.
//!
//! Depends only on `ureq` + `serde_json` (see CONTRACTS.md section 13).

pub mod args;
pub mod format;
pub mod model;
pub mod net;
pub mod render;
