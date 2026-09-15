import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // 相对路径：Electron 以 loadFile（file://）加载 dist 产物，
  // 绝对 /assets 会解析到文件系统根导致脚本 404、白屏（Tauri 内嵌资产同样兼容）
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    // Rust 构建产物（432MB bit-cli.exe 等）不进 watcher：EBUSY 会让 dev server 直接崩
    watch: { ignored: ["**/src-tauri/target/**", "**/target/**", "**/crates/bit-napi/*.node"] },
  },
});
