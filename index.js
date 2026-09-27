const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const ANIMESATURN_URL = 'https://www.animesaturn.net/';

const builder = new addonBuilder({
  id: 'org.animesaturn.nuviocatalog',
  version: '1.2.0',
  name: 'AnimeSaturn Catalogo Nuvio',
  description: 'Mostra gli ultimi anime usciti su AnimeSaturn in ordine cronologico.',
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

function cleanTitle(title) {
  if (!title) return '';
  return title
    .replace(/\(ITA\)/gi, '')
    .replace(/SUB ITA/gi, '')
    .replace(/\(TV\)/gi, '')
    .replace(/Episodio \d+/gi, '')
    .replace(/EP \d+/gi, '')
    .replace(/Stagione \d+/gi, '')
    .replace(/Season \d+/gi, '')
    .trim();
}

async function updateAnimeSaturnCatalog() {
  try {
    console.log('[AnimeSaturn] Avvio scraping griglia "Ultime Uscite"...');

    const response = await axios.get(ANIMESATURN_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const animeTitles = [];

    // Estrae i titoli direttamente dalle card presenti nella sezione "Ultime uscite"
    $('.main-anime-card, .anime-card, .ep-card, .card').each((i, el) => {
      // Cerca prima nel testo del titolo card o dell'alt/title dell'immagine
      let title = $(el).find('.anime-title, .card-title, .title, a.anime-link').text().trim();
      
      if (!title) {
        title = $(el).find('img').attr('alt') \vert{}\vert{}$(el).find('a').attr('title');
      }

      if (title) {
        const cleaned = cleanTitle(title);
        if (cleaned && !animeTitles.includes(cleaned)) {
          animeTitles.push(cleaned);
        }
      }
    });

    // Se i selettori di classe falliscono, estrae i link contenuti nel blocco principale
    if (animeTitles.length === 0) {
      $('a[href*="/anime/"]').each((i, el) => {
        const text = $(el).text().trim();
        const cleaned = cleanTitle(text);
        if (cleaned && cleaned.length > 2 && !animeTitles.includes(cleaned)) {
          animeTitles.push(cleaned);
        }
      });
    }

    const topTitles = animeTitles.slice(0, 20);
    const newCatalog = [];
    const newMetaMap = new Map();

    for (const titleQuery of topTitles) {
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
                genres
                status
              }
            }
          `,
          variables: { search: titleQuery }
        }, { timeout: 4000 });

        const media = aniListRes.data?.data?.Media;
        if (media) {
          const metaId = `kitsu:${media.id}`;
          
          if (!newCatalog.some(item => item.id === metaId)) {
            const metaObject = {
              id: metaId,
              type: 'series',
              name: media.title.romaji || media.title.english || titleQuery,
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
        console.warn(`[AniList] Saltato: "${titleQuery}" (${e.message})`);
      }
    }

    if (newCatalog.length > 0) {
      cachedCatalog = newCatalog;
      cachedMetaMap = newMetaMap;
      console.log(`[AnimeSaturn] Catalogo aggiornato con successo (${cachedCatalog.length} anime estratti)`);
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
