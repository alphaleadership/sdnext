const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Copie récursive d'un dossier via fs, utilisée pour dupliquer
// la structure de cache Diffusers dans le cache Huggingface interne
// de SD.Next — évite qu'un pipeline multi-composants retélécharge
// ses fichiers au chargement du modèle.
function copyDirRecursive(src, dest, onFile) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, onFile);
    } else {
      fs.copyFileSync(srcPath, destPath);
      if (onFile) onFile(destPath);
    }
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let clients = [];
function broadcast(msg) {
  clients.forEach(res => res.write(`data: ${JSON.stringify(msg)}\n\n`));
}

app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.push(res);
  req.on('close', () => { clients = clients.filter(c => c !== res); });
});

function resolveProxyUrl(formProxyUrl) {
  if (formProxyUrl) return { url: formProxyUrl, source: 'formulaire' };
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (envProxy) return { url: envProxy, source: 'variable d\'environnement' };
  return { url: null, source: null };
}

function buildAgent(proxyUrl) {
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

function httpGetJson(url, token, proxyUrl) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const agent = buildAgent(proxyUrl);
    https.get(url, { headers, agent }, (res) => {
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath, token, proxyUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const agent = buildAgent(proxyUrl);
    const doRequest = (requestUrl, redirectCount = 0) => {
      https.get(requestUrl, { headers, agent }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirectCount > 5) return reject(new Error('Trop de redirections'));
          const nextUrl = new URL(res.headers.location, requestUrl).toString();
          return doRequest(nextUrl, redirectCount + 1);
        }
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} pour ${requestUrl}`));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const fileStream = fs.createWriteStream(destPath);
        res.on('data', chunk => {
          downloaded += chunk.length;
          onProgress(downloaded, total);
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', reject);
      }).on('error', reject);
    };
    doRequest(url);
  });
}

app.post('/api/download', async (req, res) => {
  const {
    repoId, token, proxyUrl: formProxyUrl,
    wantDiffusers, diffusersFolder,
    wantHfLink, hfCacheFolder,
    wantCheckpoint, checkpointFolder,
  } = req.body;

  if (!repoId) return res.status(400).json({ error: 'repoId requis' });
  if (!wantDiffusers && !wantCheckpoint) return res.status(400).json({ error: 'Choisis au moins un type de téléchargement' });
  res.json({ started: true });

  const { url: proxyUrl, source: proxySource } = resolveProxyUrl(formProxyUrl);

  try {
    if (proxyUrl) {
      broadcast({ type: 'log', text: `Utilisation du proxy (${proxySource}): ${proxyUrl}` });
    } else {
      broadcast({ type: 'log', text: 'Aucun proxy configuré (ni formulaire, ni variables d\'environnement).' });
    }

    broadcast({ type: 'log', text: `Récupération de la liste des fichiers pour ${repoId}...` });
    const info = await httpGetJson(`https://huggingface.co/api/models/${repoId}`, token, proxyUrl);
    const allFiles = (info.siblings || []).map(s => s.rfilename);
    const commitSha = info.sha;

    if (allFiles.length === 0) {
      broadcast({ type: 'log', text: 'Aucun fichier trouvé dans ce dépôt.' });
      return broadcast({ type: 'done', error: true });
    }

    const [author, repoName] = repoId.split('/');
    const hasDiffusersPipeline = allFiles.includes('model_index.json');
    const rootSafetensors = allFiles.filter(f => f.endsWith('.safetensors') && !f.includes('/'));

    let plannedTasks = [];
    let diffusersModelRootDir = null;
    let diffusersCacheFolderName = null;

    if (wantDiffusers) {
      if (!hasDiffusersPipeline) {
        broadcast({ type: 'log', text: `Pas de model_index.json trouvé : ce dépôt n'a pas de pipeline Diffusers, étape ignorée.` });
      } else if (!commitSha) {
        broadcast({ type: 'log', text: `Impossible de récupérer le hash du commit (sha), pipeline Diffusers ignoré.` });
      } else {
        const diffusersFiles = allFiles.filter(f => !rootSafetensors.includes(f));
        const cacheFolderName = `models--${author}--${repoName}`;
        const modelRootDir = path.join(diffusersFolder, cacheFolderName);
        const snapshotDir = path.join(modelRootDir, 'snapshots', commitSha);
        const refsDir = path.join(modelRootDir, 'refs');

        fs.mkdirSync(refsDir, { recursive: true });
        fs.writeFileSync(path.join(refsDir, 'main'), commitSha);

        diffusersModelRootDir = modelRootDir;
        diffusersCacheFolderName = cacheFolderName;

        broadcast({ type: 'log', text: `Pipeline Diffusers : ${diffusersFiles.length} fichiers vers ${snapshotDir}` });
        diffusersFiles.forEach(file => {
          plannedTasks.push({
            file,
            url: `https://huggingface.co/${repoId}/resolve/main/${file}`,
            destPath: path.join(snapshotDir, file),
          });
        });
      }
    }

    if (wantCheckpoint) {
      if (rootSafetensors.length === 0) {
        broadcast({ type: 'log', text: `Aucun fichier .safetensors autonome trouvé à la racine du dépôt, étape ignorée.` });
      } else {
        broadcast({ type: 'log', text: `Checkpoints : ${rootSafetensors.length} fichier(s) .safetensors vers ${checkpointFolder}` });
        rootSafetensors.forEach(file => {
          plannedTasks.push({
            file,
            url: `https://huggingface.co/${repoId}/resolve/main/${file}`,
            destPath: path.join(checkpointFolder, path.basename(file)),
          });
        });
      }
    }

    if (plannedTasks.length === 0) {
      broadcast({ type: 'log', text: 'Rien à télécharger avec les options choisies.' });
      return broadcast({ type: 'done', error: true });
    }

    for (let i = 0; i < plannedTasks.length; i++) {
      const { file, url, destPath } = plannedTasks[i];
      broadcast({ type: 'log', text: `[${i + 1}/${plannedTasks.length}] ${file}` });
      await downloadFile(url, destPath, token, proxyUrl, (downloaded, total) => {
        broadcast({ type: 'progress', file, index: i + 1, total: plannedTasks.length, downloaded, totalBytes: total });
      });
    }

    broadcast({ type: 'log', text: 'Téléchargement terminé.' });

    // Copie dans le cache Huggingface interne de SD.Next
    if (wantHfLink && diffusersModelRootDir && diffusersCacheFolderName) {
      const destCachePath = path.join(hfCacheFolder, diffusersCacheFolderName);
      if (fs.existsSync(destCachePath)) {
        broadcast({ type: 'log', text: `Cache HF : dossier déjà présent, copie ignorée — ${destCachePath}` });
      } else {
        broadcast({ type: 'log', text: `Copie vers le cache HF de SD.Next : ${destCachePath}...` });
        let copiedCount = 0;
        copyDirRecursive(diffusersModelRootDir, destCachePath, () => {
          copiedCount++;
          if (copiedCount % 10 === 0) {
            broadcast({ type: 'log', text: `  ${copiedCount} fichiers copiés...` });
          }
        });
        broadcast({ type: 'log', text: `Cache HF : copie terminée (${copiedCount} fichiers) -> ${destCachePath}` });
      }
    }

    if (wantCheckpoint && rootSafetensors.length > 0) {
      broadcast({ type: 'log', text: `Les checkpoints .safetensors sont prêts dans le dossier Stable-diffusion.` });
    }

    broadcast({ type: 'done' });
  } catch (err) {
    broadcast({ type: 'log', text: `ERREUR: ${err.message}` });
    broadcast({ type: 'done', error: true });
  }
});

