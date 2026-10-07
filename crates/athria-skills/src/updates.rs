//! Signed Skill packages. The desktop owns networking; this module owns trust,
//! compatibility, extraction and crash-safe local activation.
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, io::{Cursor, Read}, path::{Path, PathBuf}};
use crate::{BUNDLED_SKILLS, SkillIdentity, skill_version};

pub const INDEX_LIMIT: usize = 1024 * 1024;
pub const PACKAGE_LIMIT: usize = 10 * 1024 * 1024;
pub const EXTRACT_LIMIT: u64 = 20 * 1024 * 1024;
pub const PUBLIC_KEY: &str = include_str!("../../../packages/skills/update-public-key.txt");
pub const BUNDLED_RELEASE: &str = include_str!("../../../packages/skills/release.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub version: String,
    pub min_app_version: String,
    pub max_app_version: String,
    pub supported_contracts: Vec<String>,
    pub skills: Vec<SkillIdentity>,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub revoked: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Index { pub schema_version: u32, pub packages: Vec<Package> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope { pub payload: String, pub signature: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: String,
    pub min_app_version: String,
    pub max_app_version: String,
    pub supported_contracts: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences { pub automatic: bool, pub last_attempt: Option<u64>, pub last_success: Option<u64> }
impl Default for Preferences {
    fn default() -> Self { Self { automatic: true, last_attempt: None, last_success: None } }
}
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub fn contract_fingerprint(contract: &str) -> String { digest(contract.replace("\r\n", "\n").as_bytes()) }
pub fn bundled_release() -> Result<Release, String> { serde_json::from_str(BUNDLED_RELEASE).map_err(|e| e.to_string()) }
fn hex_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }
pub fn trusted_url(url: &str) -> bool {
    url.starts_with("https://github.com/whywww/Athria/releases/download/skills-v")
        && !url.contains(['?', '#', '\\']) && !url.contains("/../")
}
impl Package {
    pub fn compatible(&self, app: &Version, contract: &str) -> bool {
        !self.revoked && self.supported_contracts.iter().any(|v| v == contract)
            && Version::parse(&self.min_app_version).is_ok_and(|v| app >= &v)
            && Version::parse(&self.max_app_version).is_ok_and(|v| app < &v)
    }
    fn validate(&self) -> Result<(), String> {
        let min = Version::parse(&self.min_app_version).map_err(|e| e.to_string())?;
        let max = Version::parse(&self.max_app_version).map_err(|e| e.to_string())?;
        Version::parse(&self.version).map_err(|e| e.to_string())?;
        if min >= max || !hex_digest(&self.sha256) || !trusted_url(&self.url)
            || self.supported_contracts.is_empty() || !self.supported_contracts.iter().all(|v| hex_digest(v)) {
            return Err("Invalid Skill release metadata.".into());
        }
        let names: BTreeSet<_> = self.skills.iter().map(|v| v.name.as_str()).collect();
        if self.skills.len() != BUNDLED_SKILLS.len() || names != BUNDLED_SKILLS.into_iter().collect()
            || self.skills.iter().any(|v| !hex_digest(&v.hash) || Version::parse(&v.version).is_err()) {
            return Err("The release must contain all five valid Athria Skills.".into());
        }
        Ok(())
    }
}
pub fn verify_index(bytes: &[u8], key: &str) -> Result<Index, String> {
    if bytes.len() > INDEX_LIMIT { return Err("Skill index exceeds the size limit.".into()); }
    let key: [u8; 32] = STANDARD.decode(key.trim()).map_err(|_| "Skill update public key is not configured.")?
        .try_into().map_err(|_| "Skill update public key is not configured.")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|e| e.to_string())?;
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let payload = STANDARD.decode(envelope.payload).map_err(|e| e.to_string())?;
    let signature = Signature::from_slice(&STANDARD.decode(envelope.signature).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    key.verify_strict(&payload, &signature).map_err(|_| "Skill index signature verification failed.")?;
    let index: Index = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
    if index.schema_version != 1 { return Err("Unsupported Skill index format.".into()); }
    let mut versions = BTreeSet::new();
    for package in &index.packages {
        package.validate()?;
        if !versions.insert(&package.version) { return Err("Duplicate Skill package version.".into()); }
    }
    Ok(index)
}
pub fn newest<'a>(index: &'a Index, app: &Version, contract: &str) -> Option<&'a Package> {
    index.packages.iter().filter(|p| p.compatible(app, contract))
        .max_by_key(|p| Version::parse(&p.version).ok())
}

