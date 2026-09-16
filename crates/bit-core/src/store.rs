// yxpil · BIT
//! 全量数据存储：SQLite 单库（bit.db，WAL 模式，支持 host / worker 多进程并发）。
//!
//! 取代原 data_dir 下的散落 JSON 文件：
//! - 普通文档（tools/runtimes/tool_stats/audit/memories/skills/goals/todos/plugin_jobs/config）
//!   存 `documents` 表，JSON 字节原样入库；
//! - 敏感文档（ai_config/mcp_servers/hidden_codes）双重加密入库：
//!   JSON → 设备密钥流加密(BITENC1，见 securefile) → OS 原生加密(DPAPI，见 osprotect)；
//!   非 Windows 平台第二层为直通（单层），即「没有就不第二遍」；
//! - 会话存 `sessions` 表：一行一个会话（updated 新者胜），取代多进程共享
//!   sessions.json 的 mtime 合并方案；
//! - 遗留 JSON 文件在启动时一次性导入并改名 `.json.migrated` 留档，导入幂等；
//! - 仍保留为文件的（非数据存储）：config.json（device_key/client_key 引导锚点，
//!   securefile::device_key 与 guardian 校验读取）、guardian.json（守护进程 IPC
//!   握手文件）、upgrade/（升级器工作区）、images/ toolhomes/（二进制资产）。

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::Path;

/// 普通文档（明文 JSON 入库）
pub const PLAIN_DOCS: &[&str] = &[
    "config",
    "tools",
    "runtimes",
    "tool_stats",
    "audit",
    "memories",
    "skills",
    "goals",
    "todos",
    "plugin_jobs",
];

/// 敏感文档（设备密钥 + OS 原生 双层加密入库）
pub const SECRET_DOCS: &[&str] = &["ai_config", "mcp_servers", "hidden_codes"];

/// 打开/创建数据目录下的 bit.db。多进程共享：WAL + busy_timeout。
/// 返回的 Connection 由调用方持有（Ctx.db）。
pub fn open(data_dir: &Path) -> Connection {
    let conn = Connection::open(data_dir.join("bit.db"))
        .unwrap_or_else(|e| panic!("[store] cannot open bit.db: {e}"));
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS documents(
            name TEXT PRIMARY KEY,
            data BLOB NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS sessions(
            id TEXT PRIMARY KEY,
            ord INTEGER NOT NULL,
            updated TEXT NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .expect("[store] schema init failed");
    conn
}

// ---------- 普通文档 ----------

pub fn get(conn: &Connection, name: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT data FROM documents WHERE name = ?1", [name], |r| {
        r.get::<_, Vec<u8>>(0)
    })
    .ok()
}

pub fn put(conn: &Connection, name: &str, data: &[u8]) {
    let _ = conn.execute(
        "INSERT INTO documents(name, data) VALUES(?1, ?2)
         ON CONFLICT(name) DO UPDATE SET data = excluded.data,
             updated_at = datetime('now','localtime')",
        rusqlite::params![name, data],
    );
}

pub fn get_json<T: DeserializeOwned>(conn: &Connection, name: &str) -> Option<T> {
    let raw = get(conn, name)?;
    match serde_json::from_slice(&raw) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("[store] {name} json parse failed: {e}");
            None
        }
    }
}

pub fn put_json<T: Serialize>(conn: &Connection, name: &str, val: &T) {
    match serde_json::to_vec(val) {
        Ok(b) => put(conn, name, &b),
        Err(e) => eprintln!("[store] {name} serialize failed: {e}"),
    }
}

pub fn del(conn: &Connection, name: &str) {
    let _ = conn.execute("DELETE FROM documents WHERE name = ?1", [name]);
}

// ---------- 敏感文档：BITENC1(设备密钥) → os_protect(DPAPI) 双层 ----------

/// 写敏感文档。key 为空时退化为明文入库（首启 device_key 尚未生成的兼容路径）。
pub fn put_secret_json<T: Serialize>(conn: &Connection, name: &str, key: &str, val: &T) {
    let json = match serde_json::to_vec(val) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[store] {name} serialize failed: {e}");
            return;
        }
    };
    let blob = if key.is_empty() {
        crate::osprotect::protect(&json) // 无 key：单层明文（tag 0）
    } else {
        let enc = crate::securefile::encrypt_bytes(key, &json);
        crate::osprotect::protect(enc.as_bytes()) // 双层：BITENC1 → DPAPI
    };
    put(conn, name, &blob);
}

