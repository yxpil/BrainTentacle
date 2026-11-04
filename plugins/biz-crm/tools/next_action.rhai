// 从跟进纪要里挑下一步：Rhai 沙盒脚本，只用宿主内置函数与字符串方法。
// 这个 Rhai 构建不认三元写法 `a ? b : c`（实测 Unknown operator: '?'），条件取值一律用 if 表达式。
let note = if params.note == () { "" } else { params.note };
if note.len() == 0 {
    #{"ok": false, "error": "纪要为空"}
} else {
    let hits = [];
    let words = ["回", "报价", "签约", "上门", "试用", "退款", "发票", "对账", "下周", "明天"];
    for w in words {
        if note.contains(w) {
            hits.push(w);
        }
    }
    let grade = "B";
    if note.contains("急") || note.contains("签约") {
        grade = "A";
    } else if note.contains("随便看看") || note.contains("再说") {
        grade = "C";
    }
    let next = if grade == "A" {
        "今天之内回复"
    } else if grade == "C" {
        "放进周会清单"
    } else {
        "三天内跟进"
    };
    #{"ok": true, "grade": grade, "signals": hits, "next": next, "length": note.len()}
}
