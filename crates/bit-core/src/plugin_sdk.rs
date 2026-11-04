// yxpil · BIT
//! 插件开发糖（进程侧）：把 SDK 物化进 toolhomes，让插件的 node / python 进程
//! 一行 `require("bit")` / `import bit` 就能回连宿主能力，不必各自抄一遍
//! `http.request` + Bearer + 解包 + 错误处理。
//!
//! 为什么落在 toolhomes/node_modules：
//! - Node 从**导入文件所在目录逐级往上**找 node_modules，插件包在
//!   `toolhomes/plugins/<id>/`，所以 `toolhomes/node_modules/bit` 对 CJS 的
//!   `require("bit")` 与 ESM 的 `import "bit"` 同时可见（ESM 不认 NODE_PATH，
//!   只靠目录链——这条路径是两种语法唯一都能吃到的位置）；
//! - 解释器工具的工作目录本来就是 toolhomes（见 script_runtime），同一条链；
//! - 落在 toolhomes 而不是插件目录里：插件目录有防篡改哈希基线，宿主往里面
//!   写东西等于自己制造"内容被改过"的假象。
//!
//! Python 没有目录链这回事，只能靠 `PYTHONPATH`：物化到 `toolhomes/py/bit.py`，
//! 由 `apply_env` 在拉起进程时追加。
//!
//! 这些文件由宿主生成、内容随构建固定，插件改不动也没必要改：每次 scan/启动
//! 都会按内容比对重写（只在变化时落盘）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::Ctx;

const NODE_CJS: &str = include_str!("../assets/plugin-sdk-node.cjs");
const NODE_MJS: &str = include_str!("../assets/plugin-sdk-node.mjs");
const NODE_DTS: &str = include_str!("../assets/plugin-sdk-node.d.ts");
const PY_MOD: &str = include_str!("../assets/plugin-sdk-py.py");

/// node 包的清单：exports 同时给出 require / import 两个出口，types 给编辑器
const PKG_JSON: &str = r#"{
  "name": "bit",
  "version": "1.0.0",
  "description": "BIT 插件进程侧 SDK（宿主生成，别手改：每次扫描都会按构建内容覆盖）",
  "main": "index.cjs",
  "types": "index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./index.mjs",
      "require": "./index.cjs",
      "default": "./index.cjs"
    }
  }
}
"#;

/// toolhomes 根（AI 与插件进程的统一环境目录）
pub fn root(ctx: &Arc<Ctx>) -> PathBuf {
    crate::toolenv::dir(ctx)
}

/// node 包目录：toolhomes/node_modules/bit
pub fn bit_pkg(ctx: &Arc<Ctx>) -> PathBuf {
    root(ctx).join("node_modules").join("bit")
}

/// python 模块目录：toolhomes/py
pub fn py_dir(ctx: &Arc<Ctx>) -> PathBuf {
    root(ctx).join("py")
}

/// 内容不同才写：避免每次扫描都产生磁盘写入与 mtime 抖动
fn write_if_changed(path: &Path, content: &str) -> bool {
    if let Ok(old) = std::fs::read_to_string(path) {
        if old == content {
            return false;
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, content).is_ok()
}

/// 物化 SDK（幂等）。返回本次真正重写的文件数，0 = 已是最新。
/// 启动与每次插件扫描都调它：插件装完就能立刻 require，不需要重启应用。
pub fn ensure(ctx: &Arc<Ctx>) -> usize {
    let pkg = bit_pkg(ctx);
    let py = py_dir(ctx);
    let mut n = 0usize;
    if write_if_changed(&pkg.join("package.json"), PKG_JSON) {
        n += 1;
    }
    if write_if_changed(&pkg.join("index.cjs"), NODE_CJS) {
        n += 1;
    }
    if write_if_changed(&pkg.join("index.mjs"), NODE_MJS) {
        n += 1;
    }
    if write_if_changed(&pkg.join("index.d.ts"), NODE_DTS) {
        n += 1;
    }
    if write_if_changed(&py.join("bit.py"), PY_MOD) {
        n += 1;
    }
    n
}

/// SDK 是否已就位（给插件页/诊断看，不触发写入）
pub fn installed(ctx: &Arc<Ctx>) -> bool {
    bit_pkg(ctx).join("index.cjs").is_file() && py_dir(ctx).join("bit.py").is_file()
}

/// 把 `add` 拼到已有搜索路径前面（保留插件/用户自己设的值）。
/// 分隔符交给 std::env 的 split/join——Windows 用 `;`、类 Unix 用 `:`，
/// 拿 MAIN_SEPARATOR 去切 PATH 会把每条路径切碎成盘符和目录名。
fn prepend_path(existing: Option<String>, add: &Path) -> String {
    let head = add.to_string_lossy().to_string();
    let Some(tail) = existing.filter(|s| !s.trim().is_empty()) else {
        return head;
    };
    let mut paths: Vec<PathBuf> = std::env::split_paths(&tail).collect();
    if paths.iter().any(|p| p.to_string_lossy() == head) {
        return tail; // 已经在里面就不重复堆叠
    }
    paths.insert(0, add.to_path_buf());
    std::env::join_paths(paths)
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|_| format!("{head}{}{tail}", std::path::MAIN_SEPARATOR_STR))
}

