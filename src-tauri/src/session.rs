// yxpil · BIT
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ai::ChatMessage;

/// 一段独立的对话会话（多会话分组）
/// favorite：收藏（置顶且批量删除时受保护）；color：彩色标签（十六进制色值，空=无色）
#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created: String,
    pub updated: String,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub color: String,
}

impl Session {
    pub fn new(title: &str) -> Self {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        Session {
            id: uuid::Uuid::new_v4().simple().to_string(),
            title: if title.trim().is_empty() { "新对话".into() } else { title.trim().to_string() },
            created: now.clone(),
            updated: now,
            messages: Vec::new(),
            favorite: false,
            color: String::new(),
        }
    }

    pub fn touch(&mut self) {
        self.updated = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }

    /// 会话摘要（用于列表右侧预览）：取最后一条非工具反馈消息的开头
    pub fn preview(&self) -> String {
        self.messages
            .iter()
            .rev()
            .find(|m| m.role != "system")
            .map(|m| {
                let s: String = m.content.chars().take(40).collect();
                s.replace('\n', " ")
            })
            .unwrap_or_default()
    }
}

/// 会话存储：始终保证至少有一个会话，并记录当前激活会话
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SessionStore {
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub active: String,
}

impl SessionStore {
    /// 载入：bit.db 会话表（一行一个会话）为准；表为空时兜底遗留 sessions.json /
    /// chats.json（import_legacy 正常路径已把 sessions.json 导入，兜底覆盖直接调用场景）
    pub fn load(data_dir: &std::path::Path, conn: &rusqlite::Connection) -> SessionStore {
        let (rows, active) = crate::store::load_sessions(conn);
        if !rows.is_empty() {
            let sessions: Vec<Session> = rows
                .iter()
                .filter_map(|(_, data)| serde_json::from_str(data).ok())
                .collect();
            if !sessions.is_empty() {
                let mut st = SessionStore { sessions, active };
                if !st.sessions.iter().any(|s| s.id == st.active) {
                    st.active = st.sessions[0].id.clone();
                }
                return st;
            }
        }
        // 兜底：遗留 sessions.json（旧整仓格式）
        if let Some(store) = read_json::<SessionStore>(&data_dir.join("sessions.json")) {
            if !store.sessions.is_empty() {
                return store.normalized();
            }
        }
        // 兜底：旧 chats.json（单会话历史）迁移为默认会话
        let legacy: Vec<ChatMessage> =
            read_json(&data_dir.join("chats.json")).unwrap_or_default();
        let mut s = Session::new("默认对话");
        s.messages = legacy;
        let active = s.id.clone();
        SessionStore { sessions: vec![s], active }
    }

    /// 保证至少有一个会话、active 指向存在的会话
    fn normalized(mut self) -> SessionStore {
        if self.sessions.is_empty() {
            let s = Session::new("默认对话");
            self.active = s.id.clone();
            self.sessions.push(s);
        }
        if !self.sessions.iter().any(|s| s.id == self.active) {
            self.active = self.sessions[0].id.clone();
        }
        self
    }

    pub fn active_mut(&mut self) -> &mut Session {
        let active = self.active.clone();
        let idx = self.sessions.iter().position(|s| s.id == active).unwrap_or(0);
        &mut self.sessions[idx]
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }

