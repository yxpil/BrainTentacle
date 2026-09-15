// yxpil · BIT
//! 敏感配置文件「设备密钥」加密存储。
//! 仅用于 ai_config.json / mcp_servers.json 这类含第三方凭据(api_key / token)的文件：
//! 主密钥 = config.json 里明文读出的 device_key(设备和账号锚点)，零新依赖。
//!
//! 格式 `BITENC1:{ base64( salt[16] || ciphertext || mac[32] ) }`：
//! - salt   ：每次随机 16B
//! - cipher ：CTR 流式 XOR，块 = SHA256(key ‖ salt ‖ ctr_be_u32)，与 bitcrypt 同构
//! - mac    ：HMAC-SHA256(key, salt ‖ ciphertext)，校验篡改 / 密钥错误
//!
//! 读写路径透明兼容：老明文文件按明文解析；有 key 写通过程自动迁移为密文。

use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

use crate::security::{ct_eq, hmac_sha256};

pub const SECRET_PREFIX: &str = "BITENC1:";
const SALT_LEN: usize = 16;
const MAC_LEN: usize = 32;

/// 解密错误分类：区分"非加密文件(明文)"与"加密但校验失败(篡改/密钥错误)"
#[derive(Debug, Clone, PartialEq)]
pub enum DecryptErr {
    /// 无前缀 → 不是本模块加密的(明文或其它)
    NotEncrypted,
    BadPrefix,
    BadBase64,
    TooShort,
    /// MAC 不匹配：密文被篡改 或 密钥(device_key)与加密时不一致
    BadMac,
    BadUtf8,
}

/// 加密：device_key 派生主钥，随机盐 + CTR + MAC
pub fn encrypt_bytes(key: &str, plain: &[u8]) -> String {
    use base64::Engine;
    use rand::Rng;
    let salt: [u8; SALT_LEN] = rand::thread_rng().gen();
    let mut cipher = Vec::with_capacity(plain.len());
    for (i, byte) in plain.iter().enumerate() {
        let ctr = (i / 32) as u32;
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        hasher.update(salt);
        hasher.update(ctr.to_be_bytes());
        let block = hasher.finalize();
        cipher.push(byte ^ block[i % 32]);
    }
    let mut body = salt.to_vec();
    body.extend_from_slice(&cipher);
    let mac = hmac_sha256(key.as_bytes(), &body);
    body.extend_from_slice(&mac);
    format!("{SECRET_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(&body))
}

/// 解密：MAC 校验通过才返回明文；任何失败不 panic，返回分类错误
pub fn decrypt_bytes(key: &str, blob: &str) -> Result<Vec<u8>, DecryptErr> {
    use base64::Engine;
    let raw = blob.strip_prefix(SECRET_PREFIX).ok_or(DecryptErr::NotEncrypted)?;
    let buf = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|_| DecryptErr::BadBase64)?;
    if buf.len() < SALT_LEN + MAC_LEN {
        return Err(DecryptErr::TooShort);
    }
    let (body, mac) = buf.split_at(buf.len() - MAC_LEN);
    if !ct_eq(&hmac_sha256(key.as_bytes(), body), mac) {
        return Err(DecryptErr::BadMac);
    }
    let (salt, cipher) = body.split_at(SALT_LEN);
    let mut plain = Vec::with_capacity(cipher.len());
    for (i, byte) in cipher.iter().enumerate() {
        let ctr = (i / 32) as u32;
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        hasher.update(salt);
        hasher.update(ctr.to_be_bytes());
        let block = hasher.finalize();
        plain.push(byte ^ block[i % 32]);
    }
    Ok(plain)
}

/// 读取结果：value 成功解析的值，was_legacy 标记是否为"老明文(需迁移)"
pub struct SecretRead<T> {
    pub value: Option<T>,
    pub was_legacy: bool,
}

/// 读敏感 JSON：透明兼容明文/密文；解密失败回退 None 且不动磁盘。
/// key 为空(None)且文件是密文 → 视为不可解，返回 None。
pub fn read_secret_json<T: DeserializeOwned>(
    dir: &Path,
    file: &str,
    key: Option<&str>,
) -> SecretRead<T> {
    let path = dir.join(file);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return SecretRead { value: None, was_legacy: false },
    };
    if raw.starts_with(SECRET_PREFIX) {
        let key = match key {
            Some(k) if !k.is_empty() => k,
            _ => return SecretRead { value: None, was_legacy: false },
        };
        match decrypt_bytes(key, &raw) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(t) => SecretRead { value: Some(t), was_legacy: false },
                Err(e) => {
                    eprintln!("[securefile] {file} decrypt json parse failed: {e}");
                    SecretRead { value: None, was_legacy: false }
                }
            },
            Err(e) => {
                eprintln!("[securefile] {file} decrypt failed: {e:?}");
                SecretRead { value: None, was_legacy: false }
            }
        }
    } else {
        // 老明文：能解则解，标记 was_legacy=调用方可选迁移
        match serde_json::from_str(&raw) {
            Ok(t) => SecretRead { value: Some(t), was_legacy: true },
            Err(_) => SecretRead { value: None, was_legacy: false },
        }
    }
}

/// 原子写敏感 JSON。key 为空 → 退明文写(兼容首启 device_key 尚未生成)。
/// 复刻 config.rs::Config::save 的 tmp+rename 重试模式。
pub fn write_secret_json<T: Serialize>(dir: &Path, file: &str, key: Option<String>, val: &T) {
    let path = dir.join(file);
    let json = match serde_json::to_vec_pretty(val) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[securefile] {file} serialize failed: {e}");
            return;
        }
    };
    let body = match key {
        Some(k) if !k.is_empty() => encrypt_bytes(&k, &json).into_bytes(),
        _ => json, // 无 key → 明文写
    };
    atomic_write(&path, &body);
}

