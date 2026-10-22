/**
 * test-batch-export.ts — Integration test suite for batch session ZIP download with full telemetry.
 */

import http from 'http';
import express from 'express';
import fs from 'fs';
import path from 'path';
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

async function request(options: http.RequestOptions, body?: any): Promise<{ status: number; headers: http.IncomingHttpHeaders; buffer: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on('end', () => resolve({
                status: res.statusCode || 0,
                headers: res.headers,
                buffer: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function run() {
    console.log('\n======================================================');
    console.log('🧪 BATCH SESSION ZIP DOWNLOAD & TELEMETRY TEST SUITE');
    console.log('======================================================\n');

    initDatabase();
    storage.ensureStorageRoot();

    // Setup dummy test session and chunk with telemetry tags
    const testSessionId = `test_batch_${Date.now()}`;
    const clientName = 'Realme-TestDevice';
    db.createSession(testSessionId, clientName, 'Android 14 (SM-Test)', 'Batch Test Session', 'hidden');

    storage.createSessionDirs(testSessionId);
    const dummyChunkData = Buffer.from('FAKE_AUDIO_DATA_FOR_AAC_STREAMING');
    // Filename carries covert telemetry tags: Battery 88%, Screen ON Unlocked, Wall AC, Vibrate, 58dB, 32°C, Moving, Hand
    const originalChunkName = `chunk_000001_B88_S0_OBLU_D1_U1_CAC_RV_V1_dB58_T32_M1_POPEN_A01.aac`;
    storage.saveChunk(testSessionId, 1, dummyChunkData, originalChunkName);
    db.insertChunk(`chk_${Date.now()}`, testSessionId, 1, originalChunkName, path.join(storage.getRawDir(testSessionId), `chunk_000001.aac`), dummyChunkData.length, 5000);

    // Spin up test server
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/api/v1/broadcasts', broadcastRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
        // Test 1: Empty session_ids should return 400
        console.log('1. Testing validation on missing session IDs...');
        const resEmpty = await request({
            host: '127.0.0.1',
            port,
            path: '/api/v1/broadcasts/batch-export-zip',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { session_ids: [] });

        assert(resEmpty.status === 400, 'Empty session_ids returns 400 Bad Request');

        // Test 2: Valid session_ids POST returns 200 and application/zip
        console.log('\n2. Testing Pro Batch ZIP export (POST)...');
        const resZip = await request({
            host: '127.0.0.1',
            port,
            path: '/api/v1/broadcasts/batch-export-zip',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { session_ids: [testSessionId], format: 'pro_chunks' });

        assert(resZip.status === 200, 'Batch export returns 200 OK');
        assert(resZip.headers['content-type'] === 'application/zip', 'Content-Type is application/zip');
        assert(Boolean(resZip.headers['content-disposition']?.includes('attachment')), 'Content-Disposition includes attachment');
        assert(resZip.buffer.length > 100, `ZIP buffer received (${resZip.buffer.length} bytes)`);

        // Check ZIP magic header (PK\x03\x04)
        assert(resZip.buffer[0] === 0x50 && resZip.buffer[1] === 0x4B, 'Buffer has valid ZIP signature (PK)');

        // Test 3: GET endpoint with query params
        console.log('\n3. Testing Pro Batch ZIP export (GET)...');
        const resGet = await request({
            host: '127.0.0.1',
            port,
            path: `/api/v1/broadcasts/batch-export-zip?ids=${testSessionId}&format=pro_chunks`,
            method: 'GET'
        });
        assert(resGet.status === 200, 'GET /batch-export-zip returns 200 OK');
        assert(resGet.headers['content-type'] === 'application/zip', 'GET returns application/zip');

        console.log('\n======================================================');
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log('======================================================\n');
    } finally {
        server.close();
        // Cleanup test session
        try {
            storage.deleteSessionFiles(testSessionId);
            db.deleteSession(testSessionId);
        } catch { }
    }

    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((err) => {
    console.error('Test execution error:', err);
    process.exit(1);
});
