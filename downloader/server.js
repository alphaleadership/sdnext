const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const morgan = require('morgan');
const jpeg = require('jpeg-js');

// ============================================================
// LOGGER UNIFIÉ — terminal coloré + événements SSE pour le navigateur
// ============================================================
const ANSI = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${color}${text}${ANSI.reset}` : text);

const LEVELS = {
  info: { tag: 'INFO', color: ANSI.cyan },
  step: { tag: 'ETAPE', color: ANSI.magenta },
  ok: { tag: 'OK', color: ANSI.green },
  warn: { tag: 'WARN', color: ANSI.yellow },
  error: { tag: 'ERREUR', color: ANSI.red },
};

let progressActive = false;
let lastProgressRender = 0;
const PROGRESS_REFRESH_MS = 120;

function clearProgressLine() {
  if (!progressActive) return;
  process.stdout.write('\r\x1b[2K');
  progressActive = false;
}

// Historique des derniers messages : rejoué à chaque nouvelle connexion SSE
// pour que le panneau de logs du navigateur ne soit jamais vide.
const LOG_HISTORY_LIMIT = 200;
const logHistory = [];

function log(msg, level = 'info') {
  const lv = LEVELS[level] || LEVELS.info;
  const ts = Date.now();
  clearProgressLine();
  console.log(`${paint(ANSI.gray, new Date(ts).toLocaleTimeString('fr-FR', { hour12: false }))} ${paint(lv.color, `[${lv.tag.padEnd(6)}]`)} ${msg}`);
  logHistory.push({ text: msg, level, ts });
  if (logHistory.length > LOG_HISTORY_LIMIT) logHistory.shift();
}

function logBroadcast(msg, level = 'info') {
  log(msg, level);
  broadcast({ type: 'log', text: msg, level, ts: Date.now() });
}

// Évite de spammer la console : un même message (clé) n'est réaffiché
// qu'après `intervalMs` écoulé — utile pour les erreurs de scan récurrentes.
const lastThrottledLog = new Map();
function logThrottled(key, msg, level = 'info', intervalMs = 60000) {
  const now = Date.now();
  const previous = lastThrottledLog.get(key) || 0;
  if (now - previous < intervalMs) return;
  lastThrottledLog.set(key, now);
  log(msg, level);
}

function formatDuration(seconds) {
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return `${sec}s`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

// Ligne de progression réécrite en place (\r) pendant un téléchargement
function renderProgress(prefix, downloaded, totalBytes, speed) {
  const now = Date.now();
  if (now - lastProgressRender < PROGRESS_REFRESH_MS) return;
  lastProgressRender = now;

  const pct = totalBytes ? (downloaded / totalBytes) * 100 : 0;
  const barWidth = 20;
  const filled = totalBytes ? Math.round((pct / 100) * barWidth) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

  const parts = [`${pct.toFixed(1)}%`, `${formatBytes(downloaded)} / ${formatBytes(totalBytes)}`];
  if (speed > 0) {
    parts.push(`${formatBytes(speed)}/s`);
    if (totalBytes > downloaded) parts.push(`ETA ${formatDuration((totalBytes - downloaded) / speed)}`);
  }

  process.stdout.write(`\r\x1b[2K${paint(ANSI.gray, prefix)} ${paint(ANSI.blue, bar)} ${parts.join('  ')}`);
  progressActive = true;
}

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

// Compte les fichiers d'un dossier (pour le log, même en mode jonction)
function countFilesRecursive(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFilesRecursive(path.join(dir, entry.name));
    else count++;
  }
  return count;
}

// Préfère une jonction (symlink/junction) : le cache HF de SD.Next pointe alors
// vers les fichiers déjà téléchargés au lieu de les dupliquer (plusieurs Go).
// Repli sur une copie récursive si la jonction est refusée par le système.
function linkOrCopyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.symlinkSync(path.resolve(src), dest, 'junction');
    return { mode: 'jonction', files: countFilesRecursive(src) };
  } catch (e) {
    let copied = 0;
    copyDirRecursive(src, dest, () => { copied++; });
    return { mode: 'copie', files: copied, reason: e.message };
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Traçage des requêtes HTTP via le logger unifié (niveau déduit du code
// HTTP). Retour `null` : morgan n'écrit rien lui-même, c'est log() qui formatte.
app.use(morgan((tokens, req, res) => {
  const status = Number(tokens.status(req, res)) || 0;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  log(`HTTP ${tokens.method(req, res)} ${tokens.url(req, res)} ${status} ${tokens['response-time'](req, res)} ms`, level);
  return null;
}, {
  // La connexion SSE reste ouverte en permanence : pas de log inutile.
  skip: (req) => req.originalUrl === '/api/progress',
}));

let clients = [];

// État global du système, exposé via GET /api/status et l'événement SSE 'status'
let downloadRunning = false;
const sentHistory = [];
const SENT_HISTORY_LIMIT = 50;
const serverStartedAt = Date.now();

function broadcast(msg) {
  clients.forEach(res => res.write(`data: ${JSON.stringify(msg)}\n\n`));
}

app.get('/api/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  clients.push(res);

  // Rejeu de l'historique : le navigateur affiche immédiatement le contexte,
  // même avant de lancer un téléchargement.
  for (const entry of logHistory) {
    res.write(`data: ${JSON.stringify({ type: 'log', ...entry })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ type: 'hello', clients: clients.length, ts: Date.now() })}\n\n`);

  req.on('close', () => { clients = clients.filter(c => c !== res); });
});

// Battement de cœur SSE : maintient la connexion ouverte et rend le flux
// visible dans l'onglet Événements de Firefox.
const HEARTBEAT_MS = 15000;
setInterval(() => {
  if (clients.length === 0) return;
  broadcast({ type: 'ping', clients: clients.length, ts: Date.now() });
}, HEARTBEAT_MS).unref();

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
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const agent = buildAgent(proxyUrl);
    // Supprime un éventuel fichier partiel pour ne jamais laisser de .part incomplet
    const cleanup = () => { try { fs.unlinkSync(destPath); } catch (_) {} };
    const doRequest = (requestUrl, redirectCount = 0) => {
      // Ne jamais renvoyer le token HF vers un autre hôte après une redirection (CDN...)
      const headers = new URL(requestUrl).hostname.endsWith('huggingface.co') ? authHeaders : {};
      https.get(requestUrl, { headers, agent }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume(); // vide le flux pour libérer la socket
          if (redirectCount > 5) { cleanup(); return reject(new Error('Trop de redirections')); }
          const nextUrl = new URL(res.headers.location, requestUrl).toString();
          return doRequest(nextUrl, redirectCount + 1);
        }
        if (res.statusCode >= 400) {
          res.resume();
          cleanup();
          return reject(new Error(`HTTP ${res.statusCode} pour ${requestUrl}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const fileStream = fs.createWriteStream(destPath);
        const fail = (err) => { fileStream.destroy(); cleanup(); reject(err); };
        res.on('data', chunk => {
          downloaded += chunk.length;
          onProgress(downloaded, total);
        });
        res.on('error', fail);
        res.pipe(fileStream);
        fileStream.on('error', fail);
        fileStream.on('finish', () => {
          fileStream.close(() => {
            if (total > 0 && downloaded !== total) {
              cleanup();
              return reject(new Error(`Téléchargement incomplet (${formatBytes(downloaded)}/${formatBytes(total)}) pour ${requestUrl}`));
            }
            resolve();
          });
        });
      }).on('error', (err) => { cleanup(); reject(err); });
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
  // Format attendu : auteur/nom — bloque les chemins invalides ou une traversal via repoId
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(repoId).trim())) {
    return res.status(400).json({ error: 'repoId invalide (format attendu : auteur/nom-du-modele)' });
  }
  if (!wantDiffusers && !wantCheckpoint) return res.status(400).json({ error: 'Choisis au moins un type de téléchargement' });
  if (downloadRunning) return res.status(409).json({ error: 'Un téléchargement est déjà en cours.' });
  downloadRunning = true;
  broadcastStatus();
  res.json({ started: true });

  const { url: proxyUrl, source: proxySource } = resolveProxyUrl(formProxyUrl);

  try {
    if (proxyUrl) {
      logBroadcast(`Utilisation du proxy (${proxySource}): ${proxyUrl}`);
    } else {
      logBroadcast('Aucun proxy configuré (ni formulaire, ni variables d\'environnement).');
    }

    logBroadcast(`Récupération de la liste des fichiers pour ${repoId}...`);
    const info = await httpGetJson(`https://huggingface.co/api/models/${repoId}`, token, proxyUrl);
    const allFiles = (info.siblings || []).map(s => s.rfilename);
    const commitSha = info.sha;

    if (allFiles.length === 0) {
      logBroadcast('Aucun fichier trouvé dans ce dépôt.', 'warn');
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
        logBroadcast(`Pas de model_index.json trouvé : ce dépôt n'a pas de pipeline Diffusers, étape ignorée.`, 'warn');
      } else if (!commitSha) {
        logBroadcast('Impossible de récupérer le hash du commit (sha), pipeline Diffusers ignoré.', 'warn');
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

        logBroadcast(`Pipeline Diffusers : ${diffusersFiles.length} fichiers vers ${snapshotDir}`);
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
        logBroadcast('Aucun fichier .safetensors autonome trouvé à la racine du dépôt, étape ignorée.', 'warn');
      } else {
        logBroadcast(`Checkpoints : ${rootSafetensors.length} fichier(s) .safetensors vers ${checkpointFolder}`);
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
      logBroadcast('Rien à télécharger avec les options choisies.', 'warn');
      return broadcast({ type: 'done', error: true });
    }

    const completedFiles = [];
    const SSE_PROGRESS_THROTTLE_MS = 150;

    for (let i = 0; i < plannedTasks.length; i++) {
      const { file, url, destPath } = plannedTasks[i];
      const prefix = `[${i + 1}/${plannedTasks.length}]`;
      log(`${prefix} ${file}`, 'step');

      const startedAt = Date.now();
      let lastBytes = 0;
      let lastTick = startedAt;
      let speed = 0;
      let fileBytes = 0;
      let lastBroadcast = 0;

      await downloadFile(url, destPath, token, proxyUrl, (downloaded, total) => {
        fileBytes = downloaded;
        const now = Date.now();
        if (now - lastTick >= 500) {
          speed = ((downloaded - lastBytes) * 1000) / (now - lastTick);
          lastBytes = downloaded;
          lastTick = now;
        }
        renderProgress(prefix, downloaded, total, speed);
        // Throttle : un broadcast SSE par chunk inonderait le navigateur
        if (now - lastBroadcast >= SSE_PROGRESS_THROTTLE_MS || downloaded === total) {
          lastBroadcast = now;
          broadcast({ type: 'progress', file, index: i + 1, total: plannedTasks.length, filesDone: i, downloaded, totalBytes: total });
        }
      });

      clearProgressLine();
      const elapsed = (Date.now() - startedAt) / 1000;
      log(`${prefix} ${file} — ${formatBytes(fileBytes)} en ${formatDuration(elapsed)}`, 'ok');
      completedFiles.push({ file, bytes: fileBytes, seconds: Math.round(elapsed) });
    }

    logBroadcast('Téléchargement terminé.', 'ok');

    // Jonction dans le cache Huggingface interne de SD.Next
    if (wantHfLink && diffusersModelRootDir && diffusersCacheFolderName) {
      const destCachePath = path.join(hfCacheFolder, diffusersCacheFolderName);
      if (fs.existsSync(destCachePath)) {
        logBroadcast(`Cache HF : dossier déjà présent, jonction ignorée — ${destCachePath}`, 'warn');
      } else {
        logBroadcast(`Cache HF de SD.Next : ${destCachePath}...`);
        const linkStartedAt = Date.now();
        const result = linkOrCopyDir(diffusersModelRootDir, destCachePath);
        if (result.mode === 'jonction') {
          logBroadcast(`Cache HF : jonction créée (${result.files} fichiers pointés, aucun espace disque consommé) -> ${destCachePath}`, 'ok');
        } else {
          logBroadcast(`Cache HF : jonction impossible (${result.reason}), copie de ${result.files} fichiers en ${formatDuration((Date.now() - linkStartedAt) / 1000)} -> ${destCachePath}`, 'warn');
        }
      }
    }

    if (wantCheckpoint && rootSafetensors.length > 0) {
      logBroadcast('Les checkpoints .safetensors sont prêts dans le dossier Stable-diffusion.', 'ok');
    }

    const summary = {
      repoId,
      files: completedFiles,
      totalBytes: completedFiles.reduce((sum, f) => sum + f.bytes, 0),
    };
    broadcast({ type: 'done', summary });
  } catch (err) {
    clearProgressLine();
    logBroadcast(`ERREUR: ${err.message}`, 'error');
    broadcast({ type: 'done', error: true });
  } finally {
    downloadRunning = false;
    broadcastStatus();
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
const WATCH_FOLDER     = ['E:\\sdnext\\outputs',"./tosend","./generated"];
const POLL_INTERVAL_MS = 3000; // vérifie toutes les 3 secondes
// Extensions à surveiller
const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', ".pdf", ".zip"];

// Types MIME corrects pour l'envoi par email (le .pdf partait en image/png)
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};
const SEND_EXISTING    = true;
// ============================================================
const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
const seen = new Set();

