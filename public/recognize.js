// Reconnaissance des aliments 100 % dans le téléphone (aucune IA externe) :
//  - photo : réseau de neurones MobileNet (TensorFlow.js) exécuté localement ;
//  - code-barres : lecteur intégré au navigateur + base ouverte Open Food Facts.
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

// Renvoie les aliments de la base qui correspondent à la photo, du plus probable au moins probable.
export async function classifyImage(imgEl) {
  const model = await loadModel();
  const predictions = await model.classify(imgEl, 15);
  const scores = new Map();
  for (const p of predictions) {
    const label = p.className.toLowerCase();
    const hit = LABEL_MAP.find(([key]) => label.split(/,\s*/).some((part) => part.includes(key)));
    if (!hit) continue;
    const food = findFood(hit[1]);
    scores.set(food, (scores.get(food) ?? 0) + p.probability);
  }
  return {
    matches: [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([food, probability]) => ({ food, probability })),
    raw: predictions.slice(0, 3),
  };
}

// ---------- Codes-barres ----------
export const barcodeSupported = "BarcodeDetector" in window;

export async function detectBarcode(source) {
  if (!barcodeSupported) return null;
  const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
  const codes = await detector.detect(source);
  return codes[0]?.rawValue ?? null;
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
