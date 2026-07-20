/**
 * 「繼續看譜」的續看狀態暫存。
 *
 * 使用者按下訊息上的按鈕時（bot.js）記下他要回到的區間，
 * Activity 啟動並驗證身分後再來取（activity-server.js 的 /api/resume）。
 * 之所以要繞這一圈，是因為 Discord 的 launchActivity() 沒辦法夾帶參數。
 *
 * key = userId —— 同一個人以最後一次點的按鈕為準。
 */
const resumeSessions = new Map();
// 按下按鈕到 Activity 開起來只需要幾秒；設短一點，避免放太久的紀錄
// 在之後某次「一般開啟」時被誤用，害兩個端點沒有停在最兩側。
const RESUME_TTL_MS = 2 * 60 * 1000; // 2 分鐘沒去取就作廢

export function saveResumeSession(userId, data) {
    resumeSessions.set(userId, { ...data, savedAt: Date.now() });
}

/** 取出並清掉（一次性），順便清理過期的項目 */
export function takeResumeSession(userId) {
    const now = Date.now();
    for (const [k, v] of resumeSessions) {
        if (now - v.savedAt > RESUME_TTL_MS) resumeSessions.delete(k);
    }
    const found = resumeSessions.get(userId);
    if (!found) return null;
    resumeSessions.delete(userId);
    return found;
}
