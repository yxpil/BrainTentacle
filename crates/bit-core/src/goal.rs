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
    /// 计划执行时间（一次性时间点，格式 YYYY-MM-DD HH:MM 本地时间）
    #[serde(default)]
    pub scheduled_at: Option<String>,
    /// 可选重复规则（文法同 plugins::parse_schedule：every Ns/Nm/Nh、daily H:M）
    #[serde(default)]
    pub schedule: Option<String>,
    /// 上次触发时间（格式同 now()：%Y-%m-%d %H:%M:%S），供到点判定去重
    #[serde(default)]
    pub last_run: Option<String>,
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
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id,ts,goal_id,content,status,source,session_id,scheduled_at,schedule,last_run FROM todos ORDER BY rowid",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok(Todo {
                id: r.get(0)?,
                ts: r.get(1)?,
                goal_id: r.get(2)?,
                content: r.get(3)?,
                status: r.get(4)?,
                source: r.get(5)?,
                session_id: r.get(6)?,
                scheduled_at: r.get(7)?,
                schedule: r.get(8)?,
                last_run: r.get(9)?,
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
        "INSERT OR REPLACE INTO todos(id,ts,goal_id,content,status,source,session_id,scheduled_at,schedule,last_run)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            t.id,
            t.ts,
            t.goal_id,
            t.content,
            t.status,
            t.source,
            t.session_id,
            t.scheduled_at,
            t.schedule,
            t.last_run
        ],
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
            scheduled_at: None,
            schedule: None,
            last_run: None,
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

/// 设置 / 清除待办的计划执行时间（内置工具 schedule_task 的实现）。
/// action=set：校验 scheduled_at（%Y-%m-%d %H:%M 本地时间）与 schedule（plugins::parse_schedule
/// 文法：every Ns/Nm/Nh、daily H:M），至少提供一个，写入并把 last_run 重置为空（重新计到点）；
/// action=clear：三个计划字段全部清空。找不到待办返回中文错误。
pub fn schedule_task_set(
    ctx: &Arc<crate::state::Ctx>,
    todo_id: &str,
    action: &str,
    scheduled_at: Option<&str>,
    schedule: Option<&str>,
) -> Result<String, String> {
    // 模型常用空串表示「省略该参数」：统一按未提供处理
    let sa = scheduled_at.map(str::trim).filter(|s| !s.is_empty());
    let sc = schedule.map(str::trim).filter(|s| !s.is_empty());
    match action.trim() {
        "set" => {
            if sa.is_none() && sc.is_none() {
                return Err("请至少提供 scheduled_at 或 schedule 之一（两者都为空请用 action=clear）".into());
            }
            if let Some(s) = sa {
                chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").map_err(|_| {
                    format!("计划执行时间格式非法：`{s}`（要求 YYYY-MM-DD HH:MM 本地时间，如 2026-05-01 09:30）")
                })?;
            }
            if let Some(s) = sc {
                crate::plugins::parse_schedule(s).ok_or_else(|| {
                    format!("重复规则无法解析：`{s}`（支持 every 30s / every 30m / every 2h / daily 9:00）")
                })?;
            }
            let out = {
                let mut todos = ctx.todos.lock().unwrap();
                let t = todos
                    .iter_mut()
                    .find(|t| t.id == todo_id)
                    .ok_or("待办不存在")?;
                t.scheduled_at = sa.map(|s| s.to_string());
                t.schedule = sc.map(|s| s.to_string());
                t.last_run = None; // 重新计到点：清掉上次触发时间
                t.clone()
            };
            let db = ctx.db.lock().unwrap();
            let _ = db.execute(
                "UPDATE todos SET scheduled_at = ?2, schedule = ?3, last_run = NULL WHERE id = ?1",
                rusqlite::params![todo_id, out.scheduled_at, out.schedule],
            );
            Ok(format!(
                "已为待办 {todo_id} 设置计划执行时间：{}；重复规则：{}",
                out.scheduled_at.as_deref().unwrap_or("无"),
                out.schedule.as_deref().unwrap_or("无")
            ))
        }
        "clear" => {
            {
                let mut todos = ctx.todos.lock().unwrap();
                let t = todos
                    .iter_mut()
                    .find(|t| t.id == todo_id)
                    .ok_or("待办不存在")?;
                t.scheduled_at = None;
                t.schedule = None;
                t.last_run = None;
            }
            let db = ctx.db.lock().unwrap();
            let _ = db.execute(
                "UPDATE todos SET scheduled_at = NULL, schedule = NULL, last_run = NULL WHERE id = ?1",
                [todo_id],
            );
            Ok(format!("已清除待办 {todo_id} 的计划执行时间"))
        }
        other => Err(format!("未知 action：`{other}`（支持 set / clear）")),
    }
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
                scheduled_at: None,
                schedule: None,
                last_run: None,
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

