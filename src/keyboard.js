import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
    ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';

export const KB_PREFIX = 'kb:';

const TTL_MS = 30 * 60 * 1000;
const sessions = new Map(); // userId -> session

const SLIDE_SHAPES = [
    { value: '-', label: '－ 直線' },
    { value: '>', label: '＞ 順時針外弧' },
    { value: '<', label: '＜ 逆時針外弧' },
    { value: '^', label: '＾ 短弧' },
    { value: 'v', label: 'ｖ 經過中心' },
    { value: 'p', label: 'ｐ 繞中心（逆）' },
    { value: 'q', label: 'ｑ 繞中心（順）' },
    { value: 's', label: 'ｓ 閃電' },
    { value: 'z', label: 'ｚ 反閃電' },
    { value: 'pp', label: 'ｐｐ 大迴旋（逆）' },
    { value: 'qq', label: 'ｑｑ 大迴旋（順）' },
    { value: 'w', label: 'ｗ WiFi' },
];

const DURATIONS = ['1:1', '2:1', '4:1', '4:3', '8:1', '8:3', '16:1', '16:3'];

const TYPE_LABELS = {
    tap: 'tap',
    hold: 'hold',
    slide: 'slide',
    touch: 'touch',
    touchhold: 'touch長按',
};

// ============================================================
// Session
// ============================================================
function newSession() {
    return {
        bpm: 150,
        split: 8,
        tokens: [],       // 已完成的拍
        beat: [],         // 目前這拍（多顆 = each）
        pendingTag: '',   // 中途改 BPM/分拍時，掛在下一拍前的 (bpm){split}
        mode: {
            type: 'tap',
            touchZone: 'A',
            slideShape: '-',
            slidePending: null,
            duration: '8:1',
            mods: { break: false, ex: false, mine: false, hanabi: false },
        },
        page: 'main',
        createdAt: Date.now(),
    };
}

function getSession(userId) {
    const s = sessions.get(userId);
    if (!s) return null;
    if (Date.now() - s.createdAt > TTL_MS) {
        sessions.delete(userId);
        return null;
    }
    return s;
}

// ============================================================
// simai 組字
// ============================================================
function noteFromPos(s, pos) {
    const m = s.mode;
    const flags = (m.mods.break ? 'b' : '') + (m.mods.ex ? 'x' : '') + (m.mods.mine ? 'm' : '');

    switch (m.type) {
        case 'tap':
            return `${pos}${flags}`;
        case 'hold':
            return `${pos}${flags}h[${m.duration}]`;
        case 'touch': {
            const zone = m.touchZone;
            const base = zone === 'C' ? 'C' : `${zone}${pos}`;
            return `${base}${m.mods.hanabi ? 'f' : ''}`;
        }
        case 'touchhold': {
            const zone = m.touchZone;
            const base = zone === 'C' ? 'C' : `${zone}${pos}`;
            return `${base}${m.mods.hanabi ? 'f' : ''}h[${m.duration}]`;
        }
        case 'slide': {
            if (m.slidePending == null) {
                m.slidePending = pos; // 第一下：記起點
                return null;
            }
            const start = m.slidePending;
            m.slidePending = null;
            // slide 的 break/炸彈放中括號後面（decode.js 建議格式）
            const tail = (m.mods.break ? 'b' : '') + (m.mods.mine ? 'm' : '');
            return `${start}${m.slideShape}${pos}[${m.duration}]${tail}`;
        }
    }
    return null;
}

function buildSimai(s) {
    const parts = [...s.tokens];
    if (s.beat.length) parts.push((s.pendingTag || '') + s.beat.join('/'));
    const body = parts.join(',');
    if (!body.replace(/,/g, '')) return null;
    return `(${s.bpm}){${s.split}}${body},E`;
}

function modeDesc(s) {
    const m = s.mode;
    let d = TYPE_LABELS[m.type];
    if (m.type === 'slide') d += ` ${m.slideShape}[${m.duration}]`;
    if (m.type === 'hold' || m.type === 'touchhold') d += `[${m.duration}]`;
    if (m.type === 'touch' || m.type === 'touchhold') d += ` ${m.touchZone}區`;
    const mods = [];
    if (m.mods.break) mods.push('break');
    if (m.mods.ex) mods.push('ex');
    if (m.mods.mine) mods.push('炸彈');
    if (m.mods.hanabi) mods.push('花火');
    if (mods.length) d += ' ＋' + mods.join('＋');
    return d;
}

function buildContent(s) {
    const simai = buildSimai(s);
    const shown = simai ?? `(${s.bpm}){${s.split}}`;
    const lines = [
        '🎹 **simai 鍵盤**',
        '```simai',
        shown.length > 800 ? '…' + shown.slice(-800) : shown,
        '```',
        `模式：${modeDesc(s)} ｜ BPM ${s.bpm} {${s.split}} ｜ 已 ${s.tokens.length} 拍`,
    ];
    if (s.mode.slidePending != null) {
        lines.push(`⭐ slide 起點 **${s.mode.slidePending}** → 請點終點（⌫ 取消）`);
    }
    return lines.join('\n');
}