// ============================================================
// COMPTEUR D'ENVOIS — persisté dans un JSON, relu à chaque boot
// ============================================================
const COUNTER_FILE = path.join(__dirname, 'send-counter.json');

function loadCounter() {
  const empty = { count: 0, lastFile: null, lastSentAt: null, updatedAt: null };
  try {
    if (!fs.existsSync(COUNTER_FILE)) {
      fs.writeFileSync(COUNTER_FILE, JSON.stringify(empty, null, 2));
      return empty;
    }
    const raw = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    const count = Number.isFinite(raw.count) ? Math.max(0, Math.floor(raw.count)) : 0;
    return {
      count,
      lastFile: typeof raw.lastFile === 'string' ? raw.lastFile : null,
      lastSentAt: raw.lastSentAt || null,
      updatedAt: raw.updatedAt || null,
    };
  } catch (e) {
    log(`ERREUR lecture compteur (${COUNTER_FILE}) : ${e.message} — redémarrage à 0`, 'error');
    return empty;
  }
}

function saveCounter(state) {
  const payload = { ...state, updatedAt: new Date().toISOString() };
  const tmpFile = `${COUNTER_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpFile, COUNTER_FILE);
  return payload;
}

// Nom envoyé : 0042_image.png — le numéro incrémente à chaque envoi réussi
function formatSendName(originalName, seq) {
  const width = Math.max(4, String(seq).length);
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  return `${String(seq).padStart(width, '0')}_${base}${ext}`;
}

let counter = loadCounter();
// Réservation synchrone des numéros : deux envois simultanés ne peuvent
// pas recevoir le même numéro même si le JSON n'est écrit qu'après l'envoi.
let seqReserve = counter.count;

function nextSeq() {
  return ++seqReserve;
}

// ============================================================
// STATUS SYSTÈME — exposé à l'interface via GET /api/status
// et poussé en SSE (événement 'status') à chaque changement
// ============================================================

function folderStats(folder) {
  let pending = 0;
  try {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) pending++;
    }
  } catch (_) {}
  return { path: folder, exists: fs.existsSync(folder), pending };
}

function buildStatus() {
  return {
    ts: Date.now(),
    uptime: Math.round((Date.now() - serverStartedAt) / 1000),
    downloadRunning,
    counter,
    sentHistory: sentHistory.slice(-20),
    folders: WATCH_FOLDER.map(folderStats),
    sseClients: clients.length,
  };
}

function broadcastStatus() {
  broadcast({ type: 'status', status: buildStatus() });
}

app.get('/api/status', (req, res) => {
  res.json(buildStatus());
});

// ============================================================
// ENVOI DE FICHIERS VIA L'INTERFACE WEB — déposés dans ./tosend,
// le watcher les détecte ensuite et les envoie par email
// ============================================================

const TOSEND_DIR = path.join(__dirname, 'tosend');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Nom de fichier sûr : basename uniquement (pas de traversal), caractères
// limités, extension dans la whitelist du watcher
function safeUploadName(rawName) {
  const base = path.basename(String(rawName || '')).replace(/[^\w.\-]/g, '_');
  if (!base || base === '.' || base === '..') return null;
  if (!EXTENSIONS.includes(path.extname(base).toLowerCase())) return null;
  return base;
}

app.post('/api/upload', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
  const name = safeUploadName(req.query.filename);
  if (!name) {
    return res.status(400).json({ error: `Nom invalide ou extension non autorisée (${EXTENSIONS.join(' ')})` });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Corps de requête vide' });
  }
  fs.mkdirSync(TOSEND_DIR, { recursive: true });
  const ext = path.extname(name);
  let dest = path.join(TOSEND_DIR, name);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(TOSEND_DIR, `${path.basename(name, ext)}-${n++}${ext}`);
  fs.writeFileSync(dest, req.body);
  const saved = path.basename(dest);
  logBroadcast(`Fichier reçu via l'interface web : ${saved} (${formatBytes(req.body.length)}) -> ${TOSEND_DIR}`, 'ok');
  broadcastStatus();
  res.json({ saved, bytes: req.body.length });
});

