// yxpil · BIT core 集成测试（黑盒视角，仅用 bit_core 公共 API）
//
// 覆盖：敏感文件加密往返与篡改检测、HMAC 稳定性、插件清单容错、
// 监听主机归一化对注入（路径穿越/空白）的拒绝、用户路径清洗。
// 这些都不依赖运行时 Ctx / Tauri 句柄，可在 CI 中独立跑。

use bit_core::plugins::Plugin;
use bit_core::securefile::{decrypt_bytes, encrypt_bytes, read_secret_json, write_secret_json, DecryptErr, SECRET_PREFIX};
use bit_core::security::hmac_sha256;

// ── 加密存储：往返 / 盐随机 / 密文不泄露明文 ──

#[test]
fn encrypt_roundtrip_and_no_plaintext_leak() {
    let key = "bt-integration-key";
    let plain = br#"{"providers":[{"id":"x","api_key":"sk-SECRET"}]}"#;
    let enc1 = encrypt_bytes(key, plain);
    let enc2 = encrypt_bytes(key, plain);
    assert!(enc1.starts_with(SECRET_PREFIX));
    assert_ne!(enc1, enc2, "随机盐 → 两次密文不同");
    assert!(!enc1.contains("sk-SECRET"), "密文不得出现明文密钥");
    assert_eq!(decrypt_bytes(key, &enc1).unwrap(), plain);
    assert_eq!(decrypt_bytes(key, &enc2).unwrap(), plain);
}

#[test]
fn tampered_ciphertext_rejected() {
    let key = "k";
    let enc = encrypt_bytes(key, b"payload");
    // 翻转密文区一位 → MAC 校验失败
    let mut b = enc.into_bytes();
    let mid = b.len() - 16;
    b[mid] ^= 0x01;
    assert_eq!(decrypt_bytes(key, &String::from_utf8(b).unwrap()), Err(DecryptErr::BadMac));
}

#[test]
fn wrong_key_rejected_as_bad_mac() {
    let enc = encrypt_bytes("right-key", b"secret");
    assert_eq!(decrypt_bytes("wrong-key", &enc), Err(DecryptErr::BadMac));
    assert_eq!(decrypt_bytes("right-key", &enc).unwrap(), b"secret");
}

#[test]
fn non_encrypted_blob_is_notencrypted() {
    assert_eq!(decrypt_bytes("any", "{\"a\":1}"), Err(DecryptErr::NotEncrypted));
    assert_eq!(
        decrypt_bytes("any", &format!("{SECRET_PREFIX}!!!notbase64")),
        Err(DecryptErr::BadBase64)
    );
}

// ── 加密 JSON 文件：明文/密文透明读写 ──

#[test]
fn secret_json_roundtrip_with_and_without_key() {
    let dir = std::env::temp_dir().join(format!("bt-it-secret-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // 有 key → 写密文，读回还原
    write_secret_json(&dir, "k.json", Some("seckey".into()), &serde_json::json!({"v": 3}));
    let raw = std::fs::read_to_string(dir.join("k.json")).unwrap();
    assert!(raw.starts_with(SECRET_PREFIX), "有 key 必须写密文");
    let r: bit_core::securefile::SecretRead<serde_json::Value> =
        read_secret_json(&dir, "k.json", Some("seckey"));
    assert_eq!(r.value.unwrap()["v"], 3);
    assert!(!r.was_legacy);

    // 无 key → 写明文，读回标记 legacy
    write_secret_json(&dir, "p.json", None, &serde_json::json!({"v": 9}));
    let r2: bit_core::securefile::SecretRead<serde_json::Value> =
        read_secret_json(&dir, "p.json", Some("k"));
    assert!(r2.was_legacy, "老明文必须被识别");
    assert_eq!(r2.value.unwrap()["v"], 9);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn secret_json_missing_file_is_none_no_panic() {
    let dir = std::env::temp_dir().join(format!("bt-it-secret-missing-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let r: bit_core::securefile::SecretRead<serde_json::Value> =
        read_secret_json(&dir, "ghost.json", Some("k"));
    assert!(r.value.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

// ── HMAC：确定性 + 密钥敏感 ──

#[test]
fn hmac_is_deterministic_and_key_sensitive() {
    let a = hmac_sha256(b"key", b"message");
    let b = hmac_sha256(b"key", b"message");
    assert_eq!(a, b, "同 key 同消息 → 稳定摘要");
    let c = hmac_sha256(b"key2", b"message");
    assert_ne!(a, c, "不同 key → 摘要必须不同");
    assert_eq!(a.len(), 32);
}

// ── 插件清单（钩子机制）：缺 id 容错 / 非法 JSON 拒绝 ──

#[test]
fn plugin_manifest_missing_id_still_parses() {
    let p: Plugin = serde_json::from_str(r#"{ "name": "demo", "tools": [{ "name": "t" }] }"#).unwrap();
    assert_eq!(p.name, "demo");
    assert_eq!(p.tools.len(), 1);
    assert_eq!(p.tools[0].kind, "interpreter");
    assert!(p.jobs.is_empty());
}

#[test]
fn plugin_manifest_garbage_does_not_panic() {
    // 截断的 JSON 必须报错（供 scan 收集为错误列表）
    assert!(serde_json::from_str::<Plugin>(r#"{ "name": "#).is_err());
    // 数组形态：serde 宽容地得到空插件（无 tools/无 jobs），绝不 panic、不注入数据
    let p: Plugin = serde_json::from_str(r#"["not","object"]"#).unwrap();
    assert!(p.tools.is_empty());
    assert!(p.jobs.is_empty());
}

// ── 注入：监听主机归一化拒绝路径穿越/空白 ──

#[test]
fn normalize_host_rejects_injection_payloads() {
    // 路径穿越 / 命令注入特征 → 含分隔符或非法字符 → Err
    assert!(bit_core::config::normalize_host("127.0.0.1/../../etc/passwd").is_err());
    assert!(bit_core::config::normalize_host("evil.com; rm -rf /").is_err());
    assert!(bit_core::config::normalize_host("").is_err());
    assert!(bit_core::config::normalize_host(" ").is_err());
}

#[test]
fn normalize_host_strips_ipv6_brackets_and_accepts_valid() {
    assert_eq!(bit_core::config::normalize_host("[::1]").unwrap(), "::1");
    assert_eq!(bit_core::config::normalize_host("localhost").unwrap(), "localhost");
    assert_eq!(bit_core::config::normalize_host("api.example.com").unwrap(), "api.example.com");
    assert_eq!(bit_core::config::normalize_host(" 127.0.0.1 ").unwrap(), "127.0.0.1");
}

// ── 路径清洗：去引号 / 展开 ~ ──

#[test]
fn normalize_user_path_strips_quotes_and_expands_home() {
    assert_eq!(
        bit_core::paths::normalize_user_path("  \"C:\\a b.txt\"  "),
        r"C:\a b.txt"
    );
    std::env::set_var("HOME", "/home/tester");
    assert_eq!(bit_core::paths::normalize_user_path("~/x"), "/home/tester/x");
}
