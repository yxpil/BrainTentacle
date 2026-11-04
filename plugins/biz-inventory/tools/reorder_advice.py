# 补货建议：库存低于「安全库存 + 提前期消耗」就列进补货单。
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

DEFAULT_LEAD = 7.0
DEFAULT_SAFETY_FACTOR = 1.0


def main():
    try:
        params = json.load(sys.stdin)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"参数不是合法 JSON：{exc}"}, ensure_ascii=False))
        return

    lead = float(params.get("lead_days") or DEFAULT_LEAD)
    factor = float(params.get("safety_factor") or DEFAULT_SAFETY_FACTOR)
    orders = []
    for it in params.get("items") or []:
        if not isinstance(it, dict):
            continue
        try:
            stock = float(it.get("stock", 0))
            safety = float(it.get("safety", 0))
            daily = float(it.get("daily_sales", 0))
        except (TypeError, ValueError):
            continue
        need = safety * factor + daily * lead
        gap = need - stock
        if gap > 0:
            orders.append(
                {
                    "sku": str(it.get("sku") or "?"),
                    "stock": stock,
                    "need": round(need, 2),
                    "order_qty": int(-(-gap // 1)),  # 向上取整
                    "days_left": round(stock / daily, 1) if daily else None,
                }
            )

    orders.sort(key=lambda o: (o["days_left"] if o["days_left"] is not None else 9e9))
    print(
        json.dumps(
            {
                "ok": True,
                "lead_days": lead,
                "safety_factor": factor,
                "count": len(orders),
                "orders": orders,
                "summary": f"需补货 {len(orders)} 个 SKU（提前期 {lead} 天）",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
