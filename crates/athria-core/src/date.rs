//! Minimal proleptic-Gregorian civil date math.
//!
//! The TypeScript core parses `YYYY-MM-DD` strings as `Date` values at 12:00
//! UTC and then only performs whole-day arithmetic. This module reproduces the
//! same observable results with Howard Hinnant's `days_from_civil` /
//! `civil_from_days` algorithms, without pulling in a calendar crate.

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 { adjusted_year } else { adjusted_year - 399 } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_prime = (month as i64 + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`]: `(year, month, day)` for a day number.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Parses the schema-validated `YYYY-MM-DD` form.
pub(crate) fn parse_iso_date(date: &str) -> (i64, u32, u32) {
    let mut parts = date.split('-');
    let year = parts.next().expect("date must start with a year").parse().expect("year must be numeric");
    let month = parts.next().expect("date must contain a month").parse().expect("month must be numeric");
    let day = parts.next().expect("date must contain a day").parse().expect("day must be numeric");
    (year, month, day)
}

pub(crate) fn epoch_day(date: &str) -> i64 {
    let (year, month, day) = parse_iso_date(date);
    days_from_civil(year, month, day)
}

pub(crate) fn format_iso_date(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

pub(crate) fn add_days(date: &str, days: i64) -> String {
    format_iso_date(epoch_day(date) + days)
}

/// JavaScript `getUTCDay()`: Sunday is 0 ... Saturday is 6.
pub(crate) fn utc_weekday(date: &str) -> u32 {
    (epoch_day(date) + 4).rem_euclid(7) as u32
}

/// The TypeScript `scheduleWeekday` helper: `(getUTCDay() + 6) % 7`, so
/// Monday is 0 ... Sunday is 6.
pub(crate) fn monday_weekday(date: &str) -> u32 {
    (utc_weekday(date) + 6) % 7
}

pub(crate) fn day_difference(from: &str, to: &str) -> i64 {
    epoch_day(to) - epoch_day(from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_day_round_trips_through_civil_dates() {
        for date in ["1970-01-01", "2000-02-29", "2024-02-29", "2026-09-07", "2025-12-31", "2100-03-01"] {
            assert_eq!(format_iso_date(epoch_day(date)), date, "{date} must round-trip");
        }
        assert_eq!(epoch_day("1970-01-01"), 0);
        assert_eq!(epoch_day("1970-01-02"), 1);
        assert_eq!(epoch_day("1969-12-31"), -1);
    }

    #[test]
    fn weekdays_match_the_javascript_helpers() {
        // 1970-01-01 was a Thursday: getUTCDay 4, scheduleWeekday 3.
        assert_eq!(utc_weekday("1970-01-01"), 4);
        assert_eq!(monday_weekday("1970-01-01"), 3);
        // 2026-09-07 is a Monday.
        assert_eq!(monday_weekday("2026-09-07"), 0);
        assert_eq!(monday_weekday("2026-09-13"), 6);
    }

    #[test]
    fn day_differences_cross_month_and_year_boundaries() {
        assert_eq!(day_difference("2026-01-26", "2026-02-06"), 11);
        assert_eq!(day_difference("2025-12-29", "2026-01-08"), 10);
        assert_eq!(day_difference("2026-09-07", "2026-09-07"), 0);
        assert_eq!(day_difference("2026-09-14", "2026-09-07"), -7);
    }
}
