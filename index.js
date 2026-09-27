const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const ANIMESATURN_URL = 'https://www.animesaturn.net/';

const builder = new addonBuilder({
  id: 'org.animesaturn.nuviocatalog',
  version: '1.0.0',
  name: 'AnimeSaturn Catalogo Nuvio',
  description: 'Aggiunge un catalogo con l\'ultimo anime pubblicato su AnimeSaturn.',
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
  
  // Rimuove l'ID alfanumerico finale generato dal sito (es. -Qqj3j)
  let cleaned = slug.replace(/-[a-zA-Z0-9]+$/, '');

  // Sostituisce i trattini con gli spazi e pulisce i tag inutili
  cleaned = cleaned
    .replace(/-/g, ' ')
    .replace(/\bita\b/gi, '')
    .replace(/\bsub\b/gi, '')
    .replace(/\btv\b/gi, '')
    .replace(/stagione \d+/gi, '')
    .replace(/season \d+/gi, '')
    .trim();

  return cleaned;
}

async function updateAnimeSaturnCatalog() {
  try {
    console.log('[AnimeSaturn] Avvio recupero da animesaturn.net...');

    const response = await axios.get(ANIMESATURN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);

    let rawSlug = '';

    // Trova il primo link valido ad un anime
    const firstAnimeLink = $('a[href*="/anime/"]').first().attr('href');

    if (firstAnimeLink) {
      const parts = firstAnimeLink.split('/anime/')[1];
      if (parts) {
        rawSlug = parts.split('?')[0].split('#')[0];
      }
    }

    if (!rawSlug) {
      console.warn('[AnimeSaturn] Impossibile estrarre lo slug dell\'anime.');
      return;
    }

    const searchQuery = cleanTitle(rawSlug);
    console.log(`[AnimeSaturn] Slug estratto: "${rawSlug}" -> Cerco su AniList: "${searchQuery}"`);

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
    }, { timeout: 5000 });

    const media = aniListRes.data.data.Media;

    if (media) {
      cachedCatalog = [{
        id: `kitsu:${media.id}`,
        type: 'series',
        name: media.title.romaji || media.title.english || searchQuery,
        poster: media.coverImage.extraLarge,
        background: media.bannerImage,
        description: media.description ? media.description.replace(/<[^>]*>?/gm, '') : ''
      }];
      console.log(`[AnimeSaturn] Catalogo aggiornato con successo: kitsu:${media.id}`);
    } else {
      console.warn('[AnimeSaturn] Nessun risultato trovato su AniList.');
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
