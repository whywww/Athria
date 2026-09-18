use athria_core::{AdjustmentAssessment, AdjustmentInput, assess_adjustment};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Fixture {
    input: AdjustmentInput,
    expected: Value,
}

#[test]
fn adjustment_assessment_matches_the_golden_contract() {
    for source in [
        include_str!("fixtures/adjustment/weekly_minor_adherence.json"),
        include_str!("fixtures/adjustment/profile_rhythm_conflict.json"),
    ] {
        let fixture: Fixture = serde_json::from_str(source).unwrap();
        let assessment: AdjustmentAssessment = assess_adjustment(&fixture.input);
        assert_eq!(serde_json::to_value(assessment).unwrap(), fixture.expected);
    }
}
