//! MCP JSON-RPC adapter for the shared Rust Athria application.

use athria_application::{AthriaApplication, AthriaStore};
pub use athria_core::{AthriaError, AthriaErrorCode, Result};
use athria_core::{
    RpeAutoregulationInput, calculate_heart_rate_zones, calculate_training_metrics,
    estimate_one_rep_max, evaluate_double_progression, evaluate_rpe_autoregulation,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::net::{TcpListener, TcpStream};

const CONTRACT: &str = include_str!("../contract.json");

#[derive(Debug, Deserialize)]
struct Contract {
    server: Value,
    tools: Vec<Value>,
}

pub struct McpService<S: AthriaStore> {
    application: AthriaApplication<S>,
    contract: Contract,
}

impl<S: AthriaStore> McpService<S> {
    pub fn new(application: AthriaApplication<S>) -> Self {
        Self {
            application,
            contract: serde_json::from_str(CONTRACT).expect("embedded MCP contract must be valid"),
        }
    }
    pub fn tools(&self) -> &[Value] {
        &self.contract.tools
    }

    pub fn handle(&self, request: &Value) -> Option<Value> {
        let id = request.get("id").cloned()?;
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let response = match method {
            "initialize" => {
                json!({ "protocolVersion": request.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-11-25"), "capabilities": { "tools": { "listChanged": false } }, "serverInfo": self.contract.server })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": self.contract.tools }),
            "tools/call" => {
                let name = request
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let input = request
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                self.call_result(name, &input)
            }
            _ => {
                return Some(
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } }),
                );
            }
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": response }))
    }

    pub fn call_result(&self, name: &str, input: &Value) -> Value {
        let result = self
            .contract
            .tools
            .iter()
            .find(|tool| tool["name"] == name)
            .ok_or_else(|| ToolError {
                code: "INTERNAL_ERROR".into(),
                message: format!("Unknown tool: {name}"),
            })
            .and_then(|tool| {
                validate_schema(&tool["inputSchema"], input, "input").map_err(ToolError::invalid)
            })
            .and_then(|()| self.call_tool(name, input));
        match result {
            Ok(output) => {
                json!({ "content": [{ "type": "text", "text": serde_json::to_string(&output).expect("JSON output") }] })
            }
            Err(error) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": serde_json::to_string(&json!({ "error": error.message, "code": error.code })).expect("JSON error") }] })
            }
        }
    }

    fn call_tool(&self, name: &str, input: &Value) -> std::result::Result<Value, ToolError> {
        let app = &self.application;
        let application =
            |result: athria_application::Result<Value>| result.map_err(ToolError::application);
        match name {
            "get_athlete_profile" => {
                let mut profile = app.get_profile().map_err(ToolError::application)?;
                profile["profileHash"] = json!(app.profile_hash().map_err(ToolError::application)?);
                Ok(profile)
            }
            "get_training_state" => application(app.get_training_state()),
            "list_training_sessions" => serialize(
                app.list_sessions(days(input, 30)?)
                    .map_err(ToolError::application)?,
            ),
            "list_wellness" => serialize(
                app.list_wellness(days(input, 42)?)
                    .map_err(ToolError::application)?,
            ),
            "get_wellness_day" => application(app.get_wellness_day(required_str(input, "day")?)),
            "list_xunji_training_sessions" => {
                application(app.list_xunji_sessions(days(input, 30)?))
            }
            "get_xunji_sync_status" => serialize(
                app.get_xunji_sync_status()
                    .map_err(ToolError::application)?,
            ),
            "get_training_summary" => {
                application(app.get_training_summary(days(input, 7)?, None, None))
            }
            "get_current_plan" => {
                serialize(app.get_current_plan().map_err(ToolError::application)?)
            }
            "list_session_templates" => {
                serialize(app.list_templates().map_err(ToolError::application)?)
            }
            "get_session_template" => application(app.get_template(required_str(input, "id")?)),
            "get_training_taxonomy" => Ok(app.get_training_taxonomy()),
            "calculate_training_metrics" => serialize(calculate_training_metrics(
                &app.list_sessions(days(input, 90)?)
                    .map_err(ToolError::application)?,
            )),
            "estimate_1rm" => serialize(
                estimate_one_rep_max(
                    required_f64(input, "load")?,
                    required_f64(input, "reps")?,
                    required_str(input, "unit")?,
                )
                .map_err(ToolError::application)?,
            ),
            "calculate_heart_rate_zones" => serialize(
                calculate_heart_rate_zones(required_f64(input, "maxHeartRate")?)
                    .map_err(ToolError::application)?,
            ),
            "evaluate_double_progression" | "evaluate_progression" => {
                application(evaluate_double_progression(&parse(input)?))
            }
            "evaluate_rpe_autoregulation" => {
                application(evaluate_rpe_autoregulation(
                    &parse::<RpeAutoregulationInput>(input)?,
                ))
            }
            "validate_current_plan" => serialize(
                app.validate_current_plan(input)
                    .map_err(ToolError::application)?,
            ),
            "check_training_constraints" => serialize(
                app.validate_current_plan(input)
                    .map_err(ToolError::application)?
                    .results,
            ),
            "get_next_training_day" => application(
                app.get_next_training_day(input.get("onOrAfterDate").and_then(Value::as_str)),
            ),
            "list_planned_sessions" => serialize(
                app.get_calendar(
                    input.get("from").and_then(Value::as_str),
                    input.get("to").and_then(Value::as_str),
                )
                .map_err(ToolError::application)?,
            ),
            "validate_next_training_day_sessions" => {
                application(app.validate_next_training_day_sessions(input))
            }
            "create_session_template" => application(app.create_template(input)),
            "update_session_template" => application(app.update_template(input)),
            "delete_session_template" => application(app.delete_template(
                required_str(input, "id")?,
                input.get("expectedRevision").and_then(Value::as_i64),
            )),
            "save_current_plan" => {
                let saved = app
                    .save_current_plan(input)
                    .map_err(ToolError::application)?;
                Ok(
                    json!({ "revision": saved["plan"]["revision"], "impact": saved["impact"], "blockerSummary": blocker_summary(&saved["validation"]) }),
                )
            }
            "save_next_training_day_sessions" => {
                application(app.save_next_training_day_sessions(input))
            }
            "update_planned_session" => application(
                app.update_planned_session(
                    required_str(input, "id")?,
                    input
                        .get("update")
                        .ok_or_else(|| ToolError::invalid("update is required"))?,
                ),
            ),
            "record_training_session" => application(app.record_training_session(input)),
            "set_training_session_plan_match" => {
                application(app.set_training_session_plan_match(required_str(input, "id")?, input))
            }
            "allow_automatic_plan_match" => application(
                app.clear_training_session_plan_exclusion(required_str(input, "id")?, input),
            ),
            "update_manual_training_session" => {
                application(app.update_manual_training_session(required_str(input, "id")?, input))
            }
            "remove_manual_training_source" => {
                application(app.delete_manual_training_session(required_str(input, "id")?, input))
            }
            "update_wellness" => application(
                app.update_wellness(
                    required_str(input, "day")?,
                    input
                        .get("update")
                        .ok_or_else(|| ToolError::invalid("update is required"))?,
                ),
            ),
            "update_athlete_profile" => application(app.update_profile(input)),
            _ => Err(ToolError {
                code: "INTERNAL_ERROR".into(),
                message: format!("Unknown tool: {name}"),
            }),
        }
    }
}

