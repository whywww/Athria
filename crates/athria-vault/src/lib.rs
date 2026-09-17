//! Portable Athria vault cryptography and persisted DTOs.
//! Platform key caches and persistence deliberately live outside this crate.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{
    Key, XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

pub const FORMAT_VERSION: u32 = 1;
pub const KDF_MEMORY_KIB: u32 = 65_536;
pub const KDF_ITERATIONS: u32 = 3;
pub const KDF_PARALLELISM: u32 = 1;
const CHECK_VALUE: &[u8] = b"athria-vault-check-v1";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEnvelope {
    pub format_version: u32,
    pub kdf_algorithm: String,
    pub kdf_memory_kib: u32,
    pub kdf_iterations: u32,
    pub kdf_parallelism: u32,
    pub salt: String,
    pub wrap_nonce: String,
    pub wrapped_master_key: String,
    pub check_nonce: String,
    pub check_ciphertext: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSecret {
    pub source: String,
    pub config: Value,
    pub cipher_version: u32,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBundle {
    pub database_uuid: String,
    pub envelope: Option<VaultEnvelope>,
    pub secrets: Vec<EncryptedSecret>,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut value = [0; N];
    OsRng.fill_bytes(&mut value);
    value
}
fn aad(database_uuid: &str, purpose: &str) -> String {
    format!("athria:v{FORMAT_VERSION}:{database_uuid}:{purpose}")
}

fn derive_kek(password: &str, envelope: &VaultEnvelope) -> Result<Zeroizing<Vec<u8>>, String> {
    if envelope.kdf_algorithm != "argon2id" {
        return Err("Unsupported vault key derivation algorithm.".into());
    }
    let salt = BASE64
        .decode(&envelope.salt)
        .map_err(|_| "The vault salt is invalid.".to_string())?;
    let params = Params::new(
        envelope.kdf_memory_kib,
        envelope.kdf_iterations,
        envelope.kdf_parallelism,
        Some(32),
    )
    .map_err(|_| "The vault key derivation parameters are invalid.".to_string())?;
    let mut output = Zeroizing::new(vec![0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut output)
        .map_err(|_| "Athria could not derive the vault key.".to_string())?;
    Ok(output)
}

fn encrypt(
    key: &[u8],
    nonce: &[u8; 24],
    plaintext: &[u8],
    associated: &[u8],
) -> Result<String, String> {
    XChaCha20Poly1305::new(Key::from_slice(key))
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad: associated,
            },
        )
        .map(|value| BASE64.encode(value))
        .map_err(|_| "Athria could not encrypt the connection vault.".into())
}
fn decrypt(
    key: &[u8],
    nonce: &str,
    ciphertext: &str,
    associated: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = BASE64
        .decode(nonce)
        .map_err(|_| "The vault nonce is invalid.".to_string())?;
    let ciphertext = BASE64
        .decode(ciphertext)
        .map_err(|_| "The vault ciphertext is invalid.".to_string())?;
    if nonce.len() != 24 {
        return Err("The vault nonce has an invalid length.".into());
    }
    XChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: associated,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| "The database password is incorrect or the database vault is damaged.".into())
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        Err("The database password cannot be empty.".into())
    } else {
        Ok(())
    }
}
pub fn new_master_key() -> Zeroizing<Vec<u8>> {
    Zeroizing::new(random_bytes::<32>().to_vec())
}
pub fn encode_master_key(key: &[u8]) -> String {
    BASE64.encode(key)
}
pub fn decode_master_key(value: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let key = BASE64
        .decode(value)
        .map_err(|_| "The cached database key is invalid.".to_string())?;
    if key.len() != 32 {
        return Err("The cached database key has an invalid length.".into());
    }
    Ok(Zeroizing::new(key))
}
pub fn create_envelope(
    database_uuid: &str,
    password: &str,
    master_key: &[u8],
) -> Result<VaultEnvelope, String> {
    validate_password(password)?;
    let salt = random_bytes::<16>();
    let mut envelope = VaultEnvelope {
        format_version: FORMAT_VERSION,
        kdf_algorithm: "argon2id".into(),
        kdf_memory_kib: KDF_MEMORY_KIB,
        kdf_iterations: KDF_ITERATIONS,
        kdf_parallelism: KDF_PARALLELISM,
        salt: BASE64.encode(salt),
        wrap_nonce: String::new(),
        wrapped_master_key: String::new(),
        check_nonce: String::new(),
        check_ciphertext: String::new(),
    };
    let kek = derive_kek(password, &envelope)?;
    let wrap_nonce = random_bytes::<24>();
    let check_nonce = random_bytes::<24>();
    envelope.wrap_nonce = BASE64.encode(wrap_nonce);
    envelope.wrapped_master_key = encrypt(
        &kek,
        &wrap_nonce,
        master_key,
        aad(database_uuid, "master-key").as_bytes(),
    )?;
    envelope.check_nonce = BASE64.encode(check_nonce);
    envelope.check_ciphertext = encrypt(
        master_key,
        &check_nonce,
        CHECK_VALUE,
        aad(database_uuid, "key-check").as_bytes(),
    )?;
    Ok(envelope)
}
pub fn unlock(
    database_uuid: &str,
    password: &str,
    envelope: &VaultEnvelope,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let key = decrypt(
        &derive_kek(password, envelope)?,
        &envelope.wrap_nonce,
        &envelope.wrapped_master_key,
        aad(database_uuid, "master-key").as_bytes(),
    )?;
    verify_master_key(database_uuid, &key, envelope)?;
    Ok(key)
}
pub fn verify_master_key(
    database_uuid: &str,
    key: &[u8],
    envelope: &VaultEnvelope,
) -> Result<(), String> {
    if decrypt(
        key,
        &envelope.check_nonce,
        &envelope.check_ciphertext,
        aad(database_uuid, "key-check").as_bytes(),
    )?
    .as_slice()
        == CHECK_VALUE
    {
        Ok(())
    } else {
        Err("The cached database key is invalid.".into())
    }
}
pub fn encrypt_secret(
    database_uuid: &str,
    source: &str,
    config: Value,
    plaintext: &str,
    key: &[u8],
) -> Result<EncryptedSecret, String> {
    let nonce = random_bytes::<24>();
    Ok(EncryptedSecret {
        source: source.into(),
        config,
        cipher_version: FORMAT_VERSION,
        nonce: BASE64.encode(nonce),
        ciphertext: encrypt(
            key,
            &nonce,
            plaintext.as_bytes(),
            aad(database_uuid, source).as_bytes(),
        )?,
    })
}
pub fn decrypt_secret(
    database_uuid: &str,
    secret: &EncryptedSecret,
    key: &[u8],
) -> Result<Zeroizing<String>, String> {
    String::from_utf8(
        decrypt(
            key,
            &secret.nonce,
            &secret.ciphertext,
            aad(database_uuid, &secret.source).as_bytes(),
        )?
        .to_vec(),
    )
    .map(Zeroizing::new)
    .map_err(|_| "The saved connection key is invalid.".into())
}
pub fn clear_string(value: &mut String) {
    value.zeroize();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn round_trip_and_uuid_binding() {
        let master = new_master_key();
        let env = create_envelope("one", "password", &master).unwrap();
        assert!(unlock("one", "wrong", &env).is_err());
        let key = unlock("one", "password", &env).unwrap();
        let secret = encrypt_secret("one", "intervals", json!({}), "secret", &key).unwrap();
        assert_eq!(
            decrypt_secret("one", &secret, &key).unwrap().as_str(),
            "secret"
        );
        assert!(decrypt_secret("two", &secret, &key).is_err());
    }
}
