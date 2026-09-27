const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const ANIMESATURN_URL = 'https://www.animesaturn.net/';

const builder = new addonBuilder({
  id: 'org.animesaturn.nuviocatalog',
  version: '1.0.0',
  name: 'AnimeSaturn Catalogo Nuvio',
  description: 'Mostra gli ultimi anime aggiornati su AnimeSaturn.',
  resources: ['catalog'],
  types: ['anime', 'series'],
  catalogs: [
    {
      type: 'anime',
      id: 'animesaturn_latest',
      name: 'AnimeSaturn Ultimi Usciti'
    }
  ]
});

let cachedCatalog = [];

function cleanTitle(slug) {
  if (!slug) return '';
  let cleaned = slug.replace(/-[a-zA-Z0-9]+$/, '');
  return cleaned
    .replace(/-/g, ' ')
    .replace(/\bita\b/gi, '')
    .replace(/\bsub\b/gi, '')
    .replace(/\btv\b/gi, '')
    .replace(/stagione \d+/gi, '')
    .replace(/season \d+/gi, '')
    .trim();
}

async function updateAnimeSaturnCatalog() {
  try {
    console.log('[AnimeSaturn] Avvio recupero ultime uscite...');

    const response = await axios.get(ANIMESATURN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const animeLinks = [];

    // Raccoglie i link degli anime dalla home page
    $('a[href*="/anime/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('/anime/')) {
        const parts = href.split('/anime/')[1];
        if (parts) {
          const slug = parts.split('?')[0].split('#')[0];
          if (slug && !animeLinks.includes(slug)) {
            animeLinks.push(slug);
          }
        }
      }
    });

    // Seleziona fino a 35 titoli
    const topSlugs = animeLinks.slice(0, 35);
    const newCatalog = [];

    for (const slug of topSlugs) {
      const searchQuery = cleanTitle(slug);
      if (!searchQuery) continue;

      try {
        const aniListRes = await axios.post('https://graphql.anilist.co', {
          query: `
            query ($search: String) {
              Media (search: $search, type: ANIME) {
                id
                title { romaji english native }
                coverImage { extraLarge }
                bannerImage
                description
              }
            }
          `,
          variables: { search: searchQuery }
        }, { timeout: 4000 });

        const media = aniListRes.data?.data?.Media;
        if (media) {
          if (!newCatalog.some(item => item.id === `kitsu:${media.id}`)) {
            newCatalog.push({
              id: `kitsu:${media.id}`,
              type: 'series',
              name: media.title.romaji || media.title.english || searchQuery,
              poster: media.coverImage.extraLarge,
              background: media.bannerImage,
              description: media.description ? media.description.replace(/<[^>]*>?/gm, '') : ''
            });
          }
        }
      } catch (e) {
        console.warn(`[AniList] Saltato: "${searchQuery}" (${e.message})`);
      }
    }

    if (newCatalog.length > 0) {
      cachedCatalog = newCatalog;
      console.log(`[AnimeSaturn] Catalogo aggiornato con successo (${cachedCatalog.length} anime trovati)`);
    }
  } catch (err) {
    console.error('[AnimeSaturn] Errore aggiornamento:', err.message);
  }
}

builder.defineCatalogHandler(({ type, id }) => {
  if (type === 'anime' && id === 'animesaturn_latest') {
    return Promise.resolve({ metas: cachedCatalog });
  }
  return Promise.resolve({ metas: [] });
});

cron.schedule('0 19 * * *', () => {
  updateAnimeSaturnCatalog();
});

const PORT = process.env.PORT || 7000;

updateAnimeSaturnCatalog().then(() => {
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Server Nuvio attivo sulla porta: ${PORT}`);
});