#[derive(Debug)]
struct ToolError {
    code: String,
    message: String,
}
impl ToolError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_INPUT".into(),
            message: message.into(),
        }
    }
    fn application(error: AthriaError) -> Self {
        Self {
            code: error.code().as_str().into(),
            message: error.message().into(),
        }
    }
}

fn serialize(value: impl serde::Serialize) -> std::result::Result<Value, ToolError> {
    serde_json::to_value(value).map_err(|error| ToolError::invalid(error.to_string()))
}
fn parse<T: for<'de> Deserialize<'de>>(value: &Value) -> std::result::Result<T, ToolError> {
    serde_json::from_value(value.clone()).map_err(|error| ToolError::invalid(error.to_string()))
}
fn required_str<'a>(input: &'a Value, name: &str) -> std::result::Result<&'a str, ToolError> {
    input
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::invalid(format!("{name} is required")))
}
fn required_f64(input: &Value, name: &str) -> std::result::Result<f64, ToolError> {
    input
        .get(name)
        .and_then(Value::as_f64)
        .ok_or_else(|| ToolError::invalid(format!("{name} must be a number")))
}
fn days(input: &Value, default: i64) -> std::result::Result<i64, ToolError> {
    let value = input.get("days").and_then(Value::as_i64).unwrap_or(default);
    if (1..=365).contains(&value) {
        Ok(value)
    } else {
        Err(ToolError::invalid("days must be an integer from 1 to 365"))
    }
}
fn blocker_summary(validation: &Value) -> Value {
    let results = validation["results"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    json!({ "valid": validation["valid"], "blockers": results.iter().filter(|item| item["enforcement"] == "blocker" && (item["status"] == "fail" || item["status"] == "unknown")).count(), "advisories": results.iter().filter(|item| item["enforcement"] == "advisory").count(), "blockingDataGaps": validation["dataGaps"].as_array().map(|items| items.iter().filter(|item| item["blocking"] == true).count()).unwrap_or(0) })
}

fn validate_schema(schema: &Value, value: &Value, path: &str) -> std::result::Result<(), String> {
    if let Some(expected) = schema.get("const") {
        if value != expected {
            return Err(format!("{path} must equal {expected}"));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(value) {
            return Err(format!("{path} is not an allowed value"));
        }
    }
    if let Some(options) = schema.get("anyOf").and_then(Value::as_array) {
        if !options
            .iter()
            .any(|option| validate_schema(option, value, path).is_ok())
        {
            return Err(format!("{path} does not match any allowed shape"));
        }
        return Ok(());
    }
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
        if options
            .iter()
            .filter(|option| validate_schema(option, value, path).is_ok())
            .count()
            != 1
        {
            return Err(format!("{path} must match exactly one allowed shape"));
        }
        return Ok(());
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let matches = match kind {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_f64().is_some_and(|number| number.fract() == 0.0),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => true,
        };
        if !matches {
            return Err(format!("{path} must be {kind}"));
        }
    }
    if let Some(object) = value.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        for name in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(name) {
                return Err(format!("{path}.{name} is required"));
            }
        }
        if let Some(properties) = properties {
            for (name, child) in object {
                if let Some(child_schema) = properties.get(name) {
                    validate_schema(child_schema, child, &format!("{path}.{name}"))?;
                } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                    return Err(format!("{path}.{name} is not allowed"));
                }
            }
        }
        if let Some(names) = schema.get("propertyNames") {
            for name in object.keys() {
                validate_schema(
                    names,
                    &Value::String(name.clone()),
                    &format!("{path} property name"),
                )?;
            }
        }
    }
    if let Some(items) = value.as_array() {
        if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64) {
            if items.len() < minimum as usize {
                return Err(format!("{path} must contain at least {minimum} item(s)"));
            }
        }
        if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64) {
            if items.len() > maximum as usize {
                return Err(format!("{path} must contain at most {maximum} item(s)"));
            }
        }
        if schema.get("uniqueItems") == Some(&Value::Bool(true)) {
            for (index, item) in items.iter().enumerate() {
                if items[..index].contains(item) {
                    return Err(format!("{path} must contain unique items"));
                }
            }
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                validate_schema(item_schema, item, &format!("{path}[{index}]"))?;
            }
        }
    }
    if let Some(text) = value.as_str() {
        if let Some(minimum) = schema.get("minLength").and_then(Value::as_u64) {
            if text.chars().count() < minimum as usize {
                return Err(format!("{path} is too short"));
            }
        }
        if let Some(maximum) = schema.get("maxLength").and_then(Value::as_u64) {
            if text.chars().count() > maximum as usize {
                return Err(format!("{path} is too long"));
            }
        }
        if schema.get("format").and_then(Value::as_str) == Some("date")
            && !athria_core::date::is_iso_date(text)
        {
            return Err(format!("{path} must be an ISO date"));
        }
        if schema.get("format").and_then(Value::as_str) == Some("date-time")
            && !(text.contains('T')
                && (text.ends_with('Z') || text.rfind(['+', '-']).is_some_and(|index| index > 9)))
        {
            return Err(format!("{path} must be an ISO date-time with an offset"));
        }
        if schema
            .get("pattern")
            .and_then(Value::as_str)
            .is_some_and(|pattern| pattern.contains("\\d{4}-\\d{2}-\\d{2}"))
            && !athria_core::date::is_iso_date(text)
        {
            return Err(format!("{path} must match the required pattern"));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
            if number < minimum {
                return Err(format!("{path} must be at least {minimum}"));
            }
        }
        if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
            if number > maximum {
                return Err(format!("{path} must be at most {maximum}"));
            }
        }
        if let Some(minimum) = schema.get("exclusiveMinimum").and_then(Value::as_f64) {
            if number <= minimum {
                return Err(format!("{path} must be greater than {minimum}"));
            }
        }
    }
    Ok(())
}