/// 读敏感文档。返回 None：行不存在 / 解不开（跨平台拷贝、篡改、密钥不符）。
pub fn get_secret_json<T: DeserializeOwned>(
    conn: &Connection,
    name: &str,
    key: Option<&str>,
) -> Option<T> {
    let blob = get(conn, name)?;
    let inner = match crate::osprotect::unprotect(&blob) {
        Some(v) => v,
        None => {
            eprintln!("[store] {name} os-protect unwrap failed (cross-machine copy or tampered?)");
            return None;
        }
    };
    // 内层可能是 BITENC1 密文（双层）或明文 JSON（无 key 写入的兼容路径）
    let text = String::from_utf8(inner).ok()?;
    if text.starts_with(crate::securefile::SECRET_PREFIX) {
        let key = key?;
        let plain = crate::securefile::decrypt_bytes(key, &text).ok()?;
        match serde_json::from_slice(&plain) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[store] {name} decrypt json parse failed: {e}");
                None
            }
        }
    } else {
        serde_json::from_str(&text).ok()
    }
}

// ---------- 会话（一行一个会话，updated 新者胜）----------

pub fn upsert_session(conn: &Connection, id: &str, ord: usize, updated: &str, data: &str) {
    let _ = conn.execute(
        "INSERT INTO sessions(id, ord, updated, data) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, updated = excluded.updated,
             data = excluded.data",
        rusqlite::params![id, ord as i64, updated, data],
    );
}

/// 全量同步：内存 SessionStore 为准（调用方保证已 merge_from_disk），
/// 覆盖所有行并删除磁盘上多余的（对应原 sessions.json 整仓覆盖语义）
pub fn sync_sessions(conn: &Connection, sessions: &[crate::session::Session], active: &str) {
    if conn.execute_batch("BEGIN IMMEDIATE").is_err() {
        return; // 拿不到写锁（另一进程正写）：放弃本次落盘，下次重试
    }
    let ids: Vec<String> = sessions.iter().map(|s| s.id.clone()).collect();
    for (i, s) in sessions.iter().enumerate() {
        match serde_json::to_string(s) {
            Ok(data) => upsert_session(conn, &s.id, i, &s.updated, &data),
            Err(e) => eprintln!("[store] session {} serialize failed: {e}", s.id),
        }
    }
    // 删除磁盘上多余的（会话被删除后整仓覆盖语义）
    if ids.is_empty() {
        let _ = conn.execute("DELETE FROM sessions", []);
    } else {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let _ = conn.execute(
            &format!("DELETE FROM sessions WHERE id NOT IN ({placeholders})"),
            rusqlite::params_from_iter(ids.iter()),
        );
    }
    let _ = conn.execute(
        "INSERT INTO meta(key, value) VALUES('sessions_active', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [active],
    );
    bump_rev(conn);
    let _ = conn.execute_batch("COMMIT");
}

/// 读全部会话行（按 ord 稳定排序），连同 active
pub fn load_sessions(conn: &Connection) -> (Vec<(usize, String)>, String) {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT ord, data FROM sessions ORDER BY ord, id") {
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                out.push((row.0.max(0) as usize, row.1));
            }
        }
    }
    let active = conn
        .query_row("SELECT value FROM meta WHERE key = 'sessions_active'", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default();
    (out, active)
}

pub fn delete_session(conn: &Connection, id: &str) {
    let _ = conn.execute("DELETE FROM sessions WHERE id = ?1", [id]);
    bump_rev(conn);
}

// ---------- 变更计数（merge 的廉价守卫，取代原 mtime 比对）----------

fn bump_rev(conn: &Connection) {
    let _ = conn.execute(
        "INSERT INTO meta(key, value) VALUES('sessions_rev', '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        [],
    );
}

pub fn sessions_rev(conn: &Connection) -> u64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'sessions_rev'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v.max(0) as u64)
    .unwrap_or(0)
}

// ---------- 遗留 JSON 文件一次性导入（幂等）----------

