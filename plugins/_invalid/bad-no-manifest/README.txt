这个夹具目录故意不放 plugin.json：扫描器要把「目录在、清单读不到」如实报出来，
而不是当成「这里没插件」悄悄跳过。对应错误串：`plugin.json missing or unreadable`。