// ============================================================
// Components
// ============================================================
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

function buildMainComponents(s) {
    const isTouchC = (s.mode.type === 'touch' || s.mode.type === 'touchhold') && s.mode.touchZone === 'C';
    const pos = (n) => btn(`kb:pos:${n}`, String(n), ButtonStyle.Primary);
    const gap = (i) => isTouchC && i >= 2 && i <= 5
        ? btn(`kb:pos:C`, 'C', ButtonStyle.Success)      // touch C 模式：中央空白鍵變 C 鍵
        : btn(`kb:noop:${i}`, '·', ButtonStyle.Secondary, true);

    return [
        new ActionRowBuilder().addComponents(gap(0), pos(8), pos(1), gap(1)),
        new ActionRowBuilder().addComponents(pos(7), gap(2), gap(3), pos(2)),
        new ActionRowBuilder().addComponents(pos(6), gap(4), gap(5), pos(3)),
        new ActionRowBuilder().addComponents(gap(6), pos(5), pos(4), gap(7)),
        new ActionRowBuilder().addComponents(
            btn('kb:ctrl:comma', '，下一拍', ButtonStyle.Success),
            btn('kb:ctrl:undo', '⌫'),
            btn('kb:ctrl:mode', '🔧 模式'),
            btn('kb:ctrl:preview', '🎬 預覽'),
            btn('kb:ctrl:done', '✅ 完成'),
        ),
    ];
}

function buildModeComponents(s) {
    const m = s.mode;
    const typeBtn = (type) => btn(`kb:mode:${type}`, TYPE_LABELS[type],
        m.type === type ? ButtonStyle.Primary : ButtonStyle.Secondary);
    const modBtn = (mod, label) => btn(`kb:mod:${mod}`, label,
        m.mods[mod] ? ButtonStyle.Primary : ButtonStyle.Secondary);

    const rows = [
        new ActionRowBuilder().addComponents(
            typeBtn('tap'), typeBtn('hold'), typeBtn('slide'), typeBtn('touch'), typeBtn('touchhold'),
        ),
    ];

    if (m.type === 'slide') {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('kb:sel:shape')
                .setPlaceholder('slide 形狀')
                .addOptions(SLIDE_SHAPES.map((o) => ({ ...o, default: o.value === m.slideShape }))),
        ));
    } else if (m.type === 'touch' || m.type === 'touchhold') {
        rows.push(new ActionRowBuilder().addComponents(
            ...['A', 'B', 'C', 'D', 'E'].map((z) => btn(`kb:zone:${z}`, `${z} 區`,
                m.touchZone === z ? ButtonStyle.Primary : ButtonStyle.Secondary)),
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        modBtn('break', '💥 break'),
        modBtn('ex', '✨ ex'),
        modBtn('mine', '💣 炸彈'),
        modBtn('hanabi', '🎆 花火'),
    ));

    rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('kb:sel:duration')
            .setPlaceholder('hold / slide 拍長')
            .addOptions(DURATIONS.map((d) => ({ label: `[${d}]`, value: d, default: d === m.duration }))),
    ));

    rows.push(new ActionRowBuilder().addComponents(
        btn('kb:ctrl:back', '↩ 返回鍵盤', ButtonStyle.Success),
        btn('kb:ctrl:settings', '⚙ BPM／分拍'),
    ));

    return rows;
}

const componentsFor = (s) => (s.page === 'mode' ? buildModeComponents(s) : buildMainComponents(s));

function disableAll(rows) {
    return rows.map((row) => {
        const r = ActionRowBuilder.from(row);
        r.components.forEach((c) => c.setDisabled(true));
        return r;
    });
}

function buildSettingsModal(s) {
    return new ModalBuilder()
        // 附 nonce → 每次都是全新表單 id，避開 Discord 客戶端把上次輸入殘留塞回來
        // （routing 只讀 customId.split(':') 的 index 1 = 'modal'，多一段不影響）
        .setCustomId(`kb:modal:settings:${Date.now().toString(36)}`)
        .setTitle('BPM／分拍設定')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('bpm').setLabel('BPM')
                    .setStyle(TextInputStyle.Short).setValue(String(s.bpm)).setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('split').setLabel('分拍（{N}，例如 4 = 四分音符）')
                    .setStyle(TextInputStyle.Short).setValue(String(s.split)).setRequired(true),
            ),
        );
}

// ============================================================
// 入口：/keyboard 指令
// ============================================================
export async function handleKeyboardCommand(interaction) {
    const s = newSession();
    sessions.set(interaction.user.id, s); // 重開直接覆蓋舊 session
    await interaction.reply({
        content: buildContent(s),
        components: buildMainComponents(s),
        flags: MessageFlags.Ephemeral, // ephemeral = 天然只有發起者能看到、能按
    });
}

