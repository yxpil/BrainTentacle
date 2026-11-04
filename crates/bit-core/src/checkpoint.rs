// yxpil · BIT
//! 对话回退的文件快照。
//!
//! 写文件 / 编辑文件前把原始字节存到数据目录 `checkpoints/<会话>` 下，快照 id 挂在
//! 对应工具调用记录里。回退会话时只按 id 收集（不依赖消息下标，CHAT_MAX 裁剪也安全），
//! 每个路径取「回退点之后最早的一份」写回；回退点之前不存在的文件则删除。
//! 只保留最近若干份：回退窗口本身只有最近 10 条消息，旧快照按时间/数量淘汰。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::state::Ctx;

#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    id: String,
    path: String,
    /// 捕获时原文件是否存在；false = 回退时删除该文件
    existed: bool,
    size: u64,
    ts_ms: i64,
    /// 捕获时会话消息条数：同一轮（同一条 assistant 消息）内重复编辑同一文件只留最早一份
    seq: usize,
    /// 原始字节文件名（同目录）；existed=false 时为空
    blob: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Journal {
    #[serde(default)]
    entries: Vec<Meta>,
}

/// 每个会话最多保留的快照数（约覆盖最近 10 条消息里的多轮文件编辑）
const MAX_ENTRIES: usize = 160;
/// 快照保留天数：超期自动清理，避免回退窗口之外的旧编辑长期占盘
const KEEP_DAYS: i64 = 14;

/// 串行化日志读写：工具调用并发执行（buffered 16），同一会话可能同时落多个快照
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 会话 id → 目录名：`:` 等 Windows 非法字符百分号转义，文件系统安全且可逆判重
fn session_key(session: &str) -> String {
    let mut key = String::with_capacity(session.len() * 2);
    for b in session.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') {
            key.push(b as char);
        } else {
            key.push_str(&format!("%{b:02x}"));
        }
    }
    // 极端长 id 截断：碰撞只会让两个会话共用快照目录，回退按 id 取用不会串
    key.truncate(96);
    key
}

fn session_dir(ctx: &Arc<Ctx>, session: &str) -> PathBuf {
    ctx.data_dir.join("checkpoints").join(session_key(session))
}

/// 绝对路径：捕获时按进程 cwd 解析后的真实位置落账，重启后回退不受 cwd 变化影响
fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|d| d.join(path)).unwrap_or_else(|_| path.to_path_buf())
    }
}

