/**
 * 純函式：simai 逗號切割與裁切工具。不依賴 Node 或瀏覽器 API，
 * 後端（src/chart.js）跟前端（activity/main.js，用來在送出前產生預覽文字）
 * 共用同一份，確保兩邊切出來的結果保證一致。
 */

/**
 * 前處理＋依逗號切開，順序跟 decode.js 一致，逗號索引才對得上 indexToTime。
 */
export function splitCommaParts(simaiText) {
    return simaiText.replace(/\|\|.*$/gm, '').replace(/\s+/g, '').split(',');
}

/**
 * 取 [start, end) 秒範圍對應的 simai 原文片段（依逗號段切）。
 * indexToTime[i] = 第 i 個逗號段的起始時間，最後多一格是譜面結尾。
 */
export function sliceSource(simaiText, indexToTime, start, end) {
    const parts = splitCommaParts(simaiText);
    let i0 = 0;
    let i1 = parts.length - 1;
    for (let i = 0; i < parts.length; i++) {
        const segStart = indexToTime[i] ?? 0;
        const segEnd = indexToTime[i + 1] ?? segStart;
        if (segEnd <= start) i0 = Math.min(i + 1, parts.length - 1);
        if (segStart < end) i1 = i;
    }
    return parts.slice(i0, i1 + 1).join(',');
}

/**
 * 檢查 simai 開頭有沒有 BPM `(150)` 與分音 `{4}`（可以有多組、順序不拘）。
 */
export function analyzeHeader(simaiText) {
    let s = (simaiText ?? '').replace(/\|\|.*$/gm, '').replace(/\s+/g, '');
    let hasBpm = false, hasSplit = false, m;
    while ((m = s.match(/^\([^()]*\)/)) || (m = s.match(/^\{[^{}]*\}/))) {
        if (m[0][0] === '(') hasBpm = true; else hasSplit = true;
        s = s.slice(m[0].length);
    }
    return { hasBpm, hasSplit };
}

/**
 * 「切的乾淨」：把選取範圍切成一段可以獨立渲染的 simai。
 *
 * 直接依 combo 對應的時間切原始碼（切到 hold／slide 中間也照切），
 * 再把切點當下生效的 BPM 與分音補回開頭——不然片段拿掉前面的
 * `(238)` `{4}` 之後會解析失敗或速度全錯。
 *
 * @param {string} simaiText 完整譜面原文
 * @param {{indexToTime:number[], tags:{type:string,value:number,time:number}[]}} info 逗號段時間軸與 BPM/分音標籤
 */
export function buildCleanCutSimai(simaiText, info, start, end) {
    const body = sliceSource(simaiText, info.indexToTime ?? [], start, end);

    // 找出切點當下（time <= start）最後一次生效的值
    const valueAt = (type) => {
        let v = null;
        for (const t of info.tags ?? []) {
            if (t.type === type && t.time <= start + 1e-6) v = t.value;
        }
        return v;
    };

    const { hasBpm, hasSplit } = analyzeHeader(body);
    let header = '';
    if (!hasBpm) {
        const bpm = valueAt('bpm') ?? info.bpm;
        if (bpm) header += `(${bpm})`;
    }
    if (!hasSplit) {
        const split = valueAt('split');
        if (split) header += `{${split}}`;
    }
    return header + body;
}