/// 给一个进程的 env 表补上 SDK 搜索路径（node 靠目录链，这里主要照顾
/// program 在 toolhomes 之外的绝对路径服务，以及 python 的 PYTHONPATH）
pub fn apply_env(ctx: &Arc<Ctx>, env: &mut HashMap<String, String>) {
    let cur_np = env.get("NODE_PATH").cloned().or_else(|| std::env::var("NODE_PATH").ok());
    env.insert(
        "NODE_PATH".to_string(),
        prepend_path(cur_np, &root(ctx).join("node_modules")),
    );
    let cur_pp = env.get("PYTHONPATH").cloned().or_else(|| std::env::var("PYTHONPATH").ok());
    env.insert("PYTHONPATH".to_string(), prepend_path(cur_pp, &py_dir(ctx)));
}

/// 工具 id 里的插件归属：`plugin::<插件id>::<工具名>`（见 plugins::register_tools）
pub fn plugin_of_tool(tool_id: &str) -> Option<String> {
    let rest = tool_id.strip_prefix("plugin::")?;
    let pid = rest.split("::").next().unwrap_or("").trim();
    (!pid.is_empty()).then(|| pid.to_string())
}

/// 插件的解释器工具/任务进程该拿到的环境：身份 + 令牌 + 生效权限 + SDK 搜索路径。
/// 令牌与页面帧、托管服务用的是同一枚（token_for 只"取或建"，不换发），
/// 所以插件里页面和进程可以同时调用，不会互相把凭据顶掉。
pub fn plugin_env(ctx: &Arc<Ctx>, pid: &str) -> Vec<(String, String)> {
    let Some(p) = crate::plugins::enabled_plugin(ctx, pid) else {
        return Vec::new();
    };
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("BIT_PLUGIN_ID".to_string(), pid.to_string());
    env.insert("BIT_PLUGIN_TOKEN".to_string(), crate::plugin_api::token_for(pid));
    env.insert("BIT_PLUGIN_API".to_string(), crate::plugin_api::base_url());
    env.insert(
        "BIT_PLUGIN_DIR".to_string(),
        crate::plugins::dir(ctx).join(pid).to_string_lossy().to_string(),
    );
    env.insert(
        "BIT_PLUGIN_PERMS".to_string(),
        crate::plugins::effective_perms(ctx, &p).join(","),
    );
    apply_env(ctx, &mut env);
    env.into_iter().collect()
}

/// 按工具 id 取插件环境：`plugin::<插件id>::<工具名>` 才有，
/// 内置工具与 AI 临时脚本返回空表——它们没有插件身份，也不该拿到任何插件令牌。
pub fn tool_env(ctx: &Arc<Ctx>, tool_id: &str) -> Vec<(String, String)> {
    match plugin_of_tool(tool_id) {
        Some(pid) => plugin_env(ctx, &pid),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Arc<Ctx> {
        crate::plugins::test_ctx("plugin-sdk")
    }

    #[test]
    fn sdk_materializes_both_module_systems() {
        let c = ctx();
        ensure(&c);
        let pkg = bit_pkg(&c);
        assert!(pkg.join("index.cjs").is_file());
        assert!(pkg.join("index.mjs").is_file());
        assert!(pkg.join("index.d.ts").is_file());
        assert!(py_dir(&c).join("bit.py").is_file());
        // 幂等：内容没变就一个字节都不再写
        assert_eq!(ensure(&c), 0);
        assert!(installed(&c));
    }

    #[test]
    fn package_json_offers_require_and_import() {
        let c = ctx();
        ensure(&c);
        let j: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(bit_pkg(&c).join("package.json")).unwrap()).unwrap();
        assert_eq!(j["name"], "bit");
        assert_eq!(j["exports"]["."]["require"], "./index.cjs");
        assert_eq!(j["exports"]["."]["import"], "./index.mjs");
    }

    #[test]
    fn env_prepends_search_paths_once() {
        let c = ctx();
        let mut env = HashMap::new();
        apply_env(&c, &mut env);
        let pp = env.get("PYTHONPATH").unwrap().clone();
        assert!(pp.starts_with(&py_dir(&c).to_string_lossy().to_string()), "{pp}");
        // 已经有同一条路径时不重复堆叠
        let mut again = HashMap::new();
        again.insert("PYTHONPATH".to_string(), pp.clone());
        apply_env(&c, &mut again);
        assert_eq!(again.get("PYTHONPATH").unwrap(), &pp);
    }

    #[test]
    fn only_plugin_tools_get_credentials() {
        let c = ctx();
        assert_eq!(plugin_of_tool("plugin::biz-crm::lead_scan").as_deref(), Some("biz-crm"));
        assert_eq!(plugin_of_tool("shell"), None);
        // 没有登记的插件 → 不发任何凭据（停用即调不动）
        assert!(tool_env(&c, "plugin::ghost::tool").is_empty());
        assert!(tool_env(&c, "read_file").is_empty());
    }

    #[test]
    fn enabled_plugin_tool_env_carries_token_and_perms() {
        let c = ctx();
        crate::plugins::write_test_plugin(
            &c,
            "sugar",
            serde_json::json!({ "name": "糖", "permissions": ["data", "settings"] }),
            &[],
        );
        let env = crate::plugin_sdk::tool_env(&c, "plugin::sugar::t");
        let get = |k: &str| env.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone()).unwrap_or_default();
        assert_eq!(get("BIT_PLUGIN_ID"), "sugar");
        assert!(get("BIT_PLUGIN_TOKEN").starts_with("plt_"), "令牌应由宿主现发：{}", get("BIT_PLUGIN_TOKEN"));
        assert!(get("BIT_PLUGIN_PERMS").contains("data"));
        assert!(get("PYTHONPATH").contains("py"));
        assert!(get("NODE_PATH").contains("node_modules"));
    }
}
