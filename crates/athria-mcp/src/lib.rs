//! MCP JSON-RPC adapter for the shared Rust Athria application.

use athria_application::{AthriaApplication, AthriaStore};
use athria_core::{
    AdjustmentTrigger, RpeAutoregulationInput, calculate_heart_rate_zones,
    calculate_training_metrics, estimate_one_rep_max, evaluate_double_progression,
    evaluate_rpe_autoregulation,
};
pub use athria_core::{AthriaError, AthriaErrorCode, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::HashSet;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use rmcp::{
    ErrorData, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
    },
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};

const CONTRACT: &str = include_str!("../contract.json");

/// The newest revision whose wire shape this server actually emits. Advertising
/// a newer one makes era-negotiating clients negotiate it and then reject our
/// results on local schema validation.
const MAX_PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::V_2025_11_25;

#[derive(Debug, Deserialize)]
struct Contract {
    server: Value,
    tools: Vec<Value>,
}

struct RegisteredTool {
    kind: ToolKind,
    input: jsonschema::Validator,
    output: jsonschema::Validator,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolKind {
    GetAthleteProfile,
    GetTrainingState,
    ListTrainingSessions,
    ListWellness,
    GetWellnessDay,
    ListXunjiTrainingSessions,
    GetXunjiSyncStatus,
    GetTrainingSummary,
    GetCurrentPlan,
    GetPlanAdjustmentReview,
    ListSessionTemplates,
    GetSessionTemplate,
    GetTrainingTaxonomy,
    CalculateTrainingMetrics,
    EstimateOneRepMax,
    CalculateHeartRateZones,
    EvaluateProgression,
    EvaluateRpeAutoregulation,
    ValidateCurrentPlan,
    GetNextTrainingDay,
    ListPlannedSessions,
    ValidateNextTrainingDaySessions,
    CreateSessionTemplate,
    UpdateSessionTemplate,
    DeleteSessionTemplate,
    SaveCurrentPlan,
    SaveNextTrainingDaySessions,
    UpdatePlannedSession,
    RecordTrainingSession,
    OverrideTrainingSessionPlanMatch,
    AllowAutomaticPlanMatch,
    UpdateManualTrainingSession,
    RemoveManualTrainingSource,
    UpdateWellness,
    UpdateAthleteProfile,
    ReportSkillVersion,
}

impl ToolKind {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "get_athlete_profile" => Self::GetAthleteProfile,
            "get_training_state" => Self::GetTrainingState,
            "list_training_sessions" => Self::ListTrainingSessions,
            "list_wellness" => Self::ListWellness,
            "get_wellness_day" => Self::GetWellnessDay,
            "list_xunji_training_sessions" => Self::ListXunjiTrainingSessions,
            "get_xunji_sync_status" => Self::GetXunjiSyncStatus,
            "get_training_summary" => Self::GetTrainingSummary,
            "get_current_plan" => Self::GetCurrentPlan,
            "get_plan_adjustment_review" => Self::GetPlanAdjustmentReview,
            "list_session_templates" => Self::ListSessionTemplates,
            "get_session_template" => Self::GetSessionTemplate,
            "get_training_taxonomy" => Self::GetTrainingTaxonomy,
            "calculate_training_metrics" => Self::CalculateTrainingMetrics,
            "estimate_1rm" => Self::EstimateOneRepMax,
            "calculate_heart_rate_zones" => Self::CalculateHeartRateZones,
            "evaluate_progression" => Self::EvaluateProgression,
            "evaluate_rpe_autoregulation" => Self::EvaluateRpeAutoregulation,
            "validate_current_plan" => Self::ValidateCurrentPlan,
            "get_next_training_day" => Self::GetNextTrainingDay,
            "list_planned_sessions" => Self::ListPlannedSessions,
            "validate_next_training_day_sessions" => Self::ValidateNextTrainingDaySessions,
            "create_session_template" => Self::CreateSessionTemplate,
            "update_session_template" => Self::UpdateSessionTemplate,
            "delete_session_template" => Self::DeleteSessionTemplate,
            "save_current_plan" => Self::SaveCurrentPlan,
            "save_next_training_day_sessions" => Self::SaveNextTrainingDaySessions,
            "update_planned_session" => Self::UpdatePlannedSession,
            "record_training_session" => Self::RecordTrainingSession,
            "override_training_session_plan_match" => Self::OverrideTrainingSessionPlanMatch,
            "allow_automatic_plan_match" => Self::AllowAutomaticPlanMatch,
            "update_manual_training_session" => Self::UpdateManualTrainingSession,
            "remove_manual_training_source" => Self::RemoveManualTrainingSource,
            "update_wellness" => Self::UpdateWellness,
            "update_athlete_profile" => Self::UpdateAthleteProfile,
            "report_skill_version" => Self::ReportSkillVersion,
            _ => return None,
        })
    }
}

