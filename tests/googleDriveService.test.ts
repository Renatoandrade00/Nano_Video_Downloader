import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoogleDriveService } from '../src/main/storage/googleDriveService';
import { GoogleDriveSyncEvent } from '../src/shared/types';

describe('GoogleDriveService — Shared Folder & Cloud Storage Integration', () => {
  it('extracts folder ID from diverse Google Drive URL patterns and direct IDs', () => {
    const url1 = 'https://drive.google.com/drive/folders/17t1y2X3abcDeFgHiJkLmNoPqRsTuVwXyZ';
    expect(GoogleDriveService.extractFolderId(url1)).toBe('17t1y2X3abcDeFgHiJkLmNoPqRsTuVwXyZ');

    const url2 = 'https://drive.google.com/drive/folders/17t1y2X3abcDeFgHiJkLmNoPqRsTuVwXyZ?usp=sharing';
    expect(GoogleDriveService.extractFolderId(url2)).toBe('17t1y2X3abcDeFgHiJkLmNoPqRsTuVwXyZ');

    const url3 = 'https://drive.google.com/drive/u/1/folders/folder_id_ABC-123_xyz?usp=drive_link';
    expect(GoogleDriveService.extractFolderId(url3)).toBe('folder_id_ABC-123_xyz');

    const url4 = 'https://drive.google.com/open?id=open_link_id_987-xyz';
    expect(GoogleDriveService.extractFolderId(url4)).toBe('open_link_id_987-xyz');

    const directId = '1234567890abcdef-XYZ_123';
    expect(GoogleDriveService.extractFolderId(directId)).toBe(directId);

    expect(GoogleDriveService.extractFolderId('')).toBeNull();
    expect(GoogleDriveService.extractFolderId('https://example.com/not-drive')).toBeNull();
  });

  it('provides a complete Google Apps Script Webhook template for 1-click cloud sync', () => {
    const template = GoogleDriveService.getScriptTemplate();
    expect(template).toContain('function doPost(e)');
    expect(template).toContain('DriveApp.getFolderById');
    expect(template).toContain('Utilities.base64Decode');
    expect(template).toContain('Nano S Tecnologia');
  });

  it('synchronizes files to a local Google Drive Desktop folder maintaining structure', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano_gdrive_test_'));
    const localFile = path.join(tmpDir, 'Aula 01.mp4');
    fs.writeFileSync(localFile, 'Fake MP4 Video Content');

    const fakeDriveDir = path.join(tmpDir, 'GoogleDriveMock');
    fs.mkdirSync(fakeDriveDir, { recursive: true });

    const events: GoogleDriveSyncEvent[] = [];
    const service = new GoogleDriveService(
      {
        enabled: true,
        folderUrl: 'https://drive.google.com/drive/folders/testFolder123',
        folderId: 'testFolder123',
        localSyncPath: fakeDriveDir,
        mirrorLocal: true,
      },
      (e) => events.push(e),
    );

    const result = await service.syncFile({
      jobId: 'job_123',
      localFilePath: localFile,
      relativePath: path.join('Curso Teste', 'Modulo 01'),
      fileName: 'Aula 01.mp4',
      mimeType: 'video/mp4',
    });

    expect(result.ok).toBe(true);

    const expectedDest = path.join(fakeDriveDir, 'Curso Teste', 'Modulo 01', 'Aula 01.mp4');
    expect(fs.existsSync(expectedDest)).toBe(true);
    expect(fs.readFileSync(expectedDest, 'utf8')).toBe('Fake MP4 Video Content');

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].state).toBe('UPLOADING');
    expect(events[events.length - 1].state).toBe('COMPLETED');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles disabled Google Drive gracefully without throwing', async () => {
    const service = new GoogleDriveService({
      enabled: false,
      folderUrl: '',
      folderId: '',
      mirrorLocal: true,
    });

    const res = await service.syncFile({
      localFilePath: 'non_existent.mp4',
      relativePath: 'test',
      fileName: 'test.mp4',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('GOOGLE_DRIVE_DISABLED');
  });
});