app.get('/api/tosend', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(TOSEND_DIR, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const st = fs.statSync(path.join(TOSEND_DIR, e.name));
        return { name: e.name, bytes: st.size, mtime: st.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  } catch (_) {}
  res.json({ dir: TOSEND_DIR, files });
});

// Erreurs du body-parser (ex: upload trop gros) renvoyées en JSON, pas en HTML
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: `Fichier trop volumineux (limite : ${MAX_UPLOAD_MB} Mo)` });
  }
  if (err) {
    log(`Erreur middleware : ${err.message}`, 'error');
    return res.status(500).json({ error: err.message });
  }
  next();
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return `${bytes.toFixed(1)} ${units[i]}`;
}

// ============================================================
// APERÇU ASCII — rendu JPEG en caractères
// Par défaut : à la taille exacte de l'image (1 pixel = 1 caractère).
// ASCII_COLUMNS=120 ASCII_MAX_ROWS=50 pour forcer une taille plus petite
// ASCII_PREVIEW=0 pour désactiver l'aperçu.
// ============================================================
const ASCII_COLUMNS = Number(process.env.ASCII_COLUMNS) || 0;
const ASCII_MAX_ROWS = Number(process.env.ASCII_MAX_ROWS) || 0;
// Plafond de sécurité pour le fichier .txt pleine taille (1 pixel = 1 caractère) :
// une image de plusieurs dizaines de mégapixels produirait un .txt énorme.
// ASCII_FILE_MAX_PIXELS=0 pour désactiver la limite.
const ASCII_FILE_MAX_PIXELS = process.env.ASCII_FILE_MAX_PIXELS !== undefined
  ? Number(process.env.ASCII_FILE_MAX_PIXELS)
  : 4000000;