/// 启动时调用：把 data_dir 下的遗留 JSON 文件导入 bit.db 并改名 `.json.migrated` 留档。
/// 行已存在（重复启动）则跳过该文档；sessions.json 特殊处理为按会话逐行导入。
pub fn import_legacy(conn: &Connection, data_dir: &Path, device_key: Option<&str>) {
    for name in SECRET_DOCS {
        let file = data_dir.join(format!("{name}.json"));
        let Ok(raw) = std::fs::read_to_string(&file) else {
            continue;
        };
        if get(conn, name).is_some() {
            rename_migrated(&file);
            continue;
        }
        if raw.starts_with(crate::securefile::SECRET_PREFIX) {
            // 已是设备密钥密文：整串包一层 OS 加密入库（内层密文原样保留）
            put(conn, name, &crate::osprotect::protect(raw.as_bytes()));
        } else {
            // 老明文 JSON：解析后按当前策略重新加密入库
            match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(v) => put_secret_json(conn, name, device_key.unwrap_or(""), &v),
                Err(e) => eprintln!("[store] legacy {name}.json parse failed: {e}"),
            }
        }
        rename_migrated(&file);
    }

    for name in PLAIN_DOCS {
        if *name == "config" {
            continue; // config 由 Config::load 自己处理（引导锚点）
        }
        let file = data_dir.join(format!("{name}.json"));
        let Ok(raw) = std::fs::read_to_string(&file) else {
            continue;
        };
        if get(conn, name).is_none() {
            put(conn, name, raw.as_bytes());
        } else {
            // 库里已有该文档：合并而非覆盖。旧版本运行期只写文件不写库，
            // 文件里可能带有库里没有的较新数据（如运行期新增的记忆/审计），直接丢弃会丢数据
            merge_doc(conn, name, &raw);
        }
        rename_migrated(&file);
    }

    // sessions.json → 按会话逐行导入
    let sf = data_dir.join("sessions.json");
    if let Ok(raw) = std::fs::read_to_string(&sf) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if get(conn, "sessions_imported").is_none() {
                import_sessions_json(conn, &v);
                put(conn, "sessions_imported", b"1");
            }
        }
        rename_migrated(&sf);
    }
    // 旧 chats.json（单会话历史）：会话表为空时迁移为默认会话，随后留档改名
    let cf = data_dir.join("chats.json");
    if let Ok(raw) = std::fs::read_to_string(&cf) {
        if load_sessions(conn).0.is_empty() {
            if let Ok(msgs) = serde_json::from_str::<Vec<crate::ai::ChatMessage>>(&raw) {
                let mut s = crate::session::Session::new("默认对话");
                s.messages = msgs;
                let data = serde_json::to_string(&s).unwrap_or_default();
                upsert_session(conn, &s.id, 0, &s.updated, &data);
                let _ = conn.execute(
                    "INSERT INTO meta(key, value) VALUES('sessions_active', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [&s.id],
                );
                bump_rev(conn);
            }
        }
        rename_migrated(&cf);
    }
}

