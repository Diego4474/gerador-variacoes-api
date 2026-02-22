const express = require('express');
const multer = require('multer');
const cors = require('cors');
const archiver = require('archiver');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/outputs';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

const jobs = {};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegPath });
});

app.post('/upload', upload.array('files'), (req, res) => {
  const labels = JSON.parse(req.body.labels || '{}');
  const jobId = crypto.randomUUID();
  jobs[jobId] = { labels, status: 'aguardando', videos: [] };
  res.json({ jobId, sucesso: true });
});

app.post('/gerar', (req, res) => {
  const { projectName, combinations, jobId: uploadJobId } = req.body;
  const jobId = uploadJobId || crypto.randomUUID();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  if (!jobs[jobId]) jobs[jobId] = {};
  jobs[jobId].status = 'processando';
  jobs[jobId].progresso = 0;
  jobs[jobId].variacaoAtual = 0;
  jobs[jobId].total = combinations.length;
  jobs[jobId].videos = [];

  res.json({ jobId });

  let i = 0;

  function processNext() {
    if (i >= combinations.length) {
      const zipName = projectName + '_todas.zip';
      const zipPath = path.join(jobDir, zipName);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip');
      output.on('close', function() {
        jobs[jobId].status = 'concluido';
        jobs[jobId].zipUrl = '/download/' + jobId + '/' + zipName;
      });
      archive.pipe(output);
      jobs[jobId].videos.forEach(function(v) {
        archive.file(path.join(jobDir, v.nome), { name: v.nome });
      });
      archive.finalize();
      return;
    }

    const combo = combinations[i];
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const outputName = projectName + '_G' + (i+1) + 'xC' + (i+1) + 'xCTA' + (i+1) + '_' + date + '.mp4';
    const outputPath = path.join(jobDir, outputName);
    const listPath = path.join(jobDir, 'list_' + i + '.txt');

    const fileList = [combo.gancho, combo.corpo, combo.cta]
      .map(function(f) { return "file '" + path.join(UPLOAD_DIR, f) + "'"; })
      .join('\n');
    fs.writeFileSync(listPath, fileList);

    const cmd = '"' + ffmpegPath + '" -f concat -safe 0 -i "' + listPath + '" -c copy "' + outputPath + '"';
    exec(cmd, function(error) {
      if (!error) {
        jobs[jobId].videos.push({
          nome: outputName,
          composicao: combo.gancho + ' + ' + combo.corpo + ' + ' + combo.cta,
          duracao: 0,
          downloadUrl: '/download/' + jobId + '/' + outputName
        });
      }
      jobs[jobId].variacaoAtual = i + 1;
      jobs[jobId].progresso = Math.round(((i + 1) / combinations.length) * 100);
      i++;
      processNext();
    });
  }

  processNext();
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado' });
  res.json({ status: job.status, progresso: job.progresso, variacaoAtual: job.variacaoAtual, total: job.total });
});

app.get('/resultados/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado' });
  res.json({ videos: job.videos, zipUrl: job.zipUrl });
});

app.get('/download/:jobId/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.jobId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(filePath);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Servidor rodando na porta ' + PORT);
});