const ASCII_RAMP = '@%#*+=-:. '; // du plus sombre au plus clair
const ASCII_DIR = process.env.ASCII_DIR
  ? path.resolve(process.env.ASCII_DIR)
  : path.join(__dirname, 'ascii');

function renderAscii(img, columns, rows) {
  const { width, height, data } = img;
  const last = ASCII_RAMP.length - 1;
  const toChar = (luma) => ASCII_RAMP[Math.min(last, Math.floor((luma / 255) * ASCII_RAMP.length))];
  const lines = [];

  if (columns === width && rows === height) {
    // Rendu pleine taille : 1 pixel = 1 caractère, pas de tampon intermédiaire.
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < columns; x++) {
        const i = (y * width + x) * 4;
        line += toChar(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      }
      lines.push(line);
    }
  } else {
    // Sous-échantillonnage : moyenne de luminance par cellule (box filter).
    const sums = new Float32Array(rows * columns);
    const counts = new Float32Array(rows * columns);
    for (let y = 0; y < height; y++) {
      const cy = Math.min(rows - 1, Math.floor((y * rows) / height));
      const rowOffset = cy * columns;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const cell = rowOffset + Math.min(columns - 1, Math.floor((x * columns) / width));
        sums[cell] += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        counts[cell]++;
      }
    }
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < columns; x++) {
        const cell = y * columns + x;
        line += toChar(counts[cell] ? sums[cell] / counts[cell] : 255);
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}

