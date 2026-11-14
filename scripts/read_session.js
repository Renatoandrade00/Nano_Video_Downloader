const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const realUserData = 'C:\\Users\\renat\\AppData\\Roaming\\nano-video-downloader';
app.setPath('userData', realUserData);

app.whenReady().then(() => {
  try {
    const { createElectronOsProtector, createTestProtector, SecretStore } = require('../dist/main/vault/secretStore');
    const vaultDir = path.join(realUserData, 'vault');
    const protector = safeStorage.isEncryptionAvailable()
      ? createElectronOsProtector(safeStorage)
      : createTestProtector(vaultDir);

    const store = new SecretStore(vaultDir, protector);
    const session = store.decryptJson('cred_hotmart-45893c7d');

    fs.writeFileSync('C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch/read_session_result.json', JSON.stringify({
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      bearerToken: session?.bearerToken ? session.bearerToken.slice(0, 30) + '...' : null,
      cookiesCount: session?.cookies ? session.cookies.length : 0,
      partitionName: session?.partitionName,
      discoveredApiUrls: session?.discoveredApiUrls,
    }, null, 2), 'utf8');
  } catch (err) {
    fs.writeFileSync('C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch/read_session_result.json', JSON.stringify({ error: err.stack || err.message }, null, 2), 'utf8');
  } finally {
    app.quit();
  }
});