pub struct McpService<S: AthriaStore> {
    application: AthriaApplication<S>,
    contract: Contract,
    registry: Vec<RegisteredTool>,
    /// Where `report_skill_version` records the Skill versions an agent
    /// actually loaded. Athria sets this on the transports a GUI-managed
    /// Skills agent spawns; other transports accept the handshake unrecorded.
    skill_reports: Option<PathBuf>,
}

impl<S: AthriaStore> McpService<S> {
    pub fn new(application: AthriaApplication<S>) -> Self {
        let contract: Contract =
            serde_json::from_str(CONTRACT).expect("embedded MCP contract must be valid");
        let mut names = HashSet::new();
        let registry = contract
            .tools
            .iter()
            .map(|tool| {
                let name = tool["name"]
                    .as_str()
                    .expect("MCP tool name must be a string");
                assert!(names.insert(name), "duplicate MCP tool name: {name}");
                let handler = tool["handlerKey"]
                    .as_str()
                    .expect("MCP tool handlerKey must be a string");
                let kind = ToolKind::parse(handler)
                    .unwrap_or_else(|| panic!("unknown MCP handlerKey: {handler}"));
                let input = jsonschema::options()
                    .should_validate_formats(true)
                    .build(&tool["inputSchema"])
                    .unwrap_or_else(|error| panic!("invalid input schema for {name}: {error}"));
                let output = jsonschema::options()
                    .should_validate_formats(true)
                    .build(&tool["outputSchema"])
                    .unwrap_or_else(|error| panic!("invalid output schema for {name}: {error}"));
                RegisteredTool {
                    kind,
                    input,
                    output,
                }
            })
            .collect();
        Self {
            application,
            contract,
            registry,
            skill_reports: None,
        }
    }
    /// Records reported Skill versions in `path`, which is how Athria verifies
    /// the Skills a GUI-managed agent actually loaded.
    pub fn with_skill_reports(mut self, path: PathBuf) -> Self {
        self.skill_reports = Some(path);
        self
    }
    pub fn tools(&self) -> &[Value] {
        &self.contract.tools
    }

    pub fn call_result(&self, name: &str, input: &Value) -> Value {
        let result = self
            .registry
            .iter()
            .enumerate()
            .find(|(index, _)| self.contract.tools[*index]["name"] == name)
            .ok_or_else(|| ToolError {
                code: "INTERNAL_ERROR".into(),
                message: format!("Unknown tool: {name}"),
            })
            .and_then(|(_, tool)| {
                tool.input
                    .validate(input)
                    .map_err(|error| ToolError::invalid(format!("input: {error}")))?;
                let output = self.call_tool(tool.kind, input)?;
                let structured = json!({ "result": output });
                tool.output
                    .validate(&structured)
                    .map_err(|error| ToolError {
                        code: "INTERNAL_ERROR".into(),
                        message: format!("Tool output violated its contract: {error}"),
                    })?;
                Ok((output, structured))
            });
        match result {
            Ok((output, structured)) => {
                json!({ "content": [{ "type": "text", "text": serde_json::to_string(&output).expect("JSON output") }], "structuredContent": structured })
            }
            Err(error) => {
                json!({ "isError": true, "content": [{ "type": "text", "text": serde_json::to_string(&json!({ "error": error.message, "code": error.code })).expect("JSON error") }] })
            }
        }
    }