/// 库与遗留文件同有该文档时的合并（升级时一次性执行）：
/// - 数组：按 "id" 字段并集（文件侧多出的条目追加；库侧已有的以库为准）
/// - 对象：按键并集（文件侧新键补入，已有键以库为准——tool_stats / plugin_jobs 等映射）
/// - 结构不一致或解析失败：保持库侧不变（宁缺勿损）
fn merge_doc(conn: &Connection, name: &str, raw: &str) {
    let Ok(fv) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    let Some(dbv) = get_json::<serde_json::Value>(conn, name) else {
        return;
    };
    let merged = match (dbv, fv) {
        (serde_json::Value::Array(mut db), serde_json::Value::Array(f)) => {
            let ids: std::collections::HashSet<String> = db
                .iter()
                .filter_map(|x| x.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                .collect();
            for item in f {
                match item.get("id").and_then(|i| i.as_str()) {
                    Some(k) if ids.contains(k) => {}
                    _ => db.push(item),
                }
            }
            serde_json::Value::Array(db)
        }
        (serde_json::Value::Object(mut db), serde_json::Value::Object(f)) => {
            for (k, v) in f {
                db.entry(k).or_insert(v);
            }
            serde_json::Value::Object(db)
        }
        _ => return,
    };
    put_json(conn, name, &merged);
}

fn import_sessions_json(conn: &Connection, v: &serde_json::Value) {
    let Some(arr) = v.get("sessions").and_then(|s| s.as_array()) else {
        return;
    };
    for (i, s) in arr.iter().enumerate() {
        let (id, updated) = (
            s.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            s.get("updated").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        );
        if id.is_empty() {
            continue;
        }
        let data = serde_json::to_string(s).unwrap_or_default();
        upsert_session(conn, &id, i, &updated, &data);
    }
    if let Some(a) = v.get("active").and_then(|x| x.as_str()) {
        let _ = conn.execute(
            "INSERT INTO meta(key, value) VALUES('sessions_active', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [a],
        );
    }
    bump_rev(conn);
}

/// 留档改名：`.json` → `.json.migrated`；改名失败（占用）保留原文件也无碍——
/// 行已存在，下次启动导入会被跳过
fn rename_migrated(file: &Path) {
    let mut bak = file.as_os_str().to_os_string();
    bak.push(".migrated");
    let _ = std::fs::rename(file, Path::new(&bak));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bit-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn plain_doc_roundtrip_and_reopen() {
        let dir = tmp_dir("plain");
        let conn = open(&dir);
        put_json(&conn, "goals", &vec!["a", "b"]);
        assert_eq!(get_json::<Vec<String>>(&conn, "goals"), Some(vec!["a".into(), "b".into()]));
        drop(conn);
        // 模拟重启：重开连接数据仍在
        let conn = open(&dir);
        assert_eq!(get_json::<Vec<String>>(&conn, "goals"), Some(vec!["a".into(), "b".into()]));
        del(&conn, "goals");
        assert!(get_json::<Vec<String>>(&conn, "goals").is_none());
    }

    #[test]
    fn secret_doc_double_layer_roundtrip() {
        let dir = tmp_dir("secret");
        let conn = open(&dir);
        put_secret_json(&conn, "ai_config", "device-key-1", &serde_json::json!({"k": "v"}));
        // 双层密文：解外层后内层必须是 BITENC1 密文（设备密钥层存在）
        let raw = get(&conn, "ai_config").unwrap();
        let inner = crate::osprotect::unprotect(&raw).unwrap();
        let text = String::from_utf8(inner).unwrap();
        assert!(text.starts_with(crate::securefile::SECRET_PREFIX));
        assert!(!text.contains("\"k\"")); // 密文不含明文
        // 正确 key 可读
        let v = get_secret_json::<serde_json::Value>(&conn, "ai_config", Some("device-key-1")).unwrap();
        assert_eq!(v["k"], "v");
        // 错误 key 读不出（不 panic）
        assert!(get_secret_json::<serde_json::Value>(&conn, "ai_config", Some("wrong")).is_none());
        // 无 key（首次启动兼容路径）→ 明文单层，可读
        put_secret_json(&conn, "hidden_codes", "", &serde_json::json!([1, 2]));
        assert_eq!(
            get_secret_json::<serde_json::Value>(&conn, "hidden_codes", None),
            Some(serde_json::json!([1, 2]))
        );
    }

    #[test]
    fn tampered_secret_doc_returns_none_without_panic() {
        let dir = tmp_dir("tamper");
        let conn = open(&dir);
        put_secret_json(&conn, "mcp_servers", "k", &serde_json::json!([{"url":"http://x"}]));
        let mut raw = get(&conn, "mcp_servers").unwrap();
        let n = raw.len();
        raw[n - 3] ^= 0xFF; // 篡改
        put(&conn, "mcp_servers", &raw);
        // 篡改后要么解不开要么解析失败，绝不 panic、绝不吐半截数据
        let r = get_secret_json::<serde_json::Value>(&conn, "mcp_servers", Some("k"));
        if let Some(v) = r {
            assert!(v.as_array().map(|a| a.is_empty()).unwrap_or(true));
        }
    }

    #[test]
    fn legacy_json_import_idempotent_and_backed_up() {
        let dir = tmp_dir("legacy");
        std::fs::write(
            dir.join("goals.json"),
            r#"[{"id":"1","content":"x"}]"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("ai_config.json"),
            crate::securefile::encrypt_bytes("dk", br#"{"providers":[]}"#),
        )
        .unwrap();
        std::fs::write(dir.join("sessions.json"), r#"{"sessions":[{"id":"s1","updated":"2026-01-01 00:00:00"}],"active":"s1"}"#).unwrap();

        let conn = open(&dir);
        import_legacy(&conn, &dir, Some("dk"));
        // 明文导入
        assert!(get_json::<serde_json::Value>(&conn, "goals").is_some());
        // 密文导入后可用原 key 读
        assert!(get_secret_json::<serde_json::Value>(&conn, "ai_config", Some("dk")).is_some());
        // 会话按行导入
        let (rows, active) = load_sessions(&conn);
        assert_eq!(rows.len(), 1);
        assert_eq!(active, "s1");
        // 原文件已留档改名
        assert!(!dir.join("goals.json").exists());
        assert!(dir.join("goals.json.migrated").exists());
        // 二次启动：行已存在，不重复导入、不报错
        import_legacy(&conn, &dir, Some("dk"));
        assert_eq!(load_sessions(&conn).0.len(), 1);
    }

    #[test]
    fn legacy_import_merges_when_doc_exists() {
        // 升级场景：库里已有文档（新版启动写入过），遗留文件里还有旧版运行期
        // 只写文件产生的较新条目——合并导入而不是丢弃
        let dir = tmp_dir("merge");
        let conn = open(&dir);
        // 库侧：goals 有 1，memories 是映射
        put_json(&conn, "goals", &serde_json::json!([{"id":"1","title":"db-side"}]));
        put_json(&conn, "tool_stats", &serde_json::json!({"tool_a":{"ok":3}}));
        // 文件侧：goals 多出 id=2（追加），id=1 冲突以库为准；tool_stats 多出 tool_b
        std::fs::write(
            dir.join("goals.json"),
            r#"[{"id":"1","title":"file-side-stale"},{"id":"2","title":"file-only"}]"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("tool_stats.json"),
            r#"{"tool_a":{"ok":99},"tool_b":{"ok":1}}"#,
        )
        .unwrap();
        import_legacy(&conn, &dir, None);
        let goals = get_json::<serde_json::Value>(&conn, "goals").unwrap();
        let arr = goals.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["title"], "db-side"); // 冲突以库为准
        assert_eq!(arr[1]["title"], "file-only"); // 文件侧新条目保留
        let stats = get_json::<serde_json::Value>(&conn, "tool_stats").unwrap();
        assert_eq!(stats["tool_a"]["ok"], 3); // 已有键以库为准
        assert!(stats.get("tool_b").is_some()); // 新键补入
        // 文件已留档，二次启动不再有可合并内容
        assert!(!dir.join("goals.json").exists());
        import_legacy(&conn, &dir, None);
        assert_eq!(get_json::<serde_json::Value>(&conn, "goals").unwrap().as_array().unwrap().len(), 2);
    }

    /// e2e：模拟应用生命周期——遗留数据导入 → 读写 → 崩溃模拟（连接强杀）→ 重启恢复
    #[test]
    fn e2e_app_lifecycle_crash_and_restart() {
        let dir = tmp_dir("e2e");
        // 第一代：旧版 JSON 文件形态
        std::fs::write(dir.join("tools.json"), r#"[{"id":"t1"}]"#).unwrap();
        std::fs::write(dir.join("audit.json"), r#"[{"id":"a1","action":"x"}]"#).unwrap();
        let conn = open(&dir);
        import_legacy(&conn, &dir, Some("dk"));
        put_secret_json(&conn, "hidden_codes", "dk", &serde_json::json!([{"value":"sk-1"}]));
        // 模拟崩溃：不做任何 flush 直接 drop（WAL 保证已提交事务不丢）
        put_json(&conn, "todos", &vec!["t1"]);
        drop(conn);

        // 第二代：重启（新连接），所有数据完好
        let conn = open(&dir);
        assert!(get_json::<serde_json::Value>(&conn, "tools").is_some());
        assert!(get_json::<serde_json::Value>(&conn, "audit").is_some());
        assert_eq!(get_json::<Vec<String>>(&conn, "todos"), Some(vec!["t1".into()]));
        assert!(get_secret_json::<serde_json::Value>(&conn, "hidden_codes", Some("dk")).is_some());

        // 第三代：会话多进程并发写（updated 新者胜 = 后写覆盖）
        sync_sessions(&conn, &[], "s1"); // 空库占位
        upsert_session(&conn, "s1", 0, "2026-01-01 10:00:00", r#"{"id":"s1"}"#);
        upsert_session(&conn, "s1", 0, "2026-01-01 11:00:00", r#"{"id":"s1","v":2}"#);
        let (rows, _) = load_sessions(&conn);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].1.contains("\"v\":2"));
        delete_session(&conn, "s1");
        assert!(load_sessions(&conn).0.is_empty());
    }
}