/// Metadata edits to the same package version never require another download.
pub fn available_update<'a>(index: &'a Index, app: &Version, contract: &str, current: &Version) -> Option<&'a Package> {
    newest(index, app, contract).filter(|p| Version::parse(&p.version).is_ok_and(|version| version > *current))
}

/// Atomic replacement also works on Windows when the destination already exists.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Missing parent directory.")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(windows))]
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn read_preferences(root: &Path) -> Result<Preferences, String> {
    let path = root.join("preferences.json");
    if !path.exists() { return Ok(Preferences::default()); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
pub fn save_preferences(root: &Path, prefs: &Preferences) -> Result<(), String> {
    atomic_write(&root.join("preferences.json"), &serde_json::to_vec(prefs).map_err(|e| e.to_string())?)
}
pub fn cached_index(root: &Path, key: &str) -> Result<Index, String> {
    let bytes = fs::read(root.join("index.json")).map_err(|e| e.to_string())?;
    verify_index(&bytes, key)
}

/// Portable identity for remote manifests; existing Agent marker hashes remain unchanged.
pub fn portable_hash(root: &Path) -> Result<String, String> {
    if fs::symlink_metadata(root).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Skill files must not be symbolic links.".into()); }
    fn collect(root: &Path, dir: &Path, entries: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if ty.is_symlink() { return Err("Skill files must not be symbolic links.".into()); }
            if ty.is_dir() { collect(root, &entry.path(), entries)?; }
            else if ty.is_file() { entries.push((entry.path().strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"), entry.path())); }
            else { return Err("Unsupported Skill file type.".into()); }
        }
        Ok(())
    }
    let mut entries = Vec::new(); collect(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    for (name, path) in entries { hash.update(name.as_bytes()); hash.update(fs::read(path).map_err(|e| e.to_string())?); }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn validate_tree(path: &Path, package: &Package) -> Result<(), String> {
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if entries.len() != BUNDLED_SKILLS.len() { return Err("Unexpected Skill package contents.".into()); }
    for skill in &package.skills {
        let dir = path.join(&skill.name);
        if !dir.join("SKILL.md").is_file() || skill_version(&dir) != skill.version || portable_hash(&dir)? != skill.hash {
            return Err(format!("Skill {} failed content verification.", skill.name));
        }
    }
    Ok(())
}

pub fn extract_package(bytes: &[u8], package: &Package, destination: &Path) -> Result<(), String> {
    if bytes.len() > PACKAGE_LIMIT || digest(bytes) != package.sha256 { return Err("Skill package checksum verification failed.".into()); }
    package.validate()?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    if archive.len() > 4096 { return Err("Too many Skill archive entries.".into()); }
    let mut seen = BTreeSet::new(); let mut total = 0u64;
    // Validate the whole central directory before writing any files.
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().trim_end_matches('/');
        let parts: Vec<_> = name.split('/').collect();
        if parts.is_empty() || !BUNDLED_SKILLS.contains(&parts[0]) || parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains(['\\', ':']) || p.ends_with(['.', ' ']) || p.chars().any(char::is_control) || windows_device(p))
            || file.enclosed_name().is_none() || !seen.insert(name.to_lowercase())
            || file.unix_mode().is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000 && m & 0o170000 != 0o040000) {
            return Err("Unsafe or duplicate Skill archive path.".into());
        }
        if !file.is_dir() && parts.len() < 2 { return Err("Invalid Skill file path.".into()); }
        total = total.checked_add(file.size()).ok_or("Skill package is too large.")?;
        if total > EXTRACT_LIMIT { return Err("Skill package exceeds the extraction limit.".into()); }
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let target = destination.join(file.enclosed_name().ok_or("Unsafe Skill path.")?);
        if file.is_dir() { fs::create_dir_all(target).map_err(|e| e.to_string())?; }
        else {
            fs::create_dir_all(target.parent().ok_or("Invalid Skill path.")?).map_err(|e| e.to_string())?;
            let expected = file.size();
            let mut content = Vec::new();
            (&mut file).take(expected + 1).read_to_end(&mut content).map_err(|e| e.to_string())?;
            if content.len() as u64 != expected { return Err("Invalid Skill entry length.".into()); }
            fs::write(target, content).map_err(|e| e.to_string())?;
        }
    }
    validate_tree(destination, package)
}
pub fn install(root: &Path, bytes: &[u8], package: &Package) -> Result<(), String> {
    package.validate()?;
    if package.revoked { return Err("This Skill release was revoked.".into()); }
    if bytes.len() > PACKAGE_LIMIT || digest(bytes) != package.sha256 { return Err("Skill package checksum verification failed.".into()); }
    let versions = root.join("versions"); fs::create_dir_all(&versions).map_err(|e| e.to_string())?;
    let target = versions.join(&package.version);
    let staging = versions.join(format!(".{}-staging", package.version));
    if staging.exists() { fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
    if target.exists() && validate_tree(&target, package).is_ok() { return activate(root, &package.version); }
    if let Err(error) = extract_package(bytes, package, &staging) { let _ = fs::remove_dir_all(&staging); return Err(error); }
    if target.exists() { fs::remove_dir_all(&target).map_err(|e| e.to_string())?; }
    fs::rename(staging, target).map_err(|e| e.to_string())?;
    activate(root, &package.version)
}
fn activate(root: &Path, version: &str) -> Result<(), String> { atomic_write(&root.join("active.json"), &serde_json::to_vec(version).map_err(|e| e.to_string())?) }

/// Recover from a corrupt activation record using verified installed releases.
/// A newer bundled baseline wins over older downloaded packages.
pub fn resolve_source(root: &Path, bundled: &Path, bundled_version: &Version, app: &Version, contract: &str, key: &str) -> PathBuf {
    let Ok(index) = cached_index(root, key) else { return bundled.to_owned(); };
    let mut packages: Vec<_> = index.packages.iter().filter(|p| p.compatible(app, contract)
        && Version::parse(&p.version).is_ok_and(|v| v >= *bundled_version)).collect();
    packages.sort_by_key(|p| std::cmp::Reverse(Version::parse(&p.version).ok()));
    let active = fs::read(root.join("active.json")).ok().and_then(|b| serde_json::from_slice::<String>(&b).ok());
    if let Some(package) = packages.iter().find(|p| active.as_deref() == Some(&p.version)) {
        let dir = root.join("versions").join(&package.version);
        if validate_tree(&dir, package).is_ok() { return dir; }
    }
    for p in packages {
        let dir = root.join("versions").join(&p.version);
        if validate_tree(&dir, p).is_ok() { return dir; }
    }
    bundled.to_owned()
}

fn windows_device(segment: &str) -> bool {
    let name = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || name.strip_prefix("COM").or_else(|| name.strip_prefix("LPT")).is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use crate::archive::{ArchiveEntry, write_archive};
    fn temp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static ID: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!("athria-updates-{}-{}", std::process::id(), ID.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap(); root
    }
    fn package(version: &str) -> Package {
        Package { version: version.into(), min_app_version: "0.2.1-beta.1".into(), max_app_version: "0.3.0".into(), supported_contracts: vec![digest(b"contract")],
            skills: BUNDLED_SKILLS.iter().map(|n| SkillIdentity { name: n.to_string(), version: "0.1.0".into(), hash: digest(b"skill") }).collect(),
            url: format!("https://github.com/whywww/Athria/releases/download/skills-v{version}/skills.zip"), sha256: digest(b"zip"), revoked: false }
    }
    fn signed(index: &Index) -> (Vec<u8>, String) {
        let key = SigningKey::from_bytes(&[42; 32]); let payload = serde_json::to_vec(index).unwrap();
        (serde_json::to_vec(&Envelope { payload: STANDARD.encode(&payload), signature: STANDARD.encode(key.sign(&payload).to_bytes()) }).unwrap(), STANDARD.encode(key.verifying_key().to_bytes()))
    }
    #[test] fn verifies_signature_and_rejects_tampering() {
        let (bytes, key) = signed(&Index { schema_version: 1, packages: vec![package("0.1.0")] });
        assert_eq!(verify_index(&bytes, &key).unwrap().packages.len(), 1);
        let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap(); envelope.payload = STANDARD.encode(b"{}");
        assert!(verify_index(&serde_json::to_vec(&envelope).unwrap(), &key).is_err());
        assert!(verify_index(&bytes, "").is_err());
        assert!(verify_index(&vec![0; INDEX_LIMIT + 1], &key).is_err());
    }
    #[test] fn compatibility_and_revocation() {
        let app = Version::parse("0.2.1-beta.1").unwrap(); let contract = digest(b"contract");
        let mut newer = package("0.2.0"); newer.supported_contracts = vec![digest(b"new")];
        let mut index = Index { schema_version: 1, packages: vec![package("0.1.0"), newer] };
        assert_eq!(newest(&index, &app, &contract).unwrap().version, "0.1.0");
        index.packages[0].revoked = true; assert!(newest(&index, &app, &contract).is_none());
        assert!(!package("0.1.0").compatible(&Version::parse("0.3.0").unwrap(), &contract));
        assert_eq!(contract_fingerprint("a\r\nb"), contract_fingerprint("a\nb"));
    }
    fn fixture(root: &Path) -> (Package, Vec<u8>) {
        let mut entries = Vec::new(); let mut p = package("0.1.1");
        for skill in &mut p.skills {
            let dir = root.join("source").join(&skill.name); fs::create_dir_all(dir.join("references")).unwrap();
            for (name, data) in [("SKILL.md", b"instructions".as_slice()), ("manifest.json", b"{\"version\":\"0.1.0\"}".as_slice()), ("references/guide.md", b"guide".as_slice())] {
                fs::write(dir.join(name), data).unwrap(); entries.push(ArchiveEntry { name: format!("{}/{name}", skill.name), data: data.to_vec() });
            }
            skill.hash = portable_hash(&dir).unwrap();
        }
        let path = root.join("package.zip"); write_archive(&path, &entries).unwrap();
        let bytes = fs::read(path).unwrap(); p.sha256 = digest(&bytes); (p, bytes)
    }
    #[test] fn installs_recovers_and_falls_back_without_partial_activation() {
        let root = temp(); let (p, bytes) = fixture(&root); let (signed, key) = signed(&Index { schema_version: 1, packages: vec![p.clone()] });
        atomic_write(&root.join("index.json"), &signed).unwrap(); install(&root, &bytes, &p).unwrap();
        let app = Version::parse("0.2.1-beta.1").unwrap(); let baseline = Version::parse("0.1.0").unwrap(); let bundled = root.join("bundled");
        atomic_write(&root.join("active.json"), b"broken").unwrap();
        assert_eq!(resolve_source(&root, &bundled, &baseline, &app, &digest(b"contract"), &key), root.join("versions/0.1.1"));
        assert!(install(&root, &bytes[..bytes.len()-1], &p).is_err());
        assert_eq!(resolve_source(&root, &bundled, &Version::parse("0.2.0").unwrap(), &app, &digest(b"contract"), &key), bundled);
        let mut revoked = p; revoked.revoked = true;
        let (signed, _) = self::signed(&Index { schema_version: 1, packages: vec![revoked] }); atomic_write(&root.join("index.json"), &signed).unwrap();
        assert_eq!(resolve_source(&root, &bundled, &baseline, &app, &digest(b"contract"), &key), bundled);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn rejects_unsafe_archives_and_wrong_content() {
        let root = temp(); let (mut p, _) = fixture(&root);
        for name in ["athria-coach/../evil", "athria-coach/C:evil", "other/SKILL.md", "athria-coach/a\\evil", "/athria-coach/x", "athria-coach/CON.txt", "athria-coach/a."] {
            let zip = root.join("bad.zip"); write_archive(&zip, &[ArchiveEntry { name: name.into(), data: vec![1] }]).unwrap();
            let bytes = fs::read(zip).unwrap(); p.sha256 = digest(&bytes);
            assert!(extract_package(&bytes, &p, &root.join("out")).is_err(), "{name}");
        }
        let (mut p, bytes) = fixture(&root); p.skills[0].hash = digest(b"wrong");
        assert!(extract_package(&bytes, &p, &root.join("out")).is_err()); fs::remove_dir_all(root).unwrap();
    }
    #[test] fn preferences_replace_atomically() {
        let root = temp(); assert!(read_preferences(&root).unwrap().automatic);
        save_preferences(&root, &Preferences { automatic: false, ..Default::default() }).unwrap();
        save_preferences(&root, &Preferences { automatic: true, ..Default::default() }).unwrap();
        assert!(read_preferences(&root).unwrap().automatic); fs::remove_dir_all(root).unwrap();
    }
    #[test] fn compatibility_edits_reuse_installed_content_and_narrowing_falls_back() {
        let root = temp(); let (mut p, bytes) = fixture(&root);
        p.max_app_version = "0.2.1-beta.3".into();
        let app = Version::parse("0.2.1-beta.2").unwrap();
        let baseline = Version::parse("0.1.0").unwrap();
        let current = Version::parse(&p.version).unwrap();
        let bundled = root.join("bundled"); let contract = digest(b"contract");
        let mut index = Index { schema_version: 1, packages: vec![p] };
        let (envelope, key) = signed(&index); atomic_write(&root.join("index.json"), &envelope).unwrap();
        install(&root, &bytes, &index.packages[0]).unwrap();
        let original = resolve_source(&root, &bundled, &baseline, &app, &contract, &key);
        index.packages[0].max_app_version = "0.2.1-beta.4".into();
        index.packages[0].supported_contracts.push(digest(b"another tested MCP"));
        let (envelope, _) = signed(&index); atomic_write(&root.join("index.json"), &envelope).unwrap();
        assert!(available_update(&index, &app, &contract, &current).is_none());
        assert_eq!(resolve_source(&root, &bundled, &baseline, &app, &contract, &key), original);
        let future_app = Version::parse("0.2.1-beta.3").unwrap();
        assert!(available_update(&index, &future_app, &contract, &current).is_none());
        assert_eq!(resolve_source(&root, &bundled, &baseline, &future_app, &contract, &key), original);
        index.packages[0].min_app_version = "0.2.1-beta.3".into();
        let (envelope, _) = signed(&index); atomic_write(&root.join("index.json"), &envelope).unwrap();
        assert_eq!(resolve_source(&root, &bundled, &baseline, &app, &contract, &key), bundled);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn rejects_duplicates_links_and_extraction_bombs() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let root = temp();
        let mut p = package("0.1.1");
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("athria-coach/a", SimpleFileOptions::default()).unwrap(); writer.write_all(b"a").unwrap();
        writer.start_file("athria-coach/A", SimpleFileOptions::default()).unwrap(); writer.write_all(b"b").unwrap();
        let bytes = writer.finish().unwrap().into_inner(); p.sha256 = digest(&bytes);
        assert!(extract_package(&bytes, &p, &root.join("duplicates")).is_err());
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.add_symlink("athria-coach/link", "../../outside", SimpleFileOptions::default()).unwrap();
        let bytes = writer.finish().unwrap().into_inner(); p.sha256 = digest(&bytes);
        assert!(extract_package(&bytes, &p, &root.join("links")).is_err());
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("athria-coach/large", SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
        writer.write_all(&vec![0; EXTRACT_LIMIT as usize + 1]).unwrap();
        let bytes = writer.finish().unwrap().into_inner(); p.sha256 = digest(&bytes);
        assert!(extract_package(&bytes, &p, &root.join("large")).is_err());
        assert!(!root.join("large").exists()); fs::remove_dir_all(root).unwrap();
    }
}
