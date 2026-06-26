import fs from 'node:fs/promises';

const API_KEY = process.env.OWM_API_KEY;
const ENDPOINT = 'https://api.openweathermap.org/data/2.5/weather';

// 「今、雨が降っている」とみなす天気
const RAIN_CONDITIONS = ['Rain', 'Drizzle', 'Thunderstorm'];

async function main() {
  if (!API_KEY) {
    throw new Error('OWM_API_KEY が設定されていません');
  }

  // products.json を読み込む
  const raw = await fs.readFile('./products.json', 'utf-8');
  const products = JSON.parse(raw);

  // 産地（緯度経度）の重複を排除 → 同じ産地は1回しか天気を取りに行かない
  const uniqueLocations = [];
  const seen = new Set();
  for (const p of products) {
    const key = `${p.lat},${p.lon}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueLocations.push({ key, lat: p.lat, lon: p.lon });
    }
  }

  // 各産地の天気を取得
  const weatherByLoc = {};
  for (const loc of uniqueLocations) {
    try {
      const url = `${ENDPOINT}?lat=${loc.lat}&lon=${loc.lon}&appid=${API_KEY}&units=metric&lang=ja`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`天気取得失敗 (${loc.key}): HTTP ${res.status}`);
        continue; // この産地はスキップ（＝雨ではない扱い）
      }
      const data = await res.json();
      const main = data.weather?.[0]?.main ?? '';
      const isRain = RAIN_CONDITIONS.includes(main);
      weatherByLoc[loc.key] = {
        description: data.weather?.[0]?.description ?? '',
        rain1h: data.rain?.['1h'] ?? 0,
        isRain,
      };
    } catch (err) {
      console.error(`天気取得エラー (${loc.key}):`, err.message);
      // エラー時もスキップ（フェイルセーフ：雨ではない扱い）
    }
  }

  // フロントが読む形に整形
  const output = {
    updatedAt: new Date().toISOString(),
    products: products.map((p) => {
      const w = weatherByLoc[`${p.lat},${p.lon}`] ?? null;
      const isRain = w?.isRain ?? false;
      return {
        id: p.id,
        tiketId: p.tiketId ?? null,
        jspUrl: p.jspUrl ?? null,
        origin: p.origin,
        isRain,
        weather: w?.description ?? '',
        message: isRain ? p.rainMessage : null,
        rainImage: p.rainImage,
      };
    }),
  };

  await fs.mkdir('./docs', { recursive: true });
  await fs.writeFile('./docs/weather.json', JSON.stringify(output, null, 2));
  console.log('done:', output.updatedAt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
