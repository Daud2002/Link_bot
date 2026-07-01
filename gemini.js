// Gemini image generation with multi-key fallback, via the official @google/genai SDK.
//
// Reads a comma-separated list of API keys from GEMINI_API_KEYS (falls back to
// the single GEMINI_API_KEY). Tries each key in order; on an auth/quota/server
// error it moves to the next key. If every key fails, throws an aggregated
// error so the caller can tell the user "API key not working".

const { GoogleGenAI } = require('@google/genai');

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

function getKeys() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Pull the first inline image out of a generateContent response.
function extractImage(response) {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.data);
    if (imgPart) {
        return {
            base64: imgPart.inlineData.data,
            mimeType: imgPart.inlineData.mimeType || 'image/png',
        };
    }
    // Model responded but returned no image (e.g. safety block or text-only reply).
    const textPart = parts.find(p => p.text)?.text;
    return { noImage: textPart ? textPart.slice(0, 300) : 'model returned no image data' };
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
        try {
            const ai = new GoogleGenAI({ apiKey: key });
            const response = await ai.models.generateContent({
                model: MODEL,
                contents: prompt,
            });

            const result = extractImage(response);
            if (result.base64) {
                return { base64: result.base64, mimeType: result.mimeType };
            }
            // A genuine "no image / safety" result isn't a key problem — don't
            // fall through to the next key; surface it to the user.
            throw new Error(`NO_IMAGE:${result.noImage}`);
        } catch (e) {
            const msg = e?.message || String(e);
            if (msg.startsWith('NO_IMAGE:')) {
                throw new Error(msg.replace('NO_IMAGE:', '').trim() || 'Model returned no image.');
            }
            // Auth / quota / server error for this key — try the next one.
            errors.push(`key #${i + 1}: ${msg.slice(0, 200)}`);
        }
    }

    throw new Error('All Gemini API keys failed. ' + errors.join(' | '));
}

module.exports = { generatePosterImage };
