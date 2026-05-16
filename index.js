const express = require('express');
const axios = require('axios');
const cors = require("cors");
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const EXCEPTIONS_PATH = path.join(__dirname, 'data.json');

const app = express();
const port = 4059;

const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

app.use(cors());

let EXCEPTIONS = {};

if (fs.existsSync(EXCEPTIONS_PATH)) {
    EXCEPTIONS = JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, 'utf-8'));
}

function getCacheFilePath(key) {
    return path.join(CACHE_DIR, key + '.json');
}

function readCache(key) {
    const filePath = getCacheFilePath(key);

    if (!fs.existsSync(filePath)) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        if (raw.expiresAt < Date.now()) {
            fs.unlinkSync(filePath);
            console.log('[CACHE] Expired → Deleted:', key);
            return null;
        }

        return raw;
    } catch (e) {
        // 🔥 corrupted file → delete
        fs.unlinkSync(filePath);
        console.log('[CACHE] Corrupted → Deleted:', key);
        return null;
    }
}
function applyEpisodeException(animeId, episode) {
    const rule = EXCEPTIONS[animeId];

    const epNum = parseInt(episode, 10);

    if (!rule) return epNum;

    if (rule.type === "offset") {
        if (epNum >= rule.startFrom) {
            const newEp = epNum + rule.offset;
            return newEp < 1 ? 1 : newEp;
        }
    }

    return epNum;
}
function writeCache(key, data) {
    const filePath = getCacheFilePath(key);

    const payload = {
        data,
        createdAt: Date.now(),
        expiresAt: Date.now() + (10 * 24 * 60 * 60 * 1000) // 10 days
    };

    fs.writeFileSync(filePath, JSON.stringify(payload));
}

function getCacheKey(animeId, episode) {
    return `${animeId}_${episode}`;
}

async function fetchMultiServer(animeId, episode) {
    const apiUrl = `https://animelok.xyz/api/anime/${animeId}/episodes/${episode}`;

    const response = await axios.get(apiUrl, {
        headers: {
            'Accept': 'application/json'
        },
        timeout: 10000
    } );

    const servers = response.data?.episode?.servers || [];
    
    // Fix: Use .includes() or check for the new name "Multi (ToonStream)"
    const multi = servers.find(
    s => s.name && s.name.toLowerCase().includes('multi')
);


    if (!multi || !multi.url) {
        throw new Error('Multi server not found');
    }

    const parsed = new URL(multi.url);
return `https://as-cdn21.top${parsed.pathname}`;
}


async function searchAnimeId(keyword) {
    const searchUrl = `https://animelok.xyz/search?keyword=${encodeURIComponent(keyword)}`;

    const response = await axios.get(searchUrl, {
        headers: {
            'Accept': 'text/html'
        },
        timeout: 10000
    });

    const $ = cheerio.load(response.data);

    const href = $('a[href^="/anime/"]').first().attr('href');

    if (!href) {
        throw new Error('No anime found in search');
    }

    return href.replace('/anime/', '').trim();
}

async function fetchLanguagePage(languageId, page) {
    const url = `https://animelok.xyz/languages/${languageId}?page=${page}`;

    const response = await axios.get(url, {
        headers: {
            'Accept': 'text/html'
        },
        timeout: 10000
    } );

const $ = cheerio.load(response.data);

let animeIds = [];

$('a.w-full.flex.flex-col.group.gap-2.relative').each((i, el) => {

    const type = $(el).find('span.uppercase').last().text().trim().toUpperCase();

    if (type === 'CARTOON') return;

    const href = $(el).attr('href');

    if (href && href.startsWith('/anime/')) {
        animeIds.push(href.replace('/anime/', '').trim());
    }
});

animeIds = [...new Set(animeIds)];

return { animeIds };

}
async function fetchExtractorFallback(animeId, episode) {
const isEpisodeFormat = /x\d+$/i.test(animeId);
const isMovie = !isEpisodeFormat;
if (isMovie) {

    console.log('[INFO] Movie detected → AnimeSalt fallback');

    const movieId = `movies/${animeId}`;

    const infoUrl = `https://animesalt.streamindia.co.in/api/info?id=${movieId}`;

    const response = await axios.get(infoUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
    });

    const servers = response.data?.anime?.watchServers || [];

    const multi = servers.find(s =>
        s.url && s.url.includes('as-cdn21.top')
    );

    if (!multi) throw new Error('Movie fallback failed');

    return multi.url;
}

const match = animeId.match(/(.+)x(\d+)$/i);

if (!match) {
    throw new Error('Invalid animeId format');
}

