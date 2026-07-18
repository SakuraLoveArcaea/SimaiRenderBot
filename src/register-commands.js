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
    // 右鍵訊息 → Apps → 渲染譜面：抓訊息裡的 ```simai code block 來渲染
    new ContextMenuCommandBuilder()
        .setName('渲染譜面')
        .setType(ApplicationCommandType.Message),
].map((c) => c.toJSON());

const rest = new REST().setToken(token);
const guildId = process.env.DISCORD_GUILD_ID;

if (guildId) {
    // 測試用：註冊到單一伺服器（即時生效）
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    console.log(`已註冊 ${commands.length} 個指令到伺服器 ${guildId}`);
} else {
    // 正式：全域註冊（最多等 1 小時生效）
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log(`已全域註冊 ${commands.length} 個指令`);
}
