//! Readiness: a daily estimate, not a validated measure of recovery or injury risk.
//! Inputs belong to the evening before assessment_day. No input after that day is used.
use std::collections::{BTreeMap, HashSet};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::{date, tz};

pub const ALGORITHM_VERSION: &str = "athria-readiness-percentile-load";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessAssessment {
    pub algorithm_version: String,
    pub assessment_day: String,
    pub score: Option<i64>,
    pub status: String,
    pub cardiac_score: Option<f64>,
    pub sleep_score: Option<f64>,
    pub subjective_score: Option<f64>,
    pub base_score: Option<f64>,
    pub load_adjustment: f64,
    pub load_method: Option<String>,
    pub training_load: TrainingLoadAssessment,
    pub score_cap: Option<f64>,
    pub data_quality: String,
    pub missing_reasons: Vec<String>,
    pub hrv_field: Option<String>,
    pub heart_rate_field: Option<String>,
    pub hrv_baseline_days: usize,
    pub heart_rate_baseline_days: usize,
}

/// Statistics retain their original units; only normalized adjustments are combined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingLoadGroup {
    pub activity_type: Option<String>,
    pub method: String,
    pub recent_session_count: usize,
    pub valid_session_count: usize,
    pub duration_minutes: f64,
    pub known_load: Option<f64>,
    pub known_pressure: Option<f64>,
    pub complete: bool,
    pub history_windows: usize,
    pub reference_days: usize,
    pub reference_span_days: usize,
    pub percentile: Option<f64>,
    pub evidence_weight: f64,
    pub raw_adjustment: f64,
    pub weighted_adjustment: f64,
    pub duration_share: f64,
    pub eligible: bool,
    pub selected: bool,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingLoadAssessment {
    pub status: String,
    pub recent_session_count: usize,
    pub duration_minutes: f64,
    pub rated_session_count: usize,
    pub known_rpe_load: Option<f64>,
    pub known_rpe_pressure: Option<f64>,
    pub groups: Vec<TrainingLoadGroup>,
    pub combined_adjustment: f64,
    pub wellness_factor: f64,
}

fn raw_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}
fn number(record: &Value, key: &str) -> Option<f64> {
    raw_number(&record["fields"][key]["value"])
}
fn bounded(record: &Value, key: &str, max: f64) -> Option<f64> {
    number(record, key).filter(|v| (0.0..=max).contains(v))
}
fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 { sorted[mid - 1] / 2.0 + sorted[mid] / 2.0 } else { sorted[mid] }
}
fn mad(values: &[f64], center: f64) -> f64 {
    median(&values.iter().map(|v| (v - center).abs()).collect::<Vec<_>>())
}
fn day_of(record: &Value) -> Option<i64> {
    record["day"].as_str().filter(|day| date::is_iso_date(day)).map(date::epoch_day)
}
fn same_owner(a: &Value, b: &Value) -> bool { a["ownerId"] == b["ownerId"] }

fn heart_signal(current: &Value, records: &[Value], key: &str, hrv: bool) -> Option<(f64, usize)> {
    let value = number(current, key).filter(|v| *v > 0.0)?;
    let day = day_of(current)?;
    let source = current["fields"][key]["source"].as_str()?;
    let transform = |v: f64| if hrv { v.ln() } else { v };
    let mut days = BTreeMap::new();
    for record in records.iter().filter(|r| same_owner(r, current)) {
        let Some(previous) = day_of(record).filter(|d| *d >= day - 28 && *d < day) else { continue };
        if record["fields"][key]["source"].as_str() != Some(source) { continue; }
        if let Some(v) = number(record, key).filter(|v| *v > 0.0) { days.insert(previous, transform(v)); }
    }
    if days.len() < 7 { return None; }
    let values: Vec<f64> = days.into_values().collect();
    let usual = median(&values);
    let scale = (1.4826 * mad(&values, usual)).max(if hrv { 0.05 } else { 3.0 });
    let difference = if hrv { usual - transform(value) } else { value - usual };
    Some((85.0 - 20.0 * (difference / scale).clamp(0.0, 3.0), values.len()))
}
fn duration_score(seconds: f64) -> f64 {
    let hours = seconds / 3600.0;
    let nodes = [(0.0, 0.0), (4.0, 25.0), (6.0, 60.0), (7.0, 80.0), (8.0, 90.0)];
    for pair in nodes.windows(2) {
        let [(x0, y0), (x1, y1)] = pair else { unreachable!() };
        if hours <= *x1 { return y0 + (hours - x0) / (x1 - x0) * (y1 - y0); }
    }
    90.0
}
fn sleep_duration(current: &Value) -> Option<f64> {
    bounded(current, "sleepSeconds", 86400.0).filter(|v| v.fract() == 0.0)
}

