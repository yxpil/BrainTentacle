/**
 * 任务完成提示音：只在渲染层发声，系统气泡仍由主进程弹——一个终态只响一声、只弹一处。
 * 档位与音量存在 core 的 config（get/set_notify_sound）；自定义音频落在 data_dir/sounds，
 * 由 get_notify_sound 一并回成 data URL，这里直接交给 <audio> 播，不再回到打包素材的老路。
 */
import { invoke } from "@tauri-apps/api/core";

let setting = { mode: "default", volume: 60, custom: null };
let ac = null;

export function applyNotifySetting(r) {
  if (!r) return;
  setting = { ...setting, ...r };
}

export function getNotifySetting() {
  return setting;
}

/** 启动时读一次；改档后 core 发 notify-settings，各处再调这里刷新 */
export async function loadNotifySetting() {
  try {
    applyNotifySetting(await invoke("get_notify_sound", {}));
  } catch (e) {
    console.warn("[提示音] 读取设置失败:", e);
  }
  return setting;
}

const clampVolume = (v) => Math.max(0, Math.min(1, (Number(v) || 0) / 100));

/**
 * 内置短音：WebAudio 现场合成两声（"叮-咚"），不打包音频素材、不涉及任何授权。
 * 成功与失败差一个音高——失败更低，闭眼也分得出这一轮是好是坏。
 */
function blip(volume, freq) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = ac || new AC();
    if (ac.state === "suspended") ac.resume().catch(() => {});
    const peak = clampVolume(volume) * 0.35;
    if (peak <= 0) return;
    const t = ac.currentTime;
    const tone = (at, f, gain) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t + at);
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.linearRampToValueAtTime(gain, t + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
      o.connect(g);
      g.connect(ac.destination);
      o.start(t + at);
      o.stop(t + at + 0.32);
    };
    tone(0, freq, peak);
    tone(0.1, freq * 1.5, peak * 0.8);
  } catch {
    /* 一声提示而已，发声失败不影响任何正事 */
  }
}

function playFile(volume, url) {
  try {
    const a = new Audio(url);
    a.volume = clampVolume(volume);
    // 浏览器自动播放策略可能拒绝（页面没有用户手势）：放弃这一声，不打扰用户
    a.play().catch(() => {});
  } catch {
    /* 同上 */
  }
}

/** 回合终态提示：ok=正常收工；error-only 档只在失败时出声 */
export function playCompletion(ok) {
  const { mode, volume, custom } = setting;
  if (clampVolume(volume) <= 0) return;
  if (mode === "error-only" && ok) return;
  if (mode === "custom" && custom?.url) return playFile(volume, custom.url);
  blip(volume, ok ? 880 : 523.25);
}

/**
 * 设置页「试听」：绕过 error-only 的门控，让用户选完就听见自己挑的那一声。
 * 这里传 ok=false 就是听失败音，传 true 听成功音。
 */
export function previewCompletion(ok = true) {
  const { mode, volume, custom } = setting;
  if (clampVolume(volume) <= 0) return;
  if (mode === "custom" && custom?.url) return playFile(volume, custom.url);
  blip(volume, ok ? 880 : 523.25);
}
