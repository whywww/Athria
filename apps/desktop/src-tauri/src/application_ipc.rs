use std::path::Path;

use athria_application::AthriaApplication;
use athria_core::AdjustmentTrigger;
use athria_store::SqliteStore;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub type DesktopApplication = AthriaApplication<SqliteStore>;

fn body(value: Option<Value>) -> Value {
    value.unwrap_or_else(|| json!({}))
}

fn query_i64(url: &reqwest::Url, name: &str, default: i64) -> Result<i64, String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| {
            value
                .parse::<i64>()
                .map_err(|_| format!("Invalid {name} query parameter."))
        })
        .unwrap_or(Ok(default))
}

fn query(url: &reqwest::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn result<T: serde::Serialize>(value: athria_store::Result<T>) -> Result<Value, String> {
    let value = value.map_err(|error| error.message().to_owned())?;
    serde_json::to_value(value).map_err(|error| error.to_string())
}

pub fn dispatch(
    app: &DesktopApplication,
    database_path: &Path,
    method: &str,
    path: &str,
    request_body: Option<Value>,
) -> Result<Value, String> {
    let url = reqwest::Url::parse(&format!("http://athria.local{path}"))
        .map_err(|_| "Invalid Athria request path.".to_string())?;
    let route = url.path();
    let method = method.to_ascii_uppercase();
    let segments = url
        .path_segments()
        .map(|items| items.collect::<Vec<_>>())
        .unwrap_or_default();
    let input = body(request_body);

    match (method.as_str(), route) {
        ("GET", "/api/profile") => result(app.get_profile()),
        ("PUT", "/api/profile") => result(app.save_profile(&input)),
        ("GET", "/api/personal-information") => result(app.get_personal_information()),
        ("PUT", "/api/personal-information") => result(app.save_personal_information(&input)),
        ("GET", "/api/state") => result(app.get_training_state()),
        ("GET", "/api/summary") => result(app.get_training_summary(
            query_i64(&url, "days", 7)?,
            query(&url, "from").as_deref(),
            query(&url, "to").as_deref(),
        )),
        ("GET", "/api/sessions") => result(app.list_sessions(query_i64(&url, "days", 90)?)),
        ("POST", "/api/training-sessions") => result(app.record_training_session(&input)),
        ("GET", "/api/wellness") => result(app.list_wellness(query_i64(&url, "days", 42)?)),
        ("GET", "/api/training-taxonomy") => Ok(app.get_training_taxonomy()),
        ("GET", "/api/templates") => result(app.list_templates()),
        ("POST", "/api/templates") => result(app.create_template(&input)),
        ("GET", "/api/plans/current") => result(app.get_current_plan()),
        ("GET", "/api/plans/adjustment-review") => {
            result(app.review_current_plan_reminder(
                AdjustmentTrigger::WeeklyReview,
                query(&url, "acknowledgedContext").as_deref(),
            ))
        }
        ("PUT", "/api/plans/current") => result(app.save_current_plan(&input)),
        ("POST", "/api/plans/current/validate") => result(app.validate_current_plan(&input)),
        ("GET", "/api/plans/next-training-day") => {
            result(app.get_next_training_day(query(&url, "onOrAfterDate").as_deref()))
        }
        ("GET", "/api/plans/calendar") => {
            result(app.get_calendar(query(&url, "from").as_deref(), query(&url, "to").as_deref()))
        }
        ("POST", "/api/planned-sessions/validate") => {
            result(app.validate_next_training_day_sessions(&input))
        }
        ("POST", "/api/planned-sessions") => result(app.save_next_training_day_sessions(&input)),
        ("GET", "/api/imports/hevy/status") => result(app.get_hevy_import_status()),
        ("POST", "/api/imports/hevy/preview") => {
            let file_name = input
                .get("fileName")
                .and_then(Value::as_str)
                .unwrap_or("hevy.csv");
            if !file_name.to_ascii_lowercase().ends_with(".csv") {
                return Err("Hevy imports must be CSV files.".to_string());
            }
            let encoded = input
                .get("contentBase64")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let content = STANDARD
                .decode(encoded)
                .map_err(|_| "The Hevy CSV content is not valid base64.".to_string())?;
            if content.len() > 20 * 1024 * 1024 {
                return Err("Hevy CSV files must not exceed 20 MB.".to_string());
            }
            result(app.preview_hevy(&content, file_name))
        }
        ("POST", "/api/imports/hevy/commit") => result(
            app.commit_hevy(
                input
                    .get("previewToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ),
        ),
        ("GET", "/api/system/doctor") => Ok(
            json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "databasePath": database_path, "database": app.store().counts().map_err(|error| error.message().to_owned())? }),
        ),
        _ => dispatch_resource(app, &method, &segments, &input),
    }
}

fn dispatch_resource(
    app: &DesktopApplication,
    method: &str,
    segments: &[&str],
    input: &Value,
) -> Result<Value, String> {
    match segments {
        ["api", "training-sessions", id, "plan-match"] if method == "PATCH" => {
            result(app.set_training_session_plan_match(id, input))
        }
        ["api", "training-sessions", id, "automatic-match"] if method == "POST" => {
            result(app.clear_training_session_plan_exclusion(id, input))
        }
        ["api", "training-sessions", id, "type"] if method == "PATCH" => {
            result(app.update_training_session_type(id, input))
        }
        ["api", "training-sessions", id, "manual"] if method == "PATCH" => {
            result(app.update_manual_training_session(id, input))
        }
        ["api", "training-sessions", id, "manual"] if method == "DELETE" => {
            result(app.delete_manual_training_session(id, input))
        }
        ["api", "training-sessions", id] if method == "PUT" => {
            let mut value = input.clone();
            value
                .as_object_mut()
                .ok_or_else(|| "Training session input must be an object.".to_string())?
                .insert("id".to_string(), json!(id));
            result(app.record_training_session(&value))
        }
        ["api", "training-sessions", id] if method == "DELETE" => {
            result(app.delete_training_session(id, input))
        }
        ["api", "wellness", day] if method == "GET" => result(app.get_wellness_day(day)),
        ["api", "wellness", day] if method == "PATCH" => result(app.update_wellness(day, input)),
        ["api", "templates", id] if method == "GET" => result(app.get_template(id)),
        ["api", "templates", _] if method == "PUT" => result(app.update_template(input)),
        ["api", "templates", id] if method == "DELETE" => {
            result(app.delete_template(id, input.get("expectedRevision").and_then(Value::as_i64)))
        }
        ["api", "planned-sessions", id] if method == "PATCH" => {
            result(app.update_planned_session(id, input))
        }
        _ => Err("Route not found.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_profile_and_doctor_through_the_rust_application() {
        let store = SqliteStore::open_in_memory().unwrap();
        let app = AthriaApplication::new(store);
        let profile =
            dispatch(&app, Path::new("test.sqlite3"), "GET", "/api/profile", None).unwrap();
        assert_eq!(profile["ownerId"], "local-user");
        let doctor = dispatch(
            &app,
            Path::new("test.sqlite3"),
            "GET",
            "/api/system/doctor",
            None,
        )
        .unwrap();
        assert_eq!(doctor["status"], "ok");
        assert_eq!(doctor["databasePath"], "test.sqlite3");
    }

    #[test]
    fn rejects_unknown_routes() {
        let app = AthriaApplication::new(SqliteStore::open_in_memory().unwrap());
        assert_eq!(
            dispatch(&app, Path::new("test.sqlite3"), "GET", "/api/unknown", None).unwrap_err(),
            "Route not found."
        );
    }

    #[test]
    fn routes_adjustment_review_through_the_application() {
        let app = AthriaApplication::new(SqliteStore::open_in_memory().unwrap());
        let error = dispatch(
            &app,
            Path::new("test.sqlite3"),
            "GET",
            "/api/plans/adjustment-review",
            None,
        )
        .unwrap_err();
        assert_eq!(error, "There is no current plan.");
    }
}
