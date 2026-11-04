// yxpil · BIT
//! 本机操控三件套（screen / mouse / keyboard）的跨平台阻塞实现。
//! 全部在 spawn_blocking 中执行（enigo/screenshots 是阻塞 API）；
//! 平台差异：
//!   - Windows：Win32 SendInput / DXGI 截屏，开箱即用
//!   - macOS：CGEvent / CoreGraphics 截屏，首次使用需 TCC 授权（屏幕录制 + 辅助功能）
//!   - Linux：X11（XTest / XGetImage）；Wayland 下截屏/输入合成受限，报错指引

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

/// enigo 实例不便跨线程共享（非 Sync），每次调用新建（开销 ~ms 级，可接受）
fn enigo_new() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|e| format!("输入合成初始化失败: {e}"))
}

fn ie2s(e: enigo::InputError) -> String {
    format!("输入合成失败: {e}（macOS 需辅助功能授权；Linux Wayland 受限请用 X11）")
}

// ── 截屏 ────────────────────────────────────────────────────────────────────

/// 截屏：display=显示器序号（0=主屏），region=(x,y,w,h) 可选裁剪（物理像素）。
/// 返回 PNG 落盘路径（媒体缓存目录，对话 UI 自动出图）
pub fn screenshot(
    ctx: &std::sync::Arc<crate::state::Ctx>,
    display: usize,
    region: Option<(u32, u32, u32, u32)>,
    grid: bool,
) -> Result<String, String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let screen = screens
        .get(display)
        .ok_or(format!("显示器 {display} 不存在（共 {} 个，序号从 0 开始）", screens.len()))?;
    let img = screen.capture().map_err(|e| format!("截屏失败: {e}（macOS 需在 系统设置 → 隐私与安全性 → 屏幕录制 中授权 BIT；Linux Wayland 受限请用 X11）"))?;

    let mut rgba = image::RgbaImage::from_raw(img.width(), img.height(), img.into_raw())
        .ok_or("截屏数据尺寸异常")?;
    // 可选区域裁剪（按请求参数钳制到图像边界）
    if let Some((x, y, w, h)) = region {
        let (iw, ih) = rgba.dimensions();
        let x = x.min(iw.saturating_sub(1));
        let y = y.min(ih.saturating_sub(1));
        let w = w.min(iw.saturating_sub(x)).max(1);
        let h = h.min(ih.saturating_sub(y)).max(1);
        rgba = image::imageops::crop_imm(&rgba, x, y, w, h).to_image();
    }
    // 网格叠加（仅全屏截图：格子引用与全屏坐标一一对应，区域裁剪会造成错位）
    if grid && region.is_none() {
        draw_grid(&mut rgba);
    }
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S%3f");
    let path = ctx.image_dir().join(format!("shot_{ts}.png"));
    let path_str = path.to_string_lossy().to_string();
    rgba.save(&path).map_err(|e| format!("截图保存失败: {e}"))?;
    Ok(path_str)
}

// ── 屏幕网格（截图叠加 + 鼠标格子引用换算）─────────────────────────────────
// 目的：模型直接估计像素坐标误差大（DPI 缩放 / 空间感知弱），改为「看格子引用点格子」：
//   截屏时叠加 X=A..Z、Y=1..N 的网格；鼠标工具接受 "K7"（可带 .c/.tl/.tr/.bl/.br 锚点）
//   换算成格子内像素，误差锁死在半格内。

pub const GRID_COLS: u32 = 26; // X 轴 A-Z

/// 网格规格：列数（恒 26）、行数、格子宽高（物理像素，近似正方形）
pub fn grid_metrics(w: u32, h: u32) -> (u32, u32, u32, u32) {
    let cell_w = (w / GRID_COLS).max(1);
    let rows = h.div_ceil(cell_w).max(1);
    let cell_h = (h / rows).max(1);
    (GRID_COLS, rows, cell_w, cell_h)
}

