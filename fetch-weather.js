import fs from 'node:fs/promises';

// 気象庁エンドポイント（APIキー不要）
const FORECAST_ENDPOINT = 'https://www.jma.go.jp/bosai/forecast/data/forecast'; // /{府県コード}.json
const WARNING_ENDPOINT  = 'https://www.jma.go.jp/bosai/warning/data/warning';   // /{府県コード}.json

// Slack通知用のWebhook URL（GitHub Secrets から渡す）
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// 「災害級」とみなす警報コード（=これが出ていたら恵みの雨演出を止める）
// 既定は大雨に直結する警報・特別警報のみ。必要なら下に追記して調整可。
//   05:暴風警報 06:大雪警報 07:波浪警報 08:高潮警報 02:暴風雪警報
//   35:暴風特別警報 36:大雪特別警報 37:波浪特別警報 38:高潮特別警報 32:暴風雪特別警報
//   （より慎重にするなら注意報 10:大雨注意報 18:洪水注意報 を足す。ただし頻発する点に注意）
const DISASTER_WARNING_CODES = new Set([
  '03', // 大雨警報
  '04', // 洪水警報
  '33', // 大雨特別警報
]);

// 警報チェックに失敗したとき、安全側に倒して演出を止めるか（true=止める）
const FAIL_SAFE_SUPPRESS = true;

// 気象庁の天気コードが「雨」かどうか（300番台=雨）
function isRainCode(code) {
  const n = Number(code);
  return Number.isFinite(n) && n >= 300 && n < 400;
}

// 府県の予報JSONから「一次細分区域コード → 直近の天気コード」の対応表を作る
async function fetchForecastMap(area) {
  const res = await fetch(`${FORECAST_ENDPOINT}/${area}.json`);
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  const data = await res.json();
  // data[0].timeSeries[0] が直近の天気予報
  const series = data?.[0]?.timeSeries?.[0];
  const map = {};
  for (const a of series?.areas ?? []) {
    map[a.area.code] = a.weatherCodes?.[0] ?? '';
  }
  return map;
}

// 府県の警報JSNから「この府県に災害級の警報が出ているか」を判定
// （府県内のどこか＝いずれかのareaで該当コードが解除以外の状態なら true）
async function fetchDisasterActive(area) {
  const res = await fetch(`${WARNING_ENDPOINT}/${area}.json`);
  if (!res.ok) throw new Error(`warning HTTP ${res.status}`);
  const data = await res.json();
  const active = [];
  for (const at of data?.areaTypes ?? []) {
    for (const a of at.areas ?? []) {
      for (const w of a.warnings ?? []) {
        // status が「解除」のものは発表中ではないので除外
        if (w.status !== '解除' && DISASTER_WARNING_CODES.has(w.code)) {
          active.push(w.code);
        }
      }
    }
  }
  return { isDisaster: active.length > 0, codes: [...new Set(active)] };
}

// 前回の weather.json から「1つでも雨だったか」を読む（無ければ false）
async function readPreviousAnyRain() {
  try {
    const prev = JSON.parse(await fs.readFile('./docs/weather.json', 'utf-8'));
    return (prev.products ?? []).some((p) => p.isRain === true);
  } catch {
    return false; // 初回など、前回ファイルが無い場合
  }
}

// Slackに通知
async function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('SLACK_WEBHOOK_URL 未設定のため通知をスキップ');
    return;
  }
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error('Slack通知失敗: HTTP', res.status);
    else console.log('Slack通知送信:', text);
  } catch (err) {
    console.error('Slack通知エラー:', err.message);
  }
}

async function main() {
  const raw = await fs.readFile('./products.json', 'utf-8');
  const products = JSON.parse(raw);

  // ★上書きする前に、前回の「雨あり／なし」状態を読む
  const oldAnyRain = await readPreviousAnyRain();

  // 府県予報区の重複を排除（同じ県は1回ずつ取得）
  const areas = [...new Set(products.map((p) => p.jmaArea))];

  const forecastByArea = {}; // { "110000": { "110010": "300", ... } }
  const disasterByArea = {}; // { "110000": { isDisaster: bool, codes: [...] } }

  for (const area of areas) {
    // 天気（雨判定）
    try {
      forecastByArea[area] = await fetchForecastMap(area);
    } catch (err) {
      console.error(`天気取得失敗 (${area}):`, err.message);
      forecastByArea[area] = {}; // 取れなければ雨なし扱い
    }
    // 警報（安全弁）
    try {
      disasterByArea[area] = await fetchDisasterActive(area);
    } catch (err) {
      console.error(`警報取得失敗 (${area}):`, err.message);
      // 失敗時は設定に従う（既定は安全側=災害扱いにして演出抑制）
      disasterByArea[area] = { isDisaster: FAIL_SAFE_SUPPRESS, codes: ['(取得失敗)'] };
    }
  }

  const output = {
    updatedAt: new Date().toISOString(),
    source: '気象庁',
    products: products.map((p) => {
      const weatherCode = forecastByArea[p.jmaArea]?.[p.subArea] ?? '';
      const raining = isRainCode(weatherCode);
      const disaster = disasterByArea[p.jmaArea] ?? { isDisaster: false, codes: [] };

      // ★最終判定：雨が降っている かつ 災害級の警報が出ていない
      const isRain = raining && !disaster.isDisaster;

      return {
        id: p.id,
        tiketId: p.tiketId ?? null,
        singleId: p.singleId ?? null,
        origin: p.origin,
        isRain,
        weatherCode,                       // 参考：気象庁の天気コード
        raining,                           // 参考：雨かどうか（警報を考慮する前）
        suppressedByWarning: raining && disaster.isDisaster, // 参考：雨だが警報で抑制した
        activeWarnings: disaster.codes,    // 参考：発表中の該当警報コード
        message: isRain ? p.rainMessage : null,
        rainImage: p.rainImage,
      };
    }),
  };

  await fs.mkdir('./docs', { recursive: true });
  await fs.writeFile('./docs/weather.json', JSON.stringify(output, null, 2));
  console.log('done:', output.updatedAt);

  // ★状態が切り替わったときだけSlackへ通知
  const newAnyRain = output.products.some((r) => r.isRain);

  if (!oldAnyRain && newAnyRain) {
    const list = output.products
      .filter((r) => r.isRain)
      .map((r) => `・${r.origin}`)
      .join('\n');
    await notifySlack(`🌧 産地で雨が降り始めました。\n現在雨の産地:\n${list}`);
  } else if (oldAnyRain && !newAnyRain) {
    await notifySlack('☀ すべての産地で雨がやみました。');
  } else {
    console.log('状態変化なし（通知なし）');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
