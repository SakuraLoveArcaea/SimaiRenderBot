import crypto from 'crypto';

/**
 * 「繼續看譜」的續看狀態暫存。
 *
 * 1. 產生渲染按鈕時（activity-server.js）：呼叫 createResumeToken 產生短 token（8 字元）存下曲目與區間。
 *    解決 Discord customId 長度不可超過 100 字元的限制（長曲名不會爆掉）。
 * 2. 使用者按下訊息上的按鈕時（bot.js）：透過 getResumeToken 取出資訊並存入特定 userId 的 Session。
 * 3. Activity 啟動並驗證身分後（activity-server.js 的 /api/resume）：取出並自動還原該曲目與區間。
 */

// 短 token 儲存（所有人都可以點同一個按鈕，因此不立即銷毀）
const tokenStore = new Map();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 小時過期

// 用戶 Session 儲存（以 userId 為 key，Activity 啟動後取一次即清掉）
const resumeSessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 分鐘沒開啟 Activity 則作廢

export function createResumeToken(data) {
    const now = Date.now();
    // 週期性清理過期 token
    if (tokenStore.size > 200) {
        for (const [k, v] of tokenStore) {
            if (now - v.createdAt > TOKEN_TTL_MS) tokenStore.delete(k);
        }
    }
    const tokenId = crypto.randomBytes(4).toString('hex'); // 8 碼十六進位字串
    tokenStore.set(tokenId, { ...data, createdAt: now });
    return tokenId;
}

export function getResumeToken(tokenId) {
    const found = tokenStore.get(tokenId);
    if (!found) return null;
    if (Date.now() - found.createdAt > TOKEN_TTL_MS) {
        tokenStore.delete(tokenId);
        return null;
    }
    return found;
}

export function saveResumeSession(userId, data) {
    resumeSessions.set(userId, { ...data, savedAt: Date.now() });
}

/** 取出並清掉（一次性），順便清理過期的項目 */
export function takeResumeSession(userId) {
    const now = Date.now();
    for (const [k, v] of resumeSessions) {
        if (now - v.savedAt > SESSION_TTL_MS) resumeSessions.delete(k);
    }
    const found = resumeSessions.get(userId);
    if (!found) return null;
    resumeSessions.delete(userId);
    return found;
}