function asciiPreview(imageBuffer, columns, rows) {
  const img = jpeg.decode(imageBuffer, { useTArray: true, maxMemoryUsageInMB: 1024 });
  if (!img.width || !img.height) throw new Error('image JPEG illisible');

  // Taille exacte de l'image par défaut, réductible via variables d'env
  // ou paramètres explicites.
  let targetColumns = columns || ASCII_COLUMNS || img.width;
  let targetRows = rows || (ASCII_MAX_ROWS ? Math.min(ASCII_MAX_ROWS, img.height) : img.height);

  if (ASCII_FILE_MAX_PIXELS > 0 && targetColumns * targetRows > ASCII_FILE_MAX_PIXELS) {
    const scale = Math.sqrt(ASCII_FILE_MAX_PIXELS / (targetColumns * targetRows));
    targetColumns = Math.max(1, Math.floor(targetColumns * scale));
    targetRows = Math.max(1, Math.floor(targetRows * scale));
  }

  return {
    text: renderAscii(img, targetColumns, targetRows),
    width: img.width,
    height: img.height,
    columns: targetColumns,
    rows: targetRows,
  };
}

function saveAsciiPreview(fileName, preview) {
  fs.mkdirSync(ASCII_DIR, { recursive: true });
  const base = path.basename(fileName, path.extname(fileName));
  let dest = path.join(ASCII_DIR, `${base}.txt`);
  let n = 1;
  while (fs.existsSync(dest)) dest = path.join(ASCII_DIR, `${base}-${n++}.txt`);

  const header =
    `# ${fileName} — ${preview.width}x${preview.height} → ${preview.columns}x${preview.rows}\n` +
    `# généré le ${new Date().toLocaleString('fr-FR')}\n\n`;
  fs.writeFileSync(dest, header + preview.text + '\n', 'utf8');
  return dest;
}

