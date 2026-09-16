// yxpil · BIT
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize, Deserialize, Clone)]
pub struct Goal {
    pub id: String,
    pub ts: String,
    pub updated_ts: String,
    pub title: String,
    pub detail: String,
    /// active | achieved | abandoned
    pub status: String,
    pub source: String,
    /// 创建该目标的会话（None = 用户手动创建的全局目标）；注入提示词时只带本会话的
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: String,
    pub ts: String,
    /// 关联目标（可为空，表示独立待办）
    #[serde(default)]
    pub goal_id: Option<String>,
    pub content: String,
    /// pending | in_progress | completed
    pub status: String,
    pub source: String,
    /// 创建该待办的会话（None = 全局）；注入时只带本会话的
    #[serde(default)]
    pub session_id: Option<String>,
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

// ---------- 行级存储（bit.db goals/todos 独立表）----------
// 历史教训：goals/todos 曾整包 JSON 存 documents 一行（后期又分裂成文件），
// 行级化后删除/级联/按会话清理都是精确 SQL，配合 session_id/goal_id 索引。

pub fn db_goals(conn: &rusqlite::Connection) -> Vec<Goal> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id,ts,updated_ts,title,detail,status,source,session_id FROM goals ORDER BY rowid") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(Goal {
                id: r.get(0)?,
                ts: r.get(1)?,
                updated_ts: r.get(2)?,
                title: r.get(3)?,
                detail: r.get(4)?,
                status: r.get(5)?,
                source: r.get(6)?,
                session_id: r.get(7)?,
            })
        }) {
            for g in rows.flatten() {
                out.push(g);
            }
        }
    }
    out
}

pub fn db_todos(conn: &rusqlite::Connection) -> Vec<Todo> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id,ts,goal_id,content,status,source,session_id FROM todos ORDER BY rowid") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(Todo {
                id: r.get(0)?,
                ts: r.get(1)?,
                goal_id: r.get(2)?,
                content: r.get(3)?,
                status: r.get(4)?,
                source: r.get(5)?,
                session_id: r.get(6)?,
            })
        }) {
            for t in rows.flatten() {
                out.push(t);
            }
        }
    }
    out
}

fn insert_goal(conn: &rusqlite::Connection, g: &Goal) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO goals(id,ts,updated_ts,title,detail,status,source,session_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![g.id, g.ts, g.updated_ts, g.title, g.detail, g.status, g.source, g.session_id],
    );
}

fn insert_todo(conn: &rusqlite::Connection, t: &Todo) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO todos(id,ts,goal_id,content,status,source,session_id)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![t.id, t.ts, t.goal_id, t.content, t.status, t.source, t.session_id],
    );
}

/// 全量同步：内存 goals/todos 为准覆盖表（迁移兜底路径；常规路径走单行 INSERT/UPDATE/DELETE）
pub fn sync_rows(conn: &mut rusqlite::Connection, goals: &[Goal], todos: &[Todo]) {
    let Ok(mut tx) = conn.transaction() else {
        return; // 拿不到写锁（另一进程正写）：放弃本次同步，下次重试
    };
    let _ = tx.execute("DELETE FROM goals", []);
    let _ = tx.execute("DELETE FROM todos", []);
    for g in goals {
        insert_goal(&tx, g);
    }
    for t in todos {
        insert_todo(&tx, t);
    }
    let _ = tx.commit();
}

/// 落库：内存 goals/todos 全量同步到行级表（保留兼容入口，调用方持有其他锁时先释放）
/// 锁顺序约定：先 goals/todos（短临界区取克隆），后 db——persist/refresh 双向都不持有重叠。
pub fn persist(ctx: &Arc<crate::state::Ctx>) {
    let goals = ctx.goals.lock().unwrap().clone();
    let todos = ctx.todos.lock().unwrap().clone();
    let mut db = ctx.db.lock().unwrap();
    sync_rows(&mut db, &goals, &todos);
}

/// 从 bit.db 行级表重载目标/待办：桌面端会话在 worker 子进程里跑时，plan 等工具写的是
/// worker 内存 + bit.db，host 的调试/远程接口读取前必须同步（整体替换，库侧即最新状态）。
pub fn refresh_from_disk(ctx: &Arc<crate::state::Ctx>) {
    let (g, t) = {
        let db = ctx.db.lock().unwrap();
        (db_goals(&db), db_todos(&db))
    }; // db 锁先释放，再取内存锁（避免 goals→db / db→goals 交叉死锁）
    *ctx.goals.lock().unwrap() = g;
    *ctx.todos.lock().unwrap() = t;
}

