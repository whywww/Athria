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
            normalize_intervals_activity(&case["item"], case["resource"].as_str().unwrap())
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