const ASCII_DISPLAY_COLUMNS = Number(process.env.ASCII_DISPLAY_COLUMNS) || 100;
const ASCII_DISPLAY_ROWS = Number(process.env.ASCII_DISPLAY_ROWS) || 32;

function logAsciiPreview(fileName, imageBuffer,seq) {
  if (process.env.ASCII_PREVIEW === '0') return;
  try {
    // Rendu pleine taille (1 pixel = 1 caractère) pour le fichier .txt.
    const full = asciiPreview(imageBuffer);
    let dest = null;
    try {
      dest = saveAsciiPreview(`${seq}-${fileName}`, full);
      // Prévient le visionneur web qu'un nouvel aperçu est disponible
      broadcast({ type: 'ascii', name: path.basename(dest) });
    } catch (e) {
      log(`Sauvegarde de l'aperçu ASCII impossible : ${e.message}`, 'warn');
    }

    const tooBig = full.columns > ASCII_DISPLAY_COLUMNS || full.rows > ASCII_DISPLAY_ROWS;
    // Réduction uniquement pour l'affichage console/navigateur (sinon
    // plusieurs milliers de lignes figent le terminal et l'onglet).
    const shown = tooBig ? asciiPreview(imageBuffer, ASCII_DISPLAY_COLUMNS, ASCII_DISPLAY_ROWS) : full;

    const where = dest ? ` — sauvegardé : ${dest}` : '';
   // logBroadcast(`Aperçu ASCII de ${fileName} (${full.width}x${full.height} → ${full.columns}x${full.rows})${where} :`, 'info');
   //logBroadcast(shown.text, 'info');
    if (tooBig) {
      logBroadcast(`(affichage réduit à ${shown.columns}x${shown.rows} — le fichier contient le rendu pleine taille)`, 'info');
    }
  } catch (e) {
    log(`Aperçu ASCII impossible pour ${fileName} : ${e.message}`, 'warn');
  }
}

// ============================================================
// VISIONNEUR ASCII — API de lecture des aperçus générés dans ASCII_DIR
// ============================================================

// La liste est limitée aux aperçus les plus récents : le dossier peut en
// contenir des milliers (~1 Mo chacun en rendu pleine taille).
const ASCII_LIST_LIMIT = 200;
// Plafond quand le client demande explicitement une limite via ?limit=N
const ASCII_LIST_MAX = 5000;

