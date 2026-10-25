/**
 * test-batch-upload.ts — Integration test for batch offline ZIP upload (POST /:session_id/upload-zip).
 */

import http from 'http';
import express from 'express';
import AdmZip from 'adm-zip';
import { initDatabase } from '../src/database';
import * as db from '../src/database';
import * as storage from '../src/storage';
import broadcastRouter from '../src/routes/broadcast';

let passed = 0;
let failed = 0;

function assert(condition: boolean, desc: string) {
    if (condition) {
        console.log(`  ✅ PASS: ${desc}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${desc}`);
        failed++;
    }
}

async function run() {
    console.log('\n======================================================');
    console.log('🧪 BATCH OFFLINE ZIP UPLOAD TEST SUITE');
    console.log('======================================================\n');

    initDatabase();
    storage.ensureStorageRoot();

    const app = express();
    app.use(express.json());
    app.use('/api/v1/broadcasts', broadcastRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
        const testSessionId = `test_upload_zip_${Date.now()}`;
        db.createSession(testSessionId, 'TestBatchClient', 'Android 14', 'Test Batch Zip Session', 'hidden');
        storage.createSessionDirs(testSessionId);

        // 1. Create in-memory ZIP containing 3 dummy chunks
        const zip = new AdmZip();
        const dummyAudio1 = Buffer.from('FAKE_AUDIO_CHUNK_DATA_1');
        const dummyAudio2 = Buffer.from('FAKE_AUDIO_CHUNK_DATA_2');
        const dummyAudio3 = Buffer.from('FAKE_AUDIO_CHUNK_DATA_3');

        zip.addFile('chunk_001_B85_S0_O0_dB42.aac', dummyAudio1);
        zip.addFile('chunk_002_B85_S1_O0_dB25.aac', dummyAudio2);
        zip.addFile('chunk_003_B80_S0_O0_dB55_C1.aac', dummyAudio3);
        const zipBuffer = zip.toBuffer();

        // 2. Perform multipart upload
        const boundary = '----WebKitFormBoundaryBatchTest12345';
        const crlf = '\r\n';
        const pre = `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="offline_backlog.zip"${crlf}Content-Type: application/zip${crlf}${crlf}`;
        const post = `${crlf}--${boundary}--${crlf}`;
        const multipartBody = Buffer.concat([
            Buffer.from(pre, 'utf-8'),
            zipBuffer,
            Buffer.from(post, 'utf-8'),
        ]);

        const res = await new Promise<{ status: number; data: any }>((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: `/api/v1/broadcasts/${testSessionId}/upload-zip`,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': multipartBody.length,
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode || 0, data });
                    }
                });
            });
            req.on('error', reject);
            req.write(multipartBody);
            req.end();
        });

        assert(res.status === 200, `HTTP status is 200 (received ${res.status})`);
        assert(res.data.status === 'confirmed', `Response status is confirmed: ${JSON.stringify(res.data)}`);
        assert(res.data.chunks_processed === 3, `Processed 3 chunks in zip`);
        assert(res.data.chunks_inserted === 3, `Inserted 3 chunks into database`);

        // 3. Verify chunks in database
        const chunks = db.getSessionChunks(testSessionId);
        assert(chunks.length === 3, `Session has exactly 3 chunks in SQLite`);

        const callChunk = chunks.find(c => c.in_call === 1);
        assert(!!callChunk, `Call chunk correctly flagged with in_call = 1`);

        // Clean up first test session
        db.deleteSession(testSessionId);

        // 4. Test Nested Master ZIP ("Zip of 5 Zips" structure)
        const nestedSessionId = `test_upload_nested_${Date.now()}`;
        db.createSession(nestedSessionId, 'NestedTestClient', 'Android 14', 'Test Nested Zip Session', 'hidden');
        storage.createSessionDirs(nestedSessionId);

        const subZip1 = new AdmZip();
        subZip1.addFile('chunk_nested_01.aac', Buffer.from('CHUNK_A1'));
        subZip1.addFile('chunk_nested_02.aac', Buffer.from('CHUNK_A2'));

        const subZip2 = new AdmZip();
        subZip2.addFile('chunk_nested_03.aac', Buffer.from('CHUNK_B1'));
        subZip2.addFile('chunk_nested_04.aac', Buffer.from('CHUNK_B2'));

        const masterZip = new AdmZip();
        masterZip.addFile('archive_01.zip', subZip1.toBuffer());
        masterZip.addFile('archive_02.zip', subZip2.toBuffer());
        const masterZipBuffer = masterZip.toBuffer();

        const nestedMultipart = Buffer.concat([
            Buffer.from(`--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="master_archive.zip"${crlf}Content-Type: application/zip${crlf}${crlf}`, 'utf-8'),
            masterZipBuffer,
            Buffer.from(post, 'utf-8'),
        ]);

        const nestedRes = await new Promise<{ status: number; data: any }>((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: `/api/v1/broadcasts/${nestedSessionId}/upload-zip`,
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': nestedMultipart.length,
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode || 0, data });
                    }
                });
            });
            req.on('error', reject);
            req.write(nestedMultipart);
            req.end();
        });

        assert(nestedRes.status === 200, `Nested HTTP status is 200`);
        assert(nestedRes.data.status === 'confirmed', `Nested response confirmed`);
        assert(nestedRes.data.chunks_processed === 4, `Extracted 4 chunks across sub-zips in master zip`);
        assert(nestedRes.data.chunks_inserted === 4, `Inserted 4 nested chunks into SQLite in 1 transaction`);

        db.deleteSession(nestedSessionId);

        console.log(`\nResults: ${passed} passed, ${failed} failed`);
        if (failed > 0) {
            process.exit(1);
        }
    } finally {
        server.close();
    }
}

run().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
