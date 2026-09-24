use crate::error::CliError;
use crate::types::{is_valid_uuid_v7, ProblemValidationError, ValidationReceipt};
use std::collections::HashSet;

pub const MAX_DRAFT_GENERATION: u64 = 2_147_483_647;
pub const MAX_GENERATION: u64 = 2_147_483_647;
pub const MAX_COMMIT_MESSAGE_CHARS: usize = 200;
pub const MAX_EDIT_COUNT: usize = 50;
pub const MAX_EDIT_CONTENT_BYTES: usize = 512 * 1024;
pub const MAX_TOTAL_CONTENT_BYTES: usize = 1024 * 1024;
pub const MAX_PATH_LENGTH: usize = 240;
pub const MAX_RECIPIENTS_COUNT: usize = 50;
pub const MAX_FIELDS_COUNT: usize = 50;

pub const EXAMPLE_COMMIT_JSON: &str = r##"{
  "expectedGeneration": 0,
  "message": "Initial agreement draft",
  "edits": [
    {
      "path": "documents/agreement.md",
      "content": "# Mutual Non-Disclosure Agreement\n\nThis agreement is entered into..."
    }
  ],
  "provenance": {
    "automationRunId": "run-2026-09-24-001",
    "externalId": "workflow-step-1"
  }
}"##;

pub const EXAMPLE_READY_JSON: &str = r#"{
  "expectedGeneration": 1,
  "recipients": [
    {
      "email": "signer@example.com",
      "name": "Jane Doe",
      "role": "signer",
      "locale": "en",
      "routingOrder": 1
    },
    {
      "email": "approver@example.com",
      "name": "John Smith",
      "role": "approver",
      "locale": "en",
      "routingOrder": 2
    }
  ]
}"#;

pub const EXAMPLE_FIELDS_JSON: &str = r#"{
  "expectedGeneration": 1,
  "expectedFieldGeneration": 0,
  "fields": [
    {
      "recipientId": "0191eb70-6523-74b2-b7b5-2fa75bb6d001",
      "documentId": "0191eb70-6523-74b2-b7b5-2fa75bb6d002",
      "fieldType": "signature",
      "label": "Signer Signature",
      "required": true,
      "position": 0,
      "geometry": {
        "page": 1,
        "x": 0.1,
        "y": 0.7,
        "width": 0.25,
        "height": 0.05
      }
    }
  ]
}"#;

pub const EXAMPLE_SEND_JSON: &str = r#"{
  "expectedGeneration": 1,
  "expectedReadyAuditEventId": "0191eb70-6523-74b2-b7b5-2fa75bb6d003"
}"#;

pub const EXAMPLE_VOID_JSON: &str = r#"{
  "expectedStatus": "sent",
  "expectedGeneration": 1
}"#;

/// Prints the canonical JSON request example to stdout.
pub fn print_example(example: &str, raw: bool, pretty: bool) -> Result<(), CliError> {
    if raw && !pretty {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(example) {
            println!("{}", serde_json::to_string(&val)?);
            return Ok(());
        }
    }
    println!("{example}");
    Ok(())
}

fn has_control_character(s: &str) -> bool {
    s.chars().any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f)
}

fn javascript_string_length(s: &str) -> usize {
    s.encode_utf16().count()
}

fn normalized_markdown_content(content: &str) -> String {
    let normalized_newlines: String = content.replace("\r\n", "\n").replace('\r', "\n");
    format!("{}\n", normalized_newlines.trim_end())
}

pub fn is_valid_recipient_email(email: &str) -> bool {
    let trimmed = email.trim();
    if trimmed.is_empty() || trimmed.len() > 320 {
        return false;
    }
    let parts: Vec<&str> = trimmed.split('@').collect();
    if parts.len() != 2 {
        return false;
    }
    let local = parts[0];
    let domain = parts[1];
    if local.is_empty() || domain.is_empty() {
        return false;
    }
    let local_bytes = local.as_bytes();
    let last_byte = local_bytes[local_bytes.len() - 1];
    if !last_byte.is_ascii_alphanumeric()
        && last_byte != b'_'
        && last_byte != b'+'
        && last_byte != b'-'
    {
        return false;
    }
    let mut prev_dot = false;
    for &b in local_bytes {
        if b == b'.' {
            if prev_dot {
                return false;
            }
            prev_dot = true;
        } else if b.is_ascii_alphanumeric() || b == b'_' || b == b'\'' || b == b'+' || b == b'-' {
            prev_dot = false;
        } else {
            return false;
        }
    }
    if prev_dot {
        return false;
    }

    let domain_labels: Vec<&str> = domain.split('.').collect();
    if domain_labels.len() < 2 {
        return false;
    }
    for (i, label) in domain_labels.iter().enumerate() {
        if label.is_empty() {
            return false;
        }
        if i == domain_labels.len() - 1 {
            if label.len() < 2 || !label.chars().all(|c| c.is_ascii_alphabetic()) {
                return false;
            }
        } else {
            let bytes = label.as_bytes();
            if !bytes[0].is_ascii_alphanumeric() {
                return false;
            }
            if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return false;
            }
        }
    }
    true
}