app.get('/api/ascii', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(ASCII_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'))
      .map(e => {
        const st = fs.statSync(path.join(ASCII_DIR, e.name));
        return { name: e.name, bytes: st.size, mtime: st.mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  } catch (_) {}

  // ?limit=N : nombre d'aperçus demandés (défaut ASCII_LIST_LIMIT, max ASCII_LIST_MAX).
  // limit=0 ou limit=all : tous les aperçus du dossier.
  let limit = ASCII_LIST_LIMIT;
  if (req.query.limit === 'all') limit = Infinity;
  else if (req.query.limit !== undefined) {
    const n = Math.floor(Number(req.query.limit));
    if (Number.isFinite(n)) limit = n <= 0 ? Infinity : Math.min(n, ASCII_LIST_MAX);
  }
  const shown = files.slice(0, limit);
  res.json({ dir: ASCII_DIR, count: files.length, limit: shown.length, files: shown });
});

// req.params.name est déjà décodé par Express : on exige un simple nom de
// fichier .txt dont le chemin résolu reste strictement dans ASCII_DIR
// (bloque ../ et toute tentative de lecture hors du dossier ascii).
app.get('/api/ascii/:name', (req, res) => {
  const name = req.params.name;
  if (!name || path.basename(name) !== name || !name.toLowerCase().endsWith('.txt')) {
    return res.status(400).json({ error: 'Nom invalide (attendu : nom de fichier .txt du dossier ascii)' });
  }
  const filePath = path.join(ASCII_DIR, name);
  if (!filePath.startsWith(ASCII_DIR + path.sep)) {
    return res.status(400).json({ error: 'Nom invalide (hors du dossier ascii)' });
  }
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) return res.status(404).json({ error: 'Aperçu introuvable' });
    const st = fs.statSync(filePath);
    res.json({ name, bytes: st.size, mtime: st.mtime, content });
  });
});

log(`Compteur d'envois chargé (${COUNTER_FILE}) : ${counter.count} fichier(s) déjà envoyé(s).`, 'info');
 
function sendViaResend(fileName, imageBuffer, mimeType) {
  return new Promise((resolve, reject) => {
    const base64 = imageBuffer.toString('base64');
    const body = JSON.stringify({
      from: EMAIL_FROM,
      to: [EMAIL_TO],
      subject: `SD.Next — ${fileName}`,
      html: mimeType.startsWith('image/')
        ? `<p>Nouvelle image générée : <strong>${fileName}</strong></p>
<p><img src="data:${mimeType};base64,${base64}" alt="${fileName}" style="max-width:100%;height:auto;"></p>`
        : `<p>Nouveau fichier généré : <strong>${fileName}</strong> (${mimeType})</p>`,
      attachments: [{
        filename: fileName,
        content: base64,
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
          reject(new Error(`Resend HTTP ${res.statusCode} `));
        }
      });
    });
 
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
 
async function processFile(filePath) {
    log(`Traitement de : ${path.basename(filePath)}`);

    // 1. Attendre que l'écriture soit terminée
    const isReady = await waitForFileReady(filePath);
    
    if (!isReady) {
        log(`Le fichier ${path.basename(filePath)} semble toujours en cours d'écriture. On réessaiera plus tard.`, 'warn');
        // IMPORTANT : On retire du Set 'seen' pour que le prochain scan puisse le retrouver
        seen.delete(filePath); 
        return;
    }

    try {const seq = nextSeq();
        // 2. Lecture du fichier (Utilise fs.promises pour être plus moderne)
        const fileBuffer = await fs.promises.readFile(filePath);
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  log(`Fichier : ${fileName} — chemin : ${filePath} — poids : ${formatBytes(fileBuffer.length)}`);
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

        // Aperçu ASCII pour les JPEG (console + interface web)
        if (ext === '.jpg' || ext === '.jpeg') {
            logAsciiPreview(fileName, fileBuffer,seq);
        }

        // 3. Nom final basé sur le compteur persisté (repris à chaque boot)
        
        const sendName = formatSendName(fileName, seq);

        // 4. Envoi via Resend
       const data = await sendViaResend(sendName, fileBuffer, mimeType);

        // 5. Envoi réussi : on incrémente et on sauvegarde le JSON
        counter = saveCounter({
          count: Math.max(counter.count, seq),
          lastFile: sendName,
          lastSentAt: new Date().toISOString(),
        });
        sentHistory.push({ seq, name: sendName, original: fileName, bytes: fileBuffer.length, at: new Date().toISOString() });
        if (sentHistory.length > SENT_HISTORY_LIMIT) sentHistory.shift();
        broadcastStatus();
        log(`Email envoyé (id=${data.id}) : ${sendName} [envoi #${seq}]`, 'ok');
        fs.rmSync(filePath);
        seen.delete(filePath); // le fichier n'existe plus : on libère le Set
    } catch (error) {
        log(`Erreur lors de l'envoi de ${path.basename(filePath)} : ${error.message}`, 'error');
        
        // 4. Gestion de l'échec (déplacement vers un dossier NON surveillé :
        //    l'ancien 'tosend' fait partie de WATCH_FOLDER → boucle de renvois infinie)
        const errorDir = path.join(__dirname, 'failed');
        if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir);

        const destPath = path.join(errorDir, path.basename(filePath));
        try {
            if (fs.existsSync(destPath)) fs.rmSync(destPath);
            fs.renameSync(filePath, destPath);
            log(`Fichier déplacé vers ${errorDir}`, 'warn');
        } catch (moveErr) {
            log(`Critique : Impossible de déplacer le fichier : ${moveErr.message}`, 'error');
        }
        
        // On retire du Set pour permettre une nouvelle tentative si le fichier est déplacé manuellement
        seen.delete(filePath);
    }
}

 /**
 * Vérifie qu'une image est complète sur le disque (marqueur de fin de fichier).
 */
function isFileComplete(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    let fd;
    try {
        const size = fs.statSync(filePath).size;
        if (size === 0) return false;
        fd = fs.openSync(filePath, 'r');

        if (ext === '.png') {
            if (size < 12) return false;
            const tail = Buffer.alloc(12);
            fs.readSync(fd, tail, 0, 12, size - 12);
            return tail.toString('latin1', 4, 8) === 'IEND';
        }

        if (ext === '.jpg' || ext === '.jpeg') {
            if (size < 4) return false;
            const tail = Buffer.alloc(2);
            fs.readSync(fd, tail, 0, 2, size - 2);
            return tail[0] === 0xff && tail[1] === 0xd9;
        }

        if (ext === '.webp') {
            if (size < 12) return false;
            const head = Buffer.alloc(12);
            fs.readSync(fd, head, 0, 12, 0);
            if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') return false;
            return head.readUInt32LE(4) + 8 <= size;
        }

        return true;
    } catch (err) {
        return false;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    }
}

 /**
 * Vérifie si un fichier est complètement écrit sur le disque :
 * taille stable sur 3 relevés consécutifs ET marqueur de fin présent.
 */
async function waitForFileReady(filePath) {
    let lastSize = -1;
    let stable = 0;
    const maxAttempts = 15;
    const intervalMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const currentSize = fs.statSync(filePath).size;

            if (currentSize > 0 && currentSize === lastSize) stable++;
            else stable = 0;
            lastSize = currentSize;

            if (stable >= 2 && isFileComplete(filePath)) return true;
        } catch (err) {
            stable = 0;
        }

        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

function scanFolder(folder) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (e) {
    logThrottled(`scan:${folder}`, `ERREUR lecture dossier (${folder}) : ${e.message}`, 'error');
    return;
  }
 
  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      scanFolder(fullPath);
    } else if (EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      processFile(fullPath).catch(e => {
        log(`ERREUR : ${e.message}`, 'error');
        seen.delete(fullPath); // On retire du set si ça a échoué pour retenter plus tard
    });
    }
  }
}
 
