const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const realUserData = 'C:\\Users\\renat\\AppData\\Roaming\\nano-video-downloader';
app.setPath('userData', realUserData);

app.whenReady().then(async () => {
  try {
    const { createElectronOsProtector, createTestProtector, SecretStore } = require('../dist/main/vault/secretStore');
    const { VaultDatabase } = require('../dist/main/vault/database');
    const { AuthManager } = require('../dist/main/auth/authManager');
    const { AdapterRegistry } = require('../dist/main/adapters/registry');
    const { CatalogCrawler } = require('../dist/main/catalog/catalogCrawler');
    const { OwnershipVerifier } = require('../dist/main/ownership/ownershipVerifier');

    const vaultDir = path.join(realUserData, 'vault');
    const protector = safeStorage.isEncryptionAvailable()
      ? createElectronOsProtector(safeStorage)
      : createTestProtector(vaultDir);

    const db = new VaultDatabase(path.join(vaultDir, 'library.db'));
    const secrets = new SecretStore(vaultDir, protector);
    const adapters = new AdapterRegistry();
    const auth = new AuthManager(db, secrets, adapters);
    const ownership = new OwnershipVerifier(db, auth, adapters);
    const catalog = new CatalogCrawler(db, auth, adapters, ownership);

    // Testar escaneamento de anexos da aula 02 (o4EWn8BR7z)
    const rawDb = db.db;
    const lesson = rawDb.prepare("SELECT * FROM lessons WHERE external_lesson_id LIKE '%o4EWn8BR7z%'").get();
    console.log('Target Lesson:', lesson.id, lesson.title);

    const mod = rawDb.prepare("SELECT * FROM modules WHERE id = ?").get(lesson.module_id);
    const course = db.getCourse(mod.course_id);
    console.log('Course:', course.id, course.title);

    console.log('\n--- SCANNING ATTACHMENTS ---');
    const atts = await catalog.scanLessonAttachments(course.id, lesson.id);
    console.log('Scan result count:', atts.length);
    console.log('Attachments:', atts);

    console.log('\n--- DOWNLOADING ATTACHMENT ---');
    const { QueueAndChunkManager } = require('../dist/main/queue/queueManager');
    const { BandwidthLimiter } = require('../dist/main/queue/tokenBucket');
    const { MediaStreamInspector } = require('../dist/main/media/mediaInspector');
    const { DecryptionAndRemuxer } = require('../dist/main/media/remuxer');

    const queue = new QueueAndChunkManager(
      db,
      auth,
      adapters,
      ownership,
      new MediaStreamInspector(),
      new DecryptionAndRemuxer(secrets, 'ffmpeg'),
      secrets,
      new BandwidthLimiter(null),
      {
        stagingRootDir: path.join(vaultDir, 'staging'),
        getLibraryRootDir: () => 'C:/Users/renat/Videos/NanoVideoDownloader',
      },
      {},
    );

    const dlRes = await queue.downloadAttachment(atts[0].id);
    console.log('Download Result:', dlRes);
  } catch (err) {
    console.error('Scan error:', err);
  } finally {
    app.quit();
  }
});