// ---------- Goal ----------

/// 短数字 id：现有 id 中最大数字 +1（如 "12"）。旧 uuid 长 id 共存——所有查找都是精确匹配。
/// 提示词/面板里可读性好（对比 32 位 hex）。
pub fn next_short_id<'a>(ids: impl Iterator<Item = &'a String>) -> String {
    let max = ids.filter_map(|s| s.parse::<u64>().ok()).max().unwrap_or(0);
    (max + 1).to_string()
}

pub fn create_goal(
    ctx: &Arc<crate::state::Ctx>,
    title: &str,
    detail: &str,
    source: &str,
    session: Option<&str>,
) -> Result<Goal, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("目标标题不能为空".into());
    }
    let g = {
        let mut goals = ctx.goals.lock().unwrap();
        let g = Goal {
            id: next_short_id(goals.iter().map(|x| &x.id)),
            ts: now(),
            updated_ts: now(),
            title: title.to_string(),
            detail: detail.trim().to_string(),
            status: "active".into(),
            source: source.to_string(),
            session_id: session.map(|s| s.to_string()),
        };
        goals.push(g.clone());
        g
    };
    let db = ctx.db.lock().unwrap();
    insert_goal(&db, &g);
    Ok(g)
}

/// 目标状态归一化：接受模型的常见同义词 / 大小写 / 中英文变体，别动不动就打回
fn normalize_goal_status(s: &str) -> Option<&'static str> {
    match s.trim().to_lowercase().as_str() {
        "active" | "in_progress" | "in progress" | "doing" | "进行中" | "执行中" => Some("active"),
        "achieved" | "completed" | "complete" | "done" | "finished" | "已达成" | "完成" | "已完成" => Some("achieved"),
        "abandoned" | "cancelled" | "canceled" | "放弃" | "已放弃" | "取消" | "已取消" => Some("abandoned"),
        _ => None,
    }
}

/// 待办状态归一化：同上
pub fn normalize_todo_status(s: &str) -> Option<&'static str> {
    match s.trim().to_lowercase().as_str() {
        "pending" | "todo" | "to_do" | "未开始" | "待办" | "待处理" => Some("pending"),
        "in_progress" | "in progress" | "doing" | "active" | "进行中" | "执行中" => Some("in_progress"),
        "completed" | "complete" | "done" | "finished" | "achieved" | "成功" | "已完成" | "完成" => Some("completed"),
        _ => None,
    }
}

pub fn update_goal_status(ctx: &Arc<crate::state::Ctx>, id: &str, status: &str) -> Result<Goal, String> {
    let status = normalize_goal_status(status)
        .ok_or("状态必须是 active / achieved / abandoned（也接受：进行中/已完成/放弃 等同义词）")?;
    let out = {
        let mut goals = ctx.goals.lock().unwrap();
        // 防抢跑：还有未完成待办时禁止把 active 目标标成 achieved（AI 曾因此跳过全部待办）。
        // 宿主自动推进（全部完成后）不受影响——那时 pending 已为空。
        if status == "achieved" {
            let pending = {
                let todos = ctx.todos.lock().unwrap();
                todos
                    .iter()
                    .filter(|t| t.goal_id.as_deref() == Some(id) && t.status != "completed")
                    .count()
            };
            if pending > 0 {
                return Err(format!(
                    "目标 {id} 下还有 {pending} 条未完成待办，不能标记 achieved；请先逐条完成并标记待办（或把目标改为 abandoned 放弃）"
                ));
            }
        }
        let g = goals.iter_mut().find(|g| g.id == id).ok_or("目标不存在")?;
        g.status = status.to_string();
        g.updated_ts = now();
        g.clone()
    };
    let db = ctx.db.lock().unwrap();
    let _ = db.execute(
        "UPDATE goals SET status = ?2, updated_ts = ?3 WHERE id = ?1",
        rusqlite::params![id, out.status, out.updated_ts],
    );
    Ok(out)
}

