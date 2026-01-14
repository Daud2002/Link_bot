require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const WARN_THRESHOLD = parseInt(process.env.WARN_THRESHOLD || '3', 10);
const WARN_TEMPLATE = process.env.WARN_TEMPLATE || '⚠️ {name}, links are not allowed. Warning {count}/{limit}';
const KICK_TEMPLATE = process.env.KICK_TEMPLATE || '🚨 {name} exceeded {limit} warnings. Removing from group…';
const ENFORCE_GROUP_IDS = (process.env.ENFORCE_GROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Very permissive link detection: urls, domains, www, etc.
const LINK_REGEX = /\b((https?:\/\/|www\.)[^\s]+|[a-z0-9.-]+\.(com|net|org|info|io|co|us|uk|pk|in|gov|edu|de|me|ly)(\/[^\s]*)?)\b/i;


const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'link-bot-session'
    }),
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process",
            "--disable-gpu"
        ],
    },
});

function keyFor(groupId, userId) {
    return `warn:${groupId}:${userId}`;
}

function format(tpl, ctx) {
    return tpl
        .replace('{name}', ctx.name)
        .replace('{count}', String(ctx.count))
        .replace('{limit}', String(ctx.limit));
}

async function isClientAdmin(groupChat) {
    // groupChat.participants is only on GroupChat
    const me = client.info?.wid?._serialized;
    if (!me || !groupChat.participants) return false;
    const mine = groupChat.participants.find(p => p.id?._serialized === me);
    return Boolean(mine?.isAdmin || mine?.isSuperAdmin);
}

// PostgreSQL storage setup
// Use DATABASE_URL or PG connection env vars
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Ensure warnings table exists
async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS warnings (
            key TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            name TEXT,
            first_at BIGINT
        )
    `);
}

function storageKey(groupId, userId) {
    return keyFor(groupId, userId);
}

// Increment warning and return new count
async function incrementWarning(groupId, userId, name) {
    const k = storageKey(groupId, userId);
    const now = Date.now();

    // Try to upsert: if exists increment, else insert with count=1
    const res = await pool.query(`
        INSERT INTO warnings(key, group_id, user_id, count, name, first_at)
        VALUES($1, $2, $3, 1, $4, $5)
        ON CONFLICT (key) DO UPDATE SET
            count = warnings.count + 1,
            name = $4
        RETURNING count
    `, [k, groupId, userId, name, now]);

    return res.rows[0]?.count || 1;
}

async function getWarnings(groupId, userId) {
    const k = storageKey(groupId, userId);
    const res = await pool.query('SELECT count, name, first_at FROM warnings WHERE key = $1', [k]);
    if (!res.rows.length) return { count: 0, name: '' };
    const r = res.rows[0];
    return { count: r.count || 0, name: r.name || '', firstAt: r.first_at };
}

async function resetWarnings(groupId, userId) {
    const k = storageKey(groupId, userId);
    await pool.query('DELETE FROM warnings WHERE key = $1', [k]);
}


client.on('qr', async (qr) => {
    // Convert the QR to a Data URL (image)
    const qrImageUrl = await QRCode.toDataURL(qr);

    console.log('\n✅ Open this URL in a browser to scan the QR:\n');
    console.log(qrImageUrl);

    // Optional — pretty message in logs
    console.log('\n👇 Copy the above URL and open in your browser to see the QR image\n');
});


client.on('ready', async () => {
    console.log('✅ Bot is ready!');
    try {
        await ensureTable();
        console.log('✅ Postgres storage ready');
    } catch (e) {
        console.error('❌ Failed to prepare Postgres storage:', e);
        process.exit(1);
    }
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup);
    console.log('📋 Groups you are in:');
    groups.forEach(g => console.log(`${g.name} => ${g.id._serialized}`));
});

client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        const sender = await msg.getContact();
        const isAdmin = chat.groupMetadata?.participants.find(p => p.id._serialized === sender.id._serialized)?.isAdmin;

        if (!chat.isGroup || isAdmin) return;

        if (ENFORCE_GROUP_IDS.length && !ENFORCE_GROUP_IDS.includes(chat.id._serialized)) {
            return;
        }

        const isVoiceMessage = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');

        if (msg.body?.startsWith('!linkguard')) {
            const groupChat = chat; // GroupChat
            const adminsOnly = await isClientAdmin(groupChat) || groupChat.participants
                .find(p => p.id?._serialized === msg.author)?.isAdmin;
            if (!adminsOnly) return;
            if (/^!linkguard\s+status/i.test(msg.body)) {
                await chat.sendMessage(`LinkGuard active. Threshold: ${WARN_THRESHOLD}. Group: ${chat.name}`, {sendSeen: false});
                return;
            }
        }

        const hasLink = LINK_REGEX.test(msg.body || '') ||
            (msg.caption && LINK_REGEX.test(msg.caption));

        if (!hasLink && !isVoiceMessage) {
            return;
        }

        const senderName = sender.pushname || sender.verifiedName || sender.number || 'member';

        if (hasLink) {
            console.log(`[DEBUG] Detected link in ${chat.name} from ${senderName}: ${msg.body}`);
        }


        // Increment warnings (per-group, per-user)
        const count = await incrementWarning(chat.id._serialized, sender.id._serialized, senderName);

        // Reply warning to the offending message
        await msg.delete(true);

        // If exceeded threshold, try to remove
        if (count >= WARN_THRESHOLD) {
            const groupChat = chat; // GroupChat
            await groupChat.sendMessage(format(KICK_TEMPLATE, { name: senderName, count, limit: WARN_THRESHOLD }), {sendSeen: false});

            if (await isClientAdmin(groupChat)) {
                try {
                    await groupChat.removeParticipants([sender.id._serialized]);
                    await groupChat.sendMessage(`🔴 Removed ${senderName} 🔴`, {sendSeen: false});
                    // Optionally reset their counter
                    await resetWarnings(chat.id._serialized, sender.id._serialized);
                } catch (e) {
                    await groupChat.sendMessage(`❌ Tried to remove ${senderName} but failed: ${e?.message || e}`, {sendSeen: false});
                }
            } else {
                await groupChat.sendMessage(`ℹ️ I can’t remove members because I’m not a group admin.`, {sendSeen: false});
            }
        }
        else {
            await chat.sendMessage(format(WARN_TEMPLATE, { name: senderName, count, limit: WARN_THRESHOLD }), {sendSeen: false});
        }
    } catch (err) {
        console.error('Handler error:', err);
    }
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
});

client.initialize();