const base = match[1];
const startEpisode = parseInt(match[2], 10);
const epOffset = parseInt(episode, 10);

let finalEpisode;

// If starting from x1 → behave exactly like before
if (startEpisode === 1) {
    finalEpisode = epOffset;
} else {
    // If starting from x4/x5/etc → shift forward
    finalEpisode = startEpisode + (epOffset - 1);
}

const finalId = `${base}x${finalEpisode}`;

console.log('[INFO] Final AnimeSalt ID:', finalId);

    const episodeUrl = `https://animesalt.ac/episode/${finalId}/`;

    const apiUrl = `https://anime.streamindia.co.in/api/extract?url=${encodeURIComponent(episodeUrl)}`;

    const response = await axios.get(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000
    });

    if (!response.data?.success || !response.data?.data?.videoPlayerUrl) {
        throw new Error('Extractor fallback failed');
    }

    const originalUrl = response.data.data.videoPlayerUrl;

const parsed = new URL(originalUrl);

// Force your domain
const forcedUrl = `https://as-cdn21.top${parsed.pathname}`;

return forcedUrl;

}

app.get('/api/anime', async (req, res) => {
const animeId = req.query.id;
let episode = req.query.ep;

if (!animeId || !episode) {
    return res.status(400).json({
        error: 'Missing id or ep query parameters'
    });
}

episode = applyEpisodeException(animeId, episode);

    const cacheKey = getCacheKey(animeId, episode);
const cached = readCache(cacheKey);

if (cached) {
    return res.json({
        ...cached.data,
        cached: true,
        expiresAt: new Date(cached.expiresAt).toISOString()
    });
}

    try {
        let result;
        try {
            const multi = await fetchMultiServer(animeId, episode);
            result = { multi };
} catch (primaryError) {

    console.log('[INFO] Primary failed → using extractor fallback');

    const fallbackUrl = await fetchExtractorFallback(animeId, episode);

    result = {
        fallback: true,
        multi: fallbackUrl
    };
}

writeCache(cacheKey, result);

        return res.json(result);

    } catch (error) {
        console.error('[ERROR]', error.message);
        return res.status(404).json({
            error: 'Anime not found or episode unavailable'
        });
    }
});

async function fetchFullLanguage(lang) {

    let page = 1;
    let allIds = new Set();
    let hasMore = true;

    while (hasMore) {

        console.log(`[INFO] Fetching ${lang} page ${page}`);

        const { animeIds } = await fetchLanguagePage(lang, page);

        if (!animeIds.length) break;

        animeIds.forEach(id => allIds.add(id));

        page++;
    }

    return {
        language: lang,
        total: allIds.size,
        items: [...allIds]
    };
}


app.get('/api/language', async (req, res) => {
    const page = req.query.page || 1;
    const languages = ["hindi", "tamil", "telugu", "kannada", "malayalam", "bengali"];
    
    try {
        // Use .map with a catch block for each individual request
        const results = await Promise.all(
            languages.map(lang => 
                fetchLanguagePage(lang, page).catch(err => {
                    console.log(`[INFO] No data for ${lang} on page ${page}`);
                    return { animeIds: [], totalCount: 0 }; // Return empty result on error
                })
            )
        );

        const groupedData = {};

        results.forEach((result, index) => {
            const currentLang = languages[index];
            // If result is null or animeIds is empty, it just skips this loop
            if (result && result.animeIds) {
                result.animeIds.forEach(animeId => {
                    if (!groupedData[animeId]) {
                        groupedData[animeId] = { languages: [] };
                    }
                    if (!groupedData[animeId].languages.includes(currentLang)) {
                        groupedData[animeId].languages.push(currentLang);
                    }
                });
            }
        });

        return res.json(groupedData);
    } catch (error) {
        console.error('[ERROR] /api/language:', error.message);
        return res.status(500).json({ error: 'Critical error fetching data' });
    }
});

app.get('/api/language-full', async (req, res) => {

    const lang = req.query.lang;

    if (!lang) return res.status(400).json({ error: 'Missing lang' });

    try {

        const result = await fetchFullLanguage(lang);

        res.json(result);

    } catch (e) {

        console.error(e.message);

        res.status(500).json({ error: 'Failed fetching full language' });

    }
});

app.delete('/api/cache', (req, res) => {
const files = fs.readdirSync(CACHE_DIR);
const sizeBefore = files.length;

files.forEach(file => {
    fs.unlinkSync(path.join(CACHE_DIR, file));
});
    res.json({ cleared: sizeBefore });
});

app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
});