    /// 找到会话；不存在则用指定 id 新建（远程 API 客户端可直接开启指定会话）
    pub fn get_or_create_mut(&mut self, id: &str) -> &mut Session {
        if self.get_mut(id).is_none() {
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            self.sessions.push(Session {
                id: id.to_string(),
                title: "新对话".into(),
                created: now.clone(),
                updated: now,
                messages: Vec::new(),
                favorite: false,
                color: String::new(),
            });
        }
        self.get_mut(id).expect("会话已创建")
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

pub fn persist(ctx: &Arc<crate::state::Ctx>) {
    // 多进程（host + agent-worker）共用 bit.db 会话表：写前先把库侧其他进程
    // 的回合并入内存（updated 新者胜，不裁剪），否则整仓覆盖会抹掉并发回合
    // （host/worker 各持一份启动快照时，T41 双设备并发的历史隔离必挂）
    merge_from_disk(ctx, false);
    let rev = {
        let store = ctx.sessions.lock().unwrap();
        let conn = ctx.db.lock().unwrap();
        crate::store::sync_sessions(&conn, &store.sessions, &store.active);
        crate::store::sessions_rev(&conn)
    };
    *ctx.sessions_rev.lock().unwrap() = rev;
}

/// 其他进程（bit 命令行等）可能写过 bit.db 会话表：按 id 合并库侧变更（updated 新者胜）。
/// prune=true 时库中已消失的会话视为被外部删除；prune=false 时保留内存独有会话
/// （persist 写前合并用：新建会话还只在内存，裁剪会把它丢掉）。
/// rev 未变则直接返回，避免每次列表都全量解析（取代原 mtime 比对）
fn merge_from_disk(ctx: &Arc<crate::state::Ctx>, prune: bool) {
    let rev = crate::store::sessions_rev(&ctx.db.lock().unwrap());
    {
        let mut seen = ctx.sessions_rev.lock().unwrap();
        if *seen == rev {
            return;
        }
        *seen = rev;
    }
    let (rows, _) = crate::store::load_sessions(&ctx.db.lock().unwrap());
    let disk: Vec<Session> = rows
        .iter()
        .filter_map(|(_, data)| serde_json::from_str(data).ok())
        .collect();
    let disk_ids: std::collections::HashSet<String> =
        disk.iter().map(|s| s.id.clone()).collect();
    let mut store = ctx.sessions.lock().unwrap();
    for d in disk {
        match store.sessions.iter_mut().find(|s| s.id == d.id) {
            Some(s) => {
                if d.updated > s.updated {
                    *s = d;
                }
            }
            None => store.sessions.push(d),
        }
    }
    if prune {
        store.sessions.retain(|s| disk_ids.contains(&s.id));
    }
}

/// 读前刷新（GUI / 调试接口）：外部删除生效，rev 守卫零成本
pub fn refresh_from_disk(ctx: &Arc<crate::state::Ctx>) {
    merge_from_disk(ctx, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage { role: role.into(), content: content.into(), tool_calls: Vec::new(), thinking: None, ts: None, diagram: None }
    }

    fn session_with(messages: Vec<ChatMessage>) -> Session {
        let mut s = Session::new("测试");
        s.messages = messages;
        s
    }

    // ---------- preview()：debug_sessions 会话列表的摘要来源 ----------

    #[test]
    fn test_preview_takes_last_non_system_message() {
        let s = session_with(vec![
            msg("user", "第一问"),
            msg("system", "系统提示不应出现在摘要"),
            msg("assistant", "最后的回答"),
        ]);
        assert_eq!(s.preview(), "最后的回答");
    }

    #[test]
    fn test_preview_truncates_at_40_chars() {
        // 恰好 40 字不截断
        let exactly = "好".repeat(40);
        assert_eq!(session_with(vec![msg("user", &exactly)]).preview(), exactly);
        // 41 字截到 40；多字节按 char 截断，绝不产生乱码/panic
        let long = format!("{}x", "好".repeat(40));
        assert_eq!(session_with(vec![msg("user", &long)]).preview(), exactly);
    }

    #[test]
    fn test_preview_replaces_newlines_and_empty_cases() {
        assert_eq!(session_with(vec![msg("user", "两行\n内容")]).preview(), "两行 内容");
        // 空会话 → 空摘要
        assert_eq!(session_with(vec![]).preview(), "");
        // 只有 system 消息 → 空摘要（不得把系统提示泄露到列表）
        assert_eq!(session_with(vec![msg("system", "secret-prompt")]).preview(), "");
    }

    // ---------- Session / SessionStore 边界 ----------

    #[test]
    fn test_new_session_empty_title_falls_back() {
        assert_eq!(Session::new("").title, "新对话");
        assert_eq!(Session::new("   ").title, "新对话");
        assert_eq!(Session::new("  我的问题  ").title, "我的问题");
        // uuid simple 格式（无连字符）且非空
        assert_eq!(Session::new("t").id.len(), 32);
    }

    #[test]
    fn test_store_normalized_creates_default_and_fixes_active() {
        // 空存储 → 自动建默认会话
        let n = SessionStore::default().normalized();
        assert_eq!(n.sessions.len(), 1);
        assert_eq!(n.active, n.sessions[0].id);
        // active 指向不存在的会话 → 修正为第一个
        let s = session_with(vec![]);
        let store = SessionStore { sessions: vec![s.clone()], active: "missing-id".into() };
        let store = store.normalized();
        assert_eq!(store.active, s.id);
    }

    #[test]
    fn test_get_or_create_mut_reuses_and_creates() {
        let s = session_with(vec![]);
        let mut store = SessionStore { sessions: vec![s.clone()], active: s.id.clone() };
        // 已存在：复用不新建
        let reused = store.get_or_create_mut(&s.id);
        reused.messages.push(msg("user", "hello"));
        assert_eq!(store.sessions.len(), 1);
        // 不存在：用指定 id 新建（远程 API 指定会话 ID 的路径）
        let created = store.get_or_create_mut("custom-session-id");
        created.messages.push(msg("user", "remote"));
        assert_eq!(store.sessions.len(), 2);
        assert_eq!(store.sessions[1].id, "custom-session-id");
        assert_eq!(store.get_mut("custom-session-id").unwrap().messages.len(), 1);
    }
}