    fn call_tool(&self, kind: ToolKind, input: &Value) -> std::result::Result<Value, ToolError> {
        let app = &self.application;
        let application =
            |result: athria_application::Result<Value>| result.map_err(ToolError::application);
        match kind {
            ToolKind::GetAthleteProfile => {
                let mut profile = app.get_profile().map_err(ToolError::application)?;
                profile["profileHash"] = json!(app.profile_hash().map_err(ToolError::application)?);
                Ok(profile)
            }
            ToolKind::GetTrainingState => application(app.get_training_state()),
            ToolKind::ListTrainingSessions => serialize(
                app.list_sessions(days(input, 30)?)
                    .map_err(ToolError::application)?,
            ),
            ToolKind::ListWellness => serialize(
                app.list_wellness(days(input, 42)?)
                    .map_err(ToolError::application)?,
            ),
            ToolKind::GetWellnessDay => {
                application(app.get_wellness_day(required_str(input, "day")?))
            }
            ToolKind::ListXunjiTrainingSessions => {
                application(app.list_xunji_sessions(days(input, 30)?))
            }
            ToolKind::GetXunjiSyncStatus => serialize(
                app.get_xunji_sync_status()
                    .map_err(ToolError::application)?,
            ),
            ToolKind::GetTrainingSummary => {
                application(app.get_training_summary(days(input, 7)?, None, None))
            }
            ToolKind::GetCurrentPlan => {
                serialize(app.get_current_plan().map_err(ToolError::application)?)
            }
            ToolKind::GetPlanAdjustmentReview => {
                let trigger = match required_str(input, "trigger")? {
                    "weekly_review" => AdjustmentTrigger::WeeklyReview,
                    "profile_change" => AdjustmentTrigger::ProfileChange,
                    "user_request" => AdjustmentTrigger::UserRequest,
                    _ => return Err(ToolError::invalid("trigger is not an allowed value")),
                };
                serialize(
                    app.review_current_plan_for_adjustment(trigger)
                        .map_err(ToolError::application)?,
                )
            }
            ToolKind::ListSessionTemplates => {
                serialize(app.list_templates().map_err(ToolError::application)?)
            }
            ToolKind::GetSessionTemplate => {
                application(app.get_template(required_str(input, "id")?))
            }
            ToolKind::GetTrainingTaxonomy => Ok(app.get_training_taxonomy()),
            ToolKind::CalculateTrainingMetrics => serialize(calculate_training_metrics(
                &app.list_sessions(days(input, 90)?)
                    .map_err(ToolError::application)?,
            )),
            ToolKind::EstimateOneRepMax => serialize(
                estimate_one_rep_max(
                    required_f64(input, "load")?,
                    required_f64(input, "reps")?,
                    required_str(input, "unit")?,
                )
                .map_err(ToolError::application)?,
            ),
            ToolKind::CalculateHeartRateZones => serialize(
                calculate_heart_rate_zones(required_f64(input, "maxHeartRate")?)
                    .map_err(ToolError::application)?,
            ),
            ToolKind::EvaluateProgression => {
                application(evaluate_double_progression(&parse(input)?))
            }
            ToolKind::EvaluateRpeAutoregulation => application(evaluate_rpe_autoregulation(
                &parse::<RpeAutoregulationInput>(input)?,
            )),
            ToolKind::ValidateCurrentPlan => serialize(
                app.validate_current_plan(input)
                    .map_err(ToolError::application)?,
            ),
            ToolKind::GetNextTrainingDay => application(
                app.get_next_training_day(input.get("onOrAfterDate").and_then(Value::as_str)),
            ),
            ToolKind::ListPlannedSessions => serialize(
                app.get_calendar(
                    input.get("from").and_then(Value::as_str),
                    input.get("to").and_then(Value::as_str),
                )
                .map_err(ToolError::application)?,
            ),
            ToolKind::ValidateNextTrainingDaySessions => {
                application(app.validate_next_training_day_sessions(input))
            }
            ToolKind::CreateSessionTemplate => application(app.create_template(input)),
            ToolKind::UpdateSessionTemplate => application(app.update_template(input)),
            ToolKind::DeleteSessionTemplate => application(app.delete_template(
                required_str(input, "id")?,
                input.get("expectedRevision").and_then(Value::as_i64),
            )),
            ToolKind::SaveCurrentPlan => {
                let saved = app
                    .save_current_plan(input)
                    .map_err(ToolError::application)?;
                Ok(
                    json!({ "revision": saved["plan"]["revision"], "impact": saved["impact"], "blockerSummary": blocker_summary(&saved["validation"]) }),
                )
            }
            ToolKind::SaveNextTrainingDaySessions => {
                application(app.save_next_training_day_sessions(input))
            }
            ToolKind::UpdatePlannedSession => application(
                app.update_planned_session(
                    required_str(input, "id")?,
                    input
                        .get("update")
                        .ok_or_else(|| ToolError::invalid("update is required"))?,
                ),
            ),
            ToolKind::RecordTrainingSession => application(app.record_training_session(input)),
            ToolKind::OverrideTrainingSessionPlanMatch => {
                application(app.set_training_session_plan_match(required_str(input, "id")?, input))
            }
            ToolKind::AllowAutomaticPlanMatch => application(
                app.clear_training_session_plan_exclusion(required_str(input, "id")?, input),
            ),
            ToolKind::UpdateManualTrainingSession => {
                application(app.update_manual_training_session(required_str(input, "id")?, input))
            }
            ToolKind::RemoveManualTrainingSource => {
                application(app.delete_manual_training_session(required_str(input, "id")?, input))
            }
            ToolKind::UpdateWellness => application(
                app.update_wellness(
                    required_str(input, "day")?,
                    input
                        .get("update")
                        .ok_or_else(|| ToolError::invalid("update is required"))?,
                ),
            ),
            ToolKind::UpdateAthleteProfile => application(app.update_profile(input)),
            ToolKind::ReportSkillVersion => {
                let report = athria_skills::ReportInput {
                    skill: required_str(input, "skill")?.to_string(),
                    version: required_str(input, "version")?.to_string(),
                    hash: required_str(input, "hash")?.to_string(),
                };
                let Some(path) = &self.skill_reports else {
                    return Ok(json!({ "recorded": false, "skill": report.skill }));
                };
                athria_skills::record_report(path, &report).map_err(|message| ToolError {
                    code: "INTERNAL_ERROR".into(),
                    message,
                })?;
                Ok(json!({ "recorded": true, "skill": report.skill }))
            }
        }
    }
}

