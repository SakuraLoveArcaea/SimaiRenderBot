import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder,
    GatewayIntentBits, MessageFlags, ModalBuilder, Partials, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { SimaiRenderService } from './render.js';
import { KB_PREFIX, handleKeyboardCommand, handleKeyboardComponent } from './keyboard.js';
import { loadChart, sliceSource, analyzeHeader } from './chart.js';
import { startActivityServer, RESUME_BTN_PREFIX } from './activity-server.js';
import { saveResumeSession } from './resume.js';

try { process.loadEnvFile(new URL('../.env', import.meta.url).pathname); } catch { }

const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('請先在 .env 設定 DISCORD_TOKEN');
    process.exit(1);
}

const MAX_DURATION = Number(process.env.MAX_DURATION ?? 30); // 譜面最長渲染秒數（超過的部分不畫）
const MAX_RENDER_MS = Number(process.env.MAX_RENDER_SEC ?? 30) * 1000; // 預估渲染耗時上限：超過就拒絕，不讓使用者空等
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 10000); // 每人冷卻
const REACT_EMOJI = '🎬';
const ECHO_CHANNEL_ID = '1527650013981966450'; // 額外功能：這個頻道當復讀機，其他頻道不受影響

const cooldowns = new Map();
const renderedMessages = new Set(); // 🎬 反應流程：同一則訊息只渲染一次
const composeDrafts = new Map(); // /compose 暫存草稿：userId -> { text, createdAt }
const COMPOSE_TTL_MS = 10 * 60 * 1000;
const COMPOSE_MODAL_ID = 'compose:modal';
const COMPOSE_RENDER_BTN = 'compose:render';

/**
 * 每次開 Modal 都給一個獨一無二的 custom_id（附加 nonce）。
 * Discord 客戶端會用 modal 的 custom_id 快取使用者上次輸入的內容，重開同 id 的表單時
 * 就算 setValue('') 也會被無視、把舊值塞回來（殘留）。換個 id ＝ 全新表單，天然清空。
 * 提交時的路由改用 startsWith 前綴比對。
 */