fn atomic_write(path: &Path, body: &[u8]) {
    let tmp = path.with_extension("json.tmp");
    let mut ok = fs::write(&tmp, body).is_ok();
    if ok {
        ok = false;
        for _ in 0..4 {
            if fs::rename(&tmp, path).is_ok() {
                ok = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    }
    if !ok {
        if fs::write(path, body).is_ok() {
            eprintln!("[securefile] rename retry exhausted, fallback direct write ok");
        } else {
            eprintln!("[securefile] SAVE FAILED for {}", path.display());
        }
    }
}

/// 轻量读 config.json 的 device_key（不被 Config::load 尾部写副作用干扰；供测试/独立工具用）
pub fn load_device_key(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("device_key").and_then(|k| k.as_str()).filter(|s| !s.is_empty()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_salt_diversity_no_leak() {
        let key = "bitdev_testkey1234abcd";
        let plain = r#"{"providers":[{"id":"x","api_key":"sk-MY-SECRET-API-KEY"}]}"#;
        let enc1 = encrypt_bytes(key, plain.as_bytes());
        let enc2 = encrypt_bytes(key, plain.as_bytes());
        assert!(enc1.starts_with(SECRET_PREFIX));
        assert_ne!(enc1, enc2, "盐随机 → 每次密文不同");
        assert!(!enc1.contains("sk-MY-SECRET-API-KEY"), "密文不得泄露明文密钥");
        assert_eq!(decrypt_bytes(key, &enc1).unwrap(), plain.as_bytes());
        assert_eq!(decrypt_bytes(key, &enc2).unwrap(), plain.as_bytes());
    }

    #[test]
    fn format_errors() {
        let key = "k";
        // 无前缀明文 → NotEncrypted
        assert_eq!(decrypt_bytes(key, "{\"a\":1}"), Err(DecryptErr::NotEncrypted));
        // 坏 base64
        assert_eq!(decrypt_bytes(key, &format!("{SECRET_PREFIX}!!!notbase64")), Err(DecryptErr::BadBase64));
        // 太短
        assert_eq!(decrypt_bytes(key, "BITENC1:AA=="), Err(DecryptErr::TooShort));
    }

    #[test]
    fn tamper_mac_and_wrong_key() {
        let key = "bitdev_wrongtest";
        let plain = b"hello secret";
        let enc = encrypt_bytes(key, plain);
        // 翻转 MAC 一位 → BadMac
        let mut b = enc.clone().into_bytes();
        let last = b.len() - 1;
        b[last] = if b[last] == b'A' { b'B' } else { b'A' };
        assert_eq!(decrypt_bytes(key, &String::from_utf8(b).unwrap()), Err(DecryptErr::BadMac));
        // 翻转密文一位 → BadMac（用合法 base64 字符替换，XOR 可能跳出字母表变 BadBase64）
        let mut b2 = enc.clone().into_bytes();
        let n = b2.len() - 16; // 密文区
        b2[n] = if b2[n] == b'A' { b'B' } else { b'A' };
        assert_eq!(decrypt_bytes(key, &String::from_utf8(b2).unwrap()), Err(DecryptErr::BadMac));
        // 错误 key → BadMac
        assert_eq!(decrypt_bytes("otherkey", &enc), Err(DecryptErr::BadMac));
        // 正确 key 可解
        assert_eq!(decrypt_bytes(key, &enc).unwrap(), plain);
    }

    #[test]
    fn legacy_plaintext_detected() {
        let dir = std::env::temp_dir().join("bit-securefile-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.json");
        std::fs::write(&p, "{\"a\":7}").unwrap();
        let r: SecretRead<serde_json::Value> = read_secret_json(&dir, "x.json", Some("k"));
        assert!(r.was_legacy, "老明文必须被识别");
        assert_eq!(r.value.unwrap()["a"], 7);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn null_key_writes_plaintext() {
        let dir = std::env::temp_dir().join("bit-securefile-test2");
        std::fs::create_dir_all(&dir).unwrap();
        write_secret_json(&dir, "y.json", None, &serde_json::json!({"b": 2}));
        let raw = std::fs::read_to_string(dir.join("y.json")).unwrap();
        assert!(!raw.starts_with(SECRET_PREFIX), "空 key 必须写明文");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keyed_write_is_encrypted() {
        let dir = std::env::temp_dir().join("bit-securefile-test3");
        std::fs::create_dir_all(&dir).unwrap();
        write_secret_json(&dir, "z.json", Some("seckey".into()), &serde_json::json!({"c": 3}));
        let raw = std::fs::read_to_string(dir.join("z.json")).unwrap();
        assert!(raw.starts_with(SECRET_PREFIX), "有 key 必须写密文");
        let r: SecretRead<serde_json::Value> = read_secret_json(&dir, "z.json", Some("seckey"));
        assert!(!r.was_legacy);
        assert_eq!(r.value.unwrap()["c"], 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_bad_file_is_none() {
        let dir = std::env::temp_dir().join("bit-securefile-test4");
        std::fs::create_dir_all(&dir).unwrap();
        let r: SecretRead<serde_json::Value> = read_secret_json(&dir, "ghost.json", Some("k"));
        assert!(r.value.is_none());
        // 坏明文 JSON 不 panic
        let p = dir.join("bad.json");
        std::fs::write(&p, "{not json").unwrap();
        let r2: SecretRead<serde_json::Value> = read_secret_json(&dir, "bad.json", Some("k"));
        assert!(r2.value.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}