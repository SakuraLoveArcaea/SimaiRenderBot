import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder,
    GatewayIntentBits, MessageFlags, ModalBuilder, Partials, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { SimaiRenderService } from './render.js';
import { KB_PREFIX, handleKeyboardCommand, handleKeyboardComponent } from './keyboard.js';

try { process.loadEnvFile(new URL('../.env', import.meta.url).pathname); } catch { }

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('請先在 .env 設定 DISCORD_TOKEN');
    process.exit(1);
}

const MAX_DURATION = Number(process.env.MAX_DURATION ?? 30); // 最長渲染秒數
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 10000); // 每人冷卻
const REACT_EMOJI = '🎬';

const cooldowns = new Map();
const renderedMessages = new Set(); // 🎬 反應流程：同一則訊息只渲染一次
const composeDrafts = new Map(); // /compose 暫存草稿：userId -> { text, createdAt }
const COMPOSE_TTL_MS = 10 * 60 * 1000;
const COMPOSE_MODAL_ID = 'compose:modal';
const COMPOSE_RENDER_BTN = 'compose:render';

const service = new SimaiRenderService();
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,        // 自動偵測 ```simai 需要（Portal 要開 Message Content Intent）
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.Channel], // 重啟後舊訊息的反應也收得到
});

client.once('clientReady', () => {
    console.log(`已登入：${client.user.tag}`);
});

// ============================================================
// 入口 1：/render、/check、右鍵選單「渲染譜面」
// ============================================================
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'check') return await handleCheck(interaction);
            if (interaction.commandName === 'render') return await handleSlashRender(interaction);
            if (interaction.commandName === 'keyboard') return await handleKeyboardCommand(interaction);
            if (interaction.commandName === 'compose') return await handleComposeCommand(interaction);
        }
        if (interaction.isMessageContextMenuCommand() && interaction.commandName === '渲染譜面') {
            return await handleContextRender(interaction);
        }
        if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
            && interaction.customId?.startsWith(KB_PREFIX)) {
            return await handleKeyboardComponent(interaction, { buildRenderPayload, checkCooldown, friendlyError });
        }
        if (interaction.isModalSubmit() && interaction.customId === COMPOSE_MODAL_ID) {
            return await handleComposeModalSubmit(interaction);
        }
        if (interaction.isButton() && interaction.customId === COMPOSE_RENDER_BTN) {
            return await handleComposeRenderButton(interaction);
        }
    } catch (e) {
        console.error(e);
        const msg = friendlyError(e);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: msg }).catch(() => { });
        } else {
            await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => { });
        }
    }
});

// ============================================================
// 入口 2：訊息含 ```simai 區塊 → 加 🎬，有人點了才渲染（避免洗版）
// ============================================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const block = extractSimai(message.content);
    if (block?.tagged) {
        await message.react(REACT_EMOJI).catch(() => { });
    }
});

client.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot) return;
        if (reaction.partial) reaction = await reaction.fetch();
        if (reaction.emoji.name !== REACT_EMOJI) return;
        if (!reaction.me) return; // 只處理 bot 主動掛上 🎬 的訊息

        const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
        if (renderedMessages.has(message.id)) return;

        const block = extractSimai(message.content);
        if (!block?.tagged) return;

        const remain = checkCooldown(user.id);
        if (remain > 0) return; // 反應流程沒有回話餘地，冷卻中就靜默忽略

        renderedMessages.add(message.id);
        if (renderedMessages.size > 500) renderedMessages.clear();

        const placeholder = await message.reply('✅ 已收到，準備渲染…');
        try {
            await placeholder.edit(`${REACT_EMOJI} 正在渲染中，請稍候…`);
            const payload = await buildRenderPayload(block.text, {}, `由 ${user.displayName ?? user.username} 觸發`);
            await placeholder.edit({ content: null, ...payload });
        } catch (e) {
            console.error(e);
            renderedMessages.delete(message.id); // 失敗允許重試
            await placeholder.edit({ content: friendlyError(e) }).catch(() => { });
        }
    } catch (e) {
        console.error('messageReactionAdd 失敗:', e);
    }
});

// ============================================================
// 指令處理
// ============================================================
async function handleCheck(interaction) {
    const simai = stripCodeFence(interaction.options.getString('simai', true));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const info = await service.inspect(simai);
    const embed = new EmbedBuilder()
        .setTitle('📋 simai 語法檢查')
        .setColor(info.warns?.length ? 0xE6A23C : 0x67C23A)
        .addFields(
            { name: '長度', value: `${info.endTime.toFixed(2)} 秒`, inline: true },
            { name: 'BPM', value: String(info.bpm ?? '—'), inline: true },
            { name: 'Notes', value: formatCounts(info.noteCounts), inline: true },
        );
    addWarnField(embed, simai, info.warns, info.warnpos);
    await interaction.editReply({ embeds: [embed] });
}

