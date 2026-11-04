import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.js";

/**
 * 行为设置是「整包读写」的：set_behavior_settings 一次收六个字段，
 * 页眉的自动委派开关和自动化页都只改其中一个，所以统一走这里——
 * 先读回当前整包、覆盖要改的那一项再写回，避免一处开关把审批模式/内容审查清零。
 */
export async function patchBehavior(partial) {
  const cur = await api.getBehaviorSettings();
  const next = {
    auto_drive: !!cur?.auto_drive,
    tool_approval: cur?.tool_approval || "ask",
    moderation_enabled: cur?.moderation_enabled ?? true,
    auto_delegate: !!cur?.auto_delegate,
    compat_mode: cur?.compat_mode ?? false,
    subagent_max: cur?.subagent_max ?? 3,
    ...partial,
  };
  await api.setBehaviorSettings(
    next.auto_drive,
    next.tool_approval,
    next.moderation_enabled,
    next.auto_delegate,
    next.compat_mode,
    next.subagent_max
  );
  return next;
}

/**
 * 自动化相关的跨组件共享状态。
 * 放模块级是因为控件在页眉、消费方在对话页/自动化页，三处必须读到同一个值，
 * 再各自 useState + localStorage 就会出现"这里关了那里还亮着"。
 */

// ── 自动朗读回复 ──
const SPEAK_KEY = "bit.autoSpeak";
const speakSubs = new Set();
let speakOn = (() => {
  try {
    return localStorage.getItem(SPEAK_KEY) === "1";
  } catch {
    return false;
  }
})();

export function useAutoSpeak() {
  const on = useSyncExternalStore(
    (cb) => {
      speakSubs.add(cb);
      return () => speakSubs.delete(cb);
    },
    () => speakOn
  );
  const set = (next) => {
    speakOn = !!next;
    try {
      localStorage.setItem(SPEAK_KEY, speakOn ? "1" : "0");
    } catch {
      /* 存储被禁时仅本次会话生效 */
    }
    speakSubs.forEach((f) => f());
  };
  return [on, set];
}

// ── 子代理实时表（subagent-lifecycle 事件驱动）──
// 终态停留 8 秒再清，让用户看到"完成 / 失败"的结果而不是瞬间消失
const FINAL_DWELL_MS = 8000;
const subSubs = new Set();
const subs = new Map();
let subSnap = [];
let subListening = false;

function rebuild() {
  subSnap = [...subs.values()];
  subSubs.forEach((f) => f());
}

function ensureListening() {
  if (subListening) return;
  subListening = true;
  listen("subagent-lifecycle", (e) => {
    const p = e.payload || {};
    if (!p.session_id) return;
    subs.set(p.session_id, { ...(subs.get(p.session_id) || {}), ...p, session_id: p.session_id });
    if (p.phase === "done" || p.phase === "error") {
      const sid = p.session_id;
      setTimeout(() => {
        // 只删仍然是同一终态的那条：期间若有新事件说明它又动了
        const cur = subs.get(sid);
        if (cur && (cur.phase === "done" || cur.phase === "error")) {
          subs.delete(sid);
          rebuild();
        }
      }, FINAL_DWELL_MS);
    }
    rebuild();
  }).catch(() => {
    subListening = false;
  });
}

export function useSubagents() {
  return useSyncExternalStore(
    (cb) => {
      ensureListening();
      subSubs.add(cb);
      return () => subSubs.delete(cb);
    },
    () => subSnap
  );
}
