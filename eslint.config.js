import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**", "e2e/**", "installer/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      // v0.5.14 黑屏事故回归闸门：漏声明变量在渲染期抛 ReferenceError，React 整树卸载 → 黑屏。
      // 此规则让同类错误在构建前（而非用户安装后）暴露。
      "no-undef": "error",
      "no-unused-vars": "warn",
    },
  },
  // 宿主侧与桥脚本（Node 环境，且不少文件是注入 webview 的浏览器代码）：以前没给任何 globals，
  // `process`/`require`/`window`/`document` 一律误报 no-undef，真问题被埋在这批噪音里
  {
    files: ["electron/**/*.cjs", "scripts/**/*.cjs", "voice-bridge/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
  {
    files: ["electron/**/*.mjs", "scripts/**/*.mjs", "voice-bridge/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
  // 插件夹具包（含 vendored 第三方源码）：CJS 服务脚本 + 注入 iframe 的浏览器代码两种世界都有
  {
    files: ["plugins/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error", "no-unused-vars": "warn" },
  },
];