// ---------- 待办计划执行调度 ----------

/// 单条待办是否到点（纯函数，便于单测）：
/// - 一次性时间点：已到点 且 尚未为该时间点触发过（last_run 为空或早于目标时间）；
/// - 重复规则：复用 plugins::is_due（内部按 last_run 去重，天然防同 tick 重复触发）。
/// completed 过滤由调用方负责。
fn todo_is_due(t: &Todo, now_dt: chrono::NaiveDateTime) -> bool {
    // 一次性时间点
    if let Some(sa) = &t.scheduled_at {
        if let Ok(target) = chrono::NaiveDateTime::parse_from_str(sa, "%Y-%m-%d %H:%M") {
            let fired_for_target = t
                .last_run
                .as_ref()
                .and_then(|l| chrono::NaiveDateTime::parse_from_str(l, "%Y-%m-%d %H:%M:%S").ok())
                .map(|f| f >= target)
                .unwrap_or(false);
            if now_dt >= target && !fired_for_target {
                return true;
            }
        }
    }
    // 重复规则
    if let Some(s) = &t.schedule {
        if let Some(sched) = crate::plugins::parse_schedule(s) {
            if crate::plugins::is_due(&sched, t.last_run.as_ref()) {
                return true;
            }
        }
    }
    false
}

/// 单次调度 tick（循环体，抽出便于测试）：扫描未完成且带计划的待办，到点则
/// 先写 last_run 防重，再唤回关联会话 / 标记 overdue。
fn schedule_todos_tick(ctx: &Arc<crate::state::Ctx>) {
    // 快照扫描（短临界区）：未完成 且 带一次性时间或重复规则的待办
    let candidates: Vec<Todo> = {
        let todos = ctx.todos.lock().unwrap();
        todos
            .iter()
            .filter(|t| {
                t.status != "completed" && (t.scheduled_at.is_some() || t.schedule.is_some())
            })
            .cloned()
            .collect()
    };
    if candidates.is_empty() {
        return;
    }
    let now_str = now();
    let now_dt = chrono::Local::now().naive_local();
    for t in candidates {
        if !todo_is_due(&t, now_dt) {
            continue;
        }
        // 先写 last_run（内存 + 库）再执行动作：同 tick 内与下一 tick 都会因 last_run 新鲜而跳过
        {
            let mut todos = ctx.todos.lock().unwrap();
            if let Some(x) = todos.iter_mut().find(|x| x.id == t.id) {
                x.last_run = Some(now_str.clone());
            }
        }
        {
            let db = ctx.db.lock().unwrap();
            let _ = db.execute(
                "UPDATE todos SET last_run = ?2 WHERE id = ?1",
                rusqlite::params![t.id, now_str],
            );
        }
        match t.session_id.clone().filter(|s| !s.trim().is_empty()) {
            // 有关联会话：唤回该会话的 AI 执行这条待办（复用后台任务结果注入链路）
            Some(sid) => {
                crate::shellbg::notify_session_result(
                    &sid,
                    &format!("todo:{}", t.id),
                    &format!("待办到点执行：{}", t.content),
                    0,
                    String::new(),
                    String::new(),
                    "done",
                );
            }
            // 无关联会话：直接标记 overdue。normalize_todo_status 不认 overdue，
            // 走直接 SQL UPDATE（不经过 update_todo_status），同时同步内存。
            None => {
                {
                    let mut todos = ctx.todos.lock().unwrap();
                    if let Some(x) = todos.iter_mut().find(|x| x.id == t.id) {
                        x.status = "overdue".into();
                    }
                }
                let db = ctx.db.lock().unwrap();
                let _ = db.execute(
                    "UPDATE todos SET status = ?2, last_run = ?3 WHERE id = ?1",
                    rusqlite::params![t.id, "overdue", now_str],
                );
            }
        }
    }
}

