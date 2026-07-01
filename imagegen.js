// Free image generation via Pollinations.ai (Flux model), no API key required.
//
// Pollinations' keyless endpoint (image.pollinations.ai) generates an image
// directly from a text prompt in the URL and returns the image bytes. This
// avoids the paid-tier quota problem that blocks Gemini's image models on a
// free account.
//
// Env overrides:
//   IMAGE_MODEL   - pollinations model (default "flux"); e.g. flux, turbo
//   IMAGE_WIDTH   - output width  (default 1024)
//   IMAGE_HEIGHT  - output height (default 1024)
//   POLLINATIONS_KEY - optional; if set, uses the authenticated gen.pollinations.ai
//                      endpoint (more models / higher limits). Not required.

const MODEL = process.env.IMAGE_MODEL || 'flux';
const WIDTH = parseInt(process.env.IMAGE_WIDTH || '1024', 10);
const HEIGHT = parseInt(process.env.IMAGE_HEIGHT || '1024', 10);
const POLLINATIONS_KEY = (process.env.POLLINATIONS_KEY || '').trim();

// A stable, reasonable timeout — Flux generation can take 10–40s.
const TIMEOUT_MS = parseInt(process.env.IMAGE_TIMEOUT_MS || '90000', 10);

// Generate an image from a text prompt.
// Returns { base64, mimeType } on success, throws on failure.
async function generatePosterImage(prompt) {
    const encoded = encodeURIComponent(prompt);

    // Prefer the authenticated endpoint only if a key is provided; otherwise
    // use the free keyless endpoint (Flux, no billing required).
    const params = new URLSearchParams({
        model: MODEL,
        width: String(WIDTH),
        height: String(HEIGHT),
        nologo: 'true',
        // -1 asks the server to pick a random seed so repeated prompts vary.
        seed: '-1',
    });

    const url = POLLINATIONS_KEY
        ? `https://gen.pollinations.ai/image/${encoded}?${params}`
        : `https://image.pollinations.ai/prompt/${encoded}?${params}`;

    const headers = POLLINATIONS_KEY
        ? { Authorization: `Bearer ${POLLINATIONS_KEY}` }
        : {};

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(url, { headers, signal: controller.signal });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Image service HTTP ${res.status} ${body.slice(0, 200)}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
            const body = await res.text().catch(() => '');
            throw new Error(`Image service returned non-image (${contentType}): ${body.slice(0, 200)}`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) {
            throw new Error('Image service returned an empty image.');
        }

        return { base64: buf.toString('base64'), mimeType: contentType.split(';')[0] };
    } catch (e) {
        if (e?.name === 'AbortError') {
            throw new Error('Image generation timed out. Please try again.');
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { generatePosterImage };
