use std::net::TcpListener;

use athria_application::AthriaApplication;
use athria_mcp::{McpService, serve_conformance_http};
use athria_store::SqliteStore;

fn main() -> std::io::Result<()> {
    let address = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:37374".to_owned());
    let listener = TcpListener::bind(&address)?;
    eprintln!("Athria MCP conformance server listening on http://{address}/mcp");
    let application =
        AthriaApplication::new(SqliteStore::open_in_memory().map_err(std::io::Error::other)?);
    serve_conformance_http(listener, McpService::new(application))
}
