import fs from 'node:fs/promises';

// 気象庁エンドポイント（APIキー不要）
const FORECAST_ENDPOINT = 'https://www.jma.go.jp/bosai/forecast/data/forecast';
const WARNING_ENDPOINT  = 'https://www.jma.go.jp/bosai/warning/data/warning';

// Slack通知用のWebhook URL（GitHub Secrets から渡す）
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// 府県コード → 県名（警報表示用）
const PREF_NAMES = {
  '100000': '群馬県',
  '110000': '埼玉県',
  '120000': '千葉県',
  '220000': '静岡県',
  // 産地を追加したらここにも県名を足す
};

// 「災害級」とみなす警報コード（=これが出ていたら恵みの雨演出を止める）
const DISASTER_WARNING_CODES = new Set([
  '03', // 大雨警報
  '04', // 洪水警報
  '33', // 大雨特別警報
]);

// 警報コード → 日本語名（通知表示用）
const WARNING_NAMES = {
  '02': '暴風雪警報', '03': '大雨警報', '04': '洪水警報', '05': '暴風警報',
  '06': '大雪警報', '07': '波浪警報', '08': '高潮警報',
  '32': '暴風雪特別警報', '33': '大雨特別警報', '35': '暴風特別警報',
  '36': '大雪特別警報', '37': '波浪特別警報', '38': '高潮特別警報',
};

// 警報チェックに失敗したとき、安全側に倒して演出を止めるか（true=止める）
const FAIL_SAFE_SUPPRESS = true;

// 気象庁の天気コードが「雨」かどうか（300番台=雨）
function isRainCode(code) {
  const n = Number(code);
  return Number.isFinite(n) && n >= 300 && n < 400;
}

async function fetchForecastMap(area) {
  const res = await fetch(`${FORECAST_ENDPOINT}/${area}.json`);
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  const data = await res.json();
  const series = data?.[0]?.timeSeries?.[0];
  const map = {};
  for (const a of series?.areas ?? []) {
    map[a.area.code] = a.weatherCodes?.[0] ?? '';
  }
  return map;
}

// 警報を取得。details に 警報名・地域名・県名 を持たせる
async function fetchDisasterActive(area) {
  const res = await fetch(`${WARNING_ENDPOINT}/${area}.json`);
  if (!res.ok) throw new Error(`warning HTTP ${res.status}`);
  const data = await res.json();
  const prefName = PREF_NAMES[area] ?? '';
  const codes = new Set();
  const details = []; // { code, name, areaName, prefName }
  for (const at of data?.areaTypes ?? []) {
    for (const a of at.areas ?? []) {
      const areaName = a.name ?? a.code ?? '';
      for (const w of a.warnings ?? []) {
        if (w.status !== '解除' && DISASTER_WARNING_CODES.has(w.code)) {
          codes.add(w.code);
          details.push({
            code: w.code,
            name: WARNING_NAMES[w.code] ?? w.code,
            areaName,
            prefName,
          });
        }
      }
    }
  }
  return { isDisaster: codes.size > 0, codes: [...codes], details };
}

async function readPrevious() {
  try {
    return JSON.parse(await fs.readFile('./docs/weather.json', 'utf-8'));
  } catch {
    return null;
  }
}

// Slackに通知
async function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL 未設定のため通知をスキップ');
    return;
  }
  const body = text;
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) console.error('Slack通知失敗: HTTP', res.status);
    else console.log('Slack通知送信:', body);
  } catch (err) {
    console.error('Slack通知エラー:', err.message);
  }
}

async function main() {
  const raw = await fs.readFile('./products.json', 'utf-8');
  const products = JSON.parse(raw);

  // ★上書き前に前回状態を読む（商品IDごとの前回 isRain を引けるようにする）
  const prev = await readPrevious();
  const prevRainById = new Map();
  for (const p of prev?.products ?? []) {
    prevRainById.set(p.id, p.isRain === true);
  }

  const areas = [...new Set(products.map((p) => p.jmaArea))];
  const forecastByArea = {};
  const disasterByArea = {};

  for (const area of areas) {
    try {
      forecastByArea[area] = await fetchForecastMap(area);
    } catch (err) {
      console.error(`天気取得失敗 (${area}):`, err.message);
      forecastByArea[area] = {};
    }
    try {
      disasterByArea[area] = await fetchDisasterActive(area);
    } catch (err) {
      console.error(`警報取得失敗 (${area}):`, err.message);
      disasterByArea[area] = { isDisaster: FAIL_SAFE_SUPPRESS, codes: ['(取得失敗)'], details: [] };
    }
  }

  const now = new Date();
  const output = {
    updatedAt: now.toISOString(),                          // 従来どおり（機械用・UTC）
    updatedAtJst: now.toLocaleString('ja-JP', {            // 表示用（日本時間）
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
    source: '気象庁',
    products: products.map((p) => {
      const weatherCode = forecastByArea[p.jmaArea]?.[p.subArea] ?? '';
      const raining = isRainCode(weatherCode);
      const disaster = disasterByArea[p.jmaArea] ?? { isDisaster: false, codes: [], details: [] };
      const isRain = raining && !disaster.isDisaster;

      return {
        id: p.id,
        tiketId: p.tiketId ?? null,
        singleId: p.singleId ?? null,
        productName: p.productName ?? '',
        origin: p.origin,
        isRain,
        weatherCode,
        raining,
        suppressedByWarning: raining && disaster.isDisaster,
        activeWarnings: disaster.codes,
        activeWarningDetails: disaster.details,
        message: isRain ? p.rainMessage : null,
        rainImage: p.rainImage,
      };
    }),
  };

  await fs.mkdir('./docs', { recursive: true });
  await fs.writeFile('./docs/weather.json', JSON.stringify(output, null, 2));
  console.log('done:', output.updatedAt);

  // ───────── 通知判定 ─────────
  const rainingProducts = output.products.filter((r) => r.isRain);
  const newAnyRain = rainingProducts.length > 0;

  // 産地ごとに前回→今回の isRain 変化を調べる
  const changed = [];               // isRain が変化した産地（true→false / false→true）
  const turnedFalseByWarning = [];  // 警報が原因で false に変わった産地
  for (const r of output.products) {
    const before = prevRainById.has(r.id) ? prevRainById.get(r.id) : false;
    const after = r.isRain;
    if (before !== after) {
      changed.push(r);
      // true → false に変わり、かつその原因が警報（雨は降っているが警報で停止）
      if (before === true && after === false && r.suppressedByWarning) {
        turnedFalseByWarning.push(r);
      }
    }
  }

  // (1) isRain がどこかで変化したら、雨割の状態を通知
  if (changed.length > 0) {
    if (newAnyRain) {
      const list = rainingProducts
        .map((r) => `・${r.origin}（${r.productName}）`)
        .join('\n');
      await notifySlack(`🌧 雨割を実施中です。\n対象産地:\n${list}`);
    } else {
      await notifySlack('☀ 雨割は終了しました。');
    }
  } else {
    console.log('isRain の変化なし（雨割通知なし）');
  }

  // (2) 警報が原因で false に変わった産地があれば、警報を通知
  if (turnedFalseByWarning.length > 0) {
    const lines = turnedFalseByWarning
      .map((r) => {
        const names = (r.activeWarningDetails ?? [])
          .map((w) => `${w.name}（${w.prefName}${w.areaName}）`)
          .join('、');
        return `・${r.origin}（${r.productName}）：${names}`;
      })
      .join('\n');
    await notifySlack(
      `⚠️ 警報のため、以下の産地は雨割を停止しました。\n${lines}`
    );
  } else {
    console.log('警報による停止の変化なし');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