struct RmcpServer<S: AthriaStore + Send + 'static> {
    service: Arc<Mutex<McpService<S>>>,
    tools: Arc<Vec<Tool>>,
    server_name: Arc<str>,
    server_version: Arc<str>,
}

impl<S: AthriaStore + Send + 'static> Clone for RmcpServer<S> {
    fn clone(&self) -> Self {
        Self {
            service: Arc::clone(&self.service),
            tools: Arc::clone(&self.tools),
            server_name: Arc::clone(&self.server_name),
            server_version: Arc::clone(&self.server_version),
        }
    }
}

impl<S: AthriaStore + Send + 'static> RmcpServer<S> {
    fn new(service: McpService<S>) -> Self {
        let server_name: Arc<str> = service.contract.server["name"]
            .as_str()
            .expect("MCP server name must be a string")
            .into();
        let server_version: Arc<str> = service.contract.server["version"]
            .as_str()
            .expect("MCP server version must be a string")
            .into();
        let tools = service
            .tools()
            .iter()
            .map(|tool| {
                let mut wire = tool.clone();
                wire.as_object_mut()
                    .expect("MCP tool must be an object")
                    .shift_remove("handlerKey");
                serde_json::from_value(wire).expect("MCP tool must match the RMCP wire model")
            })
            .collect();
        Self {
            service: Arc::new(Mutex::new(service)),
            tools: Arc::new(tools),
            server_name,
            server_version,
        }
    }
}

