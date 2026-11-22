// Reconnaissance des aliments 100 % dans le téléphone (aucune IA externe) :
//  - photo : réseau de neurones MobileNet (TensorFlow.js) exécuté localement ;
//  - code-barres : lecteur du navigateur ou ZXing + base ouverte Open Food Facts ;
//  - apprentissage : chaque photo corrigée par l'utilisateur est mémorisée (empreinte).
import { LABEL_MAP, findFood } from "./foods.js";

let modelPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Impossible de charger " + src));
    document.head.appendChild(s);
  });
}

// Charge le modèle une seule fois (≈ 14 Mo au premier lancement, puis mis en cache).
export function loadModel() {
  modelPromise ??= (async () => {
    if (!window.tf) await loadScript("vendor/tf.min.js");
    if (!window.mobilenet) await loadScript("vendor/mobilenet.min.js");
    return window.mobilenet.load({ version: 2, alpha: 1.0 });
  })().catch((err) => {
    modelPromise = null;
    throw err;
  });
  return modelPromise;
}

// Catégories du modèle qui trahissent un emballage (canette, bouteille, brique…).
// Les canettes sont souvent vues comme « shaker », « filtre à huile » ou « ouvre-boîte ».
const PACKAGING = [
  "pop bottle", "water bottle", "beer bottle", "wine bottle", "water jug", "whiskey jug", "milk can",
  "can opener", "cocktail shaker", "oil filter", "packet", "carton", "pill bottle", "lotion", "beer glass",
];

const norm = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
// Seuil de ressemblance au-delà duquel une photo apprise est reconnue
export const SIMILARITY_THRESHOLD = 0.8;

// Analyse une photo. `examples` = photos apprises [{ food, embedding }].
// Renvoie les aliments probables, si c'est un emballage, et l'empreinte de la photo.
export async function classifyImage(imgEl, examples = []) {
  const model = await loadModel();
  const predictions = await model.classify(imgEl, 15);
  const t = model.infer(imgEl, true); // empreinte (vecteur) de la photo
  const embedding = norm(Array.from(t.dataSync ? t.dataSync() : t.arraySync().flat()));
  t.dispose?.();

  const scores = new Map();
  // 1) photos apprises : la plus ressemblante
  const learned = new Map();
  for (const ex of examples) {
    if (ex.embedding.length !== embedding.length) continue;
    const sim = cosine(embedding, ex.embedding);
    if (sim >= SIMILARITY_THRESHOLD && sim > (learned.get(ex.food.name)?.sim ?? 0)) learned.set(ex.food.name, { food: ex.food, sim });
  }
  // 2) catégories connues du modèle
  const labels = predictions.map((p) => ({ parts: p.className.toLowerCase().split(/,\s*/), probability: p.probability }));
  for (const { parts, probability } of labels) {
    const hit = LABEL_MAP.find(([key]) => parts.some((part) => part.includes(key)));
    if (!hit) continue;
    const food = findFood(hit[1]);
    scores.set(food, (scores.get(food) ?? 0) + probability);
  }
  const packaging = labels
    .slice(0, 5)
    .some(({ parts, probability }) => probability >= 0.03 && parts.some((part) => PACKAGING.some((k) => part.includes(k))));

  return {
    matches: [
      ...[...learned.values()].sort((a, b) => b.sim - a.sim).map(({ food, sim }) => ({ food, probability: sim, learned: true })),
      ...[...scores.entries()]
        .filter(([food]) => !learned.has(food.name))
        .sort((a, b) => b[1] - a[1])
        .map(([food, probability]) => ({ food, probability })),
    ],
    packaging,
    embedding,
    raw: predictions.slice(0, 3),
  };
}

// ---------- Codes-barres ----------
// 1) lecteur intégré au navigateur (BarcodeDetector) quand il existe ;
// 2) sinon, ou s'il ne trouve rien, lecteur ZXing embarqué (fonctionne partout, iPhone compris).
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
let nativeDetector;
let zxing;
let tick = 0;

async function nativeDetect(source) {
  if (!("BarcodeDetector" in window)) return null;
  try {
    if (nativeDetector === undefined) {
      const supported = await window.BarcodeDetector.getSupportedFormats?.().catch(() => FORMATS) ?? FORMATS;
      const formats = FORMATS.filter((f) => supported.includes(f));
      nativeDetector = formats.length ? new window.BarcodeDetector({ formats }) : null;
    }
    if (!nativeDetector) return null;
    const codes = await nativeDetector.detect(source);
    return codes[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

async function zxingDetect(source) {
  if (!window.ZXing) await loadScript("vendor/zxing.min.js");
  const Z = window.ZXing;
  if (!zxing) {
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxing = { reader: new Z.MultiFormatReader(), hints, canvas: document.createElement("canvas") };
    zxing.reader.setHints(hints);
  }
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  if (!w || !h) return null;
  const scale = Math.min(1, 1000 / w);
  const c = zxing.canvas;
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, c.width, c.height);
  try {
    const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)));
    return zxing.reader.decodeWithState(bitmap).getText();
  } catch {
    return null; // aucun code trouvé dans cette image
  } finally {
    zxing.reader.reset();
  }
}

// Cherche un code-barres dans une image ou une vidéo. Renvoie le code ou null.
export async function detectBarcode(source) {
  const code = await nativeDetect(source);
  if (code) return code;
  // ZXing une image sur deux en vidéo (plus lent), à chaque fois pour une photo
  if (source instanceof HTMLVideoElement && "BarcodeDetector" in window && tick++ % 2) return null;
  return zxingDetect(source);
}

export async function lookupBarcode(code) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_fr,brands,nutriments,serving_quantity`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Produit introuvable (" + res.status + ")");
  const data = await res.json();
  if (data.status !== 1 || !data.product) throw new Error("Produit inconnu dans Open Food Facts.");
  const p = data.product;
  const n = p.nutriments ?? {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const kcal = n["energy-kcal_100g"] ?? (n["energy_100g"] ? n["energy_100g"] / 4.184 : 0);
  return {
    name: [p.product_name_fr || p.product_name || "Produit " + code, p.brands?.split(",")[0]].filter(Boolean).join(" – "),
    portion: Math.round(num(p.serving_quantity)) || 100,
    kcal: num(kcal),
    protein: num(n.proteins_100g),
    satFat: num(n["saturated-fat_100g"]),
    sugar: num(n.sugars_100g),
    fiber: num(n.fiber_100g),
    free: false,
  };
}