function freshModalId(base) {
    return `${base}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

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
            if (interaction.commandName === 'testchart') return await handleChartCommand(interaction);
            if (interaction.commandName === 'play') return await interaction.launchActivity();
        }
        if (interaction.isMessageContextMenuCommand() && interaction.commandName === '渲染譜面') {
            return await handleContextRender(interaction);
        }
        if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
            && interaction.customId?.startsWith(KB_PREFIX)) {
            return await handleKeyboardComponent(interaction, { buildRenderPayload, checkCooldown, friendlyError });
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith(FIX_HEADER_MODAL_ID)) {
            return await handleFixHeaderModalSubmit(interaction);
        }
        if (interaction.isModalSubmit() && interaction.customId.startsWith(COMPOSE_MODAL_ID)) {
            return await handleComposeModalSubmit(interaction);
        }
        if (interaction.isButton() && interaction.customId === COMPOSE_RENDER_BTN) {
            return await handleComposeRenderButton(interaction);
        }
        if (interaction.isButton() && interaction.customId === CHART_RENDER_BTN) {
            return await handleChartRenderButton(interaction);
        }
        if (interaction.isButton() && interaction.customId === CHART_CANCEL_BTN) {
            return await handleChartCancelButton(interaction);
        }
        if (interaction.isButton() && interaction.customId.startsWith(FIX_HEADER_PREFIX)) {
            return await handleFixHeaderButton(interaction);
        }
        if (interaction.isButton() && interaction.customId.startsWith(RESUME_BTN_PREFIX)) {
            return await handleResumeButton(interaction);
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

    // 額外功能：指定頻道當復讀機，原樣重複訊息內容，不做 simai 偵測
    if (message.channelId === ECHO_CHANNEL_ID) {
        if (message.content) await message.channel.send(message.content).catch(() => { });
        return;
    }

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

        if (!hasLeadingHeader(block.text)) {
            await message.reply(missingHeaderReply(user.id, block.text)).catch(() => { });
            return; // 沒消耗冷卻、沒標記為已渲染，補上後可以再點一次 🎬
        }

        const est = await estimateRender(block.text);
        if (est && est.etaMs > MAX_RENDER_MS) {
            await message.reply(tooHeavyMessage(est.etaSec)).catch(() => { });
            return; // 沒消耗冷卻、沒標記為已渲染
        }

        const remain = checkCooldown(user.id);
        if (remain > 0) return; // 反應流程沒有回話餘地，冷卻中就靜默忽略

        renderedMessages.add(message.id);
        if (renderedMessages.size > 500) renderedMessages.clear();

        const placeholder = await message.reply('✅ 已收到，準備渲染…');
        try {
            const status = est ? `正在渲染中，預估約 ${est.etaSec} 秒，請稍候…` : '正在渲染中，請稍候…';
            await placeholder.edit(`${REACT_EMOJI} ${status}`);
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
    if (!hasLeadingHeader(simai)) {
        return interaction.reply({ ...missingHeaderReply(interaction.user.id, simai), flags: MessageFlags.Ephemeral });
    }
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
    const raw = interaction.targetMessage?.content ?? '';
    // 有 code block 就優先抽出來用；沒有就直接吃整則訊息內容（不強制包 ```）。
    const block = extractSimai(raw);
    const simai = (block ? block.text : raw).trim();

    if (!simai) {
        return interaction.reply({
            content: '❌ 這則訊息是空的，沒有可渲染的內容',
            flags: MessageFlags.Ephemeral,
        });
    }
    // 一點點防呆：非 code block 的純文字若完全不含音符/節奏字元，多半是聊天內容，不硬送進渲染。
    // （明確包成 code block 的內容視為使用者確定要渲染，跳過這關；真的是譜面卻缺開頭，後面 header 檢查會接手。）
    if (!block && !looksLikeSimai(simai)) {
        return interaction.reply({
            content: '❌ 看起來不像 simai 語法。若確定要渲染，請把譜面用 \\`\\`\\` 包成 code block 再試',
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

    // 最終結果以「回覆這則訊息」的形式發出（footer 不用再標來源，reply 本身就指著它）
    await runInteractionRender(interaction, simai, {}, '', interaction.targetMessage);
}

/** 極寬鬆的防呆：simai 片段必含音符位置（1–8）且有節奏逗號或開頭括號其一 */
function looksLikeSimai(text) {
    return /[1-8]/.test(text) && /[,({]/.test(text);
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
            { name: '長度', value: `${result.duration.toFixed(3)} 秒`, inline: true },
            { name: 'BPM', value: String(info.bpm ?? '—'), inline: true },
            { name: 'Notes', value: formatCounts(info.noteCounts), inline: true },
        )
        .setFooter({ text: footer })
        .setImage('attachment://chart.gif');

    addWarnField(embed, simaiText, result.warns, result.warnpos);
    return { embeds: [embed], files: [file] }; // 影片訊息本身不附 simai 文字（要文字用 /compose）
}

/**
 * 共用渲染流程（狀態機）：已收到 → 正在渲染 → 結果。
 *
 * 兩軸模型：
 *   控制面（跟操作者對話的訊息）——
 *     - 公開：/render 的 deferReply；結果就地替換自己（見 emitResult）。
 *     - ephemeral：右鍵選單、按鈕入口；只有本人看得到，不能當公開結果，成功後自刪。
 *   結果去向（只有 ephemeral 控制面才需決定，由 emitResult 收斂）——
 *     回覆來源訊息 / 孤兒公開 @使用者。
 *
 * ephemeral = 有來源訊息（右鍵）或從按鈕進來。
 */
async function runInteractionRender(interaction, simaiText, opts = {}, footerExtra = '', replyToMessage = null, fromButton = false) {
    if (!hasLeadingHeader(simaiText)) {
        // 缺開頭時把來源訊息一併記進草稿，讓補完後的「渲染這份」還能回覆到它
        return interaction.reply({ ...missingHeaderReply(interaction.user.id, simaiText, replyToMessage), flags: MessageFlags.Ephemeral });
    }
    const est = await estimateRender(simaiText, opts);
    if (est && est.etaMs > MAX_RENDER_MS) {
        return interaction.reply({ content: tooHeavyMessage(est.etaSec), flags: MessageFlags.Ephemeral });
    }

    const ephemeral = fromButton || !!replyToMessage;
    if (fromButton) {
        // 從按鈕進來：就地把帶按鈕的 ephemeral 訊息轉成狀態、移除按鈕
        await interaction.update({ content: '✅ 已收到，準備渲染…', embeds: [], files: [], components: [] });
    } else {
        await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
        await interaction.editReply({ content: '✅ 已收到，準備渲染…' });
    }
    try {
        const status = est ? `正在渲染中，預估約 ${est.etaSec} 秒，請稍候…` : '正在渲染中，請稍候…';
        await interaction.editReply({ content: `🎬 ${status}` });
        const payload = await buildRenderPayload(simaiText, opts, footerExtra);
        await emitResult(interaction, payload, { ephemeral, source: replyToMessage });
    } catch (e) {
        console.error(e);
        await interaction.editReply({ content: friendlyError(e) }).catch(() => { });
    }
}

/**
 * 把渲染結果送到正確去向並收掉控制面。三種 sink：
 *   替換自身：控制面是公開的（/render）→ 就地 editReply 成結果。
 *   回覆來源：控制面 ephemeral 且來源訊息存活 → 回覆它，刪掉 ephemeral 控制面。
 *   孤兒公開：控制面 ephemeral 且無來源（或來源已刪）→ @使用者公開貼出，刪掉 ephemeral 控制面。
 * 「來源被刪」是唯一降級：回覆失敗就落進孤兒公開，不另外報錯。
 */
async function emitResult(interaction, payload, { ephemeral, source }) {
    if (!ephemeral) {
        return interaction.editReply({ content: null, ...payload }); // 替換自身
    }
    if (source) {
        const replied = await source
            .reply({ ...payload, allowedMentions: { repliedUser: false } })
            .then(() => true, () => false);
        if (replied) return interaction.deleteReply().catch(() => { }); // 回覆來源
        // 來源已刪 → 落入孤兒公開
    }
    // 孤兒公開 + @使用者：用 channel.send 送「獨立」訊息（不是 followUp）。
    // followUp 會被當成回覆按鈕那則 ephemeral 訊息，等我們刪掉它就變成「回覆原始訊息已刪除」。
    const channel = interaction.channel
        ?? await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
    await channel?.send({
        content: `<@${interaction.user.id}>`,
        ...payload,
        allowedMentions: { users: [interaction.user.id] },
    }).catch(() => { });
    await interaction.deleteReply().catch(() => { });
}

/**
 * 估算渲染耗時：回傳 { etaMs, etaSec }；解析失敗回傳 null（不擋流程、不套上限）。
 * 有指定 start/end 時只估該範圍——音符數按時間比例粗估（inspect 沒有逐 note 時間，夠準了），
 * 不然渲染完整譜面的一小段也會被整份譜的估值誤擋。
 */
async function estimateRender(simaiText, opts = {}) {
    try {
        const info = await service.inspect(simaiText);
        const totalNotes = Object.values(info.noteCounts ?? {}).reduce((a, b) => a + b, 0);
        const start = Math.max(0, opts.start ?? 0);
        const end = Math.min(opts.end ?? info.endTime, info.endTime);
        const durationSec = Math.min(Math.max(end - start, 0), MAX_DURATION); // 對齊 renderGif 的截斷上限
        const frac = info.endTime > 0 ? durationSec / info.endTime : 1;
        const etaMs = service.estimateRenderMs(durationSec, Math.ceil(totalNotes * frac));
        return { etaMs, etaSec: Math.ceil(etaMs / 1000) };
    } catch {
        return null;
    }
}

function tooHeavyMessage(etaSec) {
    const limit = Math.round(MAX_RENDER_MS / 1000);
    return `❌ 這段譜面預估要渲染約 ${etaSec} 秒，超過上限 ${limit} 秒。請用 \`start\`／\`end\` 選一小段、或減少音符後再試。`;
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
        .setCustomId(freshModalId(COMPOSE_MODAL_ID))
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

    if (!hasLeadingHeader(text)) {
        return interaction.reply({ ...missingHeaderReply(interaction.user.id, text), flags: MessageFlags.Ephemeral });
    }

    composeDrafts.set(interaction.user.id, { text, createdAt: Date.now() }); // 存起來，重開 /compose 可以接著改
    await interaction.reply(composeSuccessPayload(text));
}

/** /compose 成功整理出 simai 文字後的回覆：可複製區塊 + 渲染按鈕 */
function composeSuccessPayload(text) {
    const renderBtn = new ButtonBuilder()
        .setCustomId(COMPOSE_RENDER_BTN)
        .setLabel('🎬 渲染這份')
        .setStyle(ButtonStyle.Primary);
    return {
        content: fenceSimai(text),
        components: [new ActionRowBuilder().addComponents(renderBtn)],
        flags: MessageFlags.Ephemeral,
    };
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

    // draft.source 只有右鍵「渲染譜面」的流程會帶：帶了就回覆原始 simai 訊息，否則公開發送
    await runInteractionRender(interaction, draft.text, {}, '', draft.source ?? null, true);
}

function isFresh(draft) {
    return !!draft && Date.now() - draft.createdAt <= COMPOSE_TTL_MS;
}

// ============================================================
// /testchart【測試用】：渲染 testChart 裡的內建譜面（模擬完整譜，之後上網抓取後
// 會演變成正式指令），可從指定 combo 開始播放；先讓玩家預覽要渲染的範圍，按了按鈕才真的渲染。
// ============================================================
const CHART_RENDER_BTN = 'chart:render';
const CHART_CANCEL_BTN = 'chart:cancel';
const CHART_LEAD_SEC = 1;          // 起點往前多帶一點，讓指定的 combo 是「掉下來」而不是憑空出現在判定線上
const CHART_DEFAULT_DURATION = 10; // 未指定長度時渲染的秒數
const chartJobs = new Map();       // userId -> { text, name, start, end, combo, createdAt }

async function handleChartCommand(interaction) {
    const combo = interaction.options.getInteger('combo') ?? 1;
    const count = interaction.options.getInteger('count');
    const duration = interaction.options.getNumber('duration');

    // 渲染長度二選一：count（combo 數）或 duration（秒數），都填就不知道該聽誰的
    if (count != null && duration != null) {
        return interaction.reply({
            content: '❌ `count`（combo 數）與 `duration`（秒數）只能擇一',
            flags: MessageFlags.Ephemeral,
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const chart = await loadChart();
    const info = await service.comboInfo(chart.text);
    const total = info.comboTimes.length;
    if (!total) {
        return interaction.editReply({ content: '❌ 譜面解析後沒有任何 note' });
    }
    if (combo > total) {
        return interaction.editReply({ content: `❌ 這份譜面總共 ${total} combo，沒有第 ${combo} 個` });
    }

    const noteTime = info.comboTimes[combo - 1];
    const start = Math.max(0, noteTime - CHART_LEAD_SEC);

    // 結束點：指定 combo 數就取最後那個 combo 的判定時間，否則按秒數；都受 MAX_DURATION 上限截斷
    const lastCombo = count != null ? Math.min(combo + count - 1, total) : null;
    let end = lastCombo != null
        ? info.comboTimes[lastCombo - 1]
        : start + (duration ?? CHART_DEFAULT_DURATION);
    const clamped = end - start > MAX_DURATION;
    end = Math.min(end, start + MAX_DURATION, info.endTime);
    if (end <= start) end = Math.min(start + 2, info.endTime); // count=1 之類的極短範圍給個保底長度

    // 預估只算範圍內的音符（comboTimes 已有逐 note 時間，不用比例粗估）
    const notesInRange = info.comboTimes.filter((t) => t >= start && t <= end).length;
    const etaMs = service.estimateRenderMs(end - start, notesInRange);
    const etaSec = Math.ceil(etaMs / 1000);

    const comboRange = lastCombo != null ? `#${combo} → #${lastCombo}（共 ${total}）` : `#${combo}（共 ${total}）`;
    const embed = new EmbedBuilder()
        .setTitle(`🗺️ 渲染範圍預覽：${chart.name}`)
        .setColor(0x9B59B6)
        .addFields(
            { name: 'combo 範圍', value: comboRange, inline: true },
            { name: '時間範圍', value: `${start.toFixed(3)}s → ${end.toFixed(3)}s${clamped ? `（超過 ${MAX_DURATION} 秒上限，已截斷）` : ''}`, inline: true },
            { name: '預估渲染', value: `約 ${etaSec} 秒`, inline: true },
            { name: '這段的譜面內容', value: '```\n' + clip(sliceSource(chart.text, info.indexToTime, start, end), 950) + '\n```' },
        )
        .setFooter({ text: `會從第 ${combo} 個 combo 前約 ${CHART_LEAD_SEC} 秒開始播放` });

    if (etaMs > MAX_RENDER_MS) {
        // 超過耗時上限就不給渲染按鈕，只留預覽讓玩家調整參數
        return interaction.editReply({
            content: `❌ 這段預估要渲染約 ${etaSec} 秒，超過上限 ${Math.round(MAX_RENDER_MS / 1000)} 秒，請把 \`duration\` 調小`,
            embeds: [embed],
        });
    }

    chartJobs.set(interaction.user.id, { text: chart.text, name: chart.name, start, end, combo, createdAt: Date.now() });
    await interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(CHART_RENDER_BTN).setLabel('🎬 渲染這段').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(CHART_CANCEL_BTN).setLabel('取消').setStyle(ButtonStyle.Secondary),
        )],
    });
}

async function handleChartRenderButton(interaction) {
    const job = chartJobs.get(interaction.user.id);
    if (!isFresh(job)) {
        return interaction.reply({ content: '⌛ 預覽已過期，請重新 `/testchart`', flags: MessageFlags.Ephemeral });
    }

    const remain = checkCooldown(interaction.user.id);
    if (remain > 0) {
        return interaction.reply({
            content: `⏳ 冷卻中，請 ${Math.ceil(remain / 1000)} 秒後再試`,
            flags: MessageFlags.Ephemeral,
        });
    }

    await runInteractionRender(
        interaction, job.text, { start: job.start, end: job.end },
        `${job.name}・從 combo #${job.combo} 開始`, null, true,
    );
}

async function handleChartCancelButton(interaction) {
    chartJobs.delete(interaction.user.id);
    await interaction.update({ content: '❌ 已取消', embeds: [], components: [] });
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
// 開頭必須有 (BPM){分拍}：沒寫的話 decode.js 會靜默套用 60bpm/{4} 預設值，
// 結果通常是錯的卻不會有任何警告，所以直接攔在渲染前請使用者補上重輸。
// ============================================================
const FIX_HEADER_PREFIX = 'compose:fixheader:';
const FIX_HEADER_MODAL_ID = 'compose:fixheader:modal';

/** 分別偵測開頭的 BPM `(N)` 與分拍 `{N}`（順序不拘，decode 兩種都吃）。 */
function hasLeadingHeader(simaiText) {
    const { hasBpm, hasSplit } = analyzeHeader(simaiText);
    return hasBpm && hasSplit;
}

function missingHeaderMessage(simaiText) {
    const { hasBpm, hasSplit } = analyzeHeader(simaiText);
    const missing = [!hasBpm && 'BPM `(150)`', !hasSplit && '分拍 `{4}`'].filter(Boolean).join(' 和 ');
    return `❌ 開頭缺少 ${missing}，要補在**最前面**。點下方按鈕填入。`;
}

/** 「✏️ 補上開頭」按鈕：customId 帶著發起者 id，點擊時只有本人能用 */
function missingHeaderComponents(userId) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(FIX_HEADER_PREFIX + userId).setLabel('✏️ 補上開頭').setStyle(ButtonStyle.Primary),
    )];
}

/**
 * 存草稿（讓表單能帶出原本內容）＋組出附按鈕的拒絕回覆。
 * source：觸發來源訊息（只有右鍵「渲染譜面」會帶）。一路存進草稿，讓最後「渲染這份」
 * 能回覆到原始 simai 訊息；/compose、/render、🎬 反應都不帶，最後就不回覆。
 */
function missingHeaderReply(userId, simaiText, source = null) {
    composeDrafts.set(userId, { text: simaiText, createdAt: Date.now(), source });
    return { content: missingHeaderMessage(simaiText), components: missingHeaderComponents(userId) };
}

/**
 * 點「▶ 繼續看譜」：把該片段的逗號區間記下來，然後開啟 Activity。
 * Discord 的 launchActivity() 不能夾帶參數，所以位置改走伺服器端暫存——
 * Activity 啟動、驗證完身分後會用自己的 user id 來 /api/resume 取回（見 activity-server.js）。
 * 任何人都能點（等於「我也想看這段」），各自的續看位置以 user id 分開存。
 */
async function handleResumeButton(interaction) {
    const [, startStr, endStr] = interaction.customId.split(':');
    saveResumeSession(interaction.user.id, {
        startComma: Number(startStr) || 0,
        endComma: Number(endStr) || 0,
    });
    await interaction.launchActivity();
}

/** 點「✏️ 補上開頭」：智能判斷缺什麼，只顯示缺的欄位（BPM／分拍），並帶出原本 simai */
async function handleFixHeaderButton(interaction) {
    const ownerId = interaction.customId.slice(FIX_HEADER_PREFIX.length);
    if (interaction.user.id !== ownerId) {
        return interaction.reply({ content: '❌ 這不是你觸發的，請自己輸入指令', flags: MessageFlags.Ephemeral });
    }

    const draft = composeDrafts.get(interaction.user.id);
    const { hasBpm, hasSplit } = analyzeHeader(isFresh(draft) ? draft.text : '');
    const rows = [];
    if (!hasBpm) {
        rows.push(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('bpm').setLabel('BPM')
                .setStyle(TextInputStyle.Short).setPlaceholder('例如 150').setRequired(true),
        ));
    }
    if (!hasSplit) {
        rows.push(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('split').setLabel('分拍（{N}，例如 4 = 四分音符）')
                .setStyle(TextInputStyle.Short).setPlaceholder('例如 4').setRequired(true),
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('body').setLabel('譜面內容（開頭會自動補上缺的設定）')
            .setStyle(TextInputStyle.Paragraph).setMaxLength(3900).setRequired(true)
            .setValue(isFresh(draft) ? draft.text : ''),
    ));

    const title = !hasBpm && !hasSplit ? '補上 BPM／分拍' : !hasBpm ? '補上 BPM' : '補上分拍';
    await interaction.showModal(
        new ModalBuilder().setCustomId(freshModalId(FIX_HEADER_MODAL_ID)).setTitle(title).addComponents(...rows)
    );
}