/// 格子引用 → 物理像素坐标（锚点：c=中心默认，tl/tr/bl/br=四分位，字号后缀如 "K7.br"）
pub fn parse_cell(s: &str, w: u32, h: u32) -> Result<(i32, i32), String> {
    let s = s.trim();
    let (core, anchor) = match s.split_once('.') {
        Some((c, a)) => (c, a.to_ascii_lowercase()),
        None => (s, "c".to_string()),
    };
    if core.len() < 2 || !core[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("格子引用格式应为 \"列+行号\"（如 K7 或 K7.br）: {s}"));
    }
    let letter = core.as_bytes()[0];
    let col = (letter.to_ascii_uppercase() - b'A') as u32;
    if col >= GRID_COLS {
        return Err(format!("列 {letter} 超出范围（A-Z）"));
    }
    let row: u32 = core[1..].parse().map_err(|_| format!("行号无效: {s}"))?;
    if row == 0 {
        return Err("行号从 1 开始".into());
    }
    let (_, rows, cw, ch) = grid_metrics(w, h);
    if row > rows {
        return Err(format!("行 {row} 超出范围（当前屏幕共 {rows} 行）"));
    }
    let (fx, fy) = match anchor.as_str() {
        "c" => (0.5, 0.5),
        "tl" => (0.25, 0.25),
        "tr" => (0.75, 0.25),
        "bl" => (0.25, 0.75),
        "br" => (0.75, 0.75),
        other => return Err(format!("锚点应为 c/tl/tr/bl/br: {other}")),
    };
    let x = (col * cw) as f64 + cw as f64 * fx;
    let y = ((row - 1) * ch) as f64 + ch as f64 * fy;
    Ok((x as i32, y as i32))
}

/// 显示器物理尺寸（display_info，无需截屏）
pub fn screen_dims(display: usize) -> Result<(u32, u32, f64), String> {
    let screens = screenshots::Screen::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let s = screens
        .get(display)
        .ok_or(format!("显示器 {display} 不存在"))?;
    let di = &s.display_info;
    Ok((di.width, di.height, di.scale_factor as f64))
}

// 5x7 点阵字体（0-9 A-Z），逐行 5 bit（高位在左）；避免引入字体依赖
const FONT5X7: &[(char, [u8; 7])] = &[
    ('0', [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E]),
    ('1', [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E]),
    ('2', [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F]),
    ('3', [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E]),
    ('4', [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02]),
    ('5', [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E]),
    ('6', [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E]),
    ('7', [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08]),
    ('8', [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E]),
    ('9', [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C]),
    ('A', [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11]),
    ('B', [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E]),
    ('C', [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E]),
    ('D', [0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C]),
    ('E', [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F]),
    ('F', [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10]),
    ('G', [0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F]),
    ('H', [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11]),
    ('I', [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E]),
    ('J', [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C]),
    ('K', [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11]),
    ('L', [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F]),
    ('M', [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11]),
    ('N', [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11]),
    ('O', [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E]),
    ('P', [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10]),
    ('Q', [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D]),
    ('R', [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11]),
    ('S', [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E]),
    ('T', [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04]),
    ('U', [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E]),
    ('V', [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04]),
    ('W', [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A]),
    ('X', [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11]),
    ('Y', [0x11, 0x11, 0x11, 0x0A, 0x04, 0x04, 0x04]),
    ('Z', [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F]),
];

fn glyph(c: char) -> [u8; 7] {
    FONT5X7
        .iter()
        .find(|(k, _)| *k == c)
        .map(|(_, g)| *g)
        .unwrap_or([0x1F; 7])
}

/// 在整图上画点阵文字（黑描边 + 白色本体，任意底色可读）
fn draw_text(img: &mut image::RgbaImage, ox: i64, oy: i64, text: &str, scale: u32) {
    let (w, h) = img.dimensions();
    let put = |img: &mut image::RgbaImage, px: i64, py: i64, col: [u8; 4]| {
        if px >= 0 && py >= 0 && (px as u32) < w && (py as u32) < h {
            img.put_pixel(px as u32, py as u32, image::Rgba(col));
        }
    };
    let mut cx = ox;
    for ch in text.chars() {
        let g = glyph(ch);
        for (ry, bits) in g.iter().enumerate() {
            for rx in 0..5u32 {
                if bits & (0x10 >> rx) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            let px = cx + (rx * scale) as i64 + sx as i64;
                            let py = oy + (ry as u32 * scale) as i64 + sy as i64;
                            // 先描边（四向偏移黑），最后统一画白本体
                            for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                                put(img, px + dx, py + dy, [0, 0, 0, 255]);
                            }
                        }
                    }
                }
            }
        }
        cx += (5 * scale + scale) as i64;
    }
    let mut cx = ox;
    for ch in text.chars() {
        let g = glyph(ch);
        for (ry, bits) in g.iter().enumerate() {
            for rx in 0..5u32 {
                if bits & (0x10 >> rx) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            put(
                                img,
                                cx + (rx * scale) as i64 + sx as i64,
                                oy + (ry as u32 * scale) as i64 + sy as i64,
                                [255, 255, 255, 255],
                            );
                        }
                    }
                }
            }
        }
        cx += (5 * scale + scale) as i64;
    }
}