/// 待办计划执行调度循环：每 30 秒扫描一次未完成且带计划的待办，到点唤回关联会话。
/// 一次性时间点 scheduled_at 触发过一次（last_run >= scheduled_at）后不再重复；
/// 重复规则 schedule 复用 plugins::is_due 判定（every/daily，与插件任务同文法）。
/// 全程静默失败：单条待办出错不影响循环与其他待办。
pub async fn schedule_todos_loop(ctx: Arc<crate::state::Ctx>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        schedule_todos_tick(&ctx);
    }
}

#[cfg(test)]
mod schedule_tests {
    use super::*;

    /// 构造仅带计划字段的待办（其余字段填默认值）
    fn todo(scheduled_at: Option<&str>, schedule: Option<&str>, last_run: Option<&str>) -> Todo {
        Todo {
            id: "t1".into(),
            ts: "2026-01-01 00:00:00".into(),
            goal_id: None,
            content: "测试待办".into(),
            status: "pending".into(),
            source: "test".into(),
            session_id: None,
            scheduled_at: scheduled_at.map(|s| s.to_string()),
            schedule: schedule.map(|s| s.to_string()),
            last_run: last_run.map(|s| s.to_string()),
        }
    }

    fn dt(s: &str) -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn one_shot_due_before_and_after() {
        let t = todo(Some("2026-05-01 09:30"), None, None);
        // 未到点
        assert!(!todo_is_due(&t, dt("2026-05-01 09:29:59")));
        // 恰到点
        assert!(todo_is_due(&t, dt("2026-05-01 09:30:00")));
        // 过点后（尚未触发过）仍到点
        assert!(todo_is_due(&t, dt("2026-05-01 10:00:00")));
    }

    #[test]
    fn one_shot_fires_only_once() {
        // 已为该时间点触发过（last_run >= scheduled_at）→ 不再重复
        let t = todo(Some("2026-05-01 09:30"), None, Some("2026-05-01 09:30:05"));
        assert!(!todo_is_due(&t, dt("2026-05-01 09:31:00")));
        // last_run 早于目标时间（如改过计划时间）→ 重新计到点
        let t2 = todo(Some("2026-05-01 09:30"), None, Some("2026-05-01 09:00:00"));
        assert!(todo_is_due(&t2, dt("2026-05-01 09:31:00")));
    }

    #[test]
    fn malformed_scheduled_at_never_due() {
        let t = todo(Some("不是时间"), None, None);
        assert!(!todo_is_due(&t, dt("2026-05-01 10:00:00")));
    }

    #[test]
    fn recurring_every_uses_last_run() {
        // 注意：plugins::is_due 的 every 分支按真实时钟算 elapsed（与插件任务同语义），
        // 故此处用相对当前时间的 last_run 构造
        let now = chrono::Local::now().naive_local();
        let t = todo(None, Some("every 30m"), None);
        // 从未触发过 → 到点
        assert!(todo_is_due(&t, now));
        // 10 分钟前触发过 → 未到下一个 30 分钟周期
        let recent = todo(None, Some("every 30m"), Some(&(now - chrono::Duration::minutes(10)).format("%Y-%m-%d %H:%M:%S").to_string()));
        assert!(!todo_is_due(&recent, now));
        // 31 分钟前触发过 → 到点
        let old = todo(None, Some("every 30m"), Some(&(now - chrono::Duration::minutes(31)).format("%Y-%m-%d %H:%M:%S").to_string()));
        assert!(todo_is_due(&old, now));
    }