async function handleSlashRender(interaction) {
    const simai = stripCodeFence(interaction.options.getString('simai', true));
    const start = interaction.options.getNumber('start') ?? 0;
    const end = interaction.options.getNumber('end');
    const fps = interaction.options.getInteger('fps') ?? 30;

    const remain = checkCooldown(interaction.user.id);
    if (remain > 0) {
        return interaction.reply({
            content: `⏳ 冷卻中，請 ${Math.ceil(remain / 1000)} 秒後再試`,
            flags: MessageFlags.Ephemeral,
        });
    }

    await runInteractionRender(interaction, simai, { start, end, fps });
}

async function handleContextRender(interaction) {
    const block = extractSimai(interaction.targetMessage?.content ?? '');
    if (!block) {
        return interaction.reply({
            content: '❌ 這則訊息裡找不到 code block。請把 simai 語法用 \\`\\`\\` 包起來（建議標記語言為 `simai`）',
            flags: MessageFlags.Ephemeral,
        });
    }

    const remain = checkCooldown(interaction.user.id);
    if (remain > 0) {
        return interaction.reply({
            content: `⏳ 冷卻中，請 ${Math.ceil(remain / 1000)} 秒後再試`,
            flags: MessageFlags.Ephemeral,
        });
    }

    await runInteractionRender(interaction, block.text, {}, `來源：${interaction.targetMessage.url}`);
}

// ============================================================
// 共用：渲染 → { embeds, files }
// ============================================================
async function buildRenderPayload(simaiText, opts = {}, footerExtra = '') {
    const info = await service.inspect(simaiText);
    if (info.endTime <= 0) throw new Error('EMPTY_CHART');

    const t0 = Date.now();
    const result = await service.renderGif(simaiText, { maxDuration: MAX_DURATION, ...opts });
    const renderSec = ((Date.now() - t0) / 1000).toFixed(1);

    const file = new AttachmentBuilder(result.gif, { name: 'chart.gif' });
    const footer = [
        `渲染 ${renderSec}s ・ ${(result.gif.length / 1e6).toFixed(2)}MB ・ ${result.quality.width}px@${result.quality.fps}fps`,
        footerExtra,
    ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
        .setTitle('🎬 譜面預覽')
        .setColor(0x4A90E2)
        .addFields(
            { name: '長度', value: `${result.duration.toFixed(1)} 秒`, inline: true },
            { name: 'BPM', value: String(info.bpm ?? '—'), inline: true },
            { name: 'Notes', value: formatCounts(info.noteCounts), inline: true },
        )
        .setFooter({ text: footer })
        .setImage('attachment://chart.gif');

    addWarnField(embed, simaiText, result.warns, result.warnpos);
    return { embeds: [embed], files: [file] }; // 影片訊息本身不附 simai 文字（要文字用 /compose）
}

/** 已收到 → 正在渲染 → 結果，套用在所有互動式渲染入口 */
async function runInteractionRender(interaction, simaiText, opts = {}, footerExtra = '') {
    await interaction.deferReply();
    await interaction.editReply({ content: '✅ 已收到，準備渲染…' });
    try {
        await interaction.editReply({ content: '🎬 正在渲染中，請稍候…' });
        const payload = await buildRenderPayload(simaiText, opts, footerExtra);
        await interaction.editReply({ content: null, ...payload });
    } catch (e) {
        console.error(e);
        await interaction.editReply({ content: friendlyError(e) }).catch(() => { });
    }
}

/** 包成 ```simai``` 區塊：方便複製貼到編輯器繼續編輯，貼回頻道也能再觸發 🎬 自動偵測 */
function fenceSimai(simaiText) {
    return '```simai\n' + clip(simaiText, 1900) + '\n```';
}

// ============================================================
// /compose：跳出多行輸入視窗，整理成可複製的 ```simai``` 區塊
// ============================================================
async function handleComposeCommand(interaction) {
    const draft = composeDrafts.get(interaction.user.id);
    const modal = new ModalBuilder()
        .setCustomId(COMPOSE_MODAL_ID)
        .setTitle('輸入 simai 語法')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('text')
                    .setLabel('simai 語法（可貼多行）')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('(150){4}\n1,2,3,4,E')
                    .setMaxLength(3900)
                    .setRequired(true)
                    .setValue(isFresh(draft) ? draft.text : ''),
            ),
        );
    await interaction.showModal(modal);
}

