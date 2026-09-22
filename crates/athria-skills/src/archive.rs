//! Minimal ZIP writer for Skill archives.
//!
//! Skill archives are a few kilobytes of markdown, so entries are stored
//! uncompressed (method 0) — a standard, universally readable ZIP with no
//! compression dependency. Bytes are deterministic: entry order is sorted and
//! timestamps are fixed, so an unchanged bundle always exports identically.

use std::fs;
use std::path::Path;

const LOCAL_HEADER: u32 = 0x0403_4b50;
const CENTRAL_HEADER: u32 = 0x0201_4b50;
const END_OF_DIRECTORY: u32 = 0x0605_4b50;
/// MS-DOS timestamp for 2020-01-01 00:00:00, used for every entry.
const DOS_DATE: u16 = 20513;
const DOS_TIME: u16 = 0;
/// Bit 11 marks file names as UTF-8.
const UTF8_FLAG: u16 = 0x0800;
const STORED: u16 = 0;
const VERSION: u16 = 20;
const DIRECTORY_ATTRIBUTES: u32 = 0x10;

pub struct ArchiveEntry {
    /// Forward-slash separated path inside the archive, never empty.
    pub name: String,
    pub data: Vec<u8>,
}

pub fn write_archive(path: &Path, entries: &[ArchiveEntry]) -> Result<(), String> {
    let mut files = entries.iter().collect::<Vec<_>>();
    files.sort_by(|left, right| left.name.cmp(&right.name));
    if files.is_empty() {
        return Err("A Skill archive needs at least one file.".to_string());
    }
    let mut directories = Vec::new();
    for file in &files {
        let mut segments = file.name.split('/').collect::<Vec<_>>();
        segments.pop();
        let mut prefix = String::new();
        for segment in segments {
            prefix.push_str(segment);
            if !directories.contains(&prefix) {
                directories.push(prefix.clone());
            }
            prefix.push('/');
        }
    }
    directories.sort();
    let total = directories.len() + files.len();
    if total > u16::MAX as usize {
        return Err("The Skill archive has too many entries.".to_string());
    }

    let mut bytes = Vec::new();
    let mut central = Vec::new();
    for directory in &directories {
        let offset = bytes.len() as u32;
        write_entry(&mut bytes, &mut central, directory, &[], offset, true);
    }
    for file in &files {
        let offset = bytes.len() as u32;
        write_entry(&mut bytes, &mut central, &file.name, &file.data, offset, false);
    }
    let directory_offset = bytes.len() as u32;
    let directory_size = central.len() as u32;
    bytes.extend_from_slice(&central);
    push_u32(&mut bytes, END_OF_DIRECTORY);
    push_u16(&mut bytes, 0);
    push_u16(&mut bytes, 0);
    push_u16(&mut bytes, total as u16);
    push_u16(&mut bytes, total as u16);
    push_u32(&mut bytes, directory_size);
    push_u32(&mut bytes, directory_offset);
    push_u16(&mut bytes, 0);

    fs::write(path, &bytes).map_err(|error| format!("Could not write {}: {error}", path.display()))
}

fn write_entry(
    bytes: &mut Vec<u8>,
    central: &mut Vec<u8>,
    name: &str,
    data: &[u8],
    offset: u32,
    directory: bool,
) {
    let name = if directory {
        format!("{name}/")
    } else {
        name.to_string()
    };
    let name = name.as_bytes();
    let size = data.len() as u32;
    let crc = crc32(data);

    push_u32(bytes, LOCAL_HEADER);
    push_u16(bytes, VERSION);
    push_u16(bytes, UTF8_FLAG);
    push_u16(bytes, STORED);
    push_u16(bytes, DOS_TIME);
    push_u16(bytes, DOS_DATE);
    push_u32(bytes, crc);
    push_u32(bytes, size);
    push_u32(bytes, size);
    push_u16(bytes, name.len() as u16);
    push_u16(bytes, 0);
    bytes.extend_from_slice(name);
    bytes.extend_from_slice(data);

    push_u32(central, CENTRAL_HEADER);
    push_u16(central, VERSION);
    push_u16(central, VERSION);
    push_u16(central, UTF8_FLAG);
    push_u16(central, STORED);
    push_u16(central, DOS_TIME);
    push_u16(central, DOS_DATE);
    push_u32(central, crc);
    push_u32(central, size);
    push_u32(central, size);
    push_u16(central, name.len() as u16);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u16(central, 0);
    push_u32(central, if directory { DIRECTORY_ATTRIBUTES } else { 0 });
    push_u32(central, offset);
    central.extend_from_slice(name);
}

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

/// IEEE CRC-32, the checksum every ZIP entry carries.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
pub(crate) fn read_entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    fn u16_at(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }
    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }
    let mut entries = Vec::new();
    let mut offset = 0usize;
    while offset + 4 <= bytes.len() && u32_at(bytes, offset) == LOCAL_HEADER {
        let method = u16_at(bytes, offset + 8);
        assert_eq!(method, STORED);
        let crc = u32_at(bytes, offset + 14);
        let size = u32_at(bytes, offset + 18) as usize;
        let name_length = u16_at(bytes, offset + 26) as usize;
        let extra_length = u16_at(bytes, offset + 28) as usize;
        let name_start = offset + 30;
        let data_start = name_start + name_length + extra_length;
        let name = String::from_utf8(bytes[name_start..name_start + name_length].to_vec()).unwrap();
        let data = bytes[data_start..data_start + size].to_vec();
        assert_eq!(crc, crc32(&data), "{name} checksum");
        assert_eq!(u32_at(bytes, offset + 22), size as u32, "{name} size");
        entries.push((name, data));
        offset = data_start + size;
    }
    let directory = bytes.len() - 22;
    assert_eq!(u32_at(bytes, directory), END_OF_DIRECTORY, "end of directory");
    assert_eq!(u16_at(bytes, directory + 10) as usize, entries.len());
    assert_eq!(u32_at(bytes, directory + 16) as usize, offset, "directory offset");
    assert_eq!(u32_at(bytes, directory + 12) as usize, directory - offset);
    assert_eq!(
        u32_at(bytes, offset),
        CENTRAL_HEADER,
        "central directory starts after the local entries"
    );
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_readable_archive_with_directories() {
        let path = std::env::temp_dir().join(format!(
            "athria-archive-{}.zip",
            std::process::id()
        ));
        write_archive(
            &path,
            &[
                ArchiveEntry {
                    name: "athria-coach/SKILL.md".into(),
                    data: b"# Coach".to_vec(),
                },
                ArchiveEntry {
                    name: "athria-coach/references/deep.md".into(),
                    data: b"deep".to_vec(),
                },
            ],
        )
        .unwrap();
        let bytes = fs::read(&path).unwrap();
        let entries = read_entries(&bytes);
        let names = entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "athria-coach/",
                "athria-coach/references/",
                "athria-coach/SKILL.md",
                "athria-coach/references/deep.md"
            ]
        );
        assert_eq!(entries[2].1, b"# Coach");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn crc32_matches_known_vectors() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn empty_archives_are_rejected() {
        let path = std::env::temp_dir().join("athria-archive-empty.zip");
        assert!(write_archive(&path, &[]).is_err());
    }
}
