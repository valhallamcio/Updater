/*
 * File: scamImages.js
 * Project: valhalla-updater
 * -----
 * The scam image check on SubQ Snap: how an image is made ready, the request body, and how
 * the answer is read. The image scam filter and scripts/scam-image-eval.js both use it, so
 * the eval scores the exact request the bot sends.
 *
 * SubQ sees an image only in the top-level "images" field, as plain base64 with no "data:"
 * prefix. An image_url part inside "state" or an "assets" map also gets HTTP 200, but the
 * model never sees the image. A seen image costs 66 to about 1,600 input tokens
 * (usage.input_tokens), so a request that reports less than that did not see it.
 *
 * SubQ gives one score for the whole request. With the plain "the image promotes a scam"
 * question, a scam image sent with three clean ones fell from 0.81 to 0.39, so the question
 * says one scam image is enough. With it, that same set scored 0.92.
 */

const sharp = require('sharp');

const MODEL = 'subq-snap-1.2';
// SubQ takes up to 4 images per request, 4 MiB each decoded. Above about 1.6 megapixels
// an image costs more and scores no better.
const MAX_PER_REQUEST = 4;
const MAX_PIXELS = 1600000;
const MAX_BYTES = 4 * 1024 * 1024;
const MEDIA_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const STATE = 'Image attachment posted in a Minecraft community Discord server';

const QUESTIONS = {
    scam: {
        type: 'noul',
        instructions: 'At least one of the attached images promotes a scam: a fake giveaway, free crypto or casino bonus, promo code for free money, a fake celebrity announcement, or a screenshot that shows a fake withdrawal or payout to lure people. Judge each image on its own; one scam image is enough.',
        criteria: {
            true: 'Fake celebrity crypto casino posts, promo codes for free money, withdrawal-success or wallet-received screenshots used as proof, gift card or Nitro giveaways.',
            false: 'Video game screenshots (Minecraft builds, inventories, menus, chat, error screens), memes, art, photos of people or pets, ordinary app or website screenshots that do not push free money.'
        }
    },
    kind: {
        type: 'choice',
        instructions: 'Which kind of scam does the image show? Pick none when it shows no scam.',
        criteria: {
            celebrity_casino: 'A celebrity or streamer (MrBeast, Elon Musk and the like) announcing a crypto casino, a giveaway or free money',
            promo_code: 'A casino or crypto site page that asks the viewer to enter or activate a promo or bonus code',
            fake_payout: 'A withdrawal-success, payout, wallet balance or received-crypto screenshot shown as proof of winnings',
            giveaway: 'A gift card, Discord Nitro, Steam or game item giveaway that asks people to claim it or log in',
            phishing: 'A fake login, verification or QR code page that asks for an account, a password or a scan',
            other_scam: 'Another scam that offers free money or a deal that is too good to be true',
            none: 'No scam'
        }
    }
};

const KINDS = {
    celebrity_casino: 'Celebrity crypto casino ad',
    promo_code: 'Promo or bonus code page',
    fake_payout: 'Fake payout or wallet screenshot',
    giveaway: 'Fake giveaway (Nitro, gift card, items)',
    phishing: 'Phishing or fake login',
    other_scam: 'Other scam',
    none: 'No scam'
};

/**
 * Makes an image ready for SubQ. A PNG, JPEG or WebP that is small enough goes as it is.
 * Anything else (a GIF or animated WebP takes its first frame, a large photo, AVIF, TIFF)
 * is scaled to 1.6 megapixels at most and sent as a JPEG.
 * @param {Buffer} input The file bytes.
 * @returns {Promise<{mediaType: string, buffer: Buffer, width: number, height: number}>}
 * @throws When sharp cannot read the file.
 */
async function prepareImage(input) {
    const image = sharp(input, { pages: 1, limitInputPixels: 100000000 });
    const meta = await image.metadata();
    const width = meta.width;
    const height = meta.pageHeight || meta.height;
    if (!width || !height) throw new Error('image has no size');
    const pixels = width * height;
    const mediaType = MEDIA_TYPES[meta.format];
    if (mediaType && (meta.pages || 1) === 1 && pixels <= MAX_PIXELS && input.length <= MAX_BYTES) {
        return { mediaType, buffer: input, width, height };
    }
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / pixels));
    const size = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
    const buffer = await image
        .resize({ ...size, fit: 'inside' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer();
    return { mediaType: 'image/jpeg', buffer, ...size };
}

/**
 * The request body for up to four images of one message.
 * @param {Array<{mediaType: string, buffer: Buffer}>} images Prepared images.
 * @returns {object} The JSON body for POST /v1/systemone.
 */
function buildRequest(images) {
    if (!images.length || images.length > MAX_PER_REQUEST) {
        throw new Error('a SubQ request takes 1 to ' + MAX_PER_REQUEST + ' images');
    }
    return {
        model: MODEL,
        state: STATE,
        images: images.map(image => ({ mediaType: image.mediaType, base64: image.buffer.toString('base64') })),
        questions: QUESTIONS
    };
}

/**
 * Reads the scam score and the scam kind out of a SubQ answer. The kind is only shown on a
 * hit, so when the model picks "none" it falls back to the likeliest scam kind.
 * @param {object} data The response body.
 * @returns {{score: number, kind: string, label: string, kindProbability: number|null, choice: string|null, tokens: number|null}}
 *     "choice" is the model's own pick, "none" included.
 * @throws When the answer has no scam score.
 */
function readAnswer(data) {
    const answers = (data && data.answers) || {};
    const score = Number(answers.scam && answers.scam.noul);
    if (!(answers.scam && Number.isFinite(score))) throw new Error('SubQ answer has no scam score');

    const kindAnswer = answers.kind || {};
    const options = Object.keys(QUESTIONS.kind.criteria);
    const probability = {};
    if (Array.isArray(kindAnswer.probabilities)) {
        options.forEach((option, i) => { probability[option] = Number(kindAnswer.probabilities[i]) || 0; });
    } else if (kindAnswer.probabilities && typeof kindAnswer.probabilities === 'object') {
        for (const option of options) probability[option] = Number(kindAnswer.probabilities[option]) || 0;
    }
    let kind = KINDS[kindAnswer.choice] ? kindAnswer.choice : null;
    if (!kind || kind === 'none') {
        const best = options.filter(option => option !== 'none')
            .sort((a, b) => (probability[b] || 0) - (probability[a] || 0))[0];
        kind = probability[best] > 0 ? best : 'other_scam';
    }
    return {
        score,
        kind,
        label: KINDS[kind],
        kindProbability: kind in probability ? probability[kind] : null,
        choice: kindAnswer.choice || null,
        tokens: data.usage && Number.isFinite(data.usage.input_tokens) ? data.usage.input_tokens : null
    };
}

module.exports = { MODEL, MAX_PER_REQUEST, MAX_PIXELS, STATE, QUESTIONS, KINDS, EXTENSIONS, prepareImage, buildRequest, readAnswer };