#[derive(Clone, Copy)]
struct Session<'a> { day: i64, value: &'a Value }
fn sessions_before<'a>(current: &Value, sessions: &'a [Value], morning: i64, timezone: &str) -> Vec<Session<'a>> {
    let mut ids = HashSet::new();
    sessions.iter().filter_map(|session| {
        if !same_owner(current, session) || session["status"].as_str() != Some("completed") { return None; }
        let start = session["startAt"].as_str()?;
        let local = if session["timePrecision"] == "date_only" {
            let source_zone = session["timezone"].as_str().unwrap_or(timezone);
            tz::local_date(start, source_zone).ok()?
        } else { tz::local_date(start, timezone).ok()? };
        let day = date::epoch_day(&local);
        if day < morning - 35 || day >= morning { return None; }
        if let Some(id) = session["id"].as_str() {
            if !ids.insert(id) { return None; }
        }
        Some(Session { day, value: session })
    }).collect()
}
fn session_load(session: &Value, method: &str) -> Option<f64> {
    if method == "sessionRpe" {
        let rpe = raw_number(&session["rpe"]).filter(|v| (1.0..=10.0).contains(v) && v.fract() == 0.0)?;
        let duration = raw_number(&session["durationMinutes"]).filter(|v| *v >= 0.0 && v.fract() == 0.0)?;
        return Some(rpe * duration).filter(|v| v.is_finite());
    }
    raw_number(&session[method]).filter(|v| *v >= 0.0)
}
fn pressure(sessions: &[Session<'_>], morning: i64, method: &str) -> Option<f64> {
    let mut total = 0.0;
    for session in sessions.iter().filter(|s| s.day >= morning - 7 && s.day < morning) {
        total += session_load(session.value, method)? * 2.0_f64.powf(-((morning - 1 - session.day) as f64) / 2.0);
    }
    total.is_finite().then_some(total)
}
fn percentile(current: f64, history: &[f64]) -> f64 {
    history.iter().map(|previous| {
        let tolerance = 1e-9 * current.abs().max(previous.abs()).max(1.0);
        if (current - previous).abs() <= tolerance { 0.5 }
        else if *previous < current { 1.0 } else { 0.0 }
    }).sum::<f64>() / history.len() as f64
}
fn raw_adjustment(rank: f64) -> f64 { 15.0 * ((rank - 0.75) / 0.25).clamp(0.0, 1.0) }
fn duration(session: &Value) -> f64 {
    raw_number(&session["durationMinutes"]).filter(|v| *v >= 0.0 && v.fract() == 0.0).unwrap_or(0.0)
}
fn load_group(sessions: &[Session<'_>], morning: i64, method: &str, activity_type: Option<&str>) -> TrainingLoadGroup {
    let recent: Vec<_> = sessions.iter().filter(|s| s.day >= morning - 7).collect();
    let valid: Vec<_> = recent.iter().filter_map(|s| session_load(s.value, method).map(|load| (s.day, load))).collect();
    let known_load: f64 = valid.iter().map(|(_, v)| *v).sum();
    let known_pressure: f64 = valid.iter().map(|(day, load)| load * 2.0_f64.powf(-((morning - 1 - day) as f64) / 2.0)).sum();
    let known = !valid.is_empty() || recent.is_empty();
    let complete = valid.len() == recent.len() && known_load.is_finite() && known_pressure.is_finite();
    let reference: std::collections::BTreeSet<_> = sessions.iter()
        .filter(|s| s.day < morning - 1 && session_load(s.value, method).is_some()).map(|s| s.day).collect();
    let span = reference.first().zip(reference.last()).map_or(0, |(first, last)| (last - first + 1) as usize);
    let history: Vec<_> = (1..=28).filter_map(|offset| pressure(sessions, morning - offset, method)).collect();
    let eligible = complete && history.len() >= 7 && reference.len() >= 3;
    let rank = eligible.then(|| percentile(known_pressure, &history));
    let evidence = if eligible { (history.len() as f64 / 28.0).min(1.0) * (reference.len() as f64 / 7.0).min(1.0) * (span as f64 / 28.0).min(1.0) } else { 0.0 };
    let raw = rank.map_or(0.0, raw_adjustment);
    TrainingLoadGroup {
        activity_type: activity_type.map(str::to_owned), method: method.into(),
        recent_session_count: recent.len(), valid_session_count: valid.len(),
        duration_minutes: recent.iter().map(|s| duration(s.value)).sum(),
        known_load: (known && known_load.is_finite()).then_some(known_load),
        known_pressure: (known && known_pressure.is_finite()).then_some(known_pressure),
        complete, history_windows: history.len(), reference_days: reference.len(), reference_span_days: span,
        percentile: rank, evidence_weight: evidence, raw_adjustment: raw, weighted_adjustment: raw * evidence,
        duration_share: 0.0, eligible, selected: false,
        status: if !complete { "incomplete" } else if !eligible { "building_baseline" } else if raw == 0.0 { "not_elevated" } else { "eligible" }.into(),
    }
}
fn atl_group(current: &Value, records: &[Value]) -> Option<TrainingLoadGroup> {
    let evening = day_of(current)?;
    let atl = number(current, "atl").filter(|v| *v >= 0.0)?;
    let ctl = number(current, "ctl").filter(|v| *v >= 0.0)?;
    let source = current["fields"]["atl"]["source"].as_str()?;
    if current["fields"]["ctl"]["source"].as_str() != Some(source) { return None; }
    let mut days = BTreeMap::new();
    for record in records.iter().filter(|r| same_owner(r, current)) {
        let Some(day) = day_of(record).filter(|d| *d >= evening - 28 && *d < evening) else { continue };
        if record["fields"]["atl"]["source"].as_str() != Some(source) || record["fields"]["ctl"]["source"].as_str() != Some(source) { continue; }
        if let Some((a, c)) = number(record, "atl").filter(|v| *v >= 0.0).zip(number(record, "ctl").filter(|v| *v >= 0.0)) { days.insert(day, a - c); }
    }
    let eligible = days.len() >= 7;
    let span = days.first_key_value().zip(days.last_key_value()).map_or(0, |((first, _), (last, _))| (last - first + 1) as usize);
    let history: Vec<_> = days.values().copied().collect();
    let balance = atl - ctl;
    let rank = eligible.then(|| percentile(balance, &history));
    let evidence = if eligible { (days.len() as f64 / 28.0).min(1.0) * (span as f64 / 28.0).min(1.0) } else { 0.0 };
    let raw = if balance <= 0.0 { 0.0 } else { rank.map_or(0.0, raw_adjustment) };
    Some(TrainingLoadGroup {
        activity_type: None, method: "atlCtl".into(), recent_session_count: 0, valid_session_count: 0,
        duration_minutes: 0.0, known_load: None, known_pressure: Some(balance), complete: true,
        history_windows: days.len(), reference_days: days.len(), reference_span_days: span,
        percentile: rank, evidence_weight: evidence, raw_adjustment: raw, weighted_adjustment: raw * evidence,
        duration_share: 1.0, eligible, selected: eligible,
        status: if !eligible { "building_baseline" } else if raw == 0.0 { "not_elevated" } else { "eligible" }.into(),
    })
}
fn training_assessment(current: &Value, records: &[Value], sessions: &[Value], timezone: &str) -> TrainingLoadAssessment {
    let morning = day_of(current).expect("validated wellness day") + 1;
    let sessions = sessions_before(current, sessions, morning, timezone);
    let overall = load_group(&sessions, morning, "sessionRpe", None);
    let mut result = TrainingLoadAssessment {
        status: String::new(), recent_session_count: overall.recent_session_count, duration_minutes: overall.duration_minutes,
        rated_session_count: overall.valid_session_count, known_rpe_load: overall.known_load, known_rpe_pressure: overall.known_pressure,
        groups: Vec::new(), combined_adjustment: 0.0, wellness_factor: 0.0,
    };
    if overall.complete && overall.eligible {
        let mut group = overall;
        group.selected = true;
        group.duration_share = if result.duration_minutes > 0.0 { 1.0 } else { 0.0 };
        result.groups.push(group);
    } else if result.recent_session_count == 0 {
        result.groups.push(overall);
    } else {
        let types: std::collections::BTreeSet<_> = sessions.iter().filter(|s| s.day >= morning - 7).map(|s| s.value["type"].as_str()).collect();
        for kind in types {
            let scoped: Vec<_> = sessions.iter().filter(|s| s.value["type"].as_str() == kind).copied().collect();
            let candidates: Vec<_> = ["sessionRpe", "trainingLoad", "powerLoad", "hrLoad", "paceLoad"].into_iter()
                .filter(|method| *method == "sessionRpe" || kind.is_some())
                .map(|method| load_group(&scoped, morning, method, kind)).collect();
            let index = candidates.iter().position(|g| g.eligible)
                .or_else(|| candidates.iter().position(|g| g.valid_session_count > 0)).unwrap_or(0);
            let mut group = candidates.into_iter().nth(index).expect("RPE candidate exists");
            group.selected = group.eligible;
            group.duration_share = if result.duration_minutes > 0.0 { group.duration_minutes / result.duration_minutes } else { 0.0 };
            result.groups.push(group);
        }
    }
    if !result.groups.iter().any(|g| g.selected) {
        if let Some(group) = atl_group(current, records) { result.groups.push(group); }
    }
    result.combined_adjustment = result.groups.iter().filter(|g| g.selected)
        .map(|g| g.weighted_adjustment * g.duration_share).sum();
    // Explicit zero-duration training cannot create a correction from session groups.
    // ATL/CTL remains a separate fallback even when there are no recent workouts.
    let selected = result.groups.iter().any(|g| g.selected);
    result.status = if selected { "not_elevated" } else if result.recent_session_count == 0 { "no_training" }
        else if result.groups.iter().any(|g| !g.complete) { "incomplete" } else { "building_baseline" }.into();
    result
}
fn wellness_load_factor(base: Option<f64>, cap: Option<f64>) -> f64 {
    base.map_or(0.0, |b| ((b.min(cap.unwrap_or(100.0)) - 45.0) / 25.0).clamp(0.0, 1.0))
}

pub fn status_for_score(score: Option<i64>) -> &'static str {
    match score { Some(70..) => "Ready", Some(45..) => "Caution", Some(_) => "Rest", None => "Insufficient data" }
}

/// `current.day` is the evening D-1. Callers supply canonical, deduplicated history.
/// Missing fields are unavailable; dates with no recorded training count as zero load.
pub fn assess_readiness(current: &Value, records: &[Value], sessions: &[Value], timezone: &str) -> ReadinessAssessment {
    let hrv = ["hrvRmssdMs", "hrvSdnnMs"].into_iter().find_map(|key| heart_signal(current, records, key, true).map(|(score, count)| (key, score, count)));
    let heart = ["restingHeartRateBpm", "avgSleepingHeartRateBpm"].into_iter().find_map(|key| heart_signal(current, records, key, false).map(|(score, count)| (key, score, count)));
    let cardiac = match (hrv, heart) {
        (Some((_, h, _)), Some((_, r, _))) => Some(0.6 * h + 0.4 * r),
        (Some((_, v, _)), None) | (None, Some((_, v, _))) => Some(v),
        _ => None,
    };
    let quality = bounded(current, "sleepScore", 100.0);
    let duration = sleep_duration(current);
    let sleep = match (quality, duration.map(duration_score)) {
        (Some(q), Some(d)) => Some(0.6 * q + 0.4 * d),
        (Some(v), None) | (None, Some(v)) => Some(v),
        _ => None,
    };
    let fatigue = bounded(current, "subjectiveFatigue", 100.0);
    let subjective = fatigue.map(|f| 100.0 - f);
    let dimensions = [(cardiac, 0.4), (sleep, 0.35), (subjective, 0.25)];
    let count = dimensions.iter().filter(|(v, _)| v.is_some()).count();
    let weight: f64 = dimensions.iter().filter_map(|(v, w)| v.map(|_| w)).sum();
    let base = (count >= 2).then(|| dimensions.iter().filter_map(|(v, w)| v.map(|v| v * w)).sum::<f64>() / weight);
    let mut load = training_assessment(current, records, sessions, timezone);
    let mut reasons = Vec::new();
    for (value, reason) in [(cardiac, "Cardiac baseline unavailable"), (sleep, "Sleep not included"), (subjective, "Subjective fatigue not included")] {
        if value.is_none() { reasons.push(reason.into()); }
    }
    if cardiac.is_some() && (hrv.is_none() || heart.is_none()) { reasons.push("Partial cardiac signals".into()); }
    if hrv.is_some_and(|(_, _, n)| n < 14) || heart.is_some_and(|(_, _, n)| n < 14) { reasons.push("Preliminary cardiac baseline".into()); }
    if load.groups.iter().any(|g| !g.complete) { reasons.push("Partial training load data".into()); }
    if load.groups.iter().any(|g| g.status == "building_baseline") { reasons.push("Training baseline is still developing".into()); }
    if count < 2 { reasons.push("At least two recovery dimensions required".into()); }
    let mut cap: Option<f64> = None;
    for (applies, limit) in [
        (fatigue.is_some_and(|f| f >= 75.0), 44.0),
        (fatigue.is_some_and(|f| f >= 50.0), 69.0),
        (duration == Some(0.0), 44.0),
        (duration.is_some_and(|d| d < 14400.0) || quality.is_some_and(|q| q <= 25.0), 69.0),
    ] { if applies { cap = Some(cap.unwrap_or(100.0).min(limit)); } }
    load.wellness_factor = wellness_load_factor(base, cap);
    let penalty = load.combined_adjustment * load.wellness_factor;
    let methods: Vec<_> = load.groups.iter().filter(|g| g.selected).map(|g| g.method.as_str()).collect();
    let method = if methods.len() > 1 { Some("mixed".to_string()) } else { methods.iter().next().map(|m| m.to_string()) };
    if method.is_some() {
        load.status = if load.recent_session_count == 0 && method.as_deref() != Some("atlCtl") { "no_training" }
            else if base.is_none() { "recovery_unavailable" } else if penalty > 0.0 { "applied" }
            else if load.combined_adjustment > 0.0 { "wellness_limited" } else { "not_elevated" }.into();
    }
    let supported = load.groups.iter().filter(|g| g.selected).all(|g| g.complete && g.evidence_weight >= 1.0)
        && load.groups.iter().filter(|g| g.selected).map(|g| g.duration_share).sum::<f64>() >= 1.0 - 1e-9;
    let score = base.map(|b| (b - penalty).clamp(0.0, 100.0).min(cap.unwrap_or(100.0)).round() as i64);
    let sufficient = count == 3 && hrv.is_some_and(|(_, _, n)| n >= 14) && heart.is_some_and(|(key, _, n)| key == "restingHeartRateBpm" && n >= 14) && supported;
    ReadinessAssessment {
        algorithm_version: ALGORITHM_VERSION.into(),
        assessment_day: day_of(current).map(|d| date::format_iso_date(d + 1)).unwrap_or_default(),
        score, status: status_for_score(score).into(), cardiac_score: cardiac, sleep_score: sleep,
        subjective_score: subjective, base_score: base, load_adjustment: penalty,
        load_method: method, training_load: load, score_cap: cap,
        data_quality: if score.is_none() { "insufficient" } else if sufficient { "sufficient" } else { "limited" }.into(),
        missing_reasons: reasons, hrv_field: hrv.map(|(key, _, _)| key.into()),
        heart_rate_field: heart.map(|(key, _, _)| key.into()),
        hrv_baseline_days: hrv.map_or(0, |(_, _, n)| n), heart_rate_baseline_days: heart.map_or(0, |(_, _, n)| n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn record(offset: i64, values: Value) -> Value {
        let fields: serde_json::Map<String, Value> = values.as_object().unwrap().iter().map(|(key, value)|
            (key.clone(), json!({"value":value,"source":"user","updatedAt":"2026-10-16T00:00:00Z"}))).collect();
        json!({"ownerId":"a","day":date::format_iso_date(date::epoch_day("2026-10-15")+offset),"fields":fields})
    }
    fn history() -> Vec<Value> {
        (1..=28).map(|n| record(-n, json!({"hrvRmssdMs":50,"restingHeartRateBpm":50,"avgSleepingHeartRateBpm":45,"atl":40,"ctl":40}))).collect()
    }
    fn assess(values: Value) -> ReadinessAssessment { assess_readiness(&record(0, values), &history(), &[], "Asia/Hong_Kong") }
    fn session(offset: i64, rpe: f64) -> Value {
        let day = date::format_iso_date(date::epoch_day("2026-10-15")+offset);
        json!({"id":format!("{offset}"),"ownerId":"a","startAt":format!("{day}T04:00:00Z"),"status":"completed","timePrecision":"exact","type":"Running","durationMinutes":60,"rpe":rpe,"sessionRpe":999999,"trainingLoad":60})
    }
    fn sessions() -> Vec<Value> { (0..35).map(|n| session(-n, 3.0)).collect() }
    #[test]
    fn sparse_month_statistics_are_included_instead_of_rejected_for_short_span() {
        let current=record(0,json!({"restingHeartRateBpm":57.65,"sleepScore":90,"subjectiveFatigue":72}));
        let mut workouts:Vec<_>=[-10,-8,-6,-5,-4,-3,-1].into_iter().map(|d| {
            let mut s=session(d,3.0); s["durationMinutes"]=json!(40); s
        }).collect();
        let mut extra=session(-4,3.0);extra["id"]=json!("extra");extra["durationMinutes"]=json!(40);workouts.push(extra);
        // A light latest workout follows the earlier denser block.
        workouts.iter_mut().find(|s| s["id"] == "-1").unwrap()["rpe"]=json!(1);
        let mut missing=session(-30,3.0); missing["rpe"]=Value::Null;workouts.push(missing);
        let result=assess_readiness(&current,&history(),&workouts,"UTC");
        assert_eq!(result.load_method.as_deref(),Some("sessionRpe"));
        let group=&result.training_load.groups[0];
        assert_eq!(group.history_windows,23); assert_eq!(group.reference_days,7); assert_eq!(group.reference_span_days,10);
        assert!((group.evidence_weight-23.0/28.0*10.0/28.0).abs()<1e-9);
        assert_eq!(result.training_load.recent_session_count,6);
        assert_eq!(result.training_load.rated_session_count,6);
        assert!(result.training_load.known_rpe_pressure.unwrap()>0.0);
        assert_eq!(result.score,Some(52));
        assert_eq!(result.training_load.status,"not_elevated");
    }

    #[test]
    fn short_history_is_usable_without_twenty_one_days_and_support_increases() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        let short:Vec<_>=[0,-2,-4,-6].into_iter().map(|d|session(d,3.0)).collect();
        let result=assess_readiness(&current,&[],&short,"UTC");
        let group=&result.training_load.groups[0];
        assert!(group.eligible); assert_eq!(group.reference_days,3); assert_eq!(group.reference_span_days,5);
        assert!(group.evidence_weight>0.0 && group.evidence_weight<1.0);
        let longer=assess_readiness(&current,&[],&sessions(),"UTC");
        assert_eq!(longer.training_load.groups[0].evidence_weight,1.0);
        let too_short:Vec<_>=[0,-2,-4].into_iter().map(|d|session(d,3.0)).collect();
        let result=assess_readiness(&current,&[],&too_short,"UTC");
        assert_eq!(result.training_load.status,"building_baseline");
        assert!(result.training_load.known_rpe_pressure.unwrap()>0.0); assert_eq!(result.load_adjustment,0.0);
    }
    #[test]
    fn rank_ties_zero_windows_and_missing_fields_have_distinct_meanings() {
        assert_eq!(percentile(0.0,&[0.0;28]),0.5);
        assert_eq!(percentile(10.0,&[0.0;28]),1.0);
        assert_eq!(percentile(10.0+1e-10,&[10.0;28]),0.5);
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        let empty=assess_readiness(&current,&[],&[],"UTC");
        assert_eq!(empty.training_load.status,"no_training"); assert_eq!(empty.training_load.known_rpe_pressure,Some(0.0));
        let mut workouts=sessions();
        workouts[0]["rpe"]=Value::Null; workouts[0]["trainingLoad"]=Value::Null;
        let partial=assess_readiness(&current,&[],&workouts,"UTC");
        assert_eq!(partial.training_load.status,"incomplete");
        assert_eq!(partial.training_load.rated_session_count,6);
        assert!(partial.training_load.known_rpe_load.unwrap()>0.0);
        assert!(!partial.training_load.groups[0].complete);
    }
    #[test]
    fn mixed_projects_choose_separate_units_and_preserve_unavailable_shares() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        let mut workouts=Vec::new();
        for d in 0..35 {
            for (kind,key) in [("Running","hrLoad"),("Cycling","powerLoad")] {
                let mut s=session(-d,3.0); s["id"]=json!(format!("{kind}-{d}"));
                s["type"]=json!(kind); s["rpe"]=Value::Null; s["trainingLoad"]=Value::Null;
                s[key]=json!(if d==0 {600.0} else {60.0}); workouts.push(s);
            }
        }
        let result=assess_readiness(&current,&[],&workouts,"UTC");
        assert_eq!(result.load_method.as_deref(),Some("mixed"));
        assert_eq!(result.training_load.groups.len(),2);
        assert!((result.load_adjustment-15.0).abs()<1e-9);
        for group in &result.training_load.groups { assert_eq!(group.duration_share,0.5); }
        // One group with missing current data contributes zero; its half is not redistributed.
        workouts[0]["hrLoad"]=Value::Null;
        let partial=assess_readiness(&current,&[],&workouts,"UTC");
        assert!((partial.load_adjustment-7.5).abs()<1e-9);
        assert!(partial.training_load.groups.iter().any(|g| !g.complete));
    }
    #[test]
    fn overlap_factor_uses_capped_wellness_and_is_continuous_at_boundaries() {
        for (base,expected) in [(30.0,0.0),(45.0,0.0),(57.5,0.5),(70.0,1.0),(90.0,1.0)] {
            assert_eq!(wellness_load_factor(Some(base),None),expected);
        }
        assert_eq!(wellness_load_factor(Some(90.0),Some(44.0)),0.0);
        assert_eq!(wellness_load_factor(None,None),0.0);
        assert!(wellness_load_factor(Some(45.00001),None)<0.000001);
        assert!(wellness_load_factor(Some(69.99999),None)>0.999999);
        let mut heavy=sessions(); heavy[0]["durationMinutes"]=json!(600);
        let mut current=record(0,json!({"sleepScore":90,"subjectiveFatigue":50}));
        let result=assess_readiness(&current,&[],&heavy,"UTC");
        assert!((result.load_adjustment-15.0*result.training_load.wellness_factor).abs()<1e-9);
        current["fields"]["subjectiveFatigue"]["value"]=json!(75);
        let result=assess_readiness(&current,&[],&heavy,"UTC");
        assert_eq!(result.load_adjustment,0.0); assert_eq!(result.training_load.status,"wellness_limited");
        assert_eq!(result.status,status_for_score(result.score));
    }
    #[test]
    fn atl_fallback_has_seven_day_minimum_and_partial_support_and_no_negative_penalty() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0,"atl":100,"ctl":40}));
        let short=assess_readiness(&current,&history()[..7],&[],"UTC");
        assert_eq!(short.load_method.as_deref(),Some("atlCtl"));
        assert!((short.training_load.groups.last().unwrap().evidence_weight-0.0625).abs()<1e-9);
        assert!(short.load_adjustment>0.0 && short.load_adjustment<15.0);
        let mut no_excess=current.clone(); no_excess["fields"]["atl"]["value"]=json!(0);
        assert_eq!(assess_readiness(&no_excess,&history()[..7],&[],"UTC").load_adjustment,0.0);
    }
    #[test]
    fn split_workouts_preserve_reference_days_rank_and_adjustment() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        let mut workouts:Vec<_>=[0,-2,-4,-6].into_iter().map(|d|session(d,3.0)).collect();
        let original=assess_readiness(&current,&[],&workouts,"UTC");
        for workout in &mut workouts { workout["durationMinutes"]=json!(30); }
        let extra:Vec<_>=workouts.iter().map(|s| {let mut copy=s.clone(); copy["id"]=json!(format!("split-{}",s["id"]));copy}).collect();
        workouts.extend(extra);
        let split=assess_readiness(&current,&[],&workouts,"UTC");
        let a=&original.training_load.groups[0]; let b=&split.training_load.groups[0];
        assert_eq!(a.reference_days,b.reference_days); assert_eq!(a.evidence_weight,b.evidence_weight);
        assert_eq!(a.percentile,b.percentile); assert_eq!(original.load_adjustment,split.load_adjustment);
    }

    #[test]
    fn all_dimension_combinations_and_rounding_boundaries() {
        for mask in 0..8 {
            let mut values=json!({});
            if mask & 1 != 0 { values["hrvRmssdMs"]=json!(50); }
            if mask & 2 != 0 { values["sleepScore"]=json!(85); }
            if mask & 4 != 0 { values["subjectiveFatigue"]=json!(0); }
            assert_eq!(assess(values).score.is_some(), (mask as u32).count_ones()>=2);
        }
        for (raw,score,status) in [(44.49,44,"Rest"),(44.51,45,"Caution"),(69.49,69,"Caution"),(69.51,70,"Ready")] {
            let sleep=(raw*0.6-25.0)/0.35;
            let result=assess(json!({"sleepScore":sleep,"subjectiveFatigue":0}));
            assert_eq!(result.score,Some(score)); assert_eq!(result.status,status);
        }
    }
    #[test]
    fn each_api_lane_is_a_whole_series_and_short_history_has_limited_weight() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        for method in ["trainingLoad","powerLoad","hrLoad","paceLoad"] {
            let mut workouts=sessions();
            for workout in &mut workouts {
                workout["rpe"]=Value::Null;
                workout["trainingLoad"]=Value::Null;
                workout[method]=json!(60.0);
            }
            workouts[0][method]=json!(600.0);
            let result=assess_readiness(&current,&[],&workouts,"UTC");
            assert_eq!(result.load_method.as_deref(),Some(method));
            assert_eq!(result.load_adjustment,15.0);
            workouts[0][method]=Value::Null;
            let result=assess_readiness(&current,&[],&workouts,"UTC");
            assert!(result.load_method.is_none()); assert_eq!(result.load_adjustment,0.0);
        }
        let workouts:Vec<_>=(0..7).map(|n|session(-n,10.0)).collect();
        let short=assess_readiness(&current,&[],&workouts,"UTC");
        assert_eq!(short.load_method.as_deref(),Some("sessionRpe"));
        assert!(short.training_load.groups[0].evidence_weight < 1.0);
        let mut zero=sessions();
        for session in &mut zero { session["rpe"]=Value::Null; session["trainingLoad"]=json!(0); }
        let result=assess_readiness(&current,&[],&zero,"UTC");
        assert_eq!(result.load_method.as_deref(),Some("trainingLoad"));
        assert_eq!(result.load_adjustment,0.0);
        assert_eq!(result.training_load.groups[0].percentile,Some(0.5));
    }
    #[test]
    fn later_wellness_and_mismatched_atl_sources_do_not_change_historical_estimates() {
        let current=record(0,json!({"hrvRmssdMs":50,"sleepScore":90,"subjectiveFatigue":0,"atl":100,"ctl":40}));
        let mut records=history();
        let before=assess_readiness(&current,&records,&sessions(),"UTC");
        records.push(record(1,json!({"hrvRmssdMs":1,"subjectiveFatigue":100,"atl":99999,"ctl":1})));
        assert_eq!(assess_readiness(&current,&records,&sessions(),"UTC"),before);
        let mut mismatch=current.clone(); mismatch["fields"]["ctl"]["source"]=json!("intervals_icu");
        assert!(assess_readiness(&mismatch,&history(),&[],"UTC").load_method.is_none());
        assert!(assess_readiness(&current,&history()[..6],&[],"UTC").load_method.is_none());
    }

    #[test]
    fn groups_correlated_signals_and_requires_two_dimensions() {
        let cardiac = assess(json!({"hrvRmssdMs":50,"restingHeartRateBpm":50}));
        assert_eq!(cardiac.cardiac_score, Some(85.0));
        assert_eq!(cardiac.score, None);
        assert_eq!(assess(json!({"sleepScore":90,"sleepSeconds":28800})).score, None);
        assert_eq!(assess(json!({"subjectiveFatigue":0})).score, None);
        assert_eq!(assess(json!({"sleepScore":90,"subjectiveFatigue":0})).score, Some(94));
        assert_eq!(assess(json!({"hrvRmssdMs":50,"restingHeartRateBpm":50,"sleepScore":85})).score, Some(85));
        assert_eq!(assess(json!({"hrvRmssdMs":50,"sleepScore":85,"subjectiveFatigue":0})).score, Some(89));
    }
    #[test]
    fn cardiac_baselines_exclude_target_future_other_owner_and_source() {
        let current = record(0, json!({"hrvRmssdMs":50,"sleepScore":85}));
        let mut records: Vec<_> = (1..=6).map(|n| record(-n, json!({"hrvRmssdMs":50}))).collect();
        records.extend([current.clone(), record(1,json!({"hrvRmssdMs":50})), record(-29,json!({"hrvRmssdMs":50}))]);
        let mut other = record(-7,json!({"hrvRmssdMs":50})); other["ownerId"] = json!("b"); records.push(other);
        let mut source = record(-8,json!({"hrvRmssdMs":50})); source["fields"]["hrvRmssdMs"]["source"] = json!("intervals_icu"); records.push(source);
        records.push(records[0].clone());
        assert_eq!(assess_readiness(&current,&records,&[],"UTC").score,None);
        records.push(record(-28,json!({"hrvRmssdMs":50})));
        let result = assess_readiness(&current,&records,&[],"UTC");
        assert_eq!(result.score,Some(85)); assert_eq!(result.hrv_baseline_days,7);
        assert_eq!(result.assessment_day,"2026-10-16");
    }
    #[test]
    fn cardiac_fallbacks_are_independent_and_mad_has_a_floor() {
        let records: Vec<_> = (1..=14).map(|n| record(-n,json!({"hrvSdnnMs":20,"avgSleepingHeartRateBpm":45}))).collect();
        let current = record(0,json!({"hrvRmssdMs":50,"hrvSdnnMs":20,"restingHeartRateBpm":50,"avgSleepingHeartRateBpm":48,"sleepScore":85}));
        let result = assess_readiness(&current,&records,&[],"UTC");
        assert_eq!(result.hrv_field.as_deref(),Some("hrvSdnnMs"));
        assert_eq!(result.heart_rate_field.as_deref(),Some("avgSleepingHeartRateBpm"));
        assert_eq!(result.cardiac_score,Some(77.0));
        assert_eq!(assess(json!({"hrvRmssdMs":5000,"sleepScore":85})).cardiac_score,Some(85.0));
        assert_eq!(assess(json!({"hrvRmssdMs":0,"restingHeartRateBpm":0,"sleepScore":85})).score,None);
    }
    #[test]
    fn sleep_interpolates_blends_and_preserves_zero_and_missing_values() {
        for (hours, expected) in [(0.0,0.0),(2.0,12.5),(4.0,25.0),(5.0,42.5),(6.0,60.0),(7.0,80.0),(7.5,85.0),(8.0,90.0),(12.0,90.0)] {
            assert_eq!(duration_score(hours*3600.0),expected);
        }
        assert_eq!(assess(json!({"sleepScore":80,"sleepSeconds":28800,"subjectiveFatigue":0})).sleep_score,Some(84.0));
        assert_eq!(assess(json!({"sleepScore":101,"sleepSeconds":25200,"subjectiveFatigue":0})).sleep_score,Some(80.0));
        for values in [json!({"sleepScore":null}),json!({"sleepScore":-1}),json!({"sleepSeconds":86401}),json!({"sleepSeconds":1.5})] {
            assert_eq!(assess(values).sleep_score,None);
        }
        assert_eq!(assess(json!({"sleepScore":0,"subjectiveFatigue":0})).sleep_score,Some(0.0));
    }
    #[test]
    fn caps_apply_before_rounding_and_status_only_depends_on_integer_score() {
        for (fatigue, max) in [(50,69),(74,69),(75,44),(100,44)] {
            assert!(assess(json!({"hrvRmssdMs":50,"sleepScore":100,"subjectiveFatigue":fatigue})).score.unwrap()<=max);
        }
        assert_eq!(assess(json!({"sleepSeconds":0,"subjectiveFatigue":0})).score,Some(42));
        assert!(assess(json!({"sleepSeconds":14399,"subjectiveFatigue":0})).score.unwrap()<=69);
        assert!(assess(json!({"sleepScore":25,"subjectiveFatigue":0})).score.unwrap()<=69);
        for (score,status) in [(44,"Rest"),(45,"Caution"),(69,"Caution"),(70,"Ready")] { assert_eq!(status_for_score(Some(score)),status); }
        assert_eq!(status_for_score(None),"Insufficient data");
    }
    #[test]
    fn load_uses_one_lane_recalculates_rpe_and_excludes_future_and_duplicate_sessions() {
        let current = record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        let mut sessions = sessions();
        let usual = assess_readiness(&current,&[],&sessions,"UTC");
        assert_eq!(usual.load_method.as_deref(),Some("sessionRpe")); assert_eq!(usual.load_adjustment,0.0);
        sessions[0]["durationMinutes"] = json!(0);
        let zero = assess_readiness(&current, &[], &sessions, "UTC");
        assert_eq!(zero.load_method.as_deref(), Some("sessionRpe"));
        assert_eq!(zero.load_adjustment, 0.0);
        sessions[0]["durationMinutes"] = json!(600);
        let heavy = assess_readiness(&current,&[],&sessions,"UTC");
        assert_eq!(heavy.load_adjustment,15.0); assert!(heavy.score<usual.score);
        sessions.extend([session(1,10.0),sessions[0].clone()]);
        let mut other = session(0,10.0); other["ownerId"] = json!("b"); sessions.push(other);
        assert_eq!(assess_readiness(&current,&[],&sessions,"UTC"),heavy);
        // Splitting a workout preserves pressure (reference eligibility already satisfied).
        sessions.truncate(35); sessions[0]["durationMinutes"] = json!(300);
        let mut split = sessions[0].clone(); split["id"] = json!("split"); sessions.push(split);
        assert_eq!(assess_readiness(&current,&[],&sessions,"UTC").load_adjustment,heavy.load_adjustment);
        sessions[0]["rpe"] = Value::Null;
        assert_eq!(assess_readiness(&current,&[],&sessions,"UTC").load_method.as_deref(),Some("trainingLoad"));
        sessions[0]["type"] = json!("Cycling");
        let grouped=assess_readiness(&current,&[],&sessions,"UTC");
        assert_eq!(grouped.training_load.groups.len(),2);
        assert!(grouped.training_load.groups.iter().any(|g| g.selected));
        assert!(grouped.training_load.groups.iter().any(|g| !g.eligible));
    }
    #[test]
    fn load_decay_and_time_precision_use_calendar_days_in_the_athlete_timezone() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0}));
        let mut recent=sessions(); recent[0]["durationMinutes"]=json!(300);
        let mut older=sessions(); older[4]["durationMinutes"]=json!(300);
        assert!(assess_readiness(&current,&[],&recent,"UTC").load_adjustment>assess_readiness(&current,&[],&older,"UTC").load_adjustment);
        let mut boundary=session(0,3.0); boundary["startAt"]=json!("2026-10-15T23:30:00Z");
        assert!(sessions_before(&current,&[boundary.clone()],date::epoch_day("2026-10-16"),"Asia/Hong_Kong").is_empty());
        boundary["timePrecision"]=json!("date_only");
        assert_eq!(sessions_before(&current,&[boundary],date::epoch_day("2026-10-16"),"UTC").len(),1);
    }
    #[test]
    fn atl_ctl_fallback_is_exclusive_and_is_not_itself_a_recovery_dimension() {
        let current=record(0,json!({"sleepScore":90,"subjectiveFatigue":0,"atl":100,"ctl":40,"form":999}));
        let result=assess_readiness(&current,&history(),&[],"UTC");
        assert_eq!(result.load_method.as_deref(),Some("atlCtl")); assert_eq!(result.load_adjustment,15.0);
        let result=assess_readiness(&current,&history(),&sessions(),"UTC");
        assert_eq!(result.load_method.as_deref(),Some("sessionRpe")); assert_eq!(result.load_adjustment,0.0);
        assert_eq!(assess(json!({"atl":100,"ctl":40})).score,None);
        assert!(assess(json!({"form":-100})).load_method.is_none());
        assert_eq!(assess(json!({"sleepScore":90,"subjectiveFatigue":0})).load_adjustment,0.0);
    }
}
