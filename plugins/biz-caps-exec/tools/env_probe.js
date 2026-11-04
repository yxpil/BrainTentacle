// 环境探针：工具进程看不到插件的环境变量，但能看到宿主给解释器准备的工作目录与 NODE_PATH。
process.stdout.write(
  JSON.stringify({
    ok: true,
    cwd: process.cwd(),
    node: process.version,
    node_path: process.env.NODE_PATH || null,
    platform: process.platform,
    // 有没有被宿主加了隐藏窗口之类的差异，这里一眼能看出来
    pid: process.pid,
    keys: Object.keys(process.env).filter((k) => /^(BIT|NODE_|PYTHON|VIRTUAL_ENV)|^PATH$/i.test(k)).sort(),
  })
);