function init() {
  WATCH_FOLDER.forEach((FOLDER)=>{
 if (!fs.existsSync(FOLDER)) {
  fs.mkdirSync(FOLDER)
    log(`Dossier absent, créé : ${FOLDER}`, 'warn');
   
  }
 
  if (!SEND_EXISTING) {
    function markExisting(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const fullPath = path.join(folder, entry.name);
        if (entry.isDirectory()) markExisting(fullPath);
        else if (EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) seen.add(fullPath);
      }
    }
    markExisting(FOLDER);
    log(`Démarrage — ${seen.size} image(s) existante(s) ignorée(s).`);
  } else {
    log('Démarrage — les images existantes seront envoyées (SEND_EXISTING=true).');
  }
 
  if (PROXY_URL) log(`Proxy : ${PROXY_URL}`, 'warn');
  log(`Surveillance de : ${FOLDER}`);
  log(`Envoi vers : ${EMAIL_TO}`);
 
  setInterval(() => scanFolder(FOLDER), POLL_INTERVAL_MS);
  })
 
}
 
init();

const PORT = Number(process.env.PORT) || 3939;
const server = app.listen(PORT, () => {
  log(`Interface disponible sur http://localhost:${PORT}`, 'ok');
  const { url, source } = resolveProxyUrl(null);
  if (url) log(`Proxy système détecté (${source}): ${url}`);
  broadcastStatus();
});

// Arrêt gracieux : on ferme le serveur HTTP avant de quitter
function shutdown(signal) {
  log(`Signal ${signal} reçu — arrêt en cours...`, 'warn');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));