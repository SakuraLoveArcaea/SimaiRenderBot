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
        if (interaction.isButton() && interaction.customId.startsWith(FIX_HEADER_PREFIX)) {
            return await handleFixHeaderButton(interaction);
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

    await runInteractionRender(interaction, simai, {}, `來源：${interaction.targetMessage.url}`);
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
            { name: '長度', value: `${result.duration.toFixed(1)} 秒`, inline: true },
            { name: 'BPM', value: String(info.bpm ?? '—'), inline: true },
            { name: 'Notes', value: formatCounts(info.noteCounts), inline: true },
        )
        .setFooter({ text: footer })
        .setImage('attachment://chart.gif');

    addWarnField(embed, simaiText, result.warns, result.warnpos);
    return { embeds: [embed], files: [file] }; // 影片訊息本身不附 simai 文字（要文字用 /compose）
}

/** 已收到 → 正在渲染（含預估秒數） → 結果，套用在所有互動式渲染入口 */
async function runInteractionRender(interaction, simaiText, opts = {}, footerExtra = '') {
    if (!hasLeadingHeader(simaiText)) {
        return interaction.reply({ ...missingHeaderReply(interaction.user.id, simaiText), flags: MessageFlags.Ephemeral });
    }
    const est = await estimateRender(simaiText);
    if (est && est.etaMs > MAX_RENDER_MS) {
        return interaction.reply({ content: tooHeavyMessage(est.etaSec), flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply();
    await interaction.editReply({ content: '✅ 已收到，準備渲染…' });
    try {
        const status = est ? `正在渲染中，預估約 ${est.etaSec} 秒，請稍候…` : '正在渲染中，請稍候…';
        await interaction.editReply({ content: `🎬 ${status}` });
        const payload = await buildRenderPayload(simaiText, opts, footerExtra);
        await interaction.editReply({ content: null, ...payload });
    } catch (e) {
        console.error(e);
        await interaction.editReply({ content: friendlyError(e) }).catch(() => { });
    }
}

/** 估算渲染耗時：回傳 { etaMs, etaSec }；解析失敗回傳 null（不擋流程、不套上限） */
async function estimateRender(simaiText) {
    try {
        const info = await service.inspect(simaiText);
        const totalNotes = Object.values(info.noteCounts ?? {}).reduce((a, b) => a + b, 0);
        const durationSec = Math.min(info.endTime, MAX_DURATION); // 對齊 renderGif 的截斷上限
        const etaMs = service.estimateRenderMs(durationSec, totalNotes);
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
// 開頭必須有 (BPM){分拍}：沒寫的話 decode.js 會靜默套用 60bpm/{4} 預設值，
// 結果通常是錯的卻不會有任何警告，所以直接攔在渲染前請使用者補上重輸。
// ============================================================
const FIX_HEADER_PREFIX = 'compose:fixheader:';
const FIX_HEADER_MODAL_ID = 'compose:fixheader:modal';

/** 分別偵測開頭的 BPM `(N)` 與分拍 `{N}`（順序不拘，decode 兩種都吃）。 */
function analyzeHeader(simaiText) {
    let s = (simaiText ?? '').replace(/\|\|.*$/gm, '').replace(/\s+/g, '');
    let hasBpm = false, hasSplit = false, m;
    while ((m = s.match(/^\([^()]*\)/)) || (m = s.match(/^\{[^{}]*\}/))) {
        if (m[0][0] === '(') hasBpm = true; else hasSplit = true;
        s = s.slice(m[0].length);
    }
    return { hasBpm, hasSplit };
}

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

/** 存草稿（讓表單能帶出原本內容）＋組出附按鈕的拒絕回覆 */
function missingHeaderReply(userId, simaiText) {
    composeDrafts.set(userId, { text: simaiText, createdAt: Date.now() });
    return { content: missingHeaderMessage(simaiText), components: missingHeaderComponents(userId) };
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

    const text = header + body;
    composeDrafts.set(interaction.user.id, { text, createdAt: Date.now() });
    await interaction.reply(composeSuccessPayload(text));
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