async function handleFixHeaderModalSubmit(interaction) {
    const getField = (id) => {
        try { return interaction.fields.getTextInputValue(id).trim(); } catch { return ''; }
    };

    const body = stripCodeFence(getField('body')).trim();
    if (!body) {
        return interaction.reply({ content: '❌ 譜面內容是空的', flags: MessageFlags.Ephemeral });
    }

    // 依 body 目前的狀態，只補「還缺的」部分（使用者可能已在 body 裡自己補了）
    const { hasBpm, hasSplit } = analyzeHeader(body);
    let header = '';
    if (!hasBpm) {
        const bpm = Number(getField('bpm'));
        if (!Number.isFinite(bpm) || bpm <= 0) {
            return interaction.reply({ content: '❌ BPM 請填正數，例如 `150`', flags: MessageFlags.Ephemeral });
        }
        header += `(${bpm})`;
    }
    if (!hasSplit) {
        const split = Number(getField('split'));
        if (!Number.isFinite(split) || split <= 0) {
            return interaction.reply({ content: '❌ 分拍請填正數，例如 `4`', flags: MessageFlags.Ephemeral });
        }
        header += `{${split}}`;
    }

    const prev = composeDrafts.get(interaction.user.id);
    const text = header + body;
    // 保留來源訊息（右鍵觸發時才有），讓後面「渲染這份」仍能回覆原始 simai
    composeDrafts.set(interaction.user.id, { text, createdAt: Date.now(), source: isFresh(prev) ? prev.source : null });
    // 成功補上開頭後，把帶著「✏️ 補上開頭」按鈕的那則 ephemeral 訊息刪掉，改發整理好的結果
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => { });
    await interaction.followUp(composeSuccessPayload(text));
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
    if (m.includes('NO_CHART')) return '❌ 找不到譜面檔：testChart 裡沒有 .simai';
    return `❌ 渲染失敗：${clip(m, 300)}`;
}

await service.init();
console.log('渲染服務就緒');
await client.login(token);

// 【測試用】/activity 互動頁面：.env 設 ENABLE_ACTIVITY=1 才啟動（見 register-commands.js 的指令註冊）
if (process.env.ENABLE_ACTIVITY === '1') {
    startActivityServer(client, service);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        await service.dispose().catch(() => { });
        client.destroy();
        process.exit(0);
    });
}