async function handleComposeModalSubmit(interaction) {
    const text = stripCodeFence(interaction.fields.getTextInputValue('text')).trim();
    if (!text) {
        return interaction.reply({ content: '❌ 內容是空的', flags: MessageFlags.Ephemeral });
    }

    composeDrafts.set(interaction.user.id, { text, createdAt: Date.now() });

    const renderBtn = new ButtonBuilder()
        .setCustomId(COMPOSE_RENDER_BTN)
        .setLabel('🎬 渲染這份')
        .setStyle(ButtonStyle.Primary);

    await interaction.reply({
        content: fenceSimai(text),
        components: [new ActionRowBuilder().addComponents(renderBtn)],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleComposeRenderButton(interaction) {
    const draft = composeDrafts.get(interaction.user.id);
    if (!isFresh(draft)) {
        return interaction.reply({ content: '⌛ 草稿已過期，請重新 `/compose`', flags: MessageFlags.Ephemeral });
    }

    const remain = checkCooldown(interaction.user.id);
    if (remain > 0) {
        return interaction.reply({
            content: `⏳ 冷卻中，請 ${Math.ceil(remain / 1000)} 秒後再試`,
            flags: MessageFlags.Ephemeral,
        });
    }

    await runInteractionRender(interaction, draft.text);
}

function isFresh(draft) {
    return !!draft && Date.now() - draft.createdAt <= COMPOSE_TTL_MS;
}

// ============================================================
// code block 解析
// ============================================================

/**
 * 從訊息內容抓 simai 片段。
 * 優先順序：```simai 標記的區塊 → 第一個無標記/其他標記的區塊。
 * 回傳 { text, tagged }；tagged = 是否為明確的 ```simai 區塊。
 */
function extractSimai(content) {
    if (!content) return null;
    const blocks = [...content.matchAll(/```(\w*)\n?([\s\S]*?)```/g)]
        .map((m) => ({ lang: m[1].toLowerCase(), text: m[2].trim() }))
        .filter((b) => b.text.length > 0);
    if (!blocks.length) return null;
    const simaiBlock = blocks.find((b) => b.lang === 'simai');
    if (simaiBlock) return { text: simaiBlock.text, tagged: true };
    return { text: blocks[0].text, tagged: false };
}

/** slash 選項裡若手滑貼了含 ``` 的內容，也幫忙剝掉 */
function stripCodeFence(s) {
    const block = extractSimai(s);
    return block ? block.text : s;
}

// ============================================================
// 錯誤位置標記：用 code block + ^^^ 指出出錯的逗號段
// ============================================================
function buildWarnBlock(simaiText, warns, warnpos) {
    if (!warns?.length) return null;

    // 重現 decode.js 的前處理，讓 warnpos（逗號索引）對得上
    const parts = simaiText.replace(/\|\|.*$/gm, '').replace(/\s+/g, '').split(',');

    const snippets = [...new Set(warnpos ?? [])].slice(0, 3).map((pos) => {
        if (pos < 0 || pos >= parts.length) return null;
        const from = Math.max(0, pos - 2);
        const to = Math.min(parts.length - 1, pos + 2);
        const before = (from > 0 ? '…' : '') + parts.slice(from, pos).join(',');
        const target = parts[pos] || '(空)';
        const after = parts.slice(pos + 1, to + 1).join(',') + (to < parts.length - 1 ? '…' : '');

        const line = [before, target].filter(Boolean).join(',') + (after ? ',' + after : '');
        const pad = ' '.repeat(before.length + (before ? 1 : 0));
        return `${line}\n${pad}${'^'.repeat(Math.max(1, target.length))}`;
    }).filter(Boolean);

    const body = [...snippets, ...warns.slice(0, 5)].join('\n');
    return '```\n' + clip(body, 950) + '\n```';
}

function addWarnField(embed, simaiText, warns, warnpos) {
    const block = buildWarnBlock(simaiText, warns, warnpos);
    if (block) embed.addFields({ name: '⚠️ 警告', value: block });
}

// ============================================================
// 雜項
// ============================================================
function checkCooldown(userId) {
    const last = cooldowns.get(userId) ?? 0;
    const remain = last + COOLDOWN_MS - Date.now();
    if (remain > 0) return remain;
    cooldowns.set(userId, Date.now());
    return 0;
}

function formatCounts(c) {
    if (!c) return '—';
    return `tap ${c.tap} / hold ${c.hold} / slide ${c.slide} / touch ${c.touch} / break ${c.break}`;
}

function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function friendlyError(e) {
    const m = String(e?.message ?? e);
    if (m.includes('EMPTY_CHART')) return '❌ 解析後沒有任何 note，請檢查 simai 語法（可先用 `/check` 檢查）';
    if (m.includes('BAD_RANGE')) return '❌ 結束時間需大於開始時間';
    if (m.includes('GIF_TOO_LARGE')) return '❌ GIF 超過 Discord 上傳上限，請用 `start` / `end` 縮短範圍';
    return `❌ 渲染失敗：${clip(m, 300)}`;
}

await service.init();
console.log('渲染服務就緒');
await client.login(token);

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        await service.dispose().catch(() => { });
        client.destroy();
        process.exit(0);
    });
}
