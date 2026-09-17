use std::net::TcpListener;

use athria_application::AthriaApplication;
use athria_mcp::{McpService, serve_http, serve_stdio};
use athria_runtime::{database_path, doctor};
use athria_store::SqliteStore;

fn usage() -> &'static str { "Usage: athria <doctor|mcp|serve> [--database <path>]" }

fn database_argument(arguments: &[String]) -> Result<Option<&str>, String> {
    match arguments.iter().position(|argument| argument == "--database") {
        Some(index) => arguments.get(index + 1).map(String::as_str).map(Some).ok_or_else(|| "--database requires a path".to_string()),
        None => Ok(None),
    }
}

fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}

fn run() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = arguments.first().map(String::as_str).ok_or_else(|| usage().to_string())?;
    let path = database_path(database_argument(&arguments)?);
    match command {
        "doctor" => { println!("{}", serde_json::to_string_pretty(&doctor(&path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?); Ok(()) }
        "mcp" => { let store = SqliteStore::open(path).map_err(|error| error.to_string())?; serve_stdio(McpService::new(AthriaApplication::new(store))).map_err(|error| error.to_string()) }
        "serve" => {
            let token = std::env::var("ATHRIA_MCP_TOKEN").map_err(|_| "ATHRIA_MCP_TOKEN is required for `athria serve`.".to_string())?;
            let address = std::env::var("ATHRIA_ADDRESS").unwrap_or_else(|_| "127.0.0.1:37373".to_string());
            if !(address.starts_with("127.0.0.1:") || address.starts_with("localhost:")) { return Err("athria serve only supports a loopback address.".to_string()); }
            let listener = TcpListener::bind(&address).map_err(|error| error.to_string())?;
            let store = SqliteStore::open(path).map_err(|error| error.to_string())?;
            eprintln!("Athria MCP HTTP listening at http://{address}/mcp");
            serve_http(listener, McpService::new(AthriaApplication::new(store)), &token).map_err(|error| error.to_string())
        }
        _ => Err(usage().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn parses_an_explicit_database() { let arguments = vec!["doctor".into(), "--database".into(), "custom.sqlite3".into()]; assert_eq!(database_argument(&arguments), Ok(Some("custom.sqlite3"))); }
    #[test] fn rejects_a_missing_database_value() { let arguments = vec!["doctor".into(), "--database".into()]; assert!(database_argument(&arguments).is_err()); }
}
