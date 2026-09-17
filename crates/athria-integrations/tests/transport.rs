use std::cell::RefCell;

use athria_integrations::{
    HttpClient, HttpRequest, HttpResponse, fetch_intervals, fetch_xunji_training,
};
use serde_json::{Value, json};

struct FakeClient {
    requests: RefCell<Vec<HttpRequest>>,
    responses: RefCell<Vec<std::result::Result<HttpResponse, String>>>,
}
impl FakeClient {
    fn new(responses: Vec<std::result::Result<HttpResponse, String>>) -> Self {
        Self {
            requests: RefCell::new(Vec::new()),
            responses: RefCell::new(responses.into_iter().rev().collect()),
        }
    }
}
impl HttpClient for FakeClient {
    fn send(&self, request: &HttpRequest) -> std::result::Result<HttpResponse, String> {
        self.requests.borrow_mut().push(request.clone());
        self.responses.borrow_mut().pop().unwrap()
    }
}
fn response(status: u16, body: Value) -> std::result::Result<HttpResponse, String> {
    Ok(HttpResponse { status, body })
}

#[test]
fn intervals_builds_authenticated_windows_and_isolates_failures() {
    let client = FakeClient::new(vec![
        response(200, json!([])),
        response(500, json!({})),
        response(500, json!({})),
        response(500, json!({})),
        response(200, json!([])),
    ]);
    let result = fetch_intervals(
        &client,
        "secret",
        "42",
        "2026-09-11T12:00:00Z",
        Some("2026-09-04"),
        Some("2026-09-04"),
    );
    assert_eq!(
        result,
        json!({ "activities": [], "wellness": "Intervals.icu returned HTTP 500", "events": [] })
    );
    let requests = client.requests.borrow();
    assert_eq!(
        requests[0].url,
        "https://intervals.icu/api/v1/athlete/42/activities?oldest=2026-09-04&newest=2026-09-11"
    );
    assert_eq!(requests[0].headers[0].1, "Basic QVBJX0tFWTpzZWNyZXQ=");
    assert!(
        requests
            .iter()
            .all(|request| !request.url.contains("secret"))
    );
}

#[test]
fn xunji_keeps_successful_days_and_never_returns_the_key() {
    let client = FakeClient::new(vec![
        response(200, json!({ "res": { "trains": [{ "localid": 1 }] } })),
        response(500, json!({ "error": "temporary" })),
        response(500, json!({ "error": "temporary" })),
        response(500, json!({ "error": "temporary" })),
    ]);
    let result = fetch_xunji_training(&client, "xjllm_secret", 2, "2026-09-03T00:00:00Z").unwrap();
    assert_eq!(result["successfulDates"], json!(["2026-09-02"]));
    assert_eq!(result["errors"][0]["datestr"], json!("2026-09-03"));
    assert!(!result.to_string().contains("xjllm_secret"));
    for request in client.requests.borrow().iter() {
        assert!(!request.url.contains("xjllm_secret"));
        assert_eq!(request.timeout_ms, 30_000);
    }
}

#[test]
fn xunji_authentication_is_typed_and_redacted() {
    let client = FakeClient::new(vec![response(401, json!({ "error": "apikey invalid" }))]);
    let error = fetch_xunji_training(&client, "xjllm_should_not_leak", 1, "2026-09-03T00:00:00Z")
        .unwrap_err();
    assert_eq!(error.0, "apikey invalid");
    assert!(!error.0.contains("should_not_leak"));
}
