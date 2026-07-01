// Gemini image generation with multi-key fallback.
//
// Reads a comma-separated list of API keys from GEMINI_API_KEYS (falls back to
// the single GEMINI_API_KEY). Tries each key in order; on an auth/quota/server
// error it moves to the next key. If every key fails, throws an aggregated
// error so the caller can tell the user "API key not working".

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

function getKeys() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Generate an image from a text prompt.
// Returns { base64, mimeType } on success, throws on total failure.
async function generatePosterImage(prompt) {
    const keys = getKeys();
    if (!keys.length) {
        throw new Error('No Gemini API keys configured (set GEMINI_API_KEYS in .env).');
    }

    const errors = [];

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                }),
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                // 400/401/403 = bad key / permission; 429 = quota; 5xx = server.
                // All are worth trying the next key for.
                errors.push(`key #${i + 1}: HTTP ${res.status} ${text.slice(0, 200)}`);
                continue;
            }

            const data = await res.json();
            const parts = data?.candidates?.[0]?.content?.parts || [];
            const imgPart = parts.find(p => p.inlineData?.data);

            if (!imgPart) {
                // Model responded but returned no image (e.g. safety block or
                // it replied with text only). Surface that; don't retry keys.
                const textPart = parts.find(p => p.text)?.text;
                throw new Error(
                    'NO_IMAGE:' + (textPart ? textPart.slice(0, 300) : 'model returned no image data')
                );
            }

            return {
                base64: imgPart.inlineData.data,
                mimeType: imgPart.inlineData.mimeType || 'image/png',
            };
        } catch (e) {
            // A genuine "no image / safety" result shouldn't fall through to the
            // next key — it isn't a key problem. Re-throw it.
            if (e?.message?.startsWith('NO_IMAGE:')) {
                throw new Error(e.message.replace('NO_IMAGE:', '').trim() || 'Model returned no image.');
            }
            errors.push(`key #${i + 1}: ${e?.message || e}`);
        }
    }

    throw new Error('All Gemini API keys failed. ' + errors.join(' | '));
}

module.exports = { generatePosterImage };
