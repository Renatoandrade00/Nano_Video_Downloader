const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const realUserData = 'C:\\Users\\renat\\AppData\\Roaming\\nano-video-downloader';
const vaultDir = path.join(realUserData, 'vault');
const dbPath = path.join(vaultDir, 'library.db');
const db = new DatabaseSync(dbPath);

const att = db.prepare("SELECT * FROM lesson_attachments WHERE external_attachment_id = '9b0cce5d-22d6-4b4e-a33d-5bc6b18690fa'").get();
console.log('Attachment in DB:', att);

// Obter token do session state salvo no scratch
const state = JSON.parse(fs.readFileSync('C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch/hotmart_authenticated_session.json', 'utf8'));
const hm = state.origins.find(o => o.origin === 'https://hotmart.com');
const userEntry = hm.localStorage.find(item => item.name.startsWith('oidc.user:'));
const accessToken = JSON.parse(userEntry.value).access_token;

async function run() {
  console.log('1. Calling attachment download endpoint:', att.file_url);
  const initRes = await fetch(att.file_url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-product-id': '8792144',
      Origin: 'https://hotmart.com',
      Referer: 'https://hotmart.com/',
    },
  });
  console.log('Init status:', initRes.status);
  const initJson = await initRes.json();
  console.log('Init JSON:', initJson);

  console.log('\n2. Calling lambda with header token...');
  const lambdaRes = await fetch(initJson.lambdaUrl, {
    headers: {
      token: initJson.token,
      Origin: 'https://hotmart.com',
      Referer: 'https://hotmart.com/',
    },
  });
  console.log('Lambda status:', lambdaRes.status);
  const signedUrl = (await lambdaRes.text()).trim();
  console.log('Signed URL:', signedUrl.slice(0, 100) + '...');

  console.log('\n3. Downloading binary PDF...');
  const pdfRes = await fetch(signedUrl);
  console.log('PDF status:', pdfRes.status);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  console.log('PDF bytes downloaded:', buf.length, 'Starts with %PDF:', buf.slice(0, 5).toString());

  const targetPath = path.join('C:/Users/renat/Videos/NanoVideoDownloader', 'Extensivo CHQAOPM 2027', '02 - Direito Constitucional', 'Materiais', 'Aula 02 — ' + att.file_name);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buf);
  console.log('PDF gravado com sucesso em:', targetPath);

  db.prepare("UPDATE lesson_attachments SET local_file_path = ? WHERE id = ?").run(targetPath, att.id);
  console.log('DB atualizado!');
}

run().catch(console.error);
