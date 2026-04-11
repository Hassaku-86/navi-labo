/**
 * update-listings.mjs
 * ヤフオク出品者ページをスクレイピングして index.html の商品データを自動更新する
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SELLER_ID = 'AG6JYKNcYAuXEaxSTT625GH6WDrt5';
const SELLER_URL = `https://auctions.yahoo.co.jp/seller/${SELLER_ID}`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      console.warn(`HTTP ${res.status} for ${url} (attempt ${i + 1})`);
    } catch (e) {
      console.warn(`Fetch error (attempt ${i + 1}): ${e.message}`);
    }
    if (i < retries - 1) await sleep(2000 * (i + 1));
  }
  return null;
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractAuctionId(url = '') {
  const m = url.match(/\/auction\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

function detectBrand(text = '') {
  const t = text.toLowerCase();
  if (t.includes('carrozzeria') || t.includes('カロッツェリア') || t.match(/avic-/)) return 'carrozzeria';
  if (t.includes('kenwood') || t.includes('ケンウッド') || t.match(/mdv-/)) return 'kenwood';
  return 'other';
}

function brandLabel(brand) {
  if (brand === 'carrozzeria') return 'Carrozzeria';
  if (brand === 'kenwood') return 'KENWOOD';
  return 'Other';
}

/**
 * __NEXT_DATA__ から商品リストを取得
 */
function parseNextData(data) {
  if (!data) return [];

  // 正しいパス: props.pageProps.initialState.search.items.listing.items
  const listing = data?.props?.pageProps?.initialState?.search?.items?.listing;
  const items = listing?.items;

  if (Array.isArray(items) && items.length > 0) {
    return items.map(item => mapItem(item)).filter(Boolean);
  }
  return [];
}

function mapItem(item) {
  if (!item) return null;
  const id = item.auctionId || extractAuctionId(item.url || '');
  if (!id) return null;

  const title = item.title || '';
  const brand = detectBrand(title);

  // buyNowPrice（即決価格）があれば即決、なければ現在価格
  const rawPrice = item.buyNowPrice || item.price || 0;
  const price = typeof rawPrice === 'number' ? rawPrice.toLocaleString('ja-JP') : String(rawPrice).replace(/[^0-9,]/g, '');
  const pl = item.buyNowPrice ? '即決' : '現在';

  const img = item.imageUrl || '';
  const endTime = item.endTime
    ? new Date(item.endTime).getTime()
    : Date.now() + 48 * 3600000;

  return { id, brand, bl: brandLabel(brand), title, price, pl, img, ends: endTime, tags: [brand] };
}

/**
 * HTMLから正規表現でオークションIDを抽出（フォールバック）
 */
function parseHTML(html) {
  const ids = new Set();
  const re = /href="https?:\/\/(?:page\.)?auctions\.yahoo\.co\.jp\/(?:jp\/)?auction\/([a-z0-9]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);

  // img候補
  const imgMap = {};
  const imgRe = /auction\/([a-z0-9]+)[^"]*"[^>]*>[\s\S]{0,200}?src="(https:\/\/auctions\.c\.yimg\.jp[^"]+)"/gi;
  while ((m = imgRe.exec(html)) !== null) imgMap[m[1]] = m[2];

  return [...ids].map(id => ({
    id,
    brand: 'carrozzeria',
    bl: 'Carrozzeria',
    title: '',
    price: '0',
    pl: '即決',
    img: imgMap[id] || '',
    ends: Date.now() + 48 * 3600000,
    tags: ['carrozzeria'],
  }));
}

/**
 * 商品配列を JavaScript コードに変換
 */
function toJS(products) {
  const lines = products.map(p => {
    const tags = JSON.stringify(p.tags);
    return `  { id:${JSON.stringify(p.id)}, brand:${JSON.stringify(p.brand)}, bl:${JSON.stringify(p.bl)}, model:'', title:${JSON.stringify(p.title)}, desc:'', price:${JSON.stringify(p.price)}, pl:${JSON.stringify(p.pl)}, ship:'送料無料', ends:${p.ends}, img:${JSON.stringify(p.img)}, tags:${tags} }`;
  });
  return `const products = [\n${lines.join(',\n')}\n];`;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Fetching Yahoo Auctions seller page...`);

  const html = await fetchPage(SELLER_URL);
  if (!html) {
    console.error('Failed to fetch seller page. Keeping existing data.');
    process.exit(0); // exit 0 to avoid failing the CI job
  }

  // 1) Try __NEXT_DATA__
  const nextData = extractNextData(html);
  let products = parseNextData(nextData);
  console.log(`__NEXT_DATA__ parse: ${products.length} items`);

  // 2) Fallback to HTML parsing
  if (products.length === 0) {
    products = parseHTML(html);
    console.log(`HTML parse fallback: ${products.length} items`);
  }

  if (products.length === 0) {
    console.warn('No products found. Keeping existing data.');
    process.exit(0);
  }

  const indexPath = join(ROOT, 'index.html');
  let indexHtml = readFileSync(indexPath, 'utf-8');

  const newJS = toJS(products);
  const updated = indexHtml.replace(/const products = \[[\s\S]*?\];/, newJS);

  if (updated === indexHtml) {
    console.warn('Could not find products array in index.html. Check the regex.');
    process.exit(0);
  }

  writeFileSync(indexPath, updated, 'utf-8');
  console.log(`Done. Updated index.html with ${products.length} active listings.`);
}

main();