pub fn serve_stdio<S: AthriaStore>(service: McpService<S>) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                writeln!(
                    stdout,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": -32700, "message": "Parse error" } })
                )?;
                stdout.flush()?;
                continue;
            }
        };
        if let Some(response) = service.handle(&request) {
            writeln!(stdout, "{response}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

/// Minimal Streamable HTTP JSON-response adapter. It deliberately binds only
/// to a caller-provided listener; the runtime owns loopback binding and token
/// generation so the application and MCP crates stay platform-independent.
pub fn serve_http<S: AthriaStore>(
    listener: TcpListener,
    service: McpService<S>,
    bearer_token: &str,
) -> std::io::Result<()> {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if let Err(error) = handle_http(stream, &service, bearer_token) {
                    eprintln!("Athria MCP HTTP request failed: {error}");
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn handle_http<S: AthriaStore>(
    mut stream: TcpStream,
    service: &McpService<S>,
    bearer_token: &str,
) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end;
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if bytes.len() > 64 * 1024 {
            return http_response(&mut stream, 413, None, "");
        }
    }
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let mut lines = headers.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let mut content_length = 0usize;
    let mut authorized = false;
    let mut host_allowed = false;
    let mut origin_allowed = true;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "content-length" => content_length = value.parse().unwrap_or(0),
                "authorization" => authorized = value == format!("Bearer {bearer_token}"),
                "host" => {
                    host_allowed =
                        value.starts_with("127.0.0.1:") || value.starts_with("localhost:")
                }
                "origin" => {
                    origin_allowed = matches!(value, "tauri://localhost" | "http://tauri.localhost")
                }
                _ => {}
            }
        }
    }
    if method != "POST" || path != "/mcp" {
        return http_response(&mut stream, 404, None, "");
    }
    if !host_allowed || !origin_allowed {
        return http_response(
            &mut stream,
            403,
            None,
            r#"{"error":"Host or origin is not allowed."}"#,
        );
    }
    if !authorized {
        return http_response(
            &mut stream,
            401,
            None,
            r#"{"error":"A valid local bearer token is required."}"#,
        );
    }
    while bytes.len() < header_end + content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    let request: Value = match serde_json::from_slice(
        &bytes[header_end..bytes.len().min(header_end + content_length)],
    ) {
        Ok(value) => value,
        Err(_) => return http_response(&mut stream, 400, None, r#"{"error":"Invalid JSON."}"#),
    };
    match service.handle(&request) {
        Some(response) => http_response(
            &mut stream,
            200,
            Some("application/json"),
            &response.to_string(),
        ),
        None => http_response(&mut stream, 202, None, ""),
    }
}

