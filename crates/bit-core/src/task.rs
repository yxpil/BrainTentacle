// yxpil · BIT
//! 全局 tokio 运行时句柄：替代 tauri::async_runtime，核心逻辑派生异步任务不再依赖 Tauri。
//! 三种宿主的安装时机：
//! - Tauri GUI（M0 过渡期）：setup 回调里 init_standalone()（Tauri 的 async_runtime::handle()
//!   返回自包装 RuntimeHandle，拿不出原生 tokio Handle；两 runtime 并存互不干扰）
//! - bit-cli（M1）：init_standalone() 自建
//! - napi（M1+）：module_init 里安装 napi 托管 runtime 的 Handle（共享同一个，杜绝双 runtime 静默失效）
use std::sync::OnceLock;

static HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();
static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// 安装运行时句柄（进程内只能装一次；重复调用忽略并保留首次）
pub fn init(handle: tokio::runtime::Handle) {
    let _ = HANDLE.set(handle);
}

/// 宿主 / CLI 自建独立 multi-thread runtime 并安装
pub fn init_standalone() -> &'static tokio::runtime::Runtime {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("bit task runtime");
    init(rt.handle().clone());
    RT.get_or_init(|| rt)
}

/// 已安装的句柄；未安装时回退当前 tokio 上下文（#[tokio::test] 等场景），
/// 都没有才 panic（生产启动顺序错误，必须立刻暴露）
pub fn handle() -> tokio::runtime::Handle {
    if let Some(h) = HANDLE.get() {
        return h.clone();
    }
    if let Ok(h) = tokio::runtime::Handle::try_current() {
        return h;
    }
    panic!("bit task runtime not init");
}

/// 派生异步任务（等价 tauri::async_runtime::spawn）
pub fn spawn<F, T>(f: F) -> tokio::task::JoinHandle<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    handle().spawn(f)
}

/// 派生阻塞任务（等价 tauri::async_runtime::spawn_blocking）
pub fn spawn_blocking<F, T>(f: F) -> tokio::task::JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    handle().spawn_blocking(f)
}

/// 在调用线程上阻塞运行 future（仅限非 async 上下文：TUI 主线程 / CLI main）
pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    handle().block_on(f)
}