fn load_journal(dir: &Path) -> Journal {
    std::fs::read_to_string(dir.join("journal.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_journal(dir: &Path, journal: &Journal) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(body) = serde_json::to_vec(journal) else { return };
    let tmp = dir.join("journal.json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join("journal.json"));
    }
}

fn remove_blob(dir: &Path, meta: &Meta) {
    if !meta.blob.is_empty() {
        let _ = std::fs::remove_file(dir.join(&meta.blob));
    }
}

fn prune(journal: &mut Journal, dir: &Path) {
    let cutoff = chrono::Utc::now().timestamp_millis() - KEEP_DAYS * 86_400_000;
    let mut dropped: Vec<Meta> = Vec::new();
    journal.entries.retain(|e| {
        if e.ts_ms < cutoff {
            dropped.push(e.clone());
            false
        } else {
            true
        }
    });
    if journal.entries.len() > MAX_ENTRIES {
        let excess = journal.entries.len() - MAX_ENTRIES;
        dropped.extend(journal.entries.drain(0..excess));
    }
    for e in dropped {
        remove_blob(dir, &e);
    }
}

/// 写盘前的快照实现（公开入口只负责算 seq 与会话目录，便于单测直接构造）
fn capture_entry(dir: &Path, session: &str, seq: usize, path: &Path, raw: Option<&[u8]>) -> Option<String> {
    let path_str = path.to_string_lossy().to_string();
    let _g = lock();
    let mut journal = load_journal(dir);
    // 同一轮同一文件只留第一份：那才是这一轮开始前的状态，后几份已被本轮前面的写入污染
    if let Some(e) = journal.entries.iter().find(|e| e.seq == seq && e.path == path_str) {
        return Some(e.id.clone());
    }
    let (existed, bytes) = match raw {
        Some(b) => (true, b.to_vec()),
        None => match std::fs::read(path) {
            Ok(b) => (true, b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, Vec::new()),
            // 读不到就无从恢复，别记一条假快照
            Err(_) => return None,
        },
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let blob = if existed {
        if std::fs::create_dir_all(dir).is_err() {
            return None;
        }
        let name = format!("{id}.bin");
        if std::fs::write(dir.join(&name), &bytes).is_err() {
            return None;
        }
        name
    } else {
        String::new()
    };
    journal.entries.push(Meta {
        id: id.clone(),
        path: path_str,
        existed,
        size: bytes.len() as u64,
        ts_ms: chrono::Utc::now().timestamp_millis(),
        seq,
        blob,
    });
    prune(&mut journal, dir);
    save_journal(dir, &journal);
    Some(id)
}

/// 写文件前保存原始字节（raw 由调用方传入，避免重复读盘）。
/// 返回快照 id；会话不存在或读不到原文件时返回 None（不阻断工具本身）。
pub fn capture(ctx: &Arc<Ctx>, session: &str, path: &Path, raw: Option<&[u8]>) -> Option<String> {
    let seq = {
        let store = ctx.sessions.lock().unwrap();
        store
            .sessions
            .iter()
            .find(|s| s.id == session)
            .map(|s| s.messages.len())
            .unwrap_or(0)
    };
    capture_entry(&session_dir(ctx, session), session, seq, &absolute(path), raw)
}

/// 快照已写入但文件写盘失败：撤销刚记的一条，避免留下无主记录
pub fn discard(ctx: &Arc<Ctx>, session: &str, id: &str) {
    let _g = lock();
    let dir = session_dir(ctx, session);
    let mut journal = load_journal(&dir);
    let mut dropped = None;
    journal.entries.retain(|e| {
        if e.id == id {
            dropped = Some(e.clone());
            false
        } else {
            true
        }
    });
    if let Some(e) = dropped {
        remove_blob(&dir, &e);
        save_journal(&dir, &journal);
    }
}

/// 回退文件核心：removed 为即将从会话里删掉的工具调用所带的快照 id。
/// 每个路径取日志里最早的一份（回退点之前的状态）写回；原先不存在的文件删除。
/// check 用于确认路径仍在当前沙箱内；失败的路径保留快照，便于用户调整后重试。
fn restore_entries(
    dir: &Path,
    removed: &[String],
    check: &dyn Fn(&str) -> Result<(), String>,
) -> serde_json::Value {
    let ids: HashSet<&str> = removed.iter().map(String::as_str).collect();
    let _g = lock();
    let mut journal = load_journal(dir);
    let mut first: HashMap<String, Meta> = HashMap::new();
    for e in journal.entries.iter() {
        if ids.contains(e.id.as_str()) {
            first.entry(e.path.clone()).or_insert_with(|| e.clone());
        }
    }
    let mut restored: Vec<String> = Vec::new();
    let mut deleted: Vec<String> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();
    // 记录已成功恢复的路径：同路径的其他快照（后续几轮又改过）一并作废
    let mut done_paths: HashSet<String> = HashSet::new();
    for meta in first.values() {
        if let Err(err) = check(&meta.path) {
            failed.push(serde_json::json!({ "path": &meta.path, "error": err }));
            continue;
        }
        if meta.existed {
            match std::fs::read(dir.join(&meta.blob)) {
                Ok(bytes) => {
                    if let Some(parent) = Path::new(&meta.path).parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    match std::fs::write(&meta.path, &bytes) {
                        Ok(_) => {
                            restored.push(meta.path.clone());
                            done_paths.insert(meta.path.clone());
                        }
                        Err(err) => failed.push(serde_json::json!({ "path": &meta.path, "error": err.to_string() })),
                    }
                }
                Err(err) => failed.push(serde_json::json!({
                    "path": &meta.path,
                    "error": format!("快照缺失: {err}"),
                })),
            }
        } else {
            match std::fs::remove_file(&meta.path) {
                Ok(_) => {
                    deleted.push(meta.path.clone());
                    done_paths.insert(meta.path.clone());
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    deleted.push(meta.path.clone());
                    done_paths.insert(meta.path.clone());
                }
                Err(err) => failed.push(serde_json::json!({ "path": &meta.path, "error": err.to_string() })),
            }
        }
    }
    // 已恢复/已删除的快照作废：它们记录的是回退点之后的状态，留着会误导下一次回退。
    // 同路径的其他快照（后续几轮又改过）也一并删掉，恢复的是最早那份，它们已无意义。
    let mut dropped: Vec<Meta> = Vec::new();
    journal.entries.retain(|e| {
        let obsolete = ids.contains(e.id.as_str()) && done_paths.contains(&e.path);
        if obsolete {
            dropped.push(e.clone());
            false
        } else {
            true
        }
    });
    for e in dropped {
        remove_blob(dir, &e);
    }
    save_journal(dir, &journal);
    serde_json::json!({ "restored": restored, "deleted": deleted, "failed": failed })
}

/// 回退某会话中这些工具调用产生的文件改动
pub fn restore(ctx: &Arc<Ctx>, session: &str, removed: &[String]) -> serde_json::Value {
    if removed.is_empty() {
        return serde_json::json!({ "restored": [], "deleted": [], "failed": [] });
    }
    let ctx_check = ctx.clone();
    let check = move |p: &str| crate::sandbox::resolve_path(&ctx_check, p).map(|_| ());
    restore_entries(&session_dir(ctx, session), removed, &check)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bit-checkpoint-{}-{tag}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ok(_: &str) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn test_capture_and_restore_existing_file() {
        let dir = temp_dir("restore");
        let target = dir.join("a.txt");
        std::fs::write(&target, b"old").unwrap();
        let id = capture_entry(&dir.join("cp"), "s1", 0, &target, None).unwrap();
        std::fs::write(&target, b"new").unwrap();
        let report = restore_entries(&dir.join("cp"), &[id.clone()], &ok);
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert_eq!(report["restored"].as_array().unwrap().len(), 1);
        // 快照已作废：再回退一次不会重复恢复（不会报错，但也没有可恢复项）
        let again = restore_entries(&dir.join("cp"), &[id], &ok);
        assert!(again["restored"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_capture_created_file_is_deleted_on_restore() {
        let dir = temp_dir("delete");
        let target = dir.join("brand-new.txt");
        let id = capture_entry(&dir.join("cp"), "s1", 0, &target, None).unwrap();
        std::fs::write(&target, b"created").unwrap();
        let report = restore_entries(&dir.join("cp"), &[id], &ok);
        assert!(!target.exists());
        assert_eq!(report["deleted"].as_array().unwrap().len(), 1);
    }

    /// 端到端：真实 write_file/edit 打快照 → agent 记录 → 回退命令截断消息并恢复文件
    #[tokio::test]
    async fn test_write_edit_then_rollback_restores_real_file() {
        let ctx = crate::plugins::test_ctx("rollback-e2e");
        let work = ctx.data_dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let file = work.join("note.txt");
        std::fs::write(&file, "before").unwrap();
        let path = file.to_string_lossy().to_string();

        let sid = "s-rollback".to_string();
        {
            let mut store = ctx.sessions.lock().unwrap();
            let mut s = crate::session::Session::new("回退测试");
            s.id = sid.clone();
            s.messages.push(crate::ai::ChatMessage::user("改一下文件"));
            store.sessions.push(s);
            store.active = sid.clone();
        }
        ctx.save_sessions();

        // 真实工具调用：写文件 → 编辑文件，快照 id 随结果返回（不写 _checkpoints 就无法被消费）
        let mut ids = Vec::new();
        let r = crate::agent::execute_tool_call(
            &ctx,
            "write_file",
            &serde_json::json!({ "path": path, "content": "after" }),
            Some(&sid),
        )
        .await
        .unwrap();
        ids.extend(
            r["_checkpoints"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string()),
        );
        let r = crate::agent::execute_tool_call(
            &ctx,
            "edit",
            &serde_json::json!({ "path": path, "old_string": "after", "new_string": "after2" }),
            Some(&sid),
        )
        .await
        .unwrap();
        ids.extend(
            r["_checkpoints"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string()),
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after2");

        // 模拟 agent 落库：assistant 消息携带快照 id
        {
            let mut store = ctx.sessions.lock().unwrap();
            let s = store.get_or_create_mut(&sid);
            let mut m = crate::ai::ChatMessage::assistant("已改好");
            m.tool_calls.push(crate::ai::ToolCallRecord {
                tool: "write_file".into(),
                params: serde_json::json!({}),
                ok: true,
                result: serde_json::json!({}),
                checkpoints: ids,
            });
            s.messages.push(m);
        }
        ctx.save_sessions();

        // 回退到用户消息（下标 0）：删掉 assistant，文件恢复成 before
        let out = crate::commands_api::rollback_session(&ctx, sid.clone(), 0).unwrap();
        assert_eq!(out["removed"], 1);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
        let kept = ctx
            .sessions
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.id == sid)
            .unwrap()
            .messages
            .len();
        assert_eq!(kept, 1);
    }

    /// 最近 10 条消息之外的位置拒绝回退（避免误删久远历史时连带大范围文件回滚）
    #[tokio::test]
    async fn test_rollback_window_enforced() {
        let ctx = crate::plugins::test_ctx("rollback-window");
        let sid = "s-window".to_string();
        {
            let mut store = ctx.sessions.lock().unwrap();
            let mut s = crate::session::Session::new("窗口测试");
            s.id = sid.clone();
            for i in 0..12 {
                s.messages.push(crate::ai::ChatMessage::user(format!("第 {i} 条")));
            }
            store.sessions.push(s);
            store.active = sid.clone();
        }
        ctx.save_sessions();
        let err = crate::commands_api::rollback_session(&ctx, sid.clone(), 0).unwrap_err();
        assert!(err.contains("最近 10 条"), "应提示窗口限制: {err}");
        // 窗口内（下标 2 = 倒数第 10 条）可以回退
        let out = crate::commands_api::rollback_session(&ctx, sid, 2).unwrap();
        assert_eq!(out["removed"], 9);
    }

    #[test]
    fn test_earliest_snapshot_wins_across_rounds() {
        let dir = temp_dir("earliest");
        let target = dir.join("a.txt");
        std::fs::write(&target, b"v0").unwrap();
        let cp = dir.join("cp");
        let first = capture_entry(&cp, "s1", 1, &target, None).unwrap();
        std::fs::write(&target, b"v1").unwrap();
        let second = capture_entry(&cp, "s1", 2, &target, None).unwrap();
        std::fs::write(&target, b"v2").unwrap();
        // 回退到最早那轮之前：应恢复 v0，而不是 v1
        let report = restore_entries(&cp, &[first, second], &ok);
        assert_eq!(std::fs::read(&target).unwrap(), b"v0");
        assert_eq!(report["restored"].as_array().unwrap().len(), 1);
        // 同路径两份快照都作废：恢复的是最早那份，后续那份留在日志里会被误用
        assert_eq!(load_journal(&cp).entries.len(), 0);
    }

    #[test]
    fn test_same_round_dedups_to_first_snapshot() {
        let dir = temp_dir("dedup");
        let target = dir.join("a.txt");
        std::fs::write(&target, b"v0").unwrap();
        let cp = dir.join("cp");
        let a = capture_entry(&cp, "s1", 3, &target, None).unwrap();
        std::fs::write(&target, b"v1").unwrap();
        let b = capture_entry(&cp, "s1", 3, &target, None).unwrap();
        assert_eq!(a, b, "同一轮重复编辑同一文件应复用第一份快照");
        let journal = load_journal(&cp);
        assert_eq!(journal.entries.len(), 1);
    }

    #[test]
    fn test_failed_path_keeps_snapshot() {
        let dir = temp_dir("fail");
        let target = dir.join("a.txt");
        std::fs::write(&target, b"old").unwrap();
        let cp = dir.join("cp");
        let id = capture_entry(&cp, "s1", 0, &target, None).unwrap();
        std::fs::write(&target, b"new").unwrap();
        let deny = |_: &str| Err("越出工作区沙箱".to_string());
        let report = restore_entries(&cp, &[id.clone()], &deny);
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(report["failed"].as_array().unwrap().len(), 1);
        // 失败不消费快照，沙箱调整后还能重试
        assert_eq!(load_journal(&cp).entries.len(), 1);
    }

    #[test]
    fn test_session_key_is_filesystem_safe() {
        let key = session_key("plugin:frame-demo/sub@1");
        assert!(!key.contains(':'));
        assert!(!key.contains('/'));
        assert!(!key.contains('@'));
        assert_eq!(session_key("plain_id-1.ok"), "plain_id-1.ok");
    }
}
