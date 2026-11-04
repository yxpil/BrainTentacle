// 巡检进程：起来打个招呼就非零退出，模拟"插件服务崩了"。
// 宿主（WorkWith）在监控到意外退出时登记异常，页眉异常灯与插件详情页都会看到它。
process.stderr.write(`${new Date().toISOString()} svc-crash/watchdog 启动即退出（故意的）\n`);
setTimeout(() => process.exit(1), 400);
