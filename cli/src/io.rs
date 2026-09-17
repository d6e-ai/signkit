use crate::error::CliError;
use serde_json::{Map, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

/// Matches the draft-commit HTTP body bound.
pub const MAX_JSON_INPUT_BYTES: usize = 2 * 1024 * 1024;

/// Matches the server DOCX import bound (`MAX_DOCX_INPUT_BYTES`).
pub const MAX_DOCX_BYTES: usize = 20 * 1024 * 1024;

/// Matches the server uploaded PDF bound (`MAX_UPLOADED_PDF_BYTES`).
pub const MAX_PDF_BYTES: usize = 20 * 1024 * 1024;

/// Matches the server decompressed evidence bound (`MAX_MANIFEST_SOURCE_BYTES`).
pub const MAX_EVIDENCE_BYTES: usize = 2 * 1024 * 1024;

/// Matches the server executed agreement PDF bound (`MAX_EXECUTED_PDF_BYTES`).
pub const MAX_COMPLETION_PDF_BYTES: usize = 32 * 1024 * 1024;

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

/// Reads PDF bytes from a regular file, or from stdin when `path` is `-`.
pub fn read_pdf_bytes(path: &str) -> Result<Vec<u8>, CliError> {
    if path == "-" {
        read_bounded_stdin(MAX_PDF_BYTES, "PDF")
    } else {
        read_bounded_file(Path::new(path), MAX_PDF_BYTES, "PDF")
    }
}

/// Writes bytes to a regular file, or to stdout when `path` is `-`.
pub fn write_output_bytes(path: &str, bytes: &[u8]) -> Result<(), CliError> {
    if path == "-" {
        io::stdout()
            .write_all(bytes)
            .map_err(|err| CliError::usage(format!("Failed to write bytes to stdout: {err}")))?;
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

/// Opens `path` for reading without ever following a trailing symlink, and
/// without the separate check-then-open window a prior `symlink_metadata`
/// call followed by `File::open` would leave: on Unix the no-follow
/// enforcement is part of the single `open(2)` syscall, so nothing can swap
/// a regular file for a symlink between the check and the use. Every
/// property that matters -- "is it a symlink", "is it a regular file", "how
/// big is it" -- is then read back from the open file descriptor
/// (`fstat`-equivalent `File::metadata`), never re-derived from the path.
fn read_bounded_file(path: &Path, max_bytes: usize, kind: &str) -> Result<Vec<u8>, CliError> {
    if path.as_os_str().is_empty() {
        return Err(CliError::usage("Input path must not be empty."));
    }
    let file = open_no_follow(path, OpenMode::Read).map_err(|err| {
        open_error(
            path,
            err,
            "Refusing to read a symbolic link. Provide a regular file or '-'.",
        )
    })?;
    let metadata = file
        .metadata()
        .map_err(|err| CliError::usage(format!("Failed to read '{}': {err}", path.display())))?;
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
    let mut buffer = Vec::new();
    file.take((max_bytes as u64) + 1)
        .read_to_end(&mut buffer)
        .map_err(|err| CliError::usage(format!("Failed to read '{}': {err}", path.display())))?;
    if buffer.len() > max_bytes {
        return Err(CliError::usage(format!(
            "{kind} input exceeds the {max_bytes} byte limit."
        )));
    }
    Ok(buffer)
}

/// Opens `path` for writing with the same no-follow, descriptor-checked
/// discipline as [`read_bounded_file`]: creating a missing file or
/// truncating an existing regular one, in the one `open(2)` call, but never
/// following a trailing symlink. This preserves the existing "overwrite an
/// existing regular file, refuse a symlink" UX -- `create_new` alone would
/// reject the ordinary overwrite case, so this uses `create` + `truncate`
/// gated by the no-follow flag instead.
fn write_bounded_file(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    if path.as_os_str().is_empty() {
        return Err(CliError::usage("Output path must not be empty."));
    }
    let mut file = open_no_follow(path, OpenMode::Write).map_err(|err| {
        open_error(
            path,
            err,
            "Refusing to write through a symbolic link. Provide a regular file or '-'.",
        )
    })?;
    let metadata = file
        .metadata()
        .map_err(|err| CliError::usage(format!("Failed to write '{}': {err}", path.display())))?;
    if !metadata.is_file() {
        return Err(CliError::usage("Output path must name a regular file."));
    }
    file.write_all(bytes)
        .map_err(|err| CliError::usage(format!("Failed to write '{}': {err}", path.display())))
}

#[derive(Clone, Copy)]
enum OpenMode {
    Read,
    Write,
}

#[cfg(unix)]
fn open_no_follow(path: &Path, mode: OpenMode) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    let nonblocking_extra = match mode {
        OpenMode::Read => {
            // `O_NONBLOCK` keeps a pre-existing FIFO at `path` from blocking this
            // open indefinitely: opening a FIFO read-only without it blocks
            // until a writer connects, which could be never. The immediately
            // following `is_file()` check rejects the FIFO (and every other
            // non-regular type) before anything is read; regular files are
            // unaffected by `O_NONBLOCK` on read.
            options.read(true);
            libc::O_NONBLOCK
        }
        OpenMode::Write => {
            // `O_NONBLOCK` keeps a pre-existing FIFO at `path` from blocking
            // this open indefinitely; the immediately following `is_file()`
            // check rejects it (and every other non-regular type) before any
            // byte is written.
            options.write(true).create(true).truncate(true);
            libc::O_NONBLOCK
        }
    };
    options
        .custom_flags(libc::O_NOFOLLOW | nonblocking_extra)
        .open(path)
}

/// No portable no-follow open exists outside Unix, so this falls back to the
/// pre-open `symlink_metadata` check the whole crate used before this fix --
/// still racy against a concurrent swap on those platforms, but explicit
/// about it rather than silently claiming the same atomicity `open_no_follow`
/// provides on Unix. Every supported CI target (Linux) takes the Unix path
/// above.
#[cfg(not(unix))]
const NON_UNIX_SYMLINK_SENTINEL: &str = "signkit: refusing symbolic link";

#[cfg(not(unix))]
fn open_no_follow(path: &Path, mode: OpenMode) -> io::Result<File> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(io::Error::other(NON_UNIX_SYMLINK_SENTINEL));
        }
    }
    match mode {
        OpenMode::Read => OpenOptions::new().read(true).open(path),
        OpenMode::Write => OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path),
    }
}

#[cfg(unix)]
fn is_symlink_open_error(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(not(unix))]
fn is_symlink_open_error(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::Other && err.to_string() == NON_UNIX_SYMLINK_SENTINEL
}

fn open_error(path: &Path, err: io::Error, symlink_message: &str) -> CliError {
    if is_symlink_open_error(&err) {
        return CliError::usage(symlink_message);
    }
    CliError::usage(format!("Failed to open '{}': {err}", path.display()))
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
    getrandom::getrandom(&mut bytes)
        .map_err(|err| CliError::usage(format!("Failed to generate an Idempotency-Key: {err}")))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
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

    #[test]
    fn resolve_idempotency_key_generates_distinct_uuid_v4_keys_when_unset() {
        let first = resolve_idempotency_key(None).unwrap();
        let second = resolve_idempotency_key(None).unwrap();
        for key in [&first, &second] {
            let bytes = key.as_bytes();
            assert_eq!(bytes.len(), 36);
            assert_eq!(bytes[14], b'4');
            assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
            assert!(key.chars().all(|c| ('!'..='~').contains(&c)));
        }
        assert_ne!(first, second);
    }
}
