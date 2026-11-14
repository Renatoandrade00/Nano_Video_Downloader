const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const realUserData = 'C:\\Users\\renat\\AppData\\Roaming\\nano-video-downloader';
app.setPath('userData', realUserData);

app.whenReady().then(async () => {
  try {
    const { createElectronOsProtector, createTestProtector, SecretStore } = require('../dist/main/vault/secretStore');
    const vaultDir = path.join(realUserData, 'vault');
    const protector = safeStorage.isEncryptionAvailable()
      ? createElectronOsProtector(safeStorage)
      : createTestProtector(vaultDir);

    const store = new SecretStore(vaultDir, protector);

    // Read the active token from playwright session
    const scratchDir = 'C:/Users/renat/.gemini/antigravity/brain/639cdbfe-15cf-413e-9f96-83c5d3108798/scratch';
    const stateFile = path.join(scratchDir, 'hotmart_authenticated_session.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    const hm = state.origins.find(o => o.origin === 'https://hotmart.com');
    const userEntry = hm.localStorage.find(item => item.name.startsWith('oidc.user:'));
    const parsedUser = JSON.parse(userEntry.value);
    const accessToken = parsedUser.access_token;
    console.log('Extracted accessToken length:', accessToken.length);

    // Load existing session and update bearerToken
    const session = store.decryptJson('cred_hotmart-45893c7d') || {};
    session.bearerToken = accessToken;
    session.partitionName = 'persist:webbridge-hotmart-hotmart-45893c7d';
    session.cookies = state.cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
    }));

    store.encryptJson('cred_hotmart-45893c7d', session);
    console.log('Session updated with bearerToken and cookies in SecretStore!');

    // Also update SQLite account status to CONNECTED
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(vaultDir, 'library.db'));
    db.prepare("UPDATE accounts SET status = 'CONNECTED', last_verified_at = ? WHERE id = 'hotmart-45893c7d'").run(new Date().toISOString());
    console.log('Account status updated to CONNECTED in SQLite!');
  } catch (err) {
    console.error('Error saving session:', err);
  } finally {
    app.quit();
  }
});