    /// 端到端：真实 Ctx（内存 + SQLite）跑一次 tick——
    /// 无会话的到点待办被标 overdue 且落库、last_run 写入防重；未到点的不动。
    #[test]
    fn tick_marks_overdue_and_persists() {
        let dir = std::env::temp_dir().join(format!("bit-sched-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        // 两条待办：一条已到点（过去时间），一条未到点（未来时间），均无会话
        let past = add_todo(&ctx, None, "已到点的待办", "test", None).unwrap();
        let future = add_todo(&ctx, None, "未到点的待办", "test", None).unwrap();
        let fmt = |dt: chrono::NaiveDateTime| dt.format("%Y-%m-%d %H:%M").to_string();
        let now = chrono::Local::now().naive_local();
        schedule_task_set(&ctx, &past.id, "set", Some(&fmt(now - chrono::Duration::minutes(5))), None).unwrap();
        schedule_task_set(&ctx, &future.id, "set", Some(&fmt(now + chrono::Duration::minutes(30))), None).unwrap();

        schedule_todos_tick(&ctx);

        // 到点的 → overdue + last_run 已写（内存）
        {
            let todos = ctx.todos.lock().unwrap();
            let p = todos.iter().find(|t| t.id == past.id).unwrap();
            assert_eq!(p.status, "overdue", "到点无会话待办应标 overdue");
            assert!(p.last_run.is_some(), "到点后应写 last_run 防重");
            let f = todos.iter().find(|t| t.id == future.id).unwrap();
            assert_eq!(f.status, "pending", "未到点待办不应被改动");
            assert!(f.last_run.is_none());
        }
        // 落库（db_todos 读回同样状态）
        {
            let db = ctx.db.lock().unwrap();
            let rows = db_todos(&db);
            let p = rows.iter().find(|t| t.id == past.id).unwrap();
            assert_eq!(p.status, "overdue");
            assert!(p.last_run.is_some());
        }
        // 再 tick 一次：last_run 已 >= 目标时间 → 不重复触发，状态保持 overdue
        schedule_todos_tick(&ctx);
        {
            let todos = ctx.todos.lock().unwrap();
            let p = todos.iter().find(|t| t.id == past.id).unwrap();
            assert!(p.last_run.is_some());
        }
        // action=clear 清空计划字段
        schedule_task_set(&ctx, &past.id, "clear", None, None).unwrap();
        {
            let todos = ctx.todos.lock().unwrap();
            let p = todos.iter().find(|t| t.id == past.id).unwrap();
            assert!(p.scheduled_at.is_none() && p.schedule.is_none() && p.last_run.is_none());
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// schedule_task_set 参数校验：非法时间 / 非法重复规则 / 不存在的待办 / 未知 action
    #[test]
    fn schedule_task_set_validation() {
        let dir = std::env::temp_dir().join(format!("bit-sched-v-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ctx = crate::state::Ctx::load(crate::state::LoadOpts {
            data_dir: dir.clone(),
            emitter: Arc::new(crate::emitter::NoopEmitter),
            host: Arc::new(crate::emitter::NoopHost),
            app_version: "test".into(),
            worker_exe: None,
            app_exe: None,
            app_args: vec![],
        });
        let t = add_todo(&ctx, None, "校验用待办", "test", None).unwrap();
        assert!(schedule_task_set(&ctx, &t.id, "set", Some("2026/05/01 09:30"), None).is_err(), "非法格式应报错");
        assert!(schedule_task_set(&ctx, &t.id, "set", None, Some("every xx")).is_err(), "非法重复规则应报错");
        assert!(schedule_task_set(&ctx, &t.id, "set", None, None).is_err(), "两者皆空应报错");
        assert!(schedule_task_set(&ctx, "no-such-id", "set", Some("2026-05-01 09:30"), None).is_err(), "待办不存在应报错");
        assert!(schedule_task_set(&ctx, &t.id, "bogus", None, None).is_err(), "未知 action 应报错");
        // 合法：时间 + 重复规则同设，last_run 被重置
        schedule_task_set(&ctx, &t.id, "set", Some("2026-05-01 09:30"), Some("daily 9:00")).unwrap();
        {
            let todos = ctx.todos.lock().unwrap();
            let x = todos.iter().find(|x| x.id == t.id).unwrap();
            assert_eq!(x.scheduled_at.as_deref(), Some("2026-05-01 09:30"));
            assert_eq!(x.schedule.as_deref(), Some("daily 9:00"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
