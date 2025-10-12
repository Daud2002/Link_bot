require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const storage = require('node-persist');
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
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process", // <- sometimes helps
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

async function incrementWarning(groupId, userId, name) {
    const k = keyFor(groupId, userId);
    const record = (await storage.getItem(k)) || { count: 0, name, firstAt: Date.now() };
    record.count += 1;
    record.name = name; // keep latest display name
    await storage.setItem(k, record);
    return record.count;
}

async function getWarnings(groupId, userId) {
    return (await storage.getItem(keyFor(groupId, userId))) || { count: 0, name: '' };
}

async function resetWarnings(groupId, userId) {
    await storage.removeItem(keyFor(groupId, userId));
}

// client.on('qr', qr => {
//     qrcode.generate(qr, { small: true });
//     console.log('Scan the QR above with WhatsApp to log in.');
// });


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
    await storage.init({ dir: './data' });
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

        // Only group chats
        if (!chat.isGroup || isAdmin) return;

        // Enforce only for selected groups if configured
        if (ENFORCE_GROUP_IDS.length && !ENFORCE_GROUP_IDS.includes(chat.id._serialized)) {
            return;
        }

        const isVoiceMessage = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');

        // Admin commands (from group admins only)
        if (msg.body?.startsWith('!linkguard')) {
            const groupChat = chat; // GroupChat
            const adminsOnly = await isClientAdmin(groupChat) || groupChat.participants
                .find(p => p.id?._serialized === msg.author)?.isAdmin;

            // Allow group admins to reset a user's counter by mention
            if (!adminsOnly) return;

            // !linkguard reset @mention
            // if (/^!linkguard\s+reset/i.test(msg.body)) {
            //     const mentions = await msg.getMentions();
            //     if (!mentions.length) {
            //         await chat.sendMessage('Usage: !linkguard reset @user');
            //         return;
            //     }
            //     for (const m of mentions) {
            //         await resetWarnings(chat.id._serialized, m.id._serialized);
            //         await chat.sendMessage(`✅ Reset warnings for ${m.pushname || m.number}`);
            //     }
            //     return;
            // }

            // !linkguard status
            if (/^!linkguard\s+status/i.test(msg.body)) {
                await chat.sendMessage(`LinkGuard active. Threshold: ${WARN_THRESHOLD}. Group: ${chat.name}`);
                return;
            }

            // Help
            // if (/^!linkguard(\s+help)?$/i.test(msg.body)) {
            //     await chat.sendMessage(
            //         'LinkGuard commands:\n' +
            //         '• !linkguard status — show status\n' +
            //         '• !linkguard reset @user — reset warnings for a user'
            //     );
            //     return;
            // }
        }

        // Detect links in normal messages
        const hasLink = LINK_REGEX.test(msg.body || '') ||
            (msg.caption && LINK_REGEX.test(msg.caption)); // also check captions

        if (!hasLink && !isVoiceMessage) {
            return;
        }

        // Identify sender



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
            await groupChat.sendMessage(format(KICK_TEMPLATE, { name: senderName, count, limit: WARN_THRESHOLD }));

            if (await isClientAdmin(groupChat)) {
                try {
                    await groupChat.removeParticipants([sender.id._serialized]);
                    await groupChat.sendMessage(`🔴 Removed ${senderName} 🔴`);
                    // Optionally reset their counter
                    await resetWarnings(chat.id._serialized, sender.id._serialized);
                } catch (e) {
                    await groupChat.sendMessage(`❌ Tried to remove ${senderName} but failed: ${e?.message || e}`);
                }
            } else {
                await groupChat.sendMessage(`ℹ️ I can’t remove members because I’m not a group admin.`);
            }
        }
        else {
            await chat.sendMessage(format(WARN_TEMPLATE, { name: senderName, count, limit: WARN_THRESHOLD }));
        }
    } catch (err) {
        console.error('Handler error:', err);
    }
});

client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
});

client.initialize();
