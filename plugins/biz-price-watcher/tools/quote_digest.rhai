// Rhai 沙盒工具：只用宿主内置的 now() / http_get() / to_json()，最后一行表达式即返回值。
// 场景：运营想要一行「SKU 价格」摘要，并顺手确认本机服务是否活着。
// 注意：这个 Rhai 构建里三元写法 `a ? b : c` 解析不过（实测 Unknown operator: '?'），一律用 if 表达式；
// 数组字面量是 `[]`，`#` 只属于 map 的 `#{}`——写成 `#[]` 会报 '#' is a reserved symbol。
let items = if params.items == () { [] } else { params.items };
let limit = if params.limit == () { 5 } else { params.limit };
let health_url = if params.health_url == () { "" } else { params.health_url };

let parts = [];
let i = 0;
while i < items.len() && i < limit {
    let it = items[i];
    let sku = if it.sku == () { "?" } else { it.sku };
    let price = if it.price == () { 0 } else { it.price };
    parts.push(`${sku} ${price}`);
    i += 1;
}

// 这个构建的数组没有 join/text：按分隔符手工累加，首个元素前不加
let digest = "";
let k = 0;
while k < parts.len() {
    if k > 0 { digest = digest + " / "; }
    digest = digest + parts[k];
    k += 1;
}

// 沙盒出网只走 http_get：返回的是 {"status":…,"body":…} 这段字符串
let probe = if health_url == "" { "未提供健康检查地址" } else { http_get(health_url) };

#{
    "count": items.len(),
    "digest": digest,
    "probe": probe,
    "ts": now()
}