// ============================================================
// 入口：kb: 前綴的按鈕 / 選單 / modal
// ctx = { buildRenderPayload, checkCooldown, friendlyError }
// ============================================================
export async function handleKeyboardComponent(interaction, ctx) {
    const s = getSession(interaction.user.id);
    if (!s) {
        const payload = { content: '⌛ 鍵盤已過期，請重新輸入 `/keyboard`', components: [], embeds: [], attachments: [] };
        if (interaction.isModalSubmit()) {
            await interaction.deferUpdate().catch(() => { });
            await interaction.editReply(payload).catch(() => { });
        } else {
            await interaction.update(payload).catch(() => { });
        }
        return;
    }

    const [, action, arg] = interaction.customId.split(':');

    // ---------- Modal ----------
    if (interaction.isModalSubmit() && action === 'modal') {
        const bpm = Number(interaction.fields.getTextInputValue('bpm'));
        const split = Number(interaction.fields.getTextInputValue('split'));
        if (Number.isFinite(bpm) && bpm > 0) {
            if (Number.isFinite(split) && split > 0) {
                if (s.tokens.length === 0 && s.beat.length === 0) {
                    // 還沒放任何 note：直接改開頭
                    s.bpm = bpm;
                    s.split = split;
                } else if (bpm !== s.bpm || split !== s.split) {
                    s.pendingTag = `(${bpm}){${split}}`;
                    s.bpm = bpm;
                    s.split = split;
                }
            }
        }
        await interaction.deferUpdate();
        await interaction.editReply({ content: buildContent(s), components: componentsFor(s), embeds: [], attachments: [] });
        return;
    }

    // ---------- 選單 ----------
    if (interaction.isStringSelectMenu() && action === 'sel') {
        if (arg === 'shape') s.mode.slideShape = interaction.values[0];
        if (arg === 'duration') s.mode.duration = interaction.values[0];
        await interaction.update({ content: buildContent(s), components: buildModeComponents(s), embeds: [], attachments: [] });
        return;
    }

    // ---------- 按鈕 ----------
    const refresh = () => interaction.update({
        content: buildContent(s), components: componentsFor(s), embeds: [], attachments: [],
    });

    switch (action) {
        case 'pos': {
            const note = noteFromPos(s, arg === 'C' ? 'C' : Number(arg));
            if (note) s.beat.push(note);
            return refresh();
        }

        case 'zone':
            s.mode.touchZone = arg;
            return refresh();

        case 'mode':
            s.mode.type = arg;
            s.mode.slidePending = null;
            return refresh();

        case 'mod':
            s.mode.mods[arg] = !s.mode.mods[arg];
            return refresh();

        case 'ctrl':
            switch (arg) {
                case 'comma':
                    s.tokens.push((s.pendingTag || '') + s.beat.join('/'));
                    s.pendingTag = '';
                    s.beat = [];
                    return refresh();

                case 'undo':
                    if (s.mode.slidePending != null) s.mode.slidePending = null;
                    else if (s.beat.length) s.beat.pop();
                    else if (s.tokens.length) s.tokens.pop();
                    return refresh();

                case 'mode':
                    s.page = 'mode';
                    return refresh();

                case 'back':
                    s.page = 'main';
                    return refresh();

                case 'settings':
                    return interaction.showModal(buildSettingsModal(s));

                case 'preview':
                case 'done':
                    return handleRender(interaction, s, ctx, arg === 'done');
            }
    }
}

async function handleRender(interaction, s, ctx, isDone) {
    const simai = buildSimai(s);
    if (!simai) {
        return interaction.update({ content: buildContent(s) + '\n❌ 還沒放任何 note', components: componentsFor(s), embeds: [], attachments: [] });
    }

    const remain = ctx.checkCooldown(interaction.user.id);
    if (remain > 0) {
        return interaction.update({
            content: buildContent(s) + `\n⏳ 冷卻中，請 ${Math.ceil(remain / 1000)} 秒後再渲染`,
            components: componentsFor(s), embeds: [], attachments: [],
        });
    }

    // 渲染要幾秒：先鎖住鍵盤防連點
    await interaction.update({
        content: buildContent(s) + `\n${isDone ? '✅' : '🎬'} 渲染中…`,
        components: disableAll(componentsFor(s)), embeds: [], attachments: [],
    });

    try {
        const payload = await ctx.buildRenderPayload(simai, {}, `由 ${interaction.user.displayName ?? interaction.user.username} 用鍵盤製作`);

        if (isDone) {
            // 公開發佈：payload.content 已內建可複製的 ```simai``` 區塊，關閉鍵盤
            await interaction.followUp(payload);
            await interaction.editReply({ content: '✅ 已完成並發佈！', components: [], embeds: [], attachments: [] });
            sessions.delete(interaction.user.id);
        } else {
            // 預覽：維持鍵盤自己的狀態列文字，只取 payload 的 GIF embed/檔案
            await interaction.editReply({
                content: buildContent(s),
                components: componentsFor(s),
                embeds: payload.embeds,
                files: payload.files,
            });
        }
    } catch (e) {
        console.error(e);
        await interaction.editReply({
            content: buildContent(s) + '\n' + ctx.friendlyError(e),
            components: componentsFor(s), embeds: [], attachments: [],
        }).catch(() => { });
    }
}
