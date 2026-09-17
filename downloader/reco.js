const http = require('http');
const fs = require('fs');
const path = require('path');
const dotenv=require("dotenv")
// ============================================================
// CONFIG
// ============================================================
const SDNEXT_URL   = 'http://localhost:7860';
const OUTPUT_DIR   = './generated';  // dossier local où sauvegarder les images
// ============================================================

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Requête HTTP générique vers SD.Next (pas de proxy — connexion locale)
function request(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(SDNEXT_URL + endpoint);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || 7860,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error(`Réponse non-JSON (HTTP ${res.statusCode}) : ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Sauvegarde une image base64 sur le disque
function saveImage(base64, filename) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

// Lister les modèles disponibles
async function listModels() {
  log('Récupération des modèles...');
  const res = await request('GET', '/sdapi/v1/sd-models');
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.body;
}

// Obtenir le modèle actuellement chargé
async function getCurrentModel() {
  const res = await request('GET', '/sdapi/v1/options');
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.body.sd_model_checkpoint;
}

// Changer de modèle
async function setModel(modelName) {
  log(`Chargement du modèle : ${modelName}`);
  const res = await request('POST', '/sdapi/v1/options', { sd_model_checkpoint: modelName });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  log('Modèle chargé.');
}

// Surveiller la progression d'une génération en cours
async function watchProgress() {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const res = await request('GET', '/sdapi/v1/progress');
        if (res.status !== 200) return;
        const { progress, eta_relative, state } = res.body;
        if (progress > 0) {
          const pct = Math.round(progress * 100);
          const eta = eta_relative ? `ETA ${eta_relative.toFixed(1)}s` : '';
          process.stdout.write(`\r  Progression : ${pct}% ${eta}    `);
        }
        if (state && !state.job_count) {
          clearInterval(interval);
          process.stdout.write('\n');
          resolve();
        }
      } catch (_) {}
    }, 500);
  });
}

// Générer une image (txt2img)
async function txt2img(params) {
  const payload = {
    prompt: '',
    negative_prompt: '',
    steps: 20,
    cfg_scale: 7,
    width: 512,
    height: 512,
    batch_size: 1,
    n_iter: 1,
    sampler_name: 'Euler a',
    save_images: true,
    ...params,
  };

  log(`Génération : "${payload.prompt.slice(0, 60)}${payload.prompt.length > 60 ? '...' : ''}"`);
  log(`Paramètres : ${payload.width}x${payload.height} — ${payload.steps} steps — CFG ${payload.cfg_scale}`);

  // Lancer la génération en arrière-plan et surveiller la progression
  let result;
  const [res] = await Promise.all([
    request('POST', '/sdapi/v1/txt2img', payload),
    watchProgress(),
  ]);
  result = res;

  if (result.status !== 200) {
    throw new Error(`Génération échouée (HTTP ${result.status}) : ${JSON.stringify(result.body)}`);
  }

  const images = result.body.images || [];
  const saved = [];

  for (let i = 0; i < images.length; i++) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${i + 1}.png`;
    const filePath = saveImage(images[i].split(',').pop(), filename);
    saved.push(filePath);
    log(`Image sauvegardée : ${filePath}`);
  }

  return saved;
}

// ============================================================
// Exemple d'utilisation — à personnaliser
// ============================================================
async function main() {
  try {
    // Afficher le modèle actuel
    const current = await getCurrentModel();
    log(`Modèle actuel : ${current}`);
    /*
    // Générer une image
    await txt2img({
      prompt: 'a kitsune with bikini, at the beach , photorealistic, 8k',
      negative_prompt: 'blurry, low quality, watermark',
      steps: 30,
      cfg_scale: 7,
      batch_size: 4,
      width: 1024,
      height: 1024,
     
    });*/
    await watchProgress()
    // Exemple : générer plusieurs images en batch
    // await txt2img({
    //   prompt: 'portrait of a woman, soft lighting, film photography',
    //   steps: 25,
    //   batch_size: 4,
    //   width: 768,
    //   height: 1024,
    // });

    // Exemple : changer de modèle avant de générer
     const models = await listModels();
     console.log('Modèles disponibles :', models.map(m => m.title));
    // await setModel('nom-du-modele.safetensors');
    // await txt2img({ prompt: '...' });

  } catch (e) {
    log(`ERREUR : ${e.message}`);
    process.exit(1);
  }
}

main();