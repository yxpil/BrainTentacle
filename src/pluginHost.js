// yxpil · BIT
// 渲染层插件加载器：读取启用且通过安全校验的插件 UI 资源（get_plugin_ui），
// 注入 <style>（css 权限）并执行 JS 插件入口（js 权限）。
//
// 插件 JS 以受限 API 执行（new Function，非 eval 全局）：
//   api.React                —— 宿主 React 实例（插件组件必须用它，hooks 才能工作）
//   api.plugin               —— { id, name, version }
//   api.registerPage({...})  —— 注册导航页（宿主渲染，插件提供 component）
//   api.removePage(id)       —— 移除自己注册的页
//   api.invoke(cmd, args)    —— 后端命令（需插件声明 "invoke" 权限）
//   api.storage              —— 按插件 id 命名空间隔离的 localStorage
//   api.log(...)             —— 带插件名前缀的 console.log
//
// 安全模型：后端出站前已过 清单 schema + 权限位 + 路径包含 + 全文件哈希基线四道闸；
// 渲染层只加载 backend 过滤后的文本，不在渲染层做二次信任判断。
import React from "react";
import { invoke } from "@tauri-apps/api/core";

// 插件页面登记表：key = "<插件id>:<页id>" -> { label, icon?, component }
let pages = {};
let loadSeq = 0;
const listeners = new Set();

/** 订阅插件页面变化（App.jsx 用 useSyncExternalStore 挂上） */
export function subscribePluginPages(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 当前插件页面登记表快照（引用仅在变更时换新，满足 useSyncExternalStore 语义） */
export function getPluginPages() {
  return pages;
}

function emit() {
  pages = { ...pages };
  listeners.forEach((cb) => cb());
}

function clearInjected() {
  document.querySelectorAll("style[data-bit-plugin]").forEach((el) => el.remove());
  pages = {};
  emit();
}

function makeApi(plugin, perms) {
  const can = (perm) => perms.has(perm);
  const ns = (k) => `bit.plugin.${plugin.id}.${k}`;
  return {
    React,
    plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
    registerPage({ id, label, icon, component }) {
      if (!id || typeof label !== "string" || typeof component !== "function") {
        throw new Error("registerPage 需要 { id: string, label: string, component: function }");
      }
      pages[`${plugin.id}:${id}`] = { label, icon, component };
      emit();
    },
    removePage(id) {
      delete pages[`${plugin.id}:${id}`];
      emit();
    },
    invoke(cmd, args) {
      if (!can("invoke")) {
        return Promise.reject(new Error(`插件 ${plugin.id} 未声明 invoke 权限`));
      }
      return invoke(cmd, args || {});
    },
    storage: {
      get: (k) => localStorage.getItem(ns(k)),
      set: (k, v) => localStorage.setItem(ns(k), v),
      remove: (k) => localStorage.removeItem(ns(k)),
    },
    log: (...a) => console.log(`[插件 ${plugin.name}]`, ...a),
  };
}

/**
 * 加载（或重载）插件 UI。幂等：先清掉上一轮注入的样式与页面登记再重放。
 * 单插件失败只影响自己（捕获到 console），不阻断其余插件与应用启动。
 */
export async function loadPluginUi() {
  const seq = ++loadSeq;
  clearInjected();
  let bundle = null;
  try {
    bundle = await invoke("get_plugin_ui");
  } catch (e) {
    console.warn("[插件] 读取 UI 资源失败:", e);
    return;
  }
  if (seq !== loadSeq) return; // 期间又触发了重载，本轮作废
  for (const p of bundle?.plugins || []) {
    const perms = new Set(p.permissions || []);
    // ── css：注入 <style data-bit-plugin>（重载时按标记整体清除）──
    if (perms.has("css")) {
      for (const c of p.css || []) {
        try {
          const el = document.createElement("style");
          el.dataset.bitPlugin = p.id;
          el.textContent = c.text;
          document.head.appendChild(el);
        } catch (e) {
          console.warn(`[插件 ${p.id}] css 注入失败:`, e);
        }
      }
    }
    // ── js：按序执行入口，单文件 try/catch 隔离 ──
    if (perms.has("js")) {
      for (const j of p.js || []) {
        try {
          // 插件 JS 的既定执行方式（后端哈希基线 + 权限声明背书）；no-new-func 未启用无需豁免
          const runner = new Function("api", `"use strict";\n${j.text}`);
          runner(makeApi(p, perms));
        } catch (e) {
          console.warn(`[插件 ${p.id}] JS 执行失败(${j.path}):`, e);
        }
      }
    }
  }
}

/** 插件开关/重扫后重放 UI（样式与页面登记整体重建；已注册事件监听待应用重启彻底清理） */
export function reloadPluginUi() {
  return loadPluginUi();
}
