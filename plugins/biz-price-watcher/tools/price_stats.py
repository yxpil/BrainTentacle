# 报价统计：stdin 收 {items:[{sku,price}], volatility_threshold?}，stdout 出 JSON。
# Windows 下 stdout 默认跟着系统代码页走，中文结果会被写成 GBK 而让宿主解析失败，显式改 UTF-8。
import json
import math
import sys

sys.stdout.reconfigure(encoding="utf-8")


def main():
    try:
        params = json.load(sys.stdin)
    except Exception as exc:  # stdin 不是合法 JSON 时给人话错误，别抛栈
        print(json.dumps({"ok": False, "error": f"参数不是合法 JSON：{exc}"}, ensure_ascii=False))
        return

    items = params.get("items") or []
    threshold = float(params.get("volatility_threshold") or 0.15)

    rows = []
    for it in items:
        if not isinstance(it, dict):
            continue
        try:
            price = float(it.get("price"))
        except (TypeError, ValueError):
            continue
        rows.append({"sku": str(it.get("sku") or it.get("name") or "?"), "price": price})

    if not rows:
        print(json.dumps({"ok": False, "error": "没有可用报价（items 为空或 price 缺失）", "count": 0}, ensure_ascii=False))
        return

    prices = [r["price"] for r in rows]
    n = len(prices)
    mean = sum(prices) / n
    var = sum((p - mean) ** 2 for p in prices) / n
    stdev = math.sqrt(var)
    cv = (stdev / mean) if mean else 0.0
    low = min(rows, key=lambda r: r["price"])
    high = max(rows, key=lambda r: r["price"])
    flagged = sorted(
        (
            {"sku": r["sku"], "price": r["price"], "deviation": abs(r["price"] - mean) / mean if mean else 0.0}
            for r in rows
            if mean and abs(r["price"] - mean) / mean >= threshold
        ),
        key=lambda x: -x["deviation"],
    )

    print(
        json.dumps(
            {
                "ok": True,
                "count": n,
                "mean": round(mean, 4),
                "stdev": round(stdev, 4),
                "volatility": round(cv, 4),
                "lowest": low,
                "highest": high,
                "threshold": threshold,
                "flagged": flagged,
                "verdict": f"{n} 条报价，均价 {mean:.2f}，离散度 {cv * 100:.1f}%，复核项 {len(flagged)} 个",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