impl<S: AthriaStore + Send + 'static> ServerHandler for RmcpServer<S> {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new(
                self.server_name.to_string(),
                self.server_version.to_string(),
            ),
        )
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Owned(vec![MAX_PROTOCOL_VERSION])
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        std::future::ready(Ok(ListToolsResult::with_all_items((*self.tools).clone())))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|tool| tool.name == name).cloned()
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + Send + '_ {
        let result = if self.get_tool(&request.name).is_none() {
            Err(ErrorData::invalid_params(
                format!("Unknown tool: {}", request.name),
                None,
            ))
        } else {
            let input = Value::Object(request.arguments.unwrap_or_default());
            let value = self
                .service
                .lock()
                .expect("MCP service lock must not be poisoned")
                .call_result(&request.name, &input);
            serde_json::from_value::<CallToolResult>(value)
                .map(CallToolResponse::from)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))
        };
        std::future::ready(result)
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

pub fn serve_stdio<S: AthriaStore + Send + 'static>(service: McpService<S>) -> std::io::Result<()> {
    tokio::runtime::Runtime::new()?.block_on(async move {
        let input = tokio::io::BufReader::new(tokio::io::stdin());
        let running = RmcpServer::new(service)
            .serve((filtered_stdio(input, tokio::io::stdout()), tokio::io::stdout()))
            .await
            .map_err(std::io::Error::other)?;
        running.waiting().await.map_err(std::io::Error::other)?;
        Ok(())
    })
}

enum PreSessionLine {
    /// A `server/discover` probe with the answer to send back instead of the line.
    Discover(Value),
    Initialize,
    Forward,
}

/// Answers a leading `server/discover` probe itself instead of letting the
/// protocol handler dispatch it: dispatching marks the session as requiring a
/// per-request `_meta` envelope, which then fails every request of the legacy
/// flow the probing client falls back to.
fn classify_pre_session_line(line: &[u8]) -> PreSessionLine {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return PreSessionLine::Forward;
    };
    match value.get("method").and_then(Value::as_str) {
        Some("server/discover") => PreSessionLine::Discover(json!({
            "jsonrpc": "2.0",
            "id": value.get("id").cloned().unwrap_or(Value::Null),
            "error": {
                "code": -32022,
                "message": "Unsupported protocol version",
                "data": {
                    "requested": value.pointer("/params/_meta").and_then(|meta| meta.get("io.modelcontextprotocol/protocolVersion")).cloned().unwrap_or(Value::Null),
                    "supported": [MAX_PROTOCOL_VERSION.as_str()],
                },
            },
        })),
        Some("initialize") => PreSessionLine::Initialize,
        _ => PreSessionLine::Forward,
    }
}

/// Streams the caller's stdin to the protocol handler, intercepting probe lines
/// until an `initialize` request ends the pre-session window.
fn filtered_stdio<R, W>(input: R, replies: W) -> tokio::io::DuplexStream
where
    R: AsyncBufRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (mut forwarded, reader) = tokio::io::duplex(8 * 1024);
    tokio::spawn(async move {
        let mut input = input;
        let mut replies = replies;
        let mut line = Vec::new();
        let mut session_started = false;
        while input.read_until(b'\n', &mut line).await.unwrap_or(0) > 0 {
            if !session_started {
                match classify_pre_session_line(&line) {
                    PreSessionLine::Discover(reply) => {
                        let written = replies.write_all(format!("{reply}\n").as_bytes()).await;
                        line.clear();
                        if written.is_err() || replies.flush().await.is_err() {
                            break;
                        }
                        continue;
                    }
                    PreSessionLine::Initialize => session_started = true,
                    PreSessionLine::Forward => {}
                }
            }
            if forwarded.write_all(&line).await.is_err() {
                break;
            }
            line.clear();
        }
    });
    reader
}

