// yxpil · BIT
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize, Deserialize, Clone)]
pub struct AuditEntry {
    pub id: String,
    pub ts: String,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub detail: serde_json::Value,
    pub ok: bool,
}

/// 从 audit 表加载全部条目（rowid 稳定序 = 追加序）
pub fn db_entries(conn: &rusqlite::Connection) -> Vec<AuditEntry> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT id,ts,actor,action,target,detail,ok FROM audit ORDER BY rowid") {
        if let Ok(rows) = stmt.query_map([], |r| {
            let detail_raw: String = r.get(5)?;
            Ok(AuditEntry {
                id: r.get(0)?,
                ts: r.get(1)?,
                actor: r.get(2)?,
                action: r.get(3)?,
                target: r.get(4)?,
                detail: serde_json::from_str(&detail_raw).unwrap_or(serde_json::Value::Null),
                ok: r.get::<_, i64>(6)? != 0,
            })
        }) {
            for e in rows.flatten() {
                out.push(e);
            }
        }
    }
    out
}

fn insert_entry(conn: &rusqlite::Connection, e: &AuditEntry) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO audit(id,ts,actor,action,target,detail,ok) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            e.id,
            e.ts,
            e.actor,
            e.action,
            e.target,
            serde_json::to_string(&e.detail).unwrap_or_default(),
            e.ok as i64,
        ],
    );
}

/// 记录一条审计事件（内存 + 单行插入 + 超限清理）。
/// 行级化前每次 record 全量重写整包 blob（2000 条 × JSON 序列化），高频调用下开销显著
pub fn record(
    ctx: &Arc<crate::state::Ctx>,
    actor: &str,
    action: &str,
    target: &str,
    detail: serde_json::Value,
    ok: bool,
) {
    let entry = AuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        ts: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        actor: actor.to_string(),
        action: action.to_string(),
        target: target.to_string(),
        detail,
        ok,
    };

    let mut log = ctx.audit.lock().unwrap();
    log.push(entry.clone());
    if log.len() > crate::state::AUDIT_MAX {
        let drop_n = log.len() - crate::state::AUDIT_MAX;
        log.drain(0..drop_n);
    }
    drop(log);
    let db = ctx.db.lock().unwrap();
    insert_entry(&db, &entry);
    // 上限清理：只保留最近 AUDIT_MAX 条
    let _ = db.execute(
        "DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY rowid DESC LIMIT ?1)",
        [crate::state::AUDIT_MAX as i64],
    );
}

/// 全量同步：内存审计日志覆盖表（迁移兜底路径）
pub fn persist(ctx: &Arc<crate::state::Ctx>) {
    let log = ctx.audit.lock().unwrap().clone();
    let mut db = ctx.db.lock().unwrap();
    let opened = db.transaction();
    if let Ok(mut tx) = opened {
        let _ = tx.execute("DELETE FROM audit", []);
        for e in &log {
            insert_entry(&tx, e);
        }
        let _ = tx.commit();
    }
}

/// 清空审计日志（内存 + 表）
pub fn clear(ctx: &Arc<crate::state::Ctx>) {
    ctx.audit.lock().unwrap().clear();
    let db = ctx.db.lock().unwrap();
    let _ = db.execute("DELETE FROM audit", []);
}

/// 删除单条审计记录（内存 + 表）；返回是否存在
pub fn delete(ctx: &Arc<crate::state::Ctx>, id: &str) -> bool {
    let removed = {
        let mut log = ctx.audit.lock().unwrap();
        let before = log.len();
        log.retain(|e| e.id != id);
        before != log.len()
    };
    if removed {
        let db = ctx.db.lock().unwrap();
        let _ = db.execute("DELETE FROM audit WHERE id = ?1", [id]);
    }
    removed
}
