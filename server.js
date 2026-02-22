const express = require('express');
const multer = require('multer');
const cors = require('cors');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const { execSync, exec } = require('child_process');
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

// Verificar ffmpeg disponível
let ffmpegCmd = 'ffmpeg';
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  console.log('FFmpeg encontrado no sistema');
} catch (e) {
  try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    ffmpegCmd = ffmpegPath;
    console.log('FFmpeg encontrado via installer:', ffmpegPath);
  } catch (e2) {
    console.error('FFmpeg não encontrado!');
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

const jobs = {};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: ffmpegCmd });
});

app.post('/upload', upload.array('files'), (req, res) => {
  try {
    const labels = JSON.parse(req.body.labels || '{}');
    const files = req.files.map(f => ({ nome: f.originalname, tipo: labels[f.originalname] || 'desconhecido' }));
    res.json({ sucesso: true, arquivos: files });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/gerar', async (req, res) => {
  const { projectName, format, combinations } = req.body;
  const jobId = uuidv4();
  const jobDir = path.join(OUTPUT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  jobs[jobId] = { status: 'processando', progresso: 0, variacaoAtual: 0, total: combinations.length, videos: [] };

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

      await new Promise((resolve, reject) => {
        const cmd = `${ffmpegCmd} -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            console.error('Erro FFmpeg:', stderr);
            reject(error);
          } else {
            resolve();
          }
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

    // Criar ZIP
    const zipName = `${projectName}_todas.zip`;
    const zipPath = path.join(jobDir, zipName);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      jobs[jobId].videos.forEach(v => {
        archive.file(path.join(jobDir, v.nome), { name: v.nome });
      });
      archive.finalize();
    });

    jobs[jobId].status = 'concluido';
    jobs[jobId].zipUrl = `/download/${jobId}/${zipName}`;
  })().catch(err => {
    console.error('Erro no processamento:', err);
    jobs[jobId].status = 'erro';
    jobs[jobId].erro = err.message;
  });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