fn http_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: Option<&str>,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n{}Connection: close\r\n\r\n{body}",
        body.len(),
        content_type
            .map(|value| format!("Content-Type: {value}\r\n"))
            .unwrap_or_default()
    )?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use athria_store::SqliteStore;
    fn service() -> McpService<SqliteStore> {
        McpService::new(AthriaApplication::new(
            SqliteStore::open_in_memory().unwrap(),
        ))
    }
    #[test]
    fn exposes_contract_and_calls_application() {
        let service = service();
        assert_eq!(service.tools().len(), 36);
        let output = service.call_result("get_athlete_profile", &json!({}));
        let profile: Value =
            serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(profile["ownerId"], "local-user");
        assert!(profile["profileHash"].as_str().is_some());
    }
    #[test]
    fn keeps_machine_readable_errors() {
        let output = service().call_result("list_training_sessions", &json!({ "days": 0 }));
        assert_eq!(output["isError"], true);
        let error: Value =
            serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(error["code"], "INVALID_INPUT");
    }
    #[test]
    fn handles_json_rpc() {
        let service = service();
        let list = service
            .handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }))
            .unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), 36);
        let call = service.handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "estimate_1rm", "arguments": { "load": 100, "reps": 5, "unit": "kg" } } })).unwrap();
        assert!(call["result"].get("isError").is_none());
    }
    #[test]
    fn serves_authenticated_loopback_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_http(stream, &service(), "secret").unwrap();
        });
        let mut client = TcpStream::connect(address).unwrap();
        let body =
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }).to_string();
        write!(client, "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        server.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("get_athlete_profile"));
    }
}
