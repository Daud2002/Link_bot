require('dotenv').config();

const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { generatePosterImage } = require('./gemini');

const WARN_THRESHOLD = parseInt(process.env.WARN_THRESHOLD || '3', 10);
const WARN_TEMPLATE = process.env.WARN_TEMPLATE || '⚠️ {name}, links are not allowed. Warning {count}/{limit}';
const KICK_TEMPLATE = process.env.KICK_TEMPLATE || '🚨 {name} exceeded {limit} warnings. Removing from group…';
const ENFORCE_GROUP_IDS = (process.env.ENFORCE_GROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// Very permissive link detection: urls, domains, www, etc.
const LINK_REGEX = /\b((https?:\/\/|www\.)[^\s]+|[a-z0-9.-]+\.(com|net|org|info|io|co|us|uk|pk|in|gov|edu|de|me|ly)(\/[^\s]*)?)\b/i;

// Poster/image generation command. Anyone in an enforced group can type
// "!image <description>" to have Gemini generate an image sent back to the group.
const IMAGE_CMD_PREFIX = process.env.IMAGE_CMD_PREFIX || '!image';
// Optional: restrict poster generation to specific group ids (comma-separated).
// If empty, it works in any group the bot is enforcing (ENFORCE_GROUP_IDS).
const IMAGE_GROUP_IDS = (process.env.IMAGE_GROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);


// Renderer (Chromium) V8 heap cap, MB. Separate from Node's own heap.
const RENDERER_HEAP_MB = parseInt(process.env.RENDERER_HEAP_MB || '256', 10);

// Low-RAM Chromium launch flags. Tuned for a single, long-lived headless tab
// running the WhatsApp Web SPA on a 1GB container.
const PUPPETEER_ARGS = [
    // sandbox (required in Railway containers)
    "--no-sandbox",
    "--disable-setuid-sandbox",
    // use /tmp instead of the tiny /dev/shm so Chromium doesn't crash under pressure
    "--disable-dev-shm-usage",
    // single process + no zygote: biggest RAM saver for one persistent tab
    "--single-process",
    "--no-zygote",
    "--no-first-run",
    "--disable-gpu",
    "--disable-accelerated-2d-canvas",
    // kill background services / threads we never use
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-breakpad",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--disable-hang-monitor",
    "--disable-prompt-on-repost",
    // keep the headless/backgrounded tab responsive so messages aren't missed
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // drop the back/forward cache and other memory-holding features
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
    // cap the renderer's V8 heap (the JS heap that actually grows over time)
    `--js-flags=--max-old-space-size=${RENDERER_HEAP_MB}`,
];

function buildClient() {
    return new Client({
        authStrategy: new LocalAuth({
            clientId: 'link-bot-session'
        }),
        puppeteer: {
            headless: true,
            // On Railway, point at the system chromium from nixpkgs (lighter than
            // the bundled full Chrome). Locally this is unset -> bundled Chrome.
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: PUPPETEER_ARGS,
        },
    });
}

let client = buildClient();

function keyFor(groupId, userId) {
    return `warn:${groupId}:${userId}`;
}

function format(tpl, ctx) {
    return tpl
        .replace('{name}', ctx.name)
        .replace('{count}', String(ctx.count))
        .replace('{limit}', String(ctx.limit));
}

// Find a participant by id, tolerant of WhatsApp ID-format differences.
// WhatsApp may deliver an author as "12345@c.us" while group metadata stores
// the same person as a "@lid" id (or vice-versa). A strict _serialized ===
// comparison then misses, and an admin looks like a non-admin. So we also
// compare the numeric/user portion before the "@".
function userPart(id) {
    if (!id) return '';
    // id can be a serialized string ("123@c.us") or an object with .user/._serialized
    if (typeof id === 'object') {
        return id.user || (id._serialized ? String(id._serialized).split('@')[0] : '');
    }
    return String(id).split('@')[0];
}

function findParticipant(participants, authorId, authorUser) {
    if (!participants) return undefined;
    const wantSerial = authorId;
    const wantUser = authorUser || userPart(authorId);
    return participants.find(p => {
        const ps = p.id?._serialized;
        if (ps && ps === wantSerial) return true;
        if (wantUser && userPart(p.id) === wantUser) return true;
        return false;
    });
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


// Number of messages currently being processed. The periodic recycle waits for
// this to reach 0 so it never tears down the browser mid-deletion.
let inFlight = 0;

function registerHandlers(c) {
    c.on('qr', async (qr) => {
        // Convert the QR to a Data URL (image)
        const qrImageUrl = await QRCode.toDataURL(qr);

        console.log('\n✅ Open this URL in a browser to scan the QR:\n');
        console.log(qrImageUrl);

        // Optional — pretty message in logs
        console.log('\n👇 Copy the above URL and open in your browser to see the QR image\n');
    });


    c.on('ready', async () => {
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

    c.on('message', async (msg) => {
      inFlight++;
      try {
        const chat = await msg.getChat();

        if (!chat.isGroup) return;

        if (ENFORCE_GROUP_IDS.length && !ENFORCE_GROUP_IDS.includes(chat.id._serialized)) {
            return;
        }

        // --- Poster/image generation: "!image <description>" ---
        // Handled before enforcement so it works for everyone (admins included)
        // and isn't affected by the link/voice rules below.
        const body = (msg.body || '').trim();
        if (body.toLowerCase().startsWith(IMAGE_CMD_PREFIX.toLowerCase())) {
            // Respect an optional per-command group allowlist.
            if (IMAGE_GROUP_IDS.length && !IMAGE_GROUP_IDS.includes(chat.id._serialized)) {
                return;
            }

            const prompt = body.slice(IMAGE_CMD_PREFIX.length).trim();
            if (!prompt) {
                await chat.sendMessage(`ℹ️ Usage: ${IMAGE_CMD_PREFIX} <describe the poster you want>`, { sendSeen: false });
                return;
            }

            console.log(`[IMAGE] Request in ${chat.name}: "${prompt}"`);
            await chat.sendMessage('🎨 Generating your poster…', { sendSeen: false });

            try {
                const { base64, mimeType } = await generatePosterImage(prompt);
                const media = new MessageMedia(mimeType, base64, 'poster.png');
                await chat.sendMessage(media, { caption: `🖼️ ${prompt}`, sendSeen: false });
            } catch (e) {
                console.error('[IMAGE] Generation failed:', e?.message || e);
                const reason = e?.message || String(e);
                if (reason.includes('All Gemini API keys failed') || reason.includes('No Gemini API keys')) {
                    await chat.sendMessage('❌ Sorry, the image service is unavailable right now (API key not working). Please try again later.', { sendSeen: false });
                } else {
                    await chat.sendMessage(`❌ Couldn't generate that image: ${reason.slice(0, 300)}`, { sendSeen: false });
                }
            }
            return; // done — do not fall through to enforcement
        }

        // The author's serialized id (works without resolving a full contact).
        const authorId = msg.author || msg.from;
        const authorUser = userPart(authorId);

        // Admin check from group metadata — does NOT depend on getContact().
        // Uses a format-tolerant lookup so @lid vs @c.us id differences don't
        // make a real admin look like a normal member (which caused admin
        // messages to be deleted).
        let authorParticipant = findParticipant(
            chat.groupMetadata?.participants, authorId, authorUser
        );
        // If metadata didn't contain the author (stale/empty), fall back to the
        // live GroupChat participant list before deciding admin status. Missing
        // the author here would wrongly enforce against a real admin.
        if (!authorParticipant && chat.participants) {
            authorParticipant = findParticipant(chat.participants, authorId, authorUser);
        }
        const isAdmin = Boolean(authorParticipant?.isAdmin || authorParticipant?.isSuperAdmin);

        if (!authorParticipant) {
            console.warn(`[ADMIN] Could not locate author ${authorId} (user=${authorUser}) in ${chat.name}'s participant list — treating as non-admin.`);
        }

        if (msg.body?.startsWith('!linkguard')) {
            const groupChat = chat; // GroupChat
            const adminsOnly = await isClientAdmin(groupChat) ||
                Boolean(findParticipant(groupChat.participants, authorId, authorUser)?.isAdmin
                    || findParticipant(groupChat.participants, authorId, authorUser)?.isSuperAdmin);
            if (!adminsOnly) return;
            if (/^!linkguard\s+status/i.test(msg.body)) {
                await chat.sendMessage(`LinkGuard active. Threshold: ${WARN_THRESHOLD}. Group: ${chat.name}`, {sendSeen: false});
                return;
            }
        }

        // Admins are exempt from enforcement (but still allowed to run commands above).
        if (isAdmin) return;

        // --- Relevance detection: only needs `msg`, never the contact. ---
        const isVoiceMessage = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');
        const hasLink = LINK_REGEX.test(msg.body || '') ||
            (msg.caption && LINK_REGEX.test(msg.caption));
        const isChannelForwarded = !!msg._data?.forwardedNewsletterMessageInfo;

        if (!hasLink && !isVoiceMessage && !isChannelForwarded) {
            return;
        }

        // Resolve the contact ONLY now that the message is actionable, and treat
        // failure as non-fatal — some messages (channels/newsletters/system) have
        // no resolvable contact and getContact() throws. Fall back to the author id.
        let sender = null;
        try {
            sender = await msg.getContact();
        } catch (e) {
            console.warn('getContact() failed, falling back to author id:', e?.message || e);
        }

        const senderId = sender?.id?._serialized || authorId;
        if (!senderId) {
            console.warn('No resolvable sender id; skipping enforcement for this message.');
            return;
        }
        const senderName = sender?.pushname || sender?.verifiedName || sender?.number
            || (authorId ? authorId.split('@')[0] : 'member');

        if (hasLink) {
            console.log(`[DEBUG] Detected link in ${chat.name} from ${senderName}: ${msg.body}`);
        }


        // Increment warnings (per-group, per-user)
        const count = await incrementWarning(chat.id._serialized, senderId, senderName);

        // Reply warning to the offending message
        await msg.delete(true);

        // If exceeded threshold, try to remove
        if (count >= WARN_THRESHOLD) {
            const groupChat = chat; // GroupChat
            await groupChat.sendMessage(format(KICK_TEMPLATE, { name: senderName, count, limit: WARN_THRESHOLD }), {sendSeen: false});

            if (await isClientAdmin(groupChat)) {
                try {
                    await groupChat.removeParticipants([senderId]);
                    await groupChat.sendMessage(`🔴 Removed ${senderName} 🔴`, {sendSeen: false});
                    // Optionally reset their counter
                    await resetWarnings(chat.id._serialized, senderId);
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
      } finally {
        inFlight--;
      }
    });

    c.on('disconnected', async (reason) => {
        console.log('Disconnected:', reason);
        // Don't leave the bot dead on an unexpected disconnect — re-initialize.
        // LocalAuth means this reconnects without a new QR scan.
        if (recycling) return; // an intentional recycle handles its own re-init
        try {
            await client.initialize();
        } catch (e) {
            console.error('Re-initialize after disconnect failed:', e);
        }
    });
}

// ---------------------------------------------------------------------------
// Memory measurement harness (pure Node, no deps). Logs Node RSS plus the
// Chromium browser process tree RSS every 30s, tagged by MEM_TAG so the
// before/after numbers are greppable in Railway logs.
// ---------------------------------------------------------------------------
function rssOfPid(pid) {
    // Linux: /proc/<pid>/statm field 2 (resident pages) * 4KB page size
    try {
        const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8');
        const residentPages = parseInt(statm.split(' ')[1], 10);
        return residentPages * 4096;
    } catch {
        return 0;
    }
}

function childPidsLinux(pid) {
    try {
        const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
            .trim().split(/\s+/).filter(Boolean).map(Number);
        return kids.flatMap(k => [k, ...childPidsLinux(k)]);
    } catch {
        return [];
    }
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

function startMemoryHarness() {
    const tag = process.env.MEM_TAG || 'baseline';
    setInterval(() => {
        const nodeRss = process.memoryUsage().rss;
        let browserRss = 0, pids = [];
        const browser = client.pupBrowser || client.pptr; // fork-dependent handle
        const bpid = browser?.process?.()?.pid;
        if (bpid) {
            pids = [bpid, ...childPidsLinux(bpid)];
            browserRss = pids.reduce((s, p) => s + rssOfPid(p), 0);
        }
        const total = nodeRss + browserRss;
        console.log(
            `[MEM:${tag}] node=${mb(nodeRss)}MB chromium=${mb(browserRss)}MB ` +
            `(pids:${pids.length}) total=${mb(total)}MB`
        );
    }, 30000).unref();
}

// ---------------------------------------------------------------------------
// Periodic browser recycle. Chromium RSS creeps up over hours; tearing the
// browser down and bringing it back flushes that creep and keeps RSS flat.
// LocalAuth preserves the session, so there's no QR re-scan.
// ---------------------------------------------------------------------------
const RECYCLE_HOURS = parseFloat(process.env.RECYCLE_HOURS || '5');
let recycling = false;

async function recycleBrowser() {
    if (recycling) return;
    recycling = true;
    try {
        // Wait (up to ~30s) for any in-flight message handling to finish.
        for (let i = 0; inFlight > 0 && i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
        }
        console.log(`♻️  Recycling browser to release memory (every ${RECYCLE_HOURS}h)…`);
        try {
            await client.destroy();
        } catch (e) {
            console.error('destroy() during recycle failed (continuing):', e?.message || e);
        }
        // Rebuild a fresh client and re-attach handlers, then bring it back up.
        client = buildClient();
        registerHandlers(client);
        await client.initialize();
        console.log('♻️  Recycle complete.');
    } catch (e) {
        console.error('Recycle failed, attempting clean re-init:', e);
        try {
            client = buildClient();
            registerHandlers(client);
            await client.initialize();
        } catch (e2) {
            console.error('Re-init after failed recycle also failed:', e2);
        }
    } finally {
        recycling = false;
    }
}

if (RECYCLE_HOURS > 0) {
    setInterval(recycleBrowser, RECYCLE_HOURS * 60 * 60 * 1000).unref();
}

// Last-resort safety nets: a stray rejection/exception in the WhatsApp page
// layer should be logged, not silently wedge or kill the bot. Railway's
// ON_FAILURE restart policy still covers a true fatal crash.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

registerHandlers(client);
startMemoryHarness();
client.initialize();
