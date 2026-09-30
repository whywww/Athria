use athria_integrations::{
    interval_modality, normalize_intervals_activity, normalize_xunji_training, parse_hevy_csv,
    sync_date_window,
};
use serde_json::{Value, json};

#[test]
fn integration_adapter_fixture_matches() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/integrations.json")).unwrap();
    let hevy = &fixture["hevy"];
    assert_eq!(
        parse_hevy_csv(
            hevy["content"].as_str().unwrap().as_bytes(),
            hevy["fileName"].as_str().unwrap()
        )
        .unwrap()
        .value,
        hevy["expected"]
    );
    for case in fixture["modalities"].as_array().unwrap() {
        assert_eq!(
            json!(interval_modality(case.get("input"))),
            case["expected"]
        );
    }
    for case in fixture["intervals"].as_array().unwrap() {
        assert_eq!(
            normalize_intervals_activity(&case["item"], case["resource"].as_str().unwrap(), "Asia/Hong_Kong")
                .unwrap(),
            case.get("expected")
                .filter(|value| !value.is_null())
                .cloned()
        );
    }
    for case in fixture["windows"].as_array().unwrap() {
        let actual = sync_date_window(
            case["lastSuccessAt"].as_str(),
            None,
            "2026-09-11T12:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            json!({ "days": actual.days, "rangeStart": actual.range_start, "rangeEnd": actual.range_end }),
            case["expected"]
        );
    }
    for case in fixture["xunji"].as_array().unwrap() {
        assert_eq!(
            normalize_xunji_training(&case["input"]).unwrap(),
            case["expected"]
        );
    }
}

#[test]
fn intervals_uses_valid_utc_time_then_hong_kong_local_fallback() {
    let cases = [
        ("2026-08-15T17:26:49", "2026-08-15T09:26:49.000Z"),
        ("2026-08-04T18:58:03", "2026-08-04T10:58:03.000Z"),
        ("2026-07-30T18:54:15", "2026-07-30T10:54:15.000Z"),
        ("2026-07-08T18:57:23", "2026-07-08T10:57:23.000Z"),
    ];
    for (local, expected) in cases {
        let activity = json!({ "id": local, "type": "Run", "start_date": null, "start_date_local": local });
        let session = normalize_intervals_activity(&activity, "activities", "Asia/Hong_Kong").unwrap().unwrap();
        assert_eq!(session["startAt"], expected);
        assert_eq!(session["timezone"], "Asia/Hong_Kong");
    }
    let utc = json!({ "id": "utc", "start_date": "2026-08-29T09:44:36Z", "start_date_local": "2026-08-29T17:44:36" });
    let session = normalize_intervals_activity(&utc, "activities", "Asia/Hong_Kong").unwrap().unwrap();
    assert_eq!(session["startAt"], "2026-08-29T09:44:36.000Z");
    assert_eq!(session["timezone"], Value::Null);
    let invalid_primary = json!({ "id": "local", "start_date": "invalid", "start_date_local": "2026-08-15T17:26:49" });
    assert_eq!(normalize_intervals_activity(&invalid_primary, "activities", "Asia/Hong_Kong").unwrap().unwrap()["startAt"], "2026-08-15T09:26:49.000Z");
    let final_fallback = json!({ "id": "start", "start_date_local": "invalid", "start": "2026-08-15T09:26:49Z" });
    assert_eq!(normalize_intervals_activity(&final_fallback, "activities", "Asia/Hong_Kong").unwrap().unwrap()["startAt"], "2026-08-15T09:26:49.000Z");
}

#[test]
fn explicit_sync_windows_preserve_the_requested_days() {
    for days in [1, 10, 30, 90] {
        let actual = sync_date_window(
            Some("2026-09-05T10:00:00Z"),
            Some(days),
            "2026-09-11T12:00:00.000Z",
        )
        .unwrap();

        assert_eq!(actual.days, days);
    }
}