/// 全屏截图叠加网格：虚线品红格线 + 每格左上角 "A1" 式标注
pub fn draw_grid(img: &mut image::RgbaImage) {
    let (w, h) = img.dimensions();
    let (cols, rows, cw, ch) = grid_metrics(w, h);
    let line_col = image::Rgba([255, 0, 128, 255]);
    // 竖线（2on/2off 虚线，减少对内容的遮挡）
    for c in 1..cols {
        let x = c * cw;
        for y in (0..h).step_by(1) {
            if (y / 2) % 2 == 0 && x < w {
                img.put_pixel(x, y, line_col);
            }
        }
    }
    // 横线
    for r in 1..rows {
        let y = r * ch;
        if y < h {
            for x in (0..w).step_by(1) {
                if (x / 2) % 2 == 0 {
                    img.put_pixel(x, y, line_col);
                }
            }
        }
    }
    // 每格左上角标注引用（1920 宽 → cell_w≈73 → scale=1；4K → scale=2+）
    let scale = (cw / 40).max(1);
    for r in 0..rows {
        for c in 0..cols {
            let label = format!("{}{}", (b'A' + c as u8) as char, r + 1);
            draw_text(img, (c * cw + 3) as i64, (r * ch + 3) as i64, &label, scale);
        }
    }
}

// ── 鼠标 ────────────────────────────────────────────────────────────────────

/// 鼠标操作：position / move / click / double_click / right_click / drag / scroll
pub fn mouse(action: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let xy = |k1: &str, k2: &str| -> Result<(i32, i32), String> {
        let x = params.get(k1).and_then(|v| v.as_f64()).ok_or(format!("Missing parameter: {k1}"))?;
        let y = params.get(k2).and_then(|v| v.as_f64()).ok_or(format!("Missing parameter: {k2}"))?;
        Ok((x as i32, y as i32))
    };
    let mut eg = enigo_new()?;
    match action {
        "position" => {
            let (x, y) = eg.location().map_err(ie2s)?;
            Ok(serde_json::json!({ "x": x, "y": y }))
        }
        "move" => {
            let (x, y) = xy("x", "y")?;
            eg.move_mouse(x, y, Coordinate::Abs).map_err(ie2s)?;
            Ok(serde_json::json!({ "ok": true, "action": "move", "x": x, "y": y }))
        }
        "click" | "double_click" | "right_click" => {
            let (x, y) = xy("x", "y")?;
            eg.move_mouse(x, y, Coordinate::Abs).map_err(ie2s)?;
            let button = if action == "right_click" { Button::Right } else { Button::Left };
            let times = if action == "double_click" { 2 } else { 1 };
            for _ in 0..times {
                eg.button(button, Direction::Click).map_err(ie2s)?;
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Ok(serde_json::json!({ "ok": true, "action": action }))
        }
        "drag" => {
            let (x, y) = xy("x", "y")?;
            let (tx, ty) = xy("x2", "y2")?;
            eg.move_mouse(x, y, Coordinate::Abs).map_err(ie2s)?;
            eg.button(Button::Left, Direction::Press).map_err(ie2s)?;
            // 分 12 段平滑拖动：部分应用（画板/网页）不响应瞬移 drag
            for i in 1..=12 {
                let px = x + (tx - x) * i / 12;
                let py = y + (ty - y) * i / 12;
                eg.move_mouse(px, py, Coordinate::Abs).map_err(ie2s)?;
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            eg.button(Button::Left, Direction::Release).map_err(ie2s)?;
            Ok(serde_json::json!({ "ok": true, "action": "drag", "from": [x, y], "to": [tx, ty] }))
        }
        "scroll" => {
            let dx = params.get("dx").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
            let dy = params.get("dy").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
            if dx == 0 && dy == 0 {
                return Err("scroll needs a non-zero dx or dy".into());
            }
            if dy != 0 {
                eg.scroll(dy, Axis::Vertical).map_err(ie2s)?;
            }
            if dx != 0 {
                eg.scroll(dx, Axis::Horizontal).map_err(ie2s)?;
            }
            Ok(serde_json::json!({ "ok": true, "action": "scroll" }))
        }
        other => Err(format!(
            "Unknown action '{other}'; available: position, move, click, double_click, right_click, drag, scroll"
        )),
    }
}

// ── 键盘 ────────────────────────────────────────────────────────────────────

/// 键名 → enigo Key 映射（命名键集 + 单字符 Unicode 直传）
fn named_key(k: &str) -> Option<Key> {
    Some(match k.to_lowercase().as_str() {
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "delete" | "backspace" => Key::Backspace,
        "forwarddelete" | "del" => Key::Delete,
        "escape" | "esc" => Key::Escape,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "left" | "leftarrow" => Key::LeftArrow,
        "right" | "rightarrow" => Key::RightArrow,
        "down" | "downarrow" => Key::DownArrow,
        "up" | "uparrow" => Key::UpArrow,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        _ => return None,
    })
}

/// 键盘操作：type（整段文本，支持 Unicode）/ key（单键 + cmd/ctrl/shift/option 修饰）
pub fn keyboard(action: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut eg = enigo_new()?;
    match action {
        "type" => {
            let text = params
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or("Missing parameter: text")?;
            if text.is_empty() {
                return Err("text cannot be empty".into());
            }
            eg.text(text).map_err(|e| format!("文本输入失败: {e}"))?;
            Ok(serde_json::json!({ "ok": true, "action": "type", "chars": text.chars().count() }))
        }
        "key" => {
            let key = params
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or("Missing parameter: key")?;
            // 修饰键：按下 → 主键 → 释放（顺序保证组合生效）
            let mut mods: Vec<Key> = Vec::new();
            if params.get("cmd").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods.push(Key::Meta);
            }
            if params.get("ctrl").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods.push(Key::Control);
            }
            if params.get("shift").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods.push(Key::Shift);
            }
            if params.get("option").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods.push(Key::Alt);
            }
            for m in &mods {
                eg.key(*m, Direction::Press).map_err(ie2s)?;
            }
            let k = named_key(key)
                .or_else(|| {
                    // 单字符键：Unicode 直传（字母/数字/符号/中文）
                    let mut cs = key.chars();
                    let (Some(c), None) = (cs.next(), cs.next()) else { return None };
                    Some(Key::Unicode(c))
                })
                .ok_or(format!(
                    "Unknown key '{key}'; use a single character or a named key (return/tab/space/delete/escape/home/end/pageup/pagedown/left/right/up/down/f1-f12)"
                ))?;
            eg.key(k, Direction::Click).map_err(ie2s)?;
            for m in mods.into_iter().rev() {
                let _ = eg.key(m, Direction::Release);
            }
            Ok(serde_json::json!({ "ok": true, "action": "key", "key": key }))
        }
        other => Err(format!("Unknown action '{other}'; available: type, key")),
    }
}