/// Minimal Streamable HTTP JSON-response adapter. It deliberately binds only
/// to a caller-provided listener; the runtime owns loopback binding and token
/// generation so the application and MCP crates stay platform-independent.
pub fn serve_http<S: AthriaStore + Send + 'static>(
    listener: TcpListener,
    service: McpService<S>,
    bearer_token: &str,
) -> std::io::Result<()> {
    let token = Arc::new(bearer_token.to_owned());
    listener.set_nonblocking(true)?;
    tokio::runtime::Runtime::new()?.block_on(async move {
        let server = RmcpServer::new(service);
        let config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(true)
            .with_json_response(true)
            .with_allowed_hosts(["localhost", "127.0.0.1"])
            .with_allowed_origins(["tauri://localhost", "http://tauri.localhost"]);
        let mcp: StreamableHttpService<_, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(server.clone()), Default::default(), config);
        let router = Router::new()
            .nest_service("/mcp", mcp)
            .layer(middleware::from_fn_with_state(token, authorize_request));
        let listener = tokio::net::TcpListener::from_std(listener)?;
        axum::serve(listener, router)
            .await
            .map_err(std::io::Error::other)
    })
}

/// Unauthenticated loopback server used only by the pinned MCP conformance suite.
#[cfg(feature = "conformance")]
pub fn serve_conformance_http<S: AthriaStore + Send + 'static>(
    listener: TcpListener,
    service: McpService<S>,
) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    tokio::runtime::Runtime::new()?.block_on(async move {
        let server = RmcpServer::new(service);
        let config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(true)
            .with_json_response(true)
            .with_allowed_hosts(["localhost", "127.0.0.1"]);
        let mcp: StreamableHttpService<_, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(server.clone()), Default::default(), config);
        let router = Router::new().nest_service("/mcp", mcp);
        let listener = tokio::net::TcpListener::from_std(listener)?;
        axum::serve(listener, router)
            .await
            .map_err(std::io::Error::other)
    })
}

