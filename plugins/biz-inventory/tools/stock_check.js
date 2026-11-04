// 库存核对：stdin 收 {system:[{sku,qty}], counted:[{sku,qty}]}，stdout 出差异清单。
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let params;
  try {
    params = JSON.parse(raw || "{}");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: "参数不是合法 JSON：" + e.message }));
    return;
  }
  const sys = new Map((params.system || []).map((x) => [String(x.sku), Number(x.qty) || 0]));
  const got = new Map((params.counted || []).map((x) => [String(x.sku), Number(x.qty) || 0]));
  const skus = new Set([...sys.keys(), ...got.keys()]);
  const diffs = [...skus].map((sku) => {
    const a = sys.has(sku) ? sys.get(sku) : null;
    const b = got.has(sku) ? got.get(sku) : null;
    return { sku, system: a, counted: b, diff: (a ?? 0) - (b ?? 0), missing: a === null || b === null };
  });
  diffs.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  process.stdout.write(
    JSON.stringify({
      ok: true,
      count: diffs.length,
      mismatched: diffs.filter((d) => d.diff !== 0).length,
      unrecorded: diffs.filter((d) => d.missing).map((d) => d.sku),
      top: diffs.slice(0, 8),
      summary: `核对 ${diffs.length} 个 SKU，${diffs.filter((d) => d.diff !== 0).length} 个有差异`,
    })
  );
});