pub fn remove_goal(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<(), String> {
    {
        let mut goals = ctx.goals.lock().unwrap();
        goals.retain(|g| g.id != id);
    }
    // 级联删除关联待办（内存 + 表）
    {
        let mut todos = ctx.todos.lock().unwrap();
        todos.retain(|t| t.goal_id.as_deref() != Some(id));
    }
    let db = ctx.db.lock().unwrap();
    let _ = db.execute("DELETE FROM goals WHERE id = ?1", [id]);
    let _ = db.execute("DELETE FROM todos WHERE goal_id = ?1", [id]);
    Ok(())
}

// ---------- Todo ----------

pub fn add_todo(
    ctx: &Arc<crate::state::Ctx>,
    goal_id: Option<String>,
    content: &str,
    source: &str,
    session: Option<&str>,
) -> Result<Todo, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("待办内容不能为空".into());
    }
    if let Some(gid) = &goal_id {
        let goals = ctx.goals.lock().unwrap();
        if !goals.iter().any(|g| &g.id == gid) {
            return Err("关联目标不存在".into());
        }
    }
    let t = {
        let mut todos = ctx.todos.lock().unwrap();
        let t = Todo {
            id: next_short_id(todos.iter().map(|x| &x.id)),
            ts: now(),
            goal_id,
            content: content.to_string(),
            status: "pending".into(),
            source: source.to_string(),
            session_id: session.map(|s| s.to_string()),
        };
        todos.push(t.clone());
        t
    };
    let db = ctx.db.lock().unwrap();
    insert_todo(&db, &t);
    Ok(t)
}

pub fn update_todo_status(ctx: &Arc<crate::state::Ctx>, id: &str, status: &str) -> Result<Todo, String> {
    let status = normalize_todo_status(status)
        .ok_or("状态必须是 pending / in_progress / completed（也接受：todo/done/进行中/已完成 等同义词）")?;
    let out = {
        let mut todos = ctx.todos.lock().unwrap();
        let t = todos.iter_mut().find(|t| t.id == id).ok_or("待办不存在")?;
        t.status = status.to_string();
        t.clone()
    };
    let db = ctx.db.lock().unwrap();
    let _ = db.execute("UPDATE todos SET status = ?2 WHERE id = ?1", rusqlite::params![id, out.status]);
    Ok(out)
}

pub fn remove_todo(ctx: &Arc<crate::state::Ctx>, id: &str) -> Result<(), String> {
    ctx.todos.lock().unwrap().retain(|t| t.id != id);
    let db = ctx.db.lock().unwrap();
    let _ = db.execute("DELETE FROM todos WHERE id = ?1", [id]);
    Ok(())
}

/// AI 批量写入待办（类似 TodoWrite：整体替换某个 goal 下或独立的待办列表）
pub fn rewrite_todos(
    ctx: &Arc<crate::state::Ctx>,
    goal_id: Option<String>,
    items: &[serde_json::Value],
    source: &str,
    session: Option<&str>,
) -> Result<usize, String> {
    let mut fresh: Vec<Todo> = Vec::new();
    {
        let mut todos = ctx.todos.lock().unwrap();
        // 清空同范围内旧待办
        match &goal_id {
            Some(gid) => todos.retain(|t| t.goal_id.as_deref() != Some(gid.as_str())),
            None => todos.retain(|t| t.goal_id.is_some()),
        }
        for item in items {
            // 同时支持 string 和 object：schema 允许 string[]，但 object[] 更丰富
            let (content, status_str) = if let Some(s) = item.as_str() {
                (s.trim().to_string(), "pending".to_string())
            } else {
                let c = item.get("content").and_then(|v| v.as_str()).unwrap_or_default().trim().to_string();
                let s = item.get("status").and_then(|v| v.as_str()).unwrap_or("pending").to_string();
                (c, s)
            };
            if content.is_empty() {
                continue;
            }
            let status = normalize_todo_status(&status_str).unwrap_or("pending").to_string();
            let new_id = next_short_id(todos.iter().chain(fresh.iter()).map(|x| &x.id));
            fresh.push(Todo {
                id: new_id,
                ts: now(),
                goal_id: goal_id.clone(),
                content,
                status,
                source: source.to_string(),
                session_id: session.map(|s| s.to_string()),
            });
        }
        todos.extend(fresh.iter().cloned());
    }
    // 表侧：删范围 + 批量插入（单事务）
    let mut db = ctx.db.lock().unwrap();
    if let Ok(mut tx) = db.transaction() {
        match &goal_id {
            Some(gid) => {
                let _ = tx.execute("DELETE FROM todos WHERE goal_id = ?1", [gid]);
            }
            None => {
                let _ = tx.execute("DELETE FROM todos WHERE goal_id IS NULL", []);
            }
        }
        for t in &fresh {
            insert_todo(&tx, t);
        }
        let _ = tx.commit();
    }
    Ok(fresh.len())
}
