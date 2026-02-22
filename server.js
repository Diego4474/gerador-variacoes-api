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

[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const jobs = {};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegPath });
});

app.post('/upload', upload.array('files'), (req, res) => {
  try {
    const labels = JSON.parse(req.body.labels || '{}');
    const jobId = crypto.randomUUID();
    jobs[jobId] = { labels, status: 'aguardando', videos: [] };
    console.log('Upload recebido, jobId:', jobId, 'arquivos:', req.files.map(f => f.originalname));
    res.json({ jobId, sucesso: true });
  } catch (err) {
    console.error('Erro no upload:', err);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/gerar', async (req, res) => {
  try {
    const { projectName, format, combinations, jobId: uploadJobId } = req.body;
    const jobId = uploadJobId || crypto.randomUUID();
    const jobDir = path.join(OUTPUT_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    if (!jobs[jobId]) jobs[jobId] = { videos: [] };
    jobs[jobId].status = 'processando';
    jobs[jobId].progresso = 0;
    jobs[jobId].variacaoAtual = 0;
    jobs[jobId].total = combinations.length;
    jobs[jobId].videos = [];

    res.json({ jobId });

    (async () => {
      for (let i = 0; i < combinations.length; i++) {
        const { gancho, corpo, cta } = combinations[i];
        const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const outputName = `${projectName}_G${i+1}xC${i+1}xCTA${i+1}_${date}.mp4`;
        const outputPath = path.join(jobDir, outputName);
        const listPath = path.join(jobDir, `list_${i}.txt`);

        const fileList = [gancho, corpo, cta]
          .map(f => `file '${path.join(UPLOAD_DIR, f)}'`)
          .join('\n');
        fs.writeFileSync(listPath, fileList);

        console.log(`Processando variação ${i+1}/${combinations.length}: ${gancho} + ${corpo} + ${cta}`);

        await new Promise((resolve, reject) => {
          const cmd = `"${ffmpegPath}" -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
          exec(cmd, (error, stdout, stderr) => {
            if (error) { console.error('Erro FFmpeg:', stderr); reject(error); }
            else resolve();
          });
        });

        jobs[jobId].videos.push({
          nome: outputName,
          composicao: `${gancho} + ${corpo} + ${cta}`,
          duracao: 0,
          downloadUrl: `/download/${jobId}/${outputName}`
        });

        jobs[jobId].variacaoAtual = i + 1;
        jobs[jobId].progresso = Math.round(((i + 1) / combinations.length) * 100);
      }

      const zipName = `${projectName}_todas.zip`;
      const zipPath = path.join(jobDir, zipName);
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip');
