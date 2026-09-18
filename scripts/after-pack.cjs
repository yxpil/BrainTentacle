// yxpil · BIT electron-builder afterPack
//! 打包收尾：删除 Electron 自带的 default_app（「默认应用」）。
//! 它是 electron.exe 不带应用时的回退壳——能把可执行文件直接变成素面 Chromium
//! 浏览器 / REPL（node_modules 里的 `electron.exe <url>` 就是走的它）。
//! 正式包里 app.asar 永远存在，default_app 纯属死重量 + 露馅口子：
//! 删掉 app.asar 即可让 BIT.exe 回退成浏览器。此钩子把这条路焊死。
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const resourcesDir = path.join(context.appOutDir, 'resources');
  for (const name of ['default_app.asar', 'default_app.asar.unpacked']) {
    const p = path.join(resourcesDir, name);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`[afterPack] 已移除 ${name}（防回退裸 Chromium）`);
    }
  }
};
