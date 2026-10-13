use athria_integrations::{
    normalize_intervals_activity, normalize_xunji_training, parse_hevy_csv,
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
fn intervals_imports_independent_loads_and_unscaled_intensity() {
    let mut activity = json!({"id":"loads","start_date":"2026-10-12T11:04:00Z","elapsed_time":3169,
        "icu_training_load":10,"power_load":0,"hr_load":10.5,"pace_load":5,"icu_intensity":133.70999});
    let session = normalize_intervals_activity(&activity, "activities", "Asia/Hong_Kong").unwrap().unwrap();
    for (field, expected) in [("trainingLoad",10.0),("powerLoad",0.0),("hrLoad",10.5),("paceLoad",5.0),("intensity",133.70999)] {
        assert_eq!(session[field].as_f64(), Some(expected));
    }
    activity["icu_training_load"] = Value::Null;
    activity["power_load"] = json!(-1);
    activity["hr_load"] = json!("bad");
    activity.as_object_mut().unwrap().remove("pace_load");
    activity["icu_intensity"] = json!(-1);
    let session = normalize_intervals_activity(&activity, "activities", "Asia/Hong_Kong").unwrap().unwrap();
    for field in athria_core::schema::session::API_SESSION_METRICS { assert_eq!(session[field], Value::Null); }
}

#[test]
fn intervals_imports_rpe_and_prefers_reported_session_load() {
    for (rpe, load, expected_rpe, expected_load) in [
        (json!(3), json!(118), json!(3), json!(118)),
        (json!(3), Value::Null, json!(3), json!(159)),
        (json!(2.5), json!(-1), json!(2.5), json!(132.5)),
        (json!(0), json!(0), json!(0), json!(0)),
        (json!(11), json!("bad"), Value::Null, Value::Null),
        (Value::Null, Value::Null, Value::Null, Value::Null),
    ] {
        let activity = json!({ "id": "swim-rpe", "type": "OpenWaterSwim", "start_date": "2026-10-12T11:04:00Z", "elapsed_time": 3169, "icu_rpe": rpe, "session_rpe": load });
        let session = normalize_intervals_activity(&activity, "activities", "Asia/Hong_Kong").unwrap().unwrap();
        assert_eq!(session["rpe"], expected_rpe);
        assert_eq!(session["sessionRpe"], expected_load);
    }
}

#[test]
fn intervals_uses_elapsed_time_for_training_duration() {
    let activity = json!({ "id": "i196655523", "type": "OpenWaterSwim", "start_date": "2026-10-12T11:04:00Z", "elapsed_time": 3169, "moving_time": 2372, "icu_recording_time": 3168 });
    let session = normalize_intervals_activity(&activity, "activities", "Asia/Hong_Kong").unwrap().unwrap();
    assert_eq!(session["durationMinutes"], 53);
    assert!(session.get("endAt").is_none());
    for (times, expected) in [
        (json!({ "elapsed_time": 1800, "icu_recording_time": 1200, "moving_time": 600 }), 30),
        (json!({ "icu_recording_time": 1200, "moving_time": 600 }), 20),
        (json!({ "moving_time": 600 }), 10),
        (json!({ "duration": 45 }), 0),
    ] {
        let mut activity = json!({ "id": "duration-priority", "start_date": "2026-10-12T11:04:00Z" });
        activity.as_object_mut().unwrap().extend(times.as_object().unwrap().clone());
        let session = normalize_intervals_activity(&activity, "activities", "Asia/Hong_Kong").unwrap().unwrap();
        assert_eq!(session["durationMinutes"], expected);
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

#[test]
fn intervals_normalizes_sport_families_and_domains() {
    let families = [
        ("Swim", "endurance", vec!["Swim", "OpenWaterSwim", "PoolSwim"]),
        ("Run", "endurance", vec!["Run", "TrailRun", "VirtualRun"]),
        ("Ride", "endurance", vec!["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "TrackRide", "Cyclocross", "EBikeRide", "EMountainBikeRide"]),
        ("Rowing", "endurance", vec!["Rowing", "VirtualRow"]),
        ("Hike", "endurance", vec!["Hike"]),
        ("Walk", "endurance", vec!["Walk"]),
    ];
    let normalize = |kind: Value| normalize_intervals_activity(&json!({
        "id": "test", "type": kind, "start_date": "2026-10-07T11:03:08Z"
    }), "activities", "Asia/Hong_Kong").unwrap().unwrap();
    for (sport, domain, aliases) in families {
        for alias in aliases {
            for input in [alias.to_owned(), alias.to_lowercase(), alias.chars().map(|c| c.to_string()).collect::<Vec<_>>().join(" - ")] {
                let session = normalize(json!(input));
                assert_eq!(session["type"], sport);
                assert_eq!(session["domains"], json!([domain]));
            }
        }
    }
    for sport in ["Tennis", "TableTennis", "Badminton", "Padel", "Pickleball", "Squash", "Racquetball"] {
        let session = normalize(json!(sport));
        assert_eq!(session["type"], sport);
        assert_eq!(session["domains"], json!(["sport_skill"]));
    }
    let unknown = normalize(json!("NotReallySwim"));
    assert_eq!(unknown["type"], "NotReallySwim");
    assert_eq!(unknown["domains"], json!([]));
    for invalid in [Value::Null, json!(""), json!("  "), json!(42), json!({})] {
        let session = normalize_intervals_activity(&json!({
            "id": "fallback", "type": invalid, "sport": "OpenWaterSwim", "name": "Run",
            "start_date": "2026-10-07T11:03:08Z"
        }), "activities", "Asia/Hong_Kong").unwrap().unwrap();
        assert_eq!(session["type"], "Swim");
    }
    let session = normalize_intervals_activity(&json!({
        "id": "priority", "type": "Unlisted", "sport": "Swim", "name": "Swim",
        "start_date": "2026-10-07T11:03:08Z"
    }), "activities", "Asia/Hong_Kong").unwrap().unwrap();
    assert_eq!(session["type"], "Unlisted");
    assert_eq!(session["domains"], json!([]));
}

#[test]
fn xunji_uses_explicit_cardio_types_and_keeps_conflicts_unclassified() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/integrations.json")).unwrap();
    let mut strength = fixture["xunji"][0]["input"].clone();
    strength["movements"][0]["metrics"] = json!({"avgHeartRate":140});
    assert_eq!(normalize_xunji_training(&strength).unwrap()["type"], "StrengthTraining");
    let mut input = fixture["xunji"][1]["input"].clone();
    let session = normalize_xunji_training(&input).unwrap();
    assert_eq!(session["type"], "Run");
    assert_eq!(session["domains"], json!(["endurance"]));
    input["movements"][0]["recordPreset"] = Value::Null;
    assert_eq!(normalize_xunji_training(&input).unwrap()["type"], "Run");
    input["movements"][0]["name"] = json!("Unknown cardio");
    assert_eq!(normalize_xunji_training(&input).unwrap()["domains"], json!([]));
    input["movements"] = json!([{ "cardio":true,"recordPreset":"Run","metrics":{} }, {"cardio":true,"recordPreset":"Ride","metrics":{}}]);
    assert_eq!(normalize_xunji_training(&input).unwrap()["type"], Value::Null);
}

#[test]
fn intervals_adapter_covers_every_alias_without_metric_inference() {
    for (kind, domain, aliases) in athria_core::training_type::TYPES {
        for alias in *aliases {
            let session = normalize_intervals_activity(&json!({"id":"classification","type":alias,"start_date":"2026-10-07T11:00:00Z","moving_time":3540,"average_heartrate":140}), "activities", "Asia/Hong_Kong").unwrap().unwrap();
            assert_eq!(session["type"], *kind);
            assert_eq!(session["domains"], json!([domain]));
            assert_eq!(session["subtype"], json!(athria_core::training_type::classify(alias).unwrap().1));
        }
    }
}
