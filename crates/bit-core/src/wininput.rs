//! Windows 前台窗口操作（进程内 Win32）。
//!
//! 全局语音要「把转写结果粘回按键那一刻的应用」，这需要两件事：记住前台窗口、粘贴前
//! 把它抢回来。两者都不能借道 powershell.exe——外部控制台进程自己会带出一个（隐藏的）
//! 控制台窗口，那个窗口反而会把前台抢走，等于边修边坏。放到进程内直接调 user32 最稳。

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
    ShowWindow, SW_RESTORE,
};

fn parse(hwnd: &str) -> Option<HWND> {
    hwnd
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|v| *v != 0)
        .map(|v| v as HWND)
}

/// 当前前台窗口句柄（十进制字符串，0 表示没有）
pub fn foreground_hwnd() -> String {
    let h = unsafe { GetForegroundWindow() };
    (h as usize).to_string()
}

/// 把指定窗口拉回前台并确认：成功返回 true。
/// SetForegroundWindow 受前台锁限制，先 AttachThreadInput 挂到当前前台线程再设，
/// 设完立刻脱离（不脱离会让两个线程的输入队列永久绑定）
pub fn activate(hwnd: &str) -> bool {
    let Some(h) = parse(hwnd) else { return false };
    unsafe {
        let fg = GetForegroundWindow();
        if fg == h {
            return true;
        }
        let fg_thread = GetWindowThreadProcessId(fg, std::ptr::null_mut());
        let cur_thread = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != cur_thread
            && AttachThreadInput(cur_thread, fg_thread, 1) != 0;
        ShowWindow(h, SW_RESTORE);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        if attached {
            AttachThreadInput(cur_thread, fg_thread, 0);
        }
        GetForegroundWindow() == h
    }
}

/// 向当前前台窗口注入 Ctrl+V（keybd_event 走原始输入，比 SendKeys 更容易被各色应用接住）
pub fn ctrl_v() {
    unsafe {
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        keybd_event(VK_V as u8, 0, 0, 0);
        keybd_event(VK_V as u8, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}
