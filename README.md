# Équilibre – suivi alimentaire par points

Application web pour smartphone (installable sur l'écran d'accueil) qui :

- **reconnaît les aliments avec la caméra**, directement dans le téléphone (réseau de neurones MobileNet via TensorFlow.js — aucune IA externe, aucune clé API) ;
- **lit les codes-barres** des produits emballés et récupère leurs valeurs nutritionnelles dans la base ouverte Open Food Facts ;
- **calcule les points** de chaque aliment et votre **budget quotidien** ;
- s'appuie sur une **base de nutriments** de 235 aliments (kcal, protéines, lipides, saturés, glucides, sucres, fibres, sel), stockée dans Supabase et disponible hors-ligne ; vos aliments personnels et les produits scannés y sont ajoutés ;
- tient le **journal des repas** (petit-déjeuner, déjeuner, dîner, collations) : ajout par repas, modification de la portion, « comme la veille », favoris ★ ;
- suit l'**eau** (verres) et les **activités physiques**, qui rapportent des points bonus ;
- affiche le **bilan de la semaine**, la série de jours suivis et la moyenne de points ;
- permet d'**exporter / importer** une sauvegarde, et de réinitialiser son mot de passe ;
- suit votre **poids** avec une courbe et votre objectif ;
- fonctionne **hors-ligne** après le premier lancement ;
- peut **sauvegarder vos données dans Supabase** (compte e-mail / mot de passe) pour les retrouver sur tous vos appareils. Sans compte, tout reste sur le téléphone.

## Les points

```
points = kcal/30 + graisses saturées/3 + sucres/8 − protéines/9 − fibres/10   (arrondi, minimum 0)
```

Les fruits et légumes frais nature sont des aliments libres (0 point). Le même calcul existe dans la base de données (fonction `public.compute_points`) : la table `foods` expose `points_100g` et `points_portion`, et les points du journal sont recalculés par la base à chaque ajout ou modification.

Activités : kcal = MET × poids × durée ; la moitié de cette énergie est rendue en points (kcal ÷ 60). Le budget quotidien est calculé à partir de vos besoins (Mifflin-St Jeor × activité), moins 500 kcal si l'objectif est de perdre du poids, divisé par 30.

## Lancer en local

```bash
npm install
npm start          # http://localhost:3000
npm test
```

La caméra en direct nécessite HTTPS (ou `localhost`). Sur un téléphone, déployez l'application (voir ci-dessous) ou utilisez le bouton « Importer », qui ouvre l'appareil photo.

## Déployer

Le dossier `public/` est un site statique : Vercel (`vercel.json` fourni), Netlify, GitHub Pages ou Supabase Storage conviennent.

## Activer la synchronisation Supabase

1. Réactivez le projet Supabase (tableau de bord → projet → *Restore*).
2. Appliquez le schéma : SQL Editor → collez `supabase/migrations/20261117000000_equilibre_schema.sql` → *Run*.
3. Copiez la clé *publishable* (Project Settings → API Keys) dans `public/config.js` (`SUPABASE_KEY`).

Tables : `profiles`, `food_entries`, `weights`, `day_logs` (eau), `activities` et `foods` (catalogue commun en lecture pour tous + aliments personnels). Toutes sont protégées par RLS : chaque utilisateur ne voit que ses données. Les migrations sont dans `supabase/migrations/` (le catalogue est généré depuis `public/foods.js`).

## Limites

La reconnaissance photo utilise un modèle généraliste qui connaît une soixantaine d'aliments (fruits, légumes, pizza, burger, pâtes, glace…). Pour un plat composé, vérifiez la proposition et ajustez la portion, ou utilisez la recherche et le code-barres.
