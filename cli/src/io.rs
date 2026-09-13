use crate::error::CliError;
use serde_json::{Map, Value};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;

/// Matches the draft-commit HTTP body bound.
pub const MAX_JSON_INPUT_BYTES: usize = 2 * 1024 * 1024;

/// Matches the server DOCX import bound (`MAX_DOCX_INPUT_BYTES`).
pub const MAX_DOCX_BYTES: usize = 20 * 1024 * 1024;

/// Reads JSON from a regular file, or from stdin when `path` is `-`.
pub fn read_json_value(path: &str) -> Result<Value, CliError> {
    let bytes = if path == "-" {
        read_bounded_stdin(MAX_JSON_INPUT_BYTES, "JSON")?
    } else {
        read_bounded_file(Path::new(path), MAX_JSON_INPUT_BYTES, "JSON")?
    };
    serde_json::from_slice(&bytes)
        .map_err(|err| CliError::usage(format!("Input is not valid JSON: {err}")))
}

/// Reads DOCX bytes from a regular file, or from stdin when `path` is `-`.
pub fn read_docx_bytes(path: &str) -> Result<Vec<u8>, CliError> {
    if path == "-" {
        read_bounded_stdin(MAX_DOCX_BYTES, "DOCX")
    } else {
        read_bounded_file(Path::new(path), MAX_DOCX_BYTES, "DOCX")
    }
}

/// Writes bytes to a regular file, or to stdout when `path` is `-`.
pub fn write_output_bytes(path: &str, bytes: &[u8]) -> Result<(), CliError> {
    if path == "-" {
        io::stdout()
            .write_all(bytes)
            .map_err(|err| CliError::usage(format!("Failed to write DOCX to stdout: {err}")))?;
        return Ok(());
    }
    write_bounded_file(Path::new(path), bytes)
}

/// Requires a JSON object, optionally overlaying unsigned integer command flags.
pub fn read_json_object(path: &str) -> Result<Map<String, Value>, CliError> {
    match read_json_value(path)? {
        Value::Object(map) => Ok(map),
        _ => Err(CliError::usage("JSON input must be an object.")),
    }
}

pub fn overlay_u64(map: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(number) = value {
        map.insert(key.to_string(), Value::from(number));
    }
}

pub fn overlay_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(text) = value {
        map.insert(key.to_string(), Value::String(text.to_string()));
    }
}

pub fn resolve_idempotency_key(provided: Option<&str>) -> Result<String, CliError> {
    match provided {
        Some(key)
            if !key.is_empty()
                && key.len() <= 200
                && key.chars().all(|c| ('!'..='~').contains(&c)) =>
        {
            Ok(key.to_string())
        }
        Some(_) => Err(CliError::usage(
            "Idempotency-Key must contain 1-200 visible ASCII characters.",
        )),
        None => new_uuid_v4(),
    }
}

fn read_bounded_file(path: &Path, max_bytes: usize, kind: &str) -> Result<Vec<u8>, CliError> {
    if path.as_os_str().is_empty() {
        return Err(CliError::usage("Input path must not be empty."));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| CliError::usage(format!("Failed to read '{}': {err}", path.display())))?;
    if metadata.file_type().is_symlink() {
        return Err(CliError::usage(
            "Refusing to read a symbolic link. Provide a regular file or '-'.",
        ));
    }
    if !metadata.is_file() {
        return Err(CliError::usage(format!(
            "{kind} input path must name a regular file."
        )));
    }
    if metadata.len() as usize > max_bytes {
        return Err(CliError::usage(format!(
            "{kind} input exceeds the {max_bytes} byte limit."
        )));
    }
    let mut file = File::open(path)
        .map_err(|err| CliError::usage(format!("Failed to open '{}': {err}", path.display())))?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;
    if buffer.len() > max_bytes {
        return Err(CliError::usage(format!(
            "{kind} input exceeds the {max_bytes} byte limit."
        )));
    }
    Ok(buffer)
}

fn write_bounded_file(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    if path.as_os_str().is_empty() {
        return Err(CliError::usage("Output path must not be empty."));
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CliError::usage(
                "Refusing to write through a symbolic link. Provide a regular file or '-'.",
            ));
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(CliError::usage(
                "DOCX output path must name a regular file.",
            ));
        }
        Ok(_) | Err(_) => {}
    }
    fs::write(path, bytes)
        .map_err(|err| CliError::usage(format!("Failed to write '{}': {err}", path.display())))
}

fn read_bounded_stdin(max_bytes: usize, kind: &str) -> Result<Vec<u8>, CliError> {
    let mut buffer = Vec::new();
    io::stdin()
        .take((max_bytes as u64) + 1)
        .read_to_end(&mut buffer)
        .map_err(|err| CliError::usage(format!("Failed to read {kind} from stdin: {err}")))?;
    if buffer.len() > max_bytes {
        return Err(CliError::usage(format!(
            "{kind} input exceeds the {max_bytes} byte limit."
        )));
    }
    if buffer.is_empty() {
        return Err(CliError::usage(format!(
            "{kind} input from stdin was empty."
        )));
    }
    Ok(buffer)
}

fn new_uuid_v4() -> Result<String, CliError> {
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes)
        .map_err(|err| CliError::usage(format!("Failed to generate an Idempotency-Key: {err}")))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn fill_random(buffer: &mut [u8]) -> io::Result<()> {
    File::open("/dev/urandom")?.read_exact(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_idempotency_key_is_uuid_v4() {
        let key = new_uuid_v4().unwrap();
        let bytes = key.as_bytes();
        assert_eq!(bytes.len(), 36);
        assert_eq!(bytes[14], b'4');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
    }
}
