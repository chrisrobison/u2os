//! Error classification and retry policy, mirroring
//! `server/agent/action-error-classifier.js` and the failure handling in
//! `server/agent/action-queue-store.js`. Deterministic: model output is never
//! consulted.

use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    Retryable,
    NonRetryable,
    AuthenticationRequired,
    OwnerAttentionRequired,
    RecoveryReviewRequired,
    OutcomeUncertain,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::Retryable => "retryable",
            ErrorClass::NonRetryable => "non_retryable",
            ErrorClass::AuthenticationRequired => "authentication_required",
            ErrorClass::OwnerAttentionRequired => "owner_attention_required",
            ErrorClass::RecoveryReviewRequired => "recovery_review_required",
            ErrorClass::OutcomeUncertain => "outcome_uncertain",
        }
    }

    pub fn parse(text: &str) -> Option<ErrorClass> {
        [
            ErrorClass::Retryable,
            ErrorClass::NonRetryable,
            ErrorClass::AuthenticationRequired,
            ErrorClass::OwnerAttentionRequired,
            ErrorClass::RecoveryReviewRequired,
            ErrorClass::OutcomeUncertain,
        ]
        .into_iter()
        .find(|c| c.as_str() == text)
    }
}

impl fmt::Display for ErrorClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The fields of an error that classification looks at (Node reads the same
/// properties off the thrown error object).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ErrorInfo {
    /// Node: `error.actionErrorClass`.
    pub action_error_class: Option<String>,
    /// Node: `error.ownerAttentionRequired === true`.
    pub owner_attention_required: bool,
    /// Node: `error.code`.
    pub code: Option<String>,
    /// Node: `error.status || error.statusCode`.
    pub status: Option<i64>,
}

const RETRYABLE_CODES: [&str; 5] = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EAI_AGAIN",
];
const AUTH_CODES: [&str; 3] = ["EAUTH", "UNAUTHENTICATED", "INVALID_CREDENTIALS"];

pub fn classify(info: &ErrorInfo) -> ErrorClass {
    if let Some(class) = info
        .action_error_class
        .as_deref()
        .and_then(ErrorClass::parse)
    {
        return class;
    }
    if info.owner_attention_required {
        return ErrorClass::OwnerAttentionRequired;
    }
    let code = info.code.as_deref().unwrap_or("").to_uppercase();
    let status = info.status.unwrap_or(0);
    if AUTH_CODES.contains(&code.as_str()) || status == 401 || status == 403 {
        return ErrorClass::AuthenticationRequired;
    }
    if RETRYABLE_CODES.contains(&code.as_str()) || status == 408 || status == 429 || status >= 500 {
        return ErrorClass::Retryable;
    }
    ErrorClass::NonRetryable
}

/// `min(max, base * 2^(attempt-1))`; `None` for invalid inputs (Node throws).
pub fn retry_delay_ms(attempt_number: u32, base_ms: i64, max_ms: i64) -> Option<i64> {
    if attempt_number < 1 || base_ms <= 0 || max_ms <= 0 {
        return None;
    }
    let factor = 1i64.checked_shl(attempt_number - 1).unwrap_or(i64::MAX);
    Some(max_ms.min(base_ms.saturating_mul(factor)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: i64,
    pub max_delay_ms: i64,
}

impl Default for RetryPolicy {
    /// Node's defaults: 5 attempts, 1 s base, 60 s cap.
    fn default() -> Self {
        RetryPolicy {
            max_attempts: 5,
            base_delay_ms: 1_000,
            max_delay_ms: 60_000,
        }
    }
}

/// What a failed attempt turns into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureOutcome {
    Retry,
    DeadLetter,
    Terminal,
    /// Rust only: Node records `failed` + class `outcome_uncertain`.
    Uncertain,
}

pub fn failure_outcome(
    class: ErrorClass,
    attempt_number: u32,
    max_attempts: u32,
) -> FailureOutcome {
    match class {
        ErrorClass::Retryable if attempt_number < max_attempts => FailureOutcome::Retry,
        ErrorClass::Retryable => FailureOutcome::DeadLetter,
        ErrorClass::OutcomeUncertain => FailureOutcome::Uncertain,
        _ => FailureOutcome::Terminal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_doubles_and_caps() {
        let d = |n| retry_delay_ms(n, 1_000, 60_000);
        assert_eq!(d(1), Some(1_000));
        assert_eq!(d(2), Some(2_000));
        assert_eq!(d(6), Some(32_000));
        assert_eq!(d(7), Some(60_000));
        assert_eq!(d(200), Some(60_000));
        assert_eq!(d(0), None);
        assert_eq!(retry_delay_ms(1, 0, 10), None);
    }

    #[test]
    fn explicit_class_beats_everything() {
        let info = ErrorInfo {
            action_error_class: Some("outcome_uncertain".into()),
            code: Some("ETIMEDOUT".into()),
            ..Default::default()
        };
        assert_eq!(classify(&info), ErrorClass::OutcomeUncertain);
        let unknown = ErrorInfo {
            action_error_class: Some("bogus".into()),
            ..Default::default()
        };
        assert_eq!(classify(&unknown), ErrorClass::NonRetryable);
    }
}
