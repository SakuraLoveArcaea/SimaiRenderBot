import {
    ApplicationCommandType, ContextMenuCommandBuilder, REST, Routes, SlashCommandBuilder,
} from 'discord.js';

try { process.loadEnvFile(new URL('../.env', import.meta.url).pathname); } catch { }

const token = process.env.DISCORD_TOKEN;
const appId = process.env.DISCORD_APP_ID;
if (!token || !appId) {
    console.error('請先在 .env 設定 DISCORD_TOKEN 與 DISCORD_APP_ID');
    process.exit(1);
}

export const commands = [
    new SlashCommandBuilder()
        .setName('render')
        .setDescription('把 simai 語法片段渲染成譜面預覽 GIF')
        .addStringOption((o) => o
            .setName('simai')
            .setDescription('simai 語法，例如 (150){4}1,2,3,4,E')
            .setRequired(true))
        .addNumberOption((o) => o
            .setName('start')
            .setDescription('開始秒數（預設 0）')
            .setMinValue(0))
        .addNumberOption((o) => o
            .setName('end')
            .setDescription('結束秒數（預設到譜面結尾）')
            .setMinValue(0))
        .addIntegerOption((o) => o
            .setName('fps')
            .setDescription('渲染 FPS（預設 30）')
            .addChoices(
                { name: '30（流暢）', value: 30 },
                { name: '24', value: 24 },
                { name: '15（省空間）', value: 15 },
            )),
    new SlashCommandBuilder()
        .setName('compose')
        .setDescription('跳出多行輸入視窗，整理成可複製的 simai 區塊，並可直接渲染'),
    new SlashCommandBuilder()
        .setName('check')
        .setDescription('檢查 simai 語法（只解析不渲染，回報錯誤與 note 統計）')
        .addStringOption((o) => o
            .setName('simai')
            .setDescription('simai 語法片段')
            .setRequired(true)),
    // 互動鍵盤（開發中，隱藏）：.env 設 ENABLE_KEYBOARD=1 後重新 npm run register 即可開啟
    ...(process.env.ENABLE_KEYBOARD === '1' ? [
        new SlashCommandBuilder()
            .setName('keyboard')
            .setDescription('開啟互動鍵盤，用按鈕點出 simai 譜面'),
    ] : []),
    // 文字頻道啟動 Activity（傳統斜線指令，在 guild 註冊可即時生效）
    ...(process.env.ENABLE_ACTIVITY === '1' ? [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('在文字頻道啟動互動 Activity 頁面')
            .addStringOption((o) => o
                .setName('chart')
                .setDescription('指定要開啟的曲目（可輸入關鍵字搜尋）')
                .setAutocomplete(true)
                .setRequired(false))
            .addStringOption((o) => o
                .setName('difficulty')
                .setDescription('譜面難度（預設 MASTER）')
                .setRequired(false)
                .addChoices(
                    { name: 'MASTER（預設）', value: 'master' },
                    { name: 'Re:MASTER', value: 're_master' },
                    { name: 'EXPERT', value: 'expert' },
                    { name: 'ADVANCED', value: 'advanced' },
                    { name: 'BASIC', value: 'basic' },
                    { name: '宴 (Utage)', value: 'utage' },
                )),
    ] : []),
    // 右鍵訊息 → Apps → 渲染譜面：抓訊息裡的 ```simai code block 來渲染
    new ContextMenuCommandBuilder()
        .setName('渲染譜面')
        .setType(ApplicationCommandType.Message),
].map((c) => c.toJSON());

// /activity（暫定名字，之後會改）：Primary Entry Point 指令，沒有 builder 支援，直接寫 raw JSON。
// handler = DiscordLaunchActivity：Discord 收到指令會直接幫忙開啟 Activity，我們的 bot 完全不會收到這次 interaction。
if (process.env.ENABLE_ACTIVITY === '1') {
    commands.push({
        type: ApplicationCommandType.PrimaryEntryPoint,
        name: 'activity',
        description: '（測試用）開啟互動頁面',
        handler: 2, // EntryPointCommandHandlerType.DiscordLaunchActivity
    });
}

const rest = new REST().setToken(token);
// 可填單一 ID 或用逗號分隔多個 ID，例如 111,222
const guildIds = (process.env.DISCORD_GUILD_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// PRIMARY_ENTRY_POINT（/activity）Discord 規定只能全域註冊，不能跟著 guild 指令一起 PUT 進 guild endpoint。
const entryPointCommands = commands.filter((c) => c.type === ApplicationCommandType.PrimaryEntryPoint);
const guildCommands = commands.filter((c) => c.type !== ApplicationCommandType.PrimaryEntryPoint);

if (guildIds.length) {
    // 測試用／指定伺服器：一般指令只在列出的伺服器註冊（即時生效）
    for (const guildId of guildIds) {
        await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: guildCommands });
        console.log(`已註冊 ${guildCommands.length} 個指令到伺服器 ${guildId}`);
    }
    if (entryPointCommands.length) {
        // 規定只能全域，跟 guild 指令的即時生效脫鉤，可能要等一段時間才在 Discord 用戶端出現
        await rest.put(Routes.applicationCommands(appId), { body: entryPointCommands });
        console.log(`已全域註冊 ${entryPointCommands.length} 個 Entry Point 指令（PRIMARY_ENTRY_POINT 規定只能全域，不受 GUILD_ID 限制，生效可能較慢）`);
    }
} else {
    // 正式：全域註冊（最多等 1 小時生效）
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log(`已全域註冊 ${commands.length} 個指令`);
}