pub fn validate_markdown_path_syntax(path: &str) -> bool {
    if path.contains("..")
        || path.len() > MAX_PATH_LENGTH
        || !path.starts_with("documents/")
        || !path.ends_with(".md")
    {
        return false;
    }
    let rest = &path["documents/".len()..path.len() - ".md".len()];
    if rest.is_empty() {
        return false;
    }
    let bytes = rest.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    rest.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

pub fn validate_commit_payload(
    object: &serde_json::Map<String, serde_json::Value>,
    envelope_id: Option<&str>,
) -> Result<ValidationReceipt, CliError> {
    let mut errors: Vec<ProblemValidationError> = Vec::new();

    if let Some(id) = envelope_id {
        if !is_valid_uuid_v7(id) {
            errors.push(ProblemValidationError {
                path: "envelopeId".to_string(),
                message: "The envelope ID must be a canonical lowercase RFC 9562 UUIDv7."
                    .to_string(),
                extra: Default::default(),
            });
        }
    }

    let allowed_keys: HashSet<&str> = ["expectedGeneration", "message", "edits", "provenance"]
        .into_iter()
        .collect();
    for key in object.keys() {
        if !allowed_keys.contains(key.as_str()) {
            errors.push(ProblemValidationError {
                path: key.clone(),
                message: format!(
                    "Unrecognized property '{key}'. Extra properties are not permitted."
                ),
                extra: Default::default(),
            });
        }
    }

    let mut expected_gen_val: Option<u64> = None;
    match object.get("expectedGeneration") {
        Some(val) => match val.as_u64() {
            Some(n) if n < MAX_DRAFT_GENERATION => {
                expected_gen_val = Some(n);
            }
            _ => {
                errors.push(ProblemValidationError {
                    path: "expectedGeneration".to_string(),
                    message: format!(
                        "expectedGeneration must be an integer between 0 and {}.",
                        MAX_DRAFT_GENERATION - 1
                    ),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "expectedGeneration".to_string(),
                message: "expectedGeneration is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    match object.get("message") {
        Some(val) => match val.as_str() {
            Some(s) => {
                let trimmed = s.trim();
                if trimmed.is_empty()
                    || javascript_string_length(trimmed) > MAX_COMMIT_MESSAGE_CHARS
                {
                    errors.push(ProblemValidationError {
                        path: "message".to_string(),
                        message: format!(
                            "Commit message must contain 1-{MAX_COMMIT_MESSAGE_CHARS} characters."
                        ),
                        extra: Default::default(),
                    });
                } else if has_control_character(trimmed) {
                    errors.push(ProblemValidationError {
                        path: "message".to_string(),
                        message:
                            "Commit messages must be a single line without control characters."
                                .to_string(),
                        extra: Default::default(),
                    });
                }
            }
            None => {
                errors.push(ProblemValidationError {
                    path: "message".to_string(),
                    message: "message must be a string.".to_string(),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "message".to_string(),
                message: "message is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    let mut total_content_bytes: usize = 0;
    let mut edit_count: usize = 0;
    match object.get("edits") {
        Some(serde_json::Value::Array(edits)) => {
            edit_count = edits.len();
            if edits.is_empty() || edits.len() > MAX_EDIT_COUNT {
                errors.push(ProblemValidationError {
                    path: "edits".to_string(),
                    message: format!("edits must contain 1-{MAX_EDIT_COUNT} items."),
                    extra: Default::default(),
                });
            }

            let mut seen_paths: HashSet<String> = HashSet::new();
            let edit_allowed_keys: HashSet<&str> = ["path", "content"].into_iter().collect();

            for (i, item) in edits.iter().enumerate() {
                match item.as_object() {
                    Some(edit_obj) => {
                        for key in edit_obj.keys() {
                            if !edit_allowed_keys.contains(key.as_str()) {
                                errors.push(ProblemValidationError {
                                    path: format!("edits[{i}].{key}"),
                                    message: format!("Unrecognized property '{key}' in edit item."),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match edit_obj.get("path") {
                            Some(val) => match val.as_str() {
                                Some(path_str) => {
                                    if !validate_markdown_path_syntax(path_str) {
                                        errors.push(ProblemValidationError {
                                            path: format!("edits[{i}].path"),
                                            message: "Draft paths must name a Markdown file directly under documents/ (e.g. documents/agreement.md) without ..".to_string(),
                                            extra: Default::default(),
                                        });
                                    } else if !seen_paths.insert(path_str.to_string()) {
                                        errors.push(ProblemValidationError {
                                            path: format!("edits[{i}].path"),
                                            message:
                                                "Draft paths must be unique within one commit."
                                                    .to_string(),
                                            extra: Default::default(),
                                        });
                                    }
                                }
                                None => {
                                    errors.push(ProblemValidationError {
                                        path: format!("edits[{i}].path"),
                                        message: "path must be a string.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("edits[{i}].path"),
                                    message: "path is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match edit_obj.get("content") {
                            Some(val) => {
                                match val.as_str() {
                                    Some(content_str) => {
                                        if content_str.contains('\0') {
                                            errors.push(ProblemValidationError {
                                            path: format!("edits[{i}].content"),
                                            message: "Markdown content must not contain a NUL character.".to_string(),
                                            extra: Default::default(),
                                        });
                                        }
                                        let content_bytes =
                                            normalized_markdown_content(content_str).len();
                                        if content_bytes > MAX_EDIT_CONTENT_BYTES {
                                            errors.push(ProblemValidationError {
                                            path: format!("edits[{i}].content"),
                                            message: format!(
                                                "Edit content size ({content_bytes} bytes) exceeds the {MAX_EDIT_CONTENT_BYTES} byte limit."
                                            ),
                                            extra: Default::default(),
                                        });
                                        }
                                        total_content_bytes += content_bytes;
                                    }
                                    None => {
                                        errors.push(ProblemValidationError {
                                            path: format!("edits[{i}].content"),
                                            message: "content must be a string.".to_string(),
                                            extra: Default::default(),
                                        });
                                    }
                                }
                            }
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("edits[{i}].content"),
                                    message: "content is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }
                    }
                    None => {
                        errors.push(ProblemValidationError {
                            path: format!("edits[{i}]"),
                            message: "Edit item must be a JSON object.".to_string(),
                            extra: Default::default(),
                        });
                    }
                }
            }

            if total_content_bytes > MAX_TOTAL_CONTENT_BYTES {
                errors.push(ProblemValidationError {
                    path: "edits".to_string(),
                    message: format!(
                        "Total edits content size ({total_content_bytes} bytes) exceeds the {MAX_TOTAL_CONTENT_BYTES} byte limit."
                    ),
                    extra: Default::default(),
                });
            }
        }
        Some(_) => {
            errors.push(ProblemValidationError {
                path: "edits".to_string(),
                message: "edits must be an array.".to_string(),
                extra: Default::default(),
            });
        }
        None => {
            errors.push(ProblemValidationError {
                path: "edits".to_string(),
                message: "edits is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    if let Some(prov_val) = object.get("provenance") {
        match prov_val.as_object() {
            Some(prov_obj) => {
                let prov_allowed_keys: HashSet<&str> =
                    ["automationRunId", "externalId"].into_iter().collect();
                for key in prov_obj.keys() {
                    if !prov_allowed_keys.contains(key.as_str()) {
                        errors.push(ProblemValidationError {
                            path: format!("provenance.{key}"),
                            message: format!("Unrecognized property '{key}' in provenance."),
                            extra: Default::default(),
                        });
                    }
                }
                for key in ["automationRunId", "externalId"] {
                    if let Some(v) = prov_obj.get(key) {
                        match v.as_str() {
                            Some(s) => {
                                let trimmed = s.trim();
                                if trimmed.is_empty()
                                    || javascript_string_length(trimmed) > 200
                                    || has_control_character(trimmed)
                                {
                                    errors.push(ProblemValidationError {
                                        path: format!("provenance.{key}"),
                                        message: format!(
                                            "{key} must contain 1-200 non-control characters."
                                        ),
                                        extra: Default::default(),
                                    });
                                }
                            }
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("provenance.{key}"),
                                    message: format!("{key} must be a string."),
                                    extra: Default::default(),
                                });
                            }
                        }
                    }
                }
            }
            None => {
                errors.push(ProblemValidationError {
                    path: "provenance".to_string(),
                    message: "provenance must be an object.".to_string(),
                    extra: Default::default(),
                });
            }
        }
    }

    if !errors.is_empty() {
        return Err(CliError::usage_with_errors(
            "Commit JSON did not match the required schema.",
            errors,
        ));
    }

    Ok(ValidationReceipt {
        valid: true,
        command: "commit".to_string(),
        envelope_id: envelope_id.map(|s| s.to_string()),
        expected_generation: expected_gen_val,
        summary: Some(format!(
            "Validated {} draft edit{} ({} bytes content).",
            edit_count,
            if edit_count == 1 { "" } else { "s" },
            total_content_bytes
        )),
        extra: Default::default(),
    })
}

pub fn validate_ready_payload(
    object: &serde_json::Map<String, serde_json::Value>,
    envelope_id: Option<&str>,
) -> Result<ValidationReceipt, CliError> {
    let mut errors: Vec<ProblemValidationError> = Vec::new();

    if let Some(id) = envelope_id {
        if !is_valid_uuid_v7(id) {
            errors.push(ProblemValidationError {
                path: "envelopeId".to_string(),
                message: "The envelope ID must be a canonical lowercase RFC 9562 UUIDv7."
                    .to_string(),
                extra: Default::default(),
            });
        }
    }

    let allowed_keys: HashSet<&str> = ["expectedGeneration", "recipients"].into_iter().collect();
    for key in object.keys() {
        if !allowed_keys.contains(key.as_str()) {
            errors.push(ProblemValidationError {
                path: key.clone(),
                message: format!(
                    "Unrecognized property '{key}'. Extra properties are not permitted."
                ),
                extra: Default::default(),
            });
        }
    }

    let mut expected_gen_val: Option<u64> = None;
    match object.get("expectedGeneration") {
        Some(val) => match val.as_u64() {
            Some(n) if (1..=MAX_GENERATION).contains(&n) => {
                expected_gen_val = Some(n);
            }
            _ => {
                errors.push(ProblemValidationError {
                    path: "expectedGeneration".to_string(),
                    message: format!(
                        "expectedGeneration must be an integer between 1 and {MAX_GENERATION}."
                    ),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "expectedGeneration".to_string(),
                message: "expectedGeneration is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    let mut recipient_count: usize = 0;
    match object.get("recipients") {
        Some(serde_json::Value::Array(recipients)) => {
            recipient_count = recipients.len();
            if recipients.is_empty() || recipients.len() > MAX_RECIPIENTS_COUNT {
                errors.push(ProblemValidationError {
                    path: "recipients".to_string(),
                    message: format!("recipients must contain 1-{MAX_RECIPIENTS_COUNT} items."),
                    extra: Default::default(),
                });
            }

            let mut seen_emails: HashSet<String> = HashSet::new();
            let mut actionable_routing_orders: HashSet<u64> = HashSet::new();
            let mut viewer_routing_orders: Vec<(usize, u64)> = Vec::new();
            let rec_allowed_keys: HashSet<&str> =
                ["email", "name", "role", "locale", "routingOrder"]
                    .into_iter()
                    .collect();

            for (i, item) in recipients.iter().enumerate() {
                match item.as_object() {
                    Some(rec_obj) => {
                        for key in rec_obj.keys() {
                            if !rec_allowed_keys.contains(key.as_str()) {
                                errors.push(ProblemValidationError {
                                    path: format!("recipients[{i}].{key}"),
                                    message: format!("Unrecognized property '{key}' in recipient."),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match rec_obj.get("email") {
                            Some(val) => match val.as_str() {
                                Some(email_str) => {
                                    let trimmed = email_str.trim();
                                    if !is_valid_recipient_email(trimmed) {
                                        errors.push(ProblemValidationError {
                                            path: format!("recipients[{i}].email"),
                                            message: "Invalid recipient email address.".to_string(),
                                            extra: Default::default(),
                                        });
                                    } else {
                                        let normalized = trimmed.to_lowercase();
                                        if !seen_emails.insert(normalized) {
                                            errors.push(ProblemValidationError {
                                                path: format!("recipients[{i}].email"),
                                                message: "Recipient email addresses must be unique within an envelope.".to_string(),
                                                extra: Default::default(),
                                            });
                                        }
                                    }
                                }
                                None => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].email"),
                                        message: "email must be a string.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("recipients[{i}].email"),
                                    message: "email is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match rec_obj.get("name") {
                            Some(val) => match val.as_str() {
                                Some(name_str) => {
                                    let trimmed = name_str.trim();
                                    if trimmed.is_empty() || javascript_string_length(trimmed) > 200
                                    {
                                        errors.push(ProblemValidationError {
                                            path: format!("recipients[{i}].name"),
                                            message: "Recipient name must contain 1-200 non-control characters.".to_string(),
                                            extra: Default::default(),
                                        });
                                    }
                                }
                                None => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].name"),
                                        message: "name must be a string.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("recipients[{i}].name"),
                                    message: "name is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        let mut role_str: Option<&str> = None;
                        match rec_obj.get("role") {
                            Some(val) => match val.as_str() {
                                Some("prefill") => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].role"),
                                        message: "Prefill recipients are not supported in ready recipient graphs.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                                Some(r @ ("signer" | "approver" | "viewer")) => {
                                    role_str = Some(r);
                                }
                                Some(_) => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].role"),
                                        message: "Recipient role must be 'signer', 'approver', or 'viewer'.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                                None => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].role"),
                                        message: "role must be a string.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("recipients[{i}].role"),
                                    message: "role is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match rec_obj.get("locale") {
                            Some(val) => match val.as_str() {
                                Some("en" | "ja") => {}
                                Some(_) => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].locale"),
                                        message: "locale must be 'en' or 'ja'.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                                None => {
                                    errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].locale"),
                                        message: "locale must be a string.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("recipients[{i}].locale"),
                                    message: "locale is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match rec_obj.get("routingOrder") {
                            Some(val) => {
                                match val.as_u64() {
                                    Some(order) if (1..=1000).contains(&order) => {
                                        if let Some(role) = role_str {
                                            if role == "signer" || role == "approver" {
                                                actionable_routing_orders.insert(order);
                                            } else if role == "viewer" {
                                                viewer_routing_orders.push((i, order));
                                            }
                                        }
                                    }
                                    _ => {
                                        errors.push(ProblemValidationError {
                                        path: format!("recipients[{i}].routingOrder"),
                                        message: "routingOrder must be an integer between 1 and 1000.".to_string(),
                                        extra: Default::default(),
                                    });
                                    }
                                }
                            }
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("recipients[{i}].routingOrder"),
                                    message: "routingOrder is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }
                    }
                    None => {
                        errors.push(ProblemValidationError {
                            path: format!("recipients[{i}]"),
                            message: "Recipient item must be a JSON object.".to_string(),
                            extra: Default::default(),
                        });
                    }
                }
            }

            if actionable_routing_orders.is_empty() {
                errors.push(ProblemValidationError {
                    path: "recipients".to_string(),
                    message: "At least one signer or approver is required.".to_string(),
                    extra: Default::default(),
                });
            }

            for (idx, order) in viewer_routing_orders {
                if !actionable_routing_orders.contains(&order) {
                    errors.push(ProblemValidationError {
                        path: format!("recipients[{idx}].routingOrder"),
                        message: "Every viewer routing order must include a signer or approver."
                            .to_string(),
                        extra: Default::default(),
                    });
                }
            }
        }
        Some(_) => {
            errors.push(ProblemValidationError {
                path: "recipients".to_string(),
                message: "recipients must be an array.".to_string(),
                extra: Default::default(),
            });
        }
        None => {
            errors.push(ProblemValidationError {
                path: "recipients".to_string(),
                message: "recipients is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    if !errors.is_empty() {
        return Err(CliError::usage_with_errors(
            "Ready JSON did not match the required schema.",
            errors,
        ));
    }

    Ok(ValidationReceipt {
        valid: true,
        command: "ready".to_string(),
        envelope_id: envelope_id.map(|s| s.to_string()),
        expected_generation: expected_gen_val,
        summary: Some(format!(
            "Validated {} recipient{}.",
            recipient_count,
            if recipient_count == 1 { "" } else { "s" }
        )),
        extra: Default::default(),
    })
}

pub fn validate_fields_payload(
    object: &serde_json::Map<String, serde_json::Value>,
    envelope_id: Option<&str>,
) -> Result<ValidationReceipt, CliError> {
    let mut errors: Vec<ProblemValidationError> = Vec::new();

    if let Some(id) = envelope_id {
        if !is_valid_uuid_v7(id) {
            errors.push(ProblemValidationError {
                path: "envelopeId".to_string(),
                message: "The envelope ID must be a canonical lowercase RFC 9562 UUIDv7."
                    .to_string(),
                extra: Default::default(),
            });
        }
    }

    let allowed_keys: HashSet<&str> = ["expectedGeneration", "expectedFieldGeneration", "fields"]
        .into_iter()
        .collect();
    for key in object.keys() {
        if !allowed_keys.contains(key.as_str()) {
            errors.push(ProblemValidationError {
                path: key.clone(),
                message: format!(
                    "Unrecognized property '{key}'. Extra properties are not permitted."
                ),
                extra: Default::default(),
            });
        }
    }

    let mut expected_gen_val: Option<u64> = None;
    match object.get("expectedGeneration") {
        Some(val) => match val.as_u64() {
            Some(n) if (1..=MAX_GENERATION).contains(&n) => {
                expected_gen_val = Some(n);
            }
            _ => {
                errors.push(ProblemValidationError {
                    path: "expectedGeneration".to_string(),
                    message: format!(
                        "expectedGeneration must be an integer between 1 and {MAX_GENERATION}."
                    ),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "expectedGeneration".to_string(),
                message: "expectedGeneration is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    match object.get("expectedFieldGeneration") {
        Some(val) => match val.as_u64() {
            Some(n) if n < MAX_GENERATION => {}
            _ => {
                errors.push(ProblemValidationError {
                    path: "expectedFieldGeneration".to_string(),
                    message: format!(
                        "expectedFieldGeneration must be an integer between 0 and {}.",
                        MAX_GENERATION - 1
                    ),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "expectedFieldGeneration".to_string(),
                message: "expectedFieldGeneration is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    let mut field_count: usize = 0;
    match object.get("fields") {
        Some(serde_json::Value::Array(fields)) => {
            field_count = fields.len();
            if fields.is_empty() || fields.len() > MAX_FIELDS_COUNT {
                errors.push(ProblemValidationError {
                    path: "fields".to_string(),
                    message: format!("fields must contain 1-{MAX_FIELDS_COUNT} items."),
                    extra: Default::default(),
                });
            }

            let mut seen_locators: HashSet<String> = HashSet::new();
            let field_allowed_keys: HashSet<&str> = [
                "recipientId",
                "documentId",
                "fieldType",
                "label",
                "required",
                "position",
                "geometry",
            ]
            .into_iter()
            .collect();

            let valid_field_types: HashSet<&str> =
                ["signature", "initials", "text", "date", "checkbox"]
                    .into_iter()
                    .collect();

            for (i, item) in fields.iter().enumerate() {
                match item.as_object() {
                    Some(f_obj) => {
                        for key in f_obj.keys() {
                            if !field_allowed_keys.contains(key.as_str()) {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].{key}"),
                                    message: format!(
                                        "Unrecognized property '{key}' in field placement."
                                    ),
                                    extra: Default::default(),
                                });
                            }
                        }

                        let mut rec_id: Option<String> = None;
                        match f_obj.get("recipientId") {
                            Some(val) => match val.as_str() {
                                Some(id) if is_valid_uuid_v7(id) => {
                                    rec_id = Some(id.to_lowercase());
                                }
                                _ => {
                                    errors.push(ProblemValidationError {
                                        path: format!("fields[{i}].recipientId"),
                                        message: "recipientId must be a canonical lowercase RFC 9562 UUIDv7.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].recipientId"),
                                    message: "recipientId is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        let mut doc_id: Option<String> = None;
                        match f_obj.get("documentId") {
                            Some(val) => match val.as_str() {
                                Some(id) if is_valid_uuid_v7(id) => {
                                    doc_id = Some(id.to_string());
                                }
                                _ => {
                                    errors.push(ProblemValidationError {
                                        path: format!("fields[{i}].documentId"),
                                        message: "documentId must be a canonical lowercase RFC 9562 UUIDv7.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].documentId"),
                                    message: "documentId is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match f_obj.get("fieldType") {
                            Some(val) => match val.as_str() {
                                Some(ft) if valid_field_types.contains(ft) => {}
                                _ => {
                                    errors.push(ProblemValidationError {
                                        path: format!("fields[{i}].fieldType"),
                                        message: "fieldType must be one of 'signature', 'initials', 'text', 'date', or 'checkbox'.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].fieldType"),
                                    message: "fieldType is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match f_obj.get("label") {
                            Some(val) => match val.as_str() {
                                Some(lbl) => {
                                    let trimmed = lbl.trim();
                                    if trimmed.is_empty()
                                        || javascript_string_length(trimmed) > 200
                                        || has_control_character(trimmed)
                                    {
                                        errors.push(ProblemValidationError {
                                            path: format!("fields[{i}].label"),
                                            message: "Field label must contain 1-200 non-control characters.".to_string(),
                                            extra: Default::default(),
                                        });
                                    }
                                }
                                _ => {
                                    errors.push(ProblemValidationError {
                                        path: format!("fields[{i}].label"),
                                        message: "label must be a string.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].label"),
                                    message: "label is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        if f_obj.get("required").and_then(|v| v.as_bool()).is_none() {
                            errors.push(ProblemValidationError {
                                path: format!("fields[{i}].required"),
                                message: "required must be a boolean.".to_string(),
                                extra: Default::default(),
                            });
                        }

                        let mut pos_val: Option<u64> = None;
                        match f_obj.get("position") {
                            Some(val) => match val.as_u64() {
                                Some(p) if p <= 100_000 => {
                                    pos_val = Some(p);
                                }
                                _ => {
                                    errors.push(ProblemValidationError {
                                        path: format!("fields[{i}].position"),
                                        message:
                                            "position must be an integer between 0 and 100000."
                                                .to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].position"),
                                    message: "position is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        if let (Some(r), Some(d), Some(p)) = (rec_id, doc_id, pos_val) {
                            let locator = format!("{r}\0{d}\0{p}");
                            if !seen_locators.insert(locator) {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}]"),
                                    message: "Field declarations must not repeat the same recipient/document/position.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }

                        match f_obj.get("geometry") {
                            Some(val) => match val.as_object() {
                                Some(geom_obj) => {
                                    let geom_allowed_keys: HashSet<&str> =
                                        ["page", "x", "y", "width", "height"].into_iter().collect();
                                    for key in geom_obj.keys() {
                                        if !geom_allowed_keys.contains(key.as_str()) {
                                            errors.push(ProblemValidationError {
                                                path: format!("fields[{i}].geometry.{key}"),
                                                message: format!(
                                                    "Unrecognized property '{key}' in geometry."
                                                ),
                                                extra: Default::default(),
                                            });
                                        }
                                    }

                                    match geom_obj.get("page") {
                                        Some(v) => match v.as_u64() {
                                            Some(page) if (1..=100_000).contains(&page) => {}
                                            _ => {
                                                errors.push(ProblemValidationError {
                                                    path: format!("fields[{i}].geometry.page"),
                                                    message: "page must be an integer between 1 and 100000.".to_string(),
                                                    extra: Default::default(),
                                                });
                                            }
                                        },
                                        None => {
                                            errors.push(ProblemValidationError {
                                                path: format!("fields[{i}].geometry.page"),
                                                message: "page is required.".to_string(),
                                                extra: Default::default(),
                                            });
                                        }
                                    }

                                    for axis in ["x", "y"] {
                                        match geom_obj.get(axis) {
                                            Some(v) => match v.as_f64() {
                                                Some(coord) if (0.0..=1.0).contains(&coord) => {}
                                                _ => {
                                                    errors.push(ProblemValidationError {
                                                        path: format!("fields[{i}].geometry.{axis}"),
                                                        message: format!("{axis} must be a number between 0 and 1."),
                                                        extra: Default::default(),
                                                    });
                                                }
                                            },
                                            None => {
                                                errors.push(ProblemValidationError {
                                                    path: format!("fields[{i}].geometry.{axis}"),
                                                    message: format!("{axis} is required."),
                                                    extra: Default::default(),
                                                });
                                            }
                                        }
                                    }

                                    for dim in ["width", "height"] {
                                        match geom_obj.get(dim) {
                                            Some(v) => match v.as_f64() {
                                                Some(size) if size > 0.0 && size <= 1.0 => {}
                                                _ => {
                                                    errors.push(ProblemValidationError {
                                                        path: format!("fields[{i}].geometry.{dim}"),
                                                        message: format!("{dim} must be greater than 0 and at most 1."),
                                                        extra: Default::default(),
                                                    });
                                                }
                                            },
                                            None => {
                                                errors.push(ProblemValidationError {
                                                    path: format!("fields[{i}].geometry.{dim}"),
                                                    message: format!("{dim} is required."),
                                                    extra: Default::default(),
                                                });
                                            }
                                        }
                                    }
                                }
                                None => {
                                    errors.push(ProblemValidationError {
                                        path: format!("fields[{i}].geometry"),
                                        message: "geometry must be a JSON object.".to_string(),
                                        extra: Default::default(),
                                    });
                                }
                            },
                            None => {
                                errors.push(ProblemValidationError {
                                    path: format!("fields[{i}].geometry"),
                                    message: "geometry is required.".to_string(),
                                    extra: Default::default(),
                                });
                            }
                        }
                    }
                    None => {
                        errors.push(ProblemValidationError {
                            path: format!("fields[{i}]"),
                            message: "Field item must be a JSON object.".to_string(),
                            extra: Default::default(),
                        });
                    }
                }
            }
        }
        Some(_) => {
            errors.push(ProblemValidationError {
                path: "fields".to_string(),
                message: "fields must be an array.".to_string(),
                extra: Default::default(),
            });
        }
        None => {
            errors.push(ProblemValidationError {
                path: "fields".to_string(),
                message: "fields is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    if !errors.is_empty() {
        return Err(CliError::usage_with_errors(
            "Fields JSON did not match the required schema.",
            errors,
        ));
    }

    Ok(ValidationReceipt {
        valid: true,
        command: "fields".to_string(),
        envelope_id: envelope_id.map(|s| s.to_string()),
        expected_generation: expected_gen_val,
        summary: Some(format!(
            "Validated {} field placement{}.",
            field_count,
            if field_count == 1 { "" } else { "s" }
        )),
        extra: Default::default(),
    })
}

pub fn validate_send_payload(
    object: &serde_json::Map<String, serde_json::Value>,
    envelope_id: Option<&str>,
) -> Result<ValidationReceipt, CliError> {
    let mut errors: Vec<ProblemValidationError> = Vec::new();

    if let Some(id) = envelope_id {
        if !is_valid_uuid_v7(id) {
            errors.push(ProblemValidationError {
                path: "envelopeId".to_string(),
                message: "The envelope ID must be a canonical lowercase RFC 9562 UUIDv7."
                    .to_string(),
                extra: Default::default(),
            });
        }
    }

    let allowed_keys: HashSet<&str> = ["expectedGeneration", "expectedReadyAuditEventId"]
        .into_iter()
        .collect();
    for key in object.keys() {
        if !allowed_keys.contains(key.as_str()) {
            errors.push(ProblemValidationError {
                path: key.clone(),
                message: format!(
                    "Unrecognized property '{key}'. Extra properties are not permitted."
                ),
                extra: Default::default(),
            });
        }
    }

    let mut expected_gen_val: Option<u64> = None;
    match object.get("expectedGeneration") {
        Some(val) => match val.as_u64() {
            Some(n) if (1..=MAX_GENERATION).contains(&n) => {
                expected_gen_val = Some(n);
            }
            _ => {
                errors.push(ProblemValidationError {
                    path: "expectedGeneration".to_string(),
                    message: format!(
                        "expectedGeneration must be an integer between 1 and {MAX_GENERATION}."
                    ),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "expectedGeneration".to_string(),
                message: "expectedGeneration is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    match object.get("expectedReadyAuditEventId") {
        Some(val) => {
            match val.as_str() {
                Some(id) if is_valid_uuid_v7(id) => {}
                _ => {
                    errors.push(ProblemValidationError {
                    path: "expectedReadyAuditEventId".to_string(),
                    message: "expectedReadyAuditEventId must be a canonical lowercase RFC 9562 UUIDv7.".to_string(),
                    extra: Default::default(),
                });
                }
            }
        }
        None => {
            errors.push(ProblemValidationError {
                path: "expectedReadyAuditEventId".to_string(),
                message: "expectedReadyAuditEventId is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    if !errors.is_empty() {
        return Err(CliError::usage_with_errors(
            "Send JSON did not match the required schema.",
            errors,
        ));
    }

    Ok(ValidationReceipt {
        valid: true,
        command: "send".to_string(),
        envelope_id: envelope_id.map(|s| s.to_string()),
        expected_generation: expected_gen_val,
        summary: Some("Validated send parameters.".to_string()),
        extra: Default::default(),
    })
}

pub fn validate_void_payload(
    object: &serde_json::Map<String, serde_json::Value>,
    envelope_id: Option<&str>,
) -> Result<ValidationReceipt, CliError> {
    let mut errors: Vec<ProblemValidationError> = Vec::new();

    if let Some(id) = envelope_id {
        if !is_valid_uuid_v7(id) {
            errors.push(ProblemValidationError {
                path: "envelopeId".to_string(),
                message: "The envelope ID must be a canonical lowercase RFC 9562 UUIDv7."
                    .to_string(),
                extra: Default::default(),
            });
        }
    }

    let allowed_keys: HashSet<&str> = ["expectedStatus", "expectedGeneration"]
        .into_iter()
        .collect();
    for key in object.keys() {
        if !allowed_keys.contains(key.as_str()) {
            errors.push(ProblemValidationError {
                path: key.clone(),
                message: format!(
                    "Unrecognized property '{key}'. Extra properties are not permitted."
                ),
                extra: Default::default(),
            });
        }
    }

    match object.get("expectedStatus") {
        Some(val) => {
            match val.as_str() {
                Some("draft" | "ready" | "sent" | "in_progress") => {}
                _ => {
                    errors.push(ProblemValidationError {
                    path: "expectedStatus".to_string(),
                    message: "expectedStatus must be one of 'draft', 'ready', 'sent', or 'in_progress'.".to_string(),
                    extra: Default::default(),
                });
                }
            }
        }
        None => {
            errors.push(ProblemValidationError {
                path: "expectedStatus".to_string(),
                message: "expectedStatus is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    let mut expected_gen_val: Option<u64> = None;
    match object.get("expectedGeneration") {
        Some(val) => match val.as_u64() {
            Some(n) if n <= MAX_GENERATION => {
                expected_gen_val = Some(n);
            }
            _ => {
                errors.push(ProblemValidationError {
                    path: "expectedGeneration".to_string(),
                    message: format!(
                        "expectedGeneration must be an integer between 0 and {MAX_GENERATION}."
                    ),
                    extra: Default::default(),
                });
            }
        },
        None => {
            errors.push(ProblemValidationError {
                path: "expectedGeneration".to_string(),
                message: "expectedGeneration is required.".to_string(),
                extra: Default::default(),
            });
        }
    }

    if !errors.is_empty() {
        return Err(CliError::usage_with_errors(
            "Void JSON did not match the required schema.",
            errors,
        ));
    }

    Ok(ValidationReceipt {
        valid: true,
        command: "void".to_string(),
        envelope_id: envelope_id.map(|s| s.to_string()),
        expected_generation: expected_gen_val,
        summary: Some("Validated void parameters.".to_string()),
        extra: Default::default(),
    })
}
