//! Local wall-clock time for daily triggers.
//!
//! Node computes `daily` slots in the *server's local time zone* (JavaScript
//! `Date`: `getDay`, `setHours`, `getFullYear`...). Rust has no IANA database
//! in this build, so the zone is injected: either a fixed offset or the US
//! DST rules (second Sunday of March to first Sunday of November, 02:00
//! local). The conversions deliberately reproduce what V8 does at a DST
//! change, which the Node parity test checks against a real `TZ`:
//!
//! * a wall time that does not exist (spring forward, 02:30) resolves with the
//!   offset in force *before* the change, so it becomes 03:30 daylight time;
//! * a wall time that happens twice (fall back, 01:30) resolves to the
//!   *earlier* instant.

const MS_PER_MIN: i64 = 60_000;
const MS_PER_DAY: i64 = 86_400_000;

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
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

/// 0 = Sunday, as JavaScript's `getDay`.
fn weekday_of_days(days: i64) -> u8 {
    (days + 4).rem_euclid(7) as u8
}

/// The nth (1-based) Sunday of a month, as a day number.
fn nth_sunday(year: i64, month: i64, n: i64) -> i64 {
    let first = days_from_civil(year, month, 1);
    let to_sunday = (7 - i64::from(weekday_of_days(first))) % 7;
    first + to_sunday + (n - 1) * 7
}

/// Local calendar fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Local {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    /// 0 = Sunday.
    pub weekday: u8,
}

impl Local {
    pub fn date_string(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    /// A constant offset from UTC in minutes (east positive). No DST.
    Fixed { offset_min: i32 },
    /// United States rules since 2007, with the given standard offset
    /// (Pacific is -480).
    UsDst { std_offset_min: i32 },
}

impl Zone {
    pub const UTC: Zone = Zone::Fixed { offset_min: 0 };

    /// Parse `fixed:<minutes>` or `us:<standard-offset-minutes>`.
    pub fn parse(spec: &str) -> Option<Zone> {
        let (kind, n) = spec.split_once(':')?;
        let n: i32 = n.parse().ok()?;
        if !(-14 * 60..=14 * 60).contains(&n) {
            return None;
        }
        match kind {
            "fixed" => Some(Zone::Fixed { offset_min: n }),
            "us" => Some(Zone::UsDst { std_offset_min: n }),
            _ => None,
        }
    }

    /// UTC offset in minutes in force at an instant.
    pub fn offset_min_at(&self, utc_ms: i64) -> i32 {
        match *self {
            Zone::Fixed { offset_min } => offset_min,
            Zone::UsDst { std_offset_min } => {
                let std = i64::from(std_offset_min);
                let (year, ..) =
                    civil_from_days((utc_ms + std * MS_PER_MIN).div_euclid(MS_PER_DAY));
                // 02:00 local standard time, then 02:00 local daylight time.
                let start =
                    (nth_sunday(year, 3, 2) * MS_PER_DAY) + 2 * 60 * MS_PER_MIN - std * MS_PER_MIN;
                let end = (nth_sunday(year, 11, 1) * MS_PER_DAY) + 2 * 60 * MS_PER_MIN
                    - (std + 60) * MS_PER_MIN;
                if utc_ms >= start && utc_ms < end {
                    std_offset_min + 60
                } else {
                    std_offset_min
                }
            }
        }
    }

    pub fn local(&self, utc_ms: i64) -> Local {
        let local_ms = utc_ms + i64::from(self.offset_min_at(utc_ms)) * MS_PER_MIN;
        let days = local_ms.div_euclid(MS_PER_DAY);
        let rem = local_ms.rem_euclid(MS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        Local {
            year,
            month,
            day,
            hour: rem / (60 * MS_PER_MIN),
            minute: (rem / MS_PER_MIN) % 60,
            weekday: weekday_of_days(days),
        }
    }

    /// The instant of local wall time `hour:minute:00.000` on a local date,
    /// resolved like JavaScript's `Date#setHours` (see the module comment).
    pub fn wall_to_utc(&self, year: i64, month: i64, day: i64, hour: i64, minute: i64) -> i64 {
        let wall = days_from_civil(year, month, day) * MS_PER_DAY
            + hour * 60 * MS_PER_MIN
            + minute * MS_PER_MIN;
        let before = i64::from(self.offset_min_at(wall - MS_PER_DAY));
        let after = i64::from(self.offset_min_at(wall + MS_PER_DAY));
        let valid = |offset: i64| {
            let t = wall - offset * MS_PER_MIN;
            (i64::from(self.offset_min_at(t)) == offset).then_some(t)
        };
        match (valid(before), valid(after)) {
            (Some(a), Some(b)) => a.min(b),
            (Some(t), None) | (None, Some(t)) => t,
            // The wall time falls in a gap: use the offset from before it.
            (None, None) => wall - before * MS_PER_MIN,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PT: Zone = Zone::UsDst {
        std_offset_min: -480,
    };

    fn utc(y: i64, m: i64, d: i64, h: i64, mi: i64) -> i64 {
        days_from_civil(y, m, d) * MS_PER_DAY + (h * 60 + mi) * MS_PER_MIN
    }

    #[test]
    fn civil_round_trip_and_weekday() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(
            civil_from_days(days_from_civil(2026, 2, 28) + 1),
            (2026, 3, 1)
        );
        assert_eq!(
            civil_from_days(days_from_civil(2024, 2, 28) + 1),
            (2024, 2, 29)
        );
        assert_eq!(weekday_of_days(days_from_civil(2026, 11, 1)), 0);
    }

    #[test]
    fn us_transitions_2026() {
        // 2026: DST starts Sunday 8 March 10:00 UTC, ends Sunday 1 November 09:00 UTC.
        assert_eq!(PT.offset_min_at(utc(2026, 3, 8, 9, 59)), -480);
        assert_eq!(PT.offset_min_at(utc(2026, 3, 8, 10, 0)), -420);
        assert_eq!(PT.offset_min_at(utc(2026, 11, 1, 8, 59)), -420);
        assert_eq!(PT.offset_min_at(utc(2026, 11, 1, 9, 0)), -480);
    }

    #[test]
    fn gap_and_overlap_resolve_like_javascript() {
        // 02:30 on 8 March 2026 does not exist: becomes 03:30 PDT = 10:30 UTC.
        assert_eq!(PT.wall_to_utc(2026, 3, 8, 2, 30), utc(2026, 3, 8, 10, 30));
        // 01:30 on 1 November 2026 happens twice: the earlier (PDT) one, 08:30 UTC.
        assert_eq!(PT.wall_to_utc(2026, 11, 1, 1, 30), utc(2026, 11, 1, 8, 30));
        assert_eq!(PT.wall_to_utc(2026, 7, 4, 7, 0), utc(2026, 7, 4, 14, 0));
        assert_eq!(PT.wall_to_utc(2026, 1, 4, 7, 0), utc(2026, 1, 4, 15, 0));
    }

    #[test]
    fn local_fields_follow_the_offset() {
        let l = PT.local(utc(2026, 3, 8, 10, 30));
        assert_eq!(
            (l.month, l.day, l.hour, l.minute, l.weekday),
            (3, 8, 3, 30, 0)
        );
        assert_eq!(Zone::parse("us:-480"), Some(PT));
        assert_eq!(
            Zone::parse("fixed:330"),
            Some(Zone::Fixed { offset_min: 330 })
        );
        assert_eq!(Zone::parse("moon:1"), None);
    }
}