const PROXY_URL = process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy; // forcer manuellement
const { Resend } = require('resend');

// ============================================================
// CONFIG — à personnaliser
// ============================================================
const dotenv=require("dotenv")
dotenv.config()
const RESEND_API_KEY   = process.env.rskey;
const EMAIL_FROM       = 'SD.Next <sdnext@arbinger.is-a.dev>';
const EMAIL_TO         = process.env.dest;
const WATCH_FOLDER     = 'E:\\sdnext\\outputs';
const POLL_INTERVAL_MS = 3000; // vérifie toutes les 3 secondes
// Extensions à surveiller
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const SEND_EXISTING    = true;
// ============================================================
const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
const seen = new Set();
 
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
 
function sendViaResend(fileName, imageBuffer, mimeType) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject: `SD.Next — ${fileName}`,
      html: `<p>Nouvelle image générée : <strong>${fileName}</strong></p>`,
      attachments: [{
        filename: fileName,
        content: imageBuffer.toString('base64'),
      }],
    });
 
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      agent,
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
 
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Resend HTTP ${res.statusCode} : ${data}`));
        }
      });
    });
 
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
 
async function processFile(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  log(`Nouvelle image détectée : ${fileName}`);
 
  // Attendre que SD.Next finisse d'écrire le fichier
  await new Promise(r => setTimeout(r, 1000));
 
  let imageBuffer;
  try {
    imageBuffer = fs.readFileSync(filePath);
  } catch (e) {
    log(`ERREUR lecture (${fileName}) : ${e.message}`);
    return;
  }
 
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : 'image/png';
 
  try {
    const data = await sendViaResend(fileName, imageBuffer, mimeType);
    log(`Email envoyé (id=${data.id}) : ${fileName}`);
  } catch (e) {
    log(`ERREUR envoi (${fileName}) : ${e.message}`);
    return; // Ne pas supprimer si l'envoi a échoué
  }
 
  try {
    fs.unlinkSync(filePath);
    log(`Fichier supprimé : ${fileName}`);
  } catch (e) {
    log(`ERREUR suppression (${fileName}) : ${e.message}`);
  }
}
 
function scanFolder(folder) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (e) {
    log(`ERREUR lecture dossier (${folder}) : ${e.message}`);
    return;
  }
 
  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      scanFolder(fullPath);
    } else if (EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      processFile(fullPath).catch(e => log(`ERREUR inattendue : ${e.message}`));
    }
  }
}
 
function init() {
  if (!fs.existsSync(WATCH_FOLDER)) {
    log(`ERREUR : dossier introuvable : ${WATCH_FOLDER}`);
    process.exit(1);
  }
 
  if (!SEND_EXISTING) {
    function markExisting(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory()) markExisting(fullPath);
        else if (EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) seen.add(fullPath);
      }
    }
    markExisting(WATCH_FOLDER);
    log(`Démarrage — ${seen.size} image(s) existante(s) ignorée(s).`);
  } else {
    log('Démarrage — les images existantes seront envoyées (SEND_EXISTING=true).');
  }
 
  if (PROXY_URL) log(`Proxy : ${PROXY_URL}`);
  log(`Surveillance de : ${WATCH_FOLDER}`);
  log(`Envoi vers : ${EMAIL_TO}`);
 
  setInterval(() => scanFolder(WATCH_FOLDER), POLL_INTERVAL_MS);
}
 
init();

app.listen(3939, () => {
  console.log('Interface disponible sur http://localhost:3939');
  const { url, source } = resolveProxyUrl(null);
  if (url) console.log(`Proxy système détecté (${source}): ${url}`);
});