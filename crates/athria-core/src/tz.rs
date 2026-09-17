//! IANA time-zone helpers matching the `Intl.DateTimeFormat` behavior of the
//! TypeScript store and application layers.
//!
//! The TypeScript implementation formats instants with the host ICU timezone
//! database (`localDate`, `localNoon`, `localWeekday` in `packages/data` and
//! `packages/application`). The Rust runtime resolves the same IANA zones with
//! `jiff`'s bundled timezone database so desktop, CLI, MCP and mobile builds
//! agree with each other without depending on the host zoneinfo.

use jiff::Timestamp;
use jiff::civil::{Date, Weekday};
use jiff::tz::TimeZone;
use time::OffsetDateTime;
use time::macros::format_description;

use crate::{AthriaError, AthriaErrorCode, Result};

/// JavaScript `new Date().toISOString()` shape: `2026-09-10T04:00:00.000Z`.
pub fn iso_from_millis(milliseconds: i64) -> String {
    let format =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
        .expect("millisecond instants are representable")
        .format(&format)
        .expect("ISO-8601 formatting is infallible")
}

fn invalid_instant(iso: &str) -> AthriaError {
    AthriaError::new(
        AthriaErrorCode::InvalidData,
        format!("invalid ISO-8601 instant `{iso}`"),
    )
}

/// `Date.parse` equivalent; panics are reserved for malformed input, matching
/// the Phase 4 core boundary.
pub fn millis(iso: &str) -> Result<i64> {
    Ok(iso
        .parse::<Timestamp>()
        .map_err(|_| invalid_instant(iso))?
        .as_millisecond())
}

fn time_zone(name: &str) -> Result<TimeZone> {
    TimeZone::get(name).map_err(|_| {
        AthriaError::new(
            AthriaErrorCode::InvalidData,
            format!("unknown IANA time zone `{name}`"),
        )
    })
}

fn zoned(iso: &str, time_zone_name: &str) -> Result<jiff::Zoned> {
    Ok(Timestamp::from_millisecond(millis(iso)?)
        .expect("parsed instants round-trip")
        .to_zoned(time_zone(time_zone_name)?))
}

/// `Intl.DateTimeFormat("en-CA")` local `YYYY-MM-DD` for an instant.
pub fn local_date(iso: &str, time_zone_name: &str) -> Result<String> {
    let value = zoned(iso, time_zone_name)?;
    Ok(format!(
        "{:04}-{:02}-{:02}",
        value.year(),
        value.month(),
        value.day()
    ))
}

/// Monday-based local weekday (0 = Monday), matching `Intl` `weekday: "short"`
/// indexed against `["Mon".."Sun"]`.
pub fn local_weekday(iso: &str, time_zone_name: &str) -> Result<i64> {
    let weekday = zoned(iso, time_zone_name)?.weekday();
    Ok(match weekday {
        Weekday::Monday => 0,
        Weekday::Tuesday => 1,
        Weekday::Wednesday => 2,
        Weekday::Thursday => 3,
        Weekday::Friday => 4,
        Weekday::Saturday => 5,
        Weekday::Sunday => 6,
    })
}

/// The instant whose local wall clock reads 12:00:00 on `date`, mirroring the
/// TypeScript `localNoon` two-pass offset resolution. Noon is never inside a
/// DST gap or fold for real zones, so the offset resolution is unambiguous.
pub fn local_noon(date: &str, time_zone_name: &str) -> Result<String> {
    let (year, month, day) = crate::date::parse_iso_date(date);
    let civil = Date::new(year as i16, month as i8, day as i8).map_err(|_| {
        AthriaError::new(
            AthriaErrorCode::InvalidData,
            format!("invalid date `{date}`"),
        )
    })?;
    let zoned = civil
        .at(12, 0, 0, 0)
        .to_zoned(time_zone(time_zone_name)?)
        .map_err(|_| invalid_instant(date))?;
    Ok(iso_from_millis(zoned.timestamp().as_millisecond()))
}

/// `new Date(instant - days * 86_400_000).toISOString()`.
pub fn iso_minus_days(iso: &str, days: i64) -> Result<String> {
    Ok(iso_from_millis(millis(iso)? - days * 86_400_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_dates_match_icu_formatting() {
        assert_eq!(
            local_date("2026-09-07T16:30:00Z", "Asia/Hong_Kong").unwrap(),
            "2026-09-08"
        );
        assert_eq!(
            local_date("2026-09-07T15:59:59Z", "Asia/Hong_Kong").unwrap(),
            "2026-09-07"
        );
        assert_eq!(
            local_date("2026-09-07T10:00:00Z", "Pacific/Kiritimati").unwrap(),
            "2026-09-08"
        );
        assert_eq!(
            local_date("2026-09-07T02:00:00Z", "America/New_York").unwrap(),
            "2026-09-06"
        );
    }

    #[test]
    fn local_noon_resolves_the_zone_offset() {
        assert_eq!(
            local_noon("2026-09-07", "Asia/Hong_Kong").unwrap(),
            "2026-09-07T04:00:00.000Z"
        );
        assert_eq!(
            local_noon("2026-09-07", "Pacific/Kiritimati").unwrap(),
            "2026-09-06T22:00:00.000Z"
        );
        assert_eq!(
            local_noon("2026-09-07", "UTC").unwrap(),
            "2026-09-07T12:00:00.000Z"
        );
    }

    #[test]
    fn weekdays_are_monday_based() {
        assert_eq!(
            local_weekday("2026-09-07T04:00:00Z", "Asia/Hong_Kong").unwrap(),
            0
        );
        assert_eq!(
            local_weekday("2026-09-13T04:00:00Z", "Asia/Hong_Kong").unwrap(),
            6
        );
    }

    #[test]
    fn instants_round_trip_through_millisecond_math() {
        assert_eq!(
            iso_minus_days("2026-09-10T04:00:00.000Z", 7).unwrap(),
            "2026-09-03T04:00:00.000Z"
        );
        assert_eq!(millis("1970-01-01T00:00:00.000Z").unwrap(), 0);
    }
}
