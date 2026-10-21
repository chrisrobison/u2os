//! Strict date parsing for history queries. Accepts `YYYY-MM-DD` (meaning the
//! end of that day, UTC) or RFC 3339 `YYYY-MM-DDTHH:MM:SS` with `Z` or a
//! `±HH:MM` offset. Anything else is rejected rather than guessed.

use crate::error::{Error, Result};

/// Days since 1970-01-01 for a civil date (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

fn num(s: &str, len: usize) -> Option<i64> {
    (s.len() == len && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

fn bad(input: &str) -> Error {
    Error::Invalid(format!(
        "unrecognised date {input:?}: use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (a date alone means the end of that day, UTC)"
    ))
}

/// Seconds since the Unix epoch.
pub fn parse_epoch(input: &str) -> Result<i64> {
    let b = || bad(input);
    let (date, time) = match input.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (input, None),
    };
    let mut parts = date.split('-');
    let (y, m, d) = (
        num(parts.next().ok_or_else(b)?, 4).ok_or_else(b)?,
        num(parts.next().ok_or_else(b)?, 2).ok_or_else(b)?,
        num(parts.next().ok_or_else(b)?, 2).ok_or_else(b)?,
    );
    if parts.next().is_some()
        || !(1..=12).contains(&m)
        || d < 1
        || d > days_in_month(y, m)
        || y < 1970
    {
        return Err(b());
    }
    let day = days_from_civil(y, m, d) * 86_400;
    let Some(time) = time else {
        return Ok(day + 86_399);
    };

    let (clock, offset) = if let Some(c) = time.strip_suffix('Z') {
        (c, 0)
    } else if time.len() > 6 && matches!(time.as_bytes()[time.len() - 6], b'+' | b'-') {
        let (c, off) = time.split_at(time.len() - 6);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let (oh, om) = off[1..].split_once(':').ok_or_else(b)?;
        let (oh, om) = (num(oh, 2).ok_or_else(b)?, num(om, 2).ok_or_else(b)?);
        if oh > 23 || om > 59 {
            return Err(b());
        }
        (c, sign * (oh * 3600 + om * 60))
    } else {
        return Err(b());
    };
    let mut c = clock.split(':');
    let (h, mi, s) = (
        num(c.next().ok_or_else(b)?, 2).ok_or_else(b)?,
        num(c.next().ok_or_else(b)?, 2).ok_or_else(b)?,
        num(c.next().ok_or_else(b)?, 2).ok_or_else(b)?,
    );
    if c.next().is_some() || h > 23 || mi > 59 || s > 59 {
        return Err(b());
    }
    Ok(day + h * 3600 + mi * 60 + s - offset)
}

/// `YYYY-MM-DDTHH:MM:SSZ`.
pub fn format_utc(epoch: i64) -> String {
    let days = epoch.div_euclid(86_400);
    let secs = epoch.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// Normalised UTC form of an accepted date, ready to hand to git.
pub fn normalize(input: &str) -> Result<String> {
    parse_epoch(input).map(format_utc)
}

pub fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_alone_is_end_of_day_utc() {
        assert_eq!(normalize("2025-06-01").unwrap(), "2025-06-01T23:59:59Z");
        assert_eq!(normalize("2024-02-29").unwrap(), "2024-02-29T23:59:59Z");
    }

    #[test]
    fn rfc3339_with_offsets() {
        assert_eq!(
            normalize("2026-10-20T10:00:00Z").unwrap(),
            "2026-10-20T10:00:00Z"
        );
        assert_eq!(
            normalize("2026-10-20T10:00:00-07:00").unwrap(),
            "2026-10-20T17:00:00Z"
        );
        assert_eq!(
            normalize("2026-01-01T00:30:00+01:00").unwrap(),
            "2025-12-31T23:30:00Z"
        );
    }

    #[test]
    fn known_epoch() {
        assert_eq!(parse_epoch("1970-01-02T00:00:00Z").unwrap(), 86_400);
        assert_eq!(format_utc(1_000_000_000), "2001-09-09T01:46:40Z");
    }

    #[test]
    fn rejects_guesses_and_garbage() {
        for bad in [
            "yesterday",
            "2025-13-01",
            "2025-02-29",
            "2025-6-1",
            "2025-06-01T10:00",
            "2025-06-01T10:00:00",
            "2025-06-01 10:00:00Z",
            "1969-12-31",
            "2025-06-01T25:00:00Z",
            "--since=1",
            "2025-06-01T10:00:00+25:00",
            "",
        ] {
            assert!(parse_epoch(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn roundtrip_many_days() {
        for day in (0..40_000).step_by(37) {
            let (y, m, d) = civil_from_days(day);
            assert_eq!(days_from_civil(y, m, d), day);
        }
    }
}