async fn authorize_request(
    State(token): State<Arc<String>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let expected = format!("Bearer {token}");
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    let mut response = if authorized {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "A valid local bearer token is required." })),
        )
            .into_response()
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
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
        assert!(service.tools().iter().all(|tool| {
            tool.get("handlerKey").and_then(Value::as_str).is_some()
                && tool.get("outputSchema").is_some()
        }));
        assert!(!service.tools().iter().any(|tool| matches!(
            tool["name"].as_str(),
            Some("check_training_constraints" | "evaluate_double_progression")
        )));
        let output = service.call_result("get_athlete_profile", &json!({}));
        let profile: Value =
            serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(profile["ownerId"], "local-user");
        assert!(profile["profileHash"].as_str().is_some());
        assert_eq!(output["structuredContent"]["result"], profile);
    }
    #[test]
    fn every_tool_has_a_valid_contract_result_fixture() {
        let service = service();
        let fixtures: Value =
            serde_json::from_str(include_str!("../tests/fixtures/tool-results.json")).unwrap();
        assert_eq!(fixtures.as_object().unwrap().len(), 36);

        for (tool, registered) in service.tools().iter().zip(&service.registry) {
            let name = tool["name"].as_str().unwrap();
            let result = fixtures
                .get(name)
                .unwrap_or_else(|| panic!("missing result fixture for {name}"));
            let envelope = json!({ "result": result });
            assert!(
                registered.output.validate(&envelope).is_ok(),
                "fixture for {name} must match its outputSchema"
            );
        }
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
    fn optional_day_windows_use_dispatcher_defaults() {
        assert_eq!(days(&json!({}), 30).unwrap(), 30);
        assert_eq!(days(&json!({}), 42).unwrap(), 42);
        assert_eq!(days(&json!({}), 7).unwrap(), 7);
        assert_eq!(days(&json!({}), 90).unwrap(), 90);

        let service = service();
        for name in [
            "list_training_sessions",
            "list_wellness",
            "list_xunji_training_sessions",
            "get_training_summary",
            "calculate_training_metrics",
        ] {
            let tool = service
                .tools()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            assert!(
                !tool["inputSchema"]["required"]
                    .as_array()
                    .is_some_and(|required| required.contains(&json!("days")))
            );
            assert!(
                service
                    .call_result(name, &json!({}))
                    .get("isError")
                    .is_none(),
                "{name} should accept an omitted days argument"
            );
        }
    }
    #[test]
    fn write_tool_annotations_match_the_risk_audit() {
        let service = service();
        let additive = [
            "create_session_template",
            "record_training_session",
            "report_skill_version",
        ];
        let destructive = [
            "update_session_template",
            "delete_session_template",
            "save_current_plan",
            "save_next_training_day_sessions",
            "update_planned_session",
            "override_training_session_plan_match",
            "allow_automatic_plan_match",
            "update_manual_training_session",
            "remove_manual_training_source",
            "update_wellness",
            "update_athlete_profile",
        ];

        for tool in service
            .tools()
            .iter()
            .filter(|tool| tool["annotations"]["readOnlyHint"] == json!(false))
        {
            let name = tool["name"].as_str().unwrap();
            let expected = destructive.contains(&name);
            assert_eq!(
                tool["annotations"]["destructiveHint"],
                json!(expected),
                "{name}"
            );
            assert!(
                additive.contains(&name) || destructive.contains(&name),
                "unclassified write tool: {name}"
            );
        }
    }
    #[test]
    fn plan_match_override_is_user_directed_and_recording_cannot_choose_a_match() {
        let service = service();
        assert!(
            service
                .tools()
                .iter()
                .all(|tool| tool["name"] != "set_training_session_plan_match")
        );

        let override_tool = service
            .tools()
            .iter()
            .find(|tool| tool["name"] == "override_training_session_plan_match")
            .unwrap();
        assert!(
            override_tool["description"]
                .as_str()
                .unwrap()
                .contains("user's explicit correction")
        );

        let record_tool = service
            .tools()
            .iter()
            .find(|tool| tool["name"] == "record_training_session")
            .unwrap();
        assert!(
            record_tool["inputSchema"]["properties"]
                .get("plannedSessionId")
                .is_none()
        );
        assert!(
            !record_tool["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("plannedSessionId"))
        );
    }
    #[test]
    fn adjustment_review_is_read_only_and_keeps_application_errors() {
        let service = service();
        let tool = service
            .tools()
            .iter()
            .find(|tool| tool["name"] == "get_plan_adjustment_review")
            .unwrap();
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(
            tool["inputSchema"]["properties"]["trigger"]["enum"],
            json!(["weekly_review", "profile_change", "user_request"])
        );

        let output = service.call_result(
            "get_plan_adjustment_review",
            &json!({ "trigger": "weekly_review" }),
        );
        assert_eq!(output["isError"], true);
        let error: Value =
            serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(error["code"], "NO_CURRENT_PLAN");
    }
    #[test]
    fn rmcp_server_advertises_only_the_wire_it_emits() {
        let server = RmcpServer::new(service());
        assert_eq!(server.tools.len(), 36);
        assert!(server.tools.iter().all(|tool| tool.output_schema.is_some()));
        assert_eq!(
            server.supported_protocol_versions().as_ref(),
            &[ProtocolVersion::V_2025_11_25]
        );
    }

    #[test]
    fn pre_session_discover_probe_is_answered_without_reaching_the_handler() {
        use tokio::io::AsyncReadExt;
        let probe = json!({ "jsonrpc": "2.0", "id": "server-discover-probe-1", "method": "server/discover", "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
        let initialize = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } });
        let later_discover = json!({ "jsonrpc": "2.0", "id": 3, "method": "server/discover", "params": {} });
        let script = format!("{probe}\n{initialize}\n{later_discover}\n");
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (mut script_writer, script_reader) = tokio::io::duplex(4096);
            let (reply_writer, mut replies) = tokio::io::duplex(4096);
            let mut forwarded =
                filtered_stdio(tokio::io::BufReader::new(script_reader), reply_writer);
            script_writer.write_all(script.as_bytes()).await.unwrap();
            drop(script_writer);
            let mut passed = String::new();
            forwarded.read_to_string(&mut passed).await.unwrap();
            let mut answered = String::new();
            replies.read_to_string(&mut answered).await.unwrap();
            assert!(!passed.contains("server/discover-probe-1"), "{passed}");
            assert!(passed.contains("\"method\":\"initialize\""), "{passed}");
            assert!(passed.contains("\"id\":3"), "{passed}");
            let rejection: Value = serde_json::from_str(answered.trim()).unwrap();
            assert_eq!(rejection["id"], "server-discover-probe-1");
            assert_eq!(rejection["error"]["code"], -32022);
            assert_eq!(rejection["error"]["data"]["requested"], "2026-07-28");
            assert_eq!(
                rejection["error"]["data"]["supported"],
                json!(["2025-11-25"])
            );
        });
    }
    #[test]
    fn serves_authenticated_loopback_http() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        fn post(address: std::net::SocketAddr, extra_headers: &str, body: &Value) -> String {
            let mut client = TcpStream::connect(address).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let body = body.to_string();
            write!(client, "POST /mcp HTTP/1.1\r\nHost: {address}\r\n{extra_headers}Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            response
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            serve_http(listener, service(), "secret").unwrap();
        });
        for _ in 0..50 {
            match TcpStream::connect(address) {
                Ok(_) => {
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }

        let legacy = post(
            address,
            "Authorization: Bearer secret\r\n",
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } }),
        );
        assert!(legacy.starts_with("HTTP/1.1 200 OK"), "{legacy:?}");
        assert!(legacy.contains("2025-11-25"));
        assert!(legacy.contains("cache-control: no-store"));

        let unsupported_revision = post(
            address,
            "Authorization: Bearer secret\r\nMCP-Protocol-Version: 2026-07-28\r\nMcp-Method: server/discover\r\n",
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "server/discover", "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }),
        );
        assert!(
            unsupported_revision.starts_with("HTTP/1.1 400 Bad Request"),
            "{unsupported_revision:?}"
        );
        assert!(unsupported_revision.contains("-32022"));
        assert!(unsupported_revision.contains("2025-11-25"));

        let unauthorized = post(
            address,
            "",
            &json!({ "jsonrpc": "2.0", "id": 3, "method": "ping", "params": {} }),
        );
        assert!(unauthorized.starts_with("HTTP/1.1 401 Unauthorized"));
        assert!(unauthorized.contains("cache-control: no-store"));

        let forbidden_origin = post(
            address,
            "Authorization: Bearer secret\r\nOrigin: https://example.com\r\n",
            &json!({ "jsonrpc": "2.0", "id": 4, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } } }),
        );
        assert!(forbidden_origin.starts_with("HTTP/1.1 403 Forbidden"));

        assert!(!server.is_finished(), "HTTP server should remain available");
    }

    #[test]
    fn report_skill_version_records_into_the_configured_sink() {
        let dir = std::env::temp_dir().join(format!(
            "athria-mcp-skill-reports-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("skill-reports.json");
        let service = service().with_skill_reports(path.clone());
        let output = service.call_result(
            "report_skill_version",
            &json!({ "skill": "athria-coach", "version": "0.1.0", "hash": "abc123" }),
        );
        assert!(output.get("isError").is_none(), "{output}");
        let recorded: Value =
            serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(recorded, json!({ "recorded": true, "skill": "athria-coach" }));
        let reports = athria_skills::read_reports(&path);
        let coach = &reports.reports["athria-coach"];
        assert_eq!(coach.version, "0.1.0");
        assert_eq!(coach.hash, "abc123");
        assert!(!coach.last_seen_at.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn report_skill_version_without_a_sink_is_accepted_but_not_recorded() {
        let output = service().call_result(
            "report_skill_version",
            &json!({ "skill": "athria-coach", "version": "0.1.0", "hash": "abc" }),
        );
        assert!(output.get("isError").is_none(), "{output}");
        let recorded: Value =
            serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(recorded, json!({ "recorded": false, "skill": "athria-coach" }));
    }

    #[test]
    fn report_skill_version_requires_a_complete_identity() {
        for input in [
            json!({}),
            json!({ "skill": "athria-coach" }),
            json!({ "skill": "athria-coach", "version": "0.1.0" }),
        ] {
            let output = service().call_result("report_skill_version", &input);
            assert_eq!(output["isError"], true, "{input}");
            let error: Value =
                serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(error["code"], "INVALID_INPUT", "{input}");
        }
    }
}
