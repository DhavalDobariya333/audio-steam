/**
 * test-chunk-duplicate.ts — Test chunk upload duplication & retry behavior
 */

import http from 'http';
import express from 'express';
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

function buildMultipartBody(fields: Record<string, string>, fileField: string, fileName: string, fileContent: Buffer) {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const crlf = '\r\n';
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
        parts.push(Buffer.from(
            `--${boundary}${crlf}` +
            `Content-Disposition: form-data; name="${key}"${crlf}${crlf}` +
            `${value}${crlf}`
        ));
    }

    parts.push(Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"${crlf}` +
        `Content-Type: audio/aac${crlf}${crlf}`
    ));
    parts.push(fileContent);
    parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`));

    return {
        boundary,
        body: Buffer.concat(parts)
    };
}

async function run() {
    console.log('\n======================================================');
    console.log('🧪 CHUNK DUPLICATE & RETRY TEST SUITE');
    console.log('======================================================\n');

    initDatabase();
    storage.ensureStorageRoot();

    const app = express();
    app.use('/api/v1/broadcasts', broadcastRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const testSessionId = `test_dup_${Date.now()}`;
    db.createSession(testSessionId, 'TestClient', 'TestDevice', 'Duplicate Test', 'hidden');
    storage.createSessionDirs(testSessionId);

    const chunkUuid = `chk_test_${Date.now()}`;
    const dummyAudio = Buffer.from('RIFF....WAVEfmt ....data....');

    // 1. Upload initial chunk
    console.log('1. Uploading initial chunk with chunk_id...');
    const { boundary, body } = buildMultipartBody(
        { chunk_id: chunkUuid, duration_ms: '5000' },
        'audio',
        'chunk_000001.aac',
        dummyAudio
    );

    const res1 = await new Promise<any>((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/v1/broadcasts/${testSessionId}/chunk`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });

    assert(res1.status === 200, `First chunk upload status is 200 (got ${res1.status})`);
    assert(res1.body.status === 'confirmed', `First chunk status is confirmed (got ${res1.body.status})`);

    // 2. Upload duplicate chunk with same chunk_id without sequence_num (simulating retry)
    console.log('\n2. Retrying upload of same chunk_id (simulating client retry)...');
    const res2 = await new Promise<any>((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/v1/broadcasts/${testSessionId}/chunk`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });

    console.log('Retry response:', res2);
    assert(res2.status === 200, `Duplicate retry status should be 200 (got ${res2.status})`);
    assert(res2.body.status === 'already_exists', `Duplicate retry body.status should be 'already_exists' (got ${res2.body.status})`);

    // 3. Concurrent upload race condition test
    console.log('\n3. Testing concurrent uploads with identical chunk_id in parallel...');
    const concurrentChunkUuid = `chk_race_${Date.now()}`;
    const raceMultipart = buildMultipartBody(
        { chunk_id: concurrentChunkUuid, duration_ms: '5000' },
        'audio',
        'chunk_race.aac',
        dummyAudio
    );

    const makeUploadCall = () => new Promise<any>((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: `/api/v1/broadcasts/${testSessionId}/chunk`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${raceMultipart.boundary}`,
                'Content-Length': raceMultipart.body.length
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.write(raceMultipart.body);
        req.end();
    });

    const [raceRes1, raceRes2] = await Promise.all([makeUploadCall(), makeUploadCall()]);
    console.log('Race result 1:', raceRes1);
    console.log('Race result 2:', raceRes2);

    assert(raceRes1.status === 200, `Race 1 status is 200 (got ${raceRes1.status})`);
    assert(raceRes2.status === 200, `Race 2 status is 200 (got ${raceRes2.status})`);
    const validStatuses = ['confirmed', 'already_exists'];
    assert(validStatuses.includes(raceRes1.body.status), `Race 1 has valid status (got ${raceRes1.body.status})`);
    assert(validStatuses.includes(raceRes2.body.status), `Race 2 has valid status (got ${raceRes2.body.status})`);

    server.close();

    console.log(`\nResults: ${passed} PASSED, ${failed} FAILED`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