// ── 网格换算测试 ────────────────────────────────────────────────────────────
#[cfg(test)]
mod grid_tests {
    use super::*;

    #[test]
    fn test_grid_metrics_1080p() {
        // 1920x1080: cell_w=73，行数=ceil(1080/73)=15，cell_h=72
        let (cols, rows, cw, ch) = grid_metrics(1920, 1080);
        assert_eq!(cols, 26);
        assert_eq!(cw, 73);
        assert_eq!(rows, 15);
        assert_eq!(ch, 72);
    }

    #[test]
    fn test_grid_metrics_small() {
        // 极小尺寸不 panic
        let (cols, _rows, cw, ch) = grid_metrics(26, 5);
        assert_eq!(cols, 26);
        assert_eq!(cw, 1);
        assert_eq!(ch, 1);
    }

    #[test]
    fn test_parse_cell_center() {
        // A1 中心 = (36, 36)；1920 宽 cw=73
        let (x, y) = parse_cell("A1", 1920, 1080).unwrap();
        assert_eq!((x, y), (36, 36));
        // B2 中心
        let (x, y) = parse_cell("B2", 1920, 1080).unwrap();
        assert_eq!((x, y), (73 + 36, 72 + 36));
        // 小写
        assert_eq!(parse_cell("b2", 1920, 1080).unwrap(), (109, 108));
    }

    #[test]
    fn test_parse_cell_anchors() {
        // K7.br：K=10 列，第 7 行，右下四分位
        let (x, y) = parse_cell("K7.br", 1920, 1080).unwrap();
        let bx = 10 * 73 + (73.0 * 0.75) as i32;
        let by = 6 * 72 + (72.0 * 0.75) as i32;
        assert_eq!((x, y), (bx, by));
        // 无效锚点
        assert!(parse_cell("K7.xx", 1920, 1080).is_err());
    }

    #[test]
    fn test_parse_cell_errors() {
        assert!(parse_cell("", 1920, 1080).is_err());
        assert!(parse_cell("1A", 1920, 1080).is_err());
        assert!(parse_cell("AA1", 1920, 1080).is_err());
        assert!(parse_cell("[", 1920, 1080).is_err()); // 非 A-Z 列
        assert!(parse_cell("A0", 1920, 1080).is_err());
        // 行越界（1080p 共 15 行）
        assert!(parse_cell("A16", 1920, 1080).is_err());
        // 合法边界
        assert!(parse_cell("Z15", 1920, 1080).is_ok());
    }

    #[test]
    fn test_draw_grid_smoke() {
        let mut img = image::RgbaImage::new(520, 400);
        draw_grid(&mut img);
        // 起始角应有标注像素（白字或黑描边或品红线附近非零）
        let px = img.get_pixel(5, 6);
        assert!(px.0[0] > 200 || px.0[2] > 100);
    }
}
