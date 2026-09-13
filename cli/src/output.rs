use serde::Serialize;

use crate::error::CliError;
use crate::types::{CliEnvelope, ProblemDetail};

/// Emits formatted JSON output for a successful command to stdout.
pub fn print_success<T: Serialize>(data: &T, raw: bool, pretty: bool) -> Result<(), CliError> {
    let json_string = if raw {
        if pretty {
            serde_json::to_string_pretty(data)?
        } else {
            serde_json::to_string(data)?
        }
    } else {
        let envelope = CliEnvelope::new(data);
        if pretty {
            serde_json::to_string_pretty(&envelope)?
        } else {
            serde_json::to_string(&envelope)?
        }
    };

    println!("{json_string}");
    Ok(())
}

/// Emits an RFC 9457 problem detail JSON document to stderr.
pub fn print_problem(problem: &ProblemDetail, pretty: bool) {
    let json_string = if pretty {
        serde_json::to_string_pretty(problem).unwrap_or_else(|_| problem.detail.clone())
    } else {
        serde_json::to_string(problem).unwrap_or_else(|_| problem.detail.clone())
    };

    eprintln!("{json_string}");
}
