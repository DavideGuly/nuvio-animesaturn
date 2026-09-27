const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const ANIMESATURN_URL = 'https://www.animesaturn.net/';

const builder = new addonBuilder({
  id: 'org.animesaturn.nuviocatalog',
  version: '1.1.0',
  name: 'AnimeSaturn Catalogo Nuvio',
  description: 'Mostra gli ultimi anime aggiornati su AnimeSaturn in ordine cronologico.',
  resources: ['catalog', 'meta'],
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
let cachedMetaMap = new Map();

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
    console.log('[AnimeSaturn] Estrazione ultimi anime in ordine cronologico...');

    const response = await axios.get(ANIMESATURN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const animeLinks = [];

    // Seleziona i box delle ultime uscite in ordine sequenziale di pagina
    $('.anime-card, .ep-card, .archive-card, .card').each((i, el) => {
      const link = $(el).find('a[href*="/anime/"]').first().attr('href');
      if (link) {
        const parts = link.split('/anime/')[1];
        if (parts) {
          const slug = parts.split('?')[0].split('#')[0];
          if (slug && !animeLinks.includes(slug)) {
            animeLinks.push(slug);
          }
        }
      }
    });

    // Fallback se i selettori di classe cambiano
    if (animeLinks.length === 0) {
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
    }

    const topSlugs = animeLinks.slice(0, 30);
    const newCatalog = [];
    const newMetaMap = new Map();

    for (const slug of topSlugs) {
      const searchQuery = cleanTitle(slug);
      if (!searchQuery) continue;

      try {
        const aniListRes = await axios.post('https://graphql.anilist.co', {
          query: `
            query ($search: String) {
              Media (search: $search, type: ANIME) {
                id
                idMal
                title { romaji english native }
                coverImage { extraLarge }
                bannerImage
                description
                genres
                status
                episodes
              }
            }
          `,
          variables: { search: searchQuery }
        }, { timeout: 4000 });

        const media = aniListRes.data?.data?.Media;
        if (media) {
          const metaId = `kitsu:${media.id}`;
          
          if (!newCatalog.some(item => item.id === metaId)) {
            const metaObject = {
              id: metaId,
              type: 'series',
              name: media.title.romaji || media.title.english || searchQuery,
              poster: media.coverImage.extraLarge,
              background: media.bannerImage,
              description: media.description ? media.description.replace(/<[^>]*>?/gm, '') : '',
              genres: media.genres || [],
              status: media.status
            };

            newCatalog.push(metaObject);
            newMetaMap.set(metaId, metaObject);
          }
        }
      } catch (e) {
        console.warn(`[AniList] Saltato: "${searchQuery}" (${e.message})`);
      }
    }

    if (newCatalog.length > 0) {
      cachedCatalog = newCatalog;
      cachedMetaMap = newMetaMap;
      console.log(`[AnimeSaturn] Catalogo aggiornato (${cachedCatalog.length} anime in ordine)`);
    }
  } catch (err) {
    console.error('[AnimeSaturn] Errore aggiornamento:', err.message);
  }
}

// Handler Catalogo
builder.defineCatalogHandler(({ type, id }) => {
  if (type === 'anime' && id === 'animesaturn_latest') {
    return Promise.resolve({ metas: cachedCatalog });
  }
  return Promise.resolve({ metas: [] });
});

// Handler Metadati (Risolve l'errore "Caricamento fallito" al click)
builder.defineMetaHandler(({ type, id }) => {
  if (cachedMetaMap.has(id)) {
    return Promise.resolve({ meta: cachedMetaMap.get(id) });
  }
  return Promise.resolve({ meta: null });
});

cron.schedule('0 19 * * *', () => {
  updateAnimeSaturnCatalog();
});

const PORT = process.env.PORT || 7000;

updateAnimeSaturnCatalog().then(() => {
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Server Nuvio attivo sulla porta: ${PORT}`);
});
