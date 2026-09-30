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
    let database_path = std::env::temp_dir().join(format!(
        "athria-conformance-{}.sqlite3",
        std::process::id()
    ));
    let application = AthriaApplication::new(
        SqliteStore::open(&database_path).map_err(std::io::Error::other)?,
    );
    let database_path = std::fs::canonicalize(database_path)?;
    serve_conformance_http(
        listener,
        McpService::new(application, database_path),
    )
}
