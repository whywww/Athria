//! Deterministic schedule expansion for supported training rhythms.
//! `expandSchedule`.
//!
//! The TypeScript implementation moves `Date` values at 12:00 UTC so that day
//! arithmetic can never be affected by local timezones, then derives weekday
//! numbers and week numbers from the elapsed day count. The port reproduces
//! exactly that behavior with civil date math (see [`crate::date`]), keeping
//! occurrence order, slot identifiers, weekday numbers and week numbers
//! identical; the golden fixtures under `tests/fixtures` verify it.

use serde::Serialize;
use serde_json::Value;

use crate::date;
use crate::json::{array_field, int_field, string_field};

/// One planned training slot produced by [`expand_schedule`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleOccurrence {
    pub ordinal: usize,
    pub slot_id: String,
    pub scheduled_date: String,
    /// `scheduleWeekday`: 0 = Monday ... 6 = Sunday.
    pub day_of_week: u32,
    pub week_number: i64,
}

fn combinations(values: &[i64], count: usize) -> Vec<Vec<i64>> {
    if count == 0 {
        return vec![Vec::new()];
    }
    if values.len() < count {
        return Vec::new();
    }
    let mut output = Vec::new();
    for index in 0..=values.len() - count {
        for tail in combinations(&values[index + 1..], count - 1) {
            let mut choice = Vec::with_capacity(count);
            choice.push(values[index]);
            choice.extend(tail);
            output.push(choice);
        }
    }
    output
}

/// Picks the offsets that best approximate even spacing inside a seven-day
/// week, with the TypeScript tie-break on the joined offset list.
fn evenly_spaced_offsets(candidates: &[i64], count: usize) -> Vec<i64> {
    let choices = combinations(candidates, count);
    let ideal: Vec<f64> = (0..count)
        .map(|index| ((index + 1) as f64 * 7.0 / (count + 1) as f64) - 1.0)
        .collect();
    let mut scored: Vec<(f64, String, Vec<i64>)> = choices
        .into_iter()
        .map(|choice| {
            let score = choice
                .iter()
                .enumerate()
                .map(|(index, value)| (*value as f64 - ideal[index]).powi(2))
                .sum::<f64>();
            let tie_break = choice
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join(",");
            (score, tie_break, choice)
        })
        .collect();
    scored.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    scored
        .into_iter()
        .next()
        .map(|(_, _, choice)| choice)
        .unwrap_or_default()
}

fn add(
    occurrences: &mut Vec<ScheduleOccurrence>,
    start_day: i64,
    end_offset: i64,
    scheduled_date: String,
    slot_id: String,
) {
    let elapsed = date::epoch_day(&scheduled_date) - start_day;
    if elapsed < 0 || elapsed >= end_offset {
        return;
    }
    occurrences.push(ScheduleOccurrence {
        ordinal: occurrences.len(),
        slot_id,
        day_of_week: date::monday_weekday(&scheduled_date),
        week_number: elapsed / 7 + 1,
        scheduled_date,
    });
}

pub fn expand_schedule(
    effective_start_date: &str,
    duration_weeks: i64,
    schedule: &Value,
) -> Vec<ScheduleOccurrence> {
    let end_offset = duration_weeks * 7;
    let start_day = date::epoch_day(effective_start_date);
    let mut occurrences: Vec<ScheduleOccurrence> = Vec::new();
    match string_field(schedule, "kind") {
        "fixed_week" => {
            let days: Vec<i64> = array_field(schedule, "days")
                .iter()
                .filter_map(Value::as_i64)
                .collect();
            for offset in 0..end_offset {
                let scheduled_date = date::add_days(effective_start_date, offset);
                let weekday = date::monday_weekday(&scheduled_date);
                if days.contains(&(weekday as i64)) {
                    add(
                        &mut occurrences,
                        start_day,
                        end_offset,
                        scheduled_date,
                        format!("weekday-{weekday}"),
                    );
                }
            }
        }
        "flexible_week" => {
            let target_days = int_field(schedule, "targetDaysPerWeek") as usize;
            let candidates: Vec<i64> = (0..7).collect();
            for week in 0..duration_weeks {
                for (index, offset) in evenly_spaced_offsets(&candidates, target_days)
                    .iter()
                    .enumerate()
                {
                    let scheduled_date = date::add_days(effective_start_date, week * 7 + offset);
                    add(
                        &mut occurrences,
                        start_day,
                        end_offset,
                        scheduled_date,
                        format!("flex-{}-{}", week + 1, index + 1),
                    );
                }
            }
        }
        _ => {
            let interval_days = int_field(schedule, "intervalDays");
            let mut cursor = effective_start_date.to_string();
            let mut index = 0i64;
            while date::epoch_day(&cursor) - start_day < end_offset {
                add(
                    &mut occurrences,
                    start_day,
                    end_offset,
                    cursor.clone(),
                    format!("interval-{}", index + 1),
                );
                index += 1;
                cursor = date::add_days(&cursor, interval_days);
            }
        }
    }
    occurrences
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dates(occurrences: &[ScheduleOccurrence]) -> Vec<String> {
        occurrences
            .iter()
            .map(|occurrence| occurrence.scheduled_date.clone())
            .collect()
    }

    #[test]
    fn fixed_week_matches_the_typescript_dates() {
        let occurrences = expand_schedule(
            "2026-09-07",
            2,
            &json!({ "kind": "fixed_week", "days": [0, 3] }),
        );
        assert_eq!(
            dates(&occurrences),
            ["2026-09-07", "2026-09-10", "2026-09-14", "2026-09-17"]
        );
        assert_eq!(occurrences[0].slot_id, "weekday-0");
        assert_eq!(occurrences[0].week_number, 1);
        assert_eq!(occurrences[3].week_number, 2);
        assert_eq!(occurrences[3].ordinal, 3);
    }

    #[test]
    fn flexible_and_interval_match_the_typescript_counts() {
        let flexible = expand_schedule(
            "2026-09-07",
            1,
            &json!({ "kind": "flexible_week", "targetDaysPerWeek": 3, "minDaysPerWeek": 2, "maxDaysPerWeek": 4 }),
        );
        assert_eq!(flexible.len(), 3);
        assert_eq!(flexible[0].slot_id, "flex-1-1");
        let interval = expand_schedule(
            "2026-09-07",
            1,
            &json!({ "kind": "interval", "intervalDays": 2 }),
        );
        assert_eq!(
            dates(&interval),
            ["2026-09-07", "2026-09-09", "2026-09-11", "2026-09-13"]
        );
    }

    #[test]
    fn schedules_cross_month_and_year_boundaries() {
        let crossing_month = expand_schedule(
            "2026-01-26",
            2,
            &json!({ "kind": "fixed_week", "days": [4] }),
        );
        assert_eq!(dates(&crossing_month), ["2026-01-30", "2026-02-06"]);
        let crossing_year = expand_schedule(
            "2025-12-29",
            2,
            &json!({ "kind": "fixed_week", "days": [3] }),
        );
        assert_eq!(dates(&crossing_year), ["2026-01-01", "2026-01-08"]);
    }
}
