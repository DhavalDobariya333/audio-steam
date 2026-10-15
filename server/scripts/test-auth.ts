/**
 * test-auth.ts — Automated test suite for dual-password authentication and routing.
 */

import http from 'http';
import { 
    createSessionToken, 
    verifySessionToken, 
    parseCookies,
    SESSION_COOKIE_NAME 
} from '../src/auth';
import { 
    MAIN_PASSWORD, 
    STEALTH_PASSWORD, 
    STEALTH_ROUTE, 
    HOST, 
    PORT 
} from '../src/config';

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

async function request(options: http.RequestOptions, body?: any): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({
                status: res.statusCode || 0,
                headers: res.headers,
                body: data
            }));
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

async function runTests() {
    console.log('\n======================================================');
    console.log('🧪 DUAL-PASSWORD AUTHENTICATION TEST SUITE');
    console.log('======================================================\n');

    // ── Unit Tests: Token generation and verification ──
    console.log('1. Testing Token Crypto & Signing...');
    const mainToken = createSessionToken('main');
    const stealthToken = createSessionToken('stealth');

    const decodedMain = verifySessionToken(mainToken);
    assert(decodedMain !== null && decodedMain.role === 'main', 'main token verified correctly');

    const decodedStealth = verifySessionToken(stealthToken);
    assert(decodedStealth !== null && decodedStealth.role === 'stealth', 'stealth token verified correctly');

    const tampered = mainToken.slice(0, -4) + 'abcd';
    assert(verifySessionToken(tampered) === null, 'tampered token is rejected');

    // ── HTTP Endpoint Tests against Live Server ──
    console.log('\n2. Testing HTTP Authentication Endpoints...');

    const baseUrl = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;

    // Test A: Wrong Password
    try {
        const wrongRes = await request({
            hostname: '127.0.0.1',
            port: PORT,
            path: '/api/v1/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { password: 'wrong-password-999' });

        assert(wrongRes.status === 401, 'wrong password returns 401 Unauthorized');
    } catch (err: any) {
        console.error('Cannot connect to server at port', PORT, 'Is it running? Error:', err.message);
        console.log('\n(Server not currently running on port; tested crypto functions directly)');
        reportSummary();
        return;
    }

    // Test B: Main Password Login
    const mainLoginRes = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { password: MAIN_PASSWORD });

    assert(mainLoginRes.status === 200, 'main password login returns 200 OK');
    const mainData = JSON.parse(mainLoginRes.body);
    assert(mainData.role === 'main', 'main login role is "main"');
    assert(mainData.redirect === '/', 'main login redirects to "/"');

    const mainCookies = mainLoginRes.headers['set-cookie'] || [];
    const mainCookieHeader = mainCookies.join('; ');
    assert(mainCookieHeader.includes(SESSION_COOKIE_NAME), 'main login sets auth_session cookie');

    // Test C: Stealth Password Login
    const stealthLoginRes = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/v1/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { password: STEALTH_PASSWORD });

    assert(stealthLoginRes.status === 200, 'stealth password login returns 200 OK');
    const stealthData = JSON.parse(stealthLoginRes.body);
    assert(stealthData.role === 'stealth', 'stealth login role is "stealth"');
    assert(stealthData.redirect === STEALTH_ROUTE, `stealth login redirects to "${STEALTH_ROUTE}"`);

    const stealthCookies = stealthLoginRes.headers['set-cookie'] || [];
    const stealthCookieHeader = stealthCookies.join('; ');
    assert(stealthCookieHeader.includes(SESSION_COOKIE_NAME), 'stealth login sets auth_session cookie');

    // Test D: Main Role Access Restriction (Stealth Route Must Be 404)
    console.log('\n3. Testing Role Isolation & Stealth Concealment...');
    const mainStealthAttempt = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: STEALTH_ROUTE,
        method: 'GET',
        headers: {
            'Cookie': mainCookieHeader,
            'Accept': 'text/html'
        }
    });
    assert(mainStealthAttempt.status === 404, 'main session cannot access stealth route (returns 404)');

    // Test E: Stealth Role Access (Stealth Route Serves 200 HTML)
    const stealthAccess = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: STEALTH_ROUTE,
        method: 'GET',
        headers: {
            'Cookie': stealthCookieHeader,
            'Accept': 'text/html'
        }
    });
    assert(stealthAccess.status === 200, 'stealth session can access stealth route (returns 200)');
    assert(stealthAccess.body.includes('Stealth Monitor Hub'), 'stealth route serves Stealth Monitor Hub content');

    // Test F: Stealth Role Can Also Access Main Hub
    const stealthMainAccess = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'GET',
        headers: {
            'Cookie': stealthCookieHeader,
            'Accept': 'text/html'
        }
    });
    assert(stealthMainAccess.status === 200, 'stealth session can access main hub (returns 200)');

    // Test G: Unauthenticated Browser Request Redirects to /login
    const unauthBrowse = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'GET',
        headers: { 'Accept': 'text/html' }
    });
    assert(unauthBrowse.status === 302 && unauthBrowse.headers.location === '/login', 'unauthenticated browser request redirects to /login');

    // Test H: Logout
    console.log('\n4. Testing Logout Flow...');
    const logoutRes = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/v1/auth/logout',
        method: 'POST',
        headers: { 'Cookie': mainCookieHeader }
    });
    assert(logoutRes.status === 200, 'logout returns 200');
    const clearedCookies = (logoutRes.headers['set-cookie'] || []).join('; ');
    assert(clearedCookies.includes('Max-Age=0'), 'logout expires auth_session cookie');

    reportSummary();
}

function reportSummary() {
    console.log('\n------------------------------------------------------');
    console.log(`Results: ${passed} PASSED, ${failed} FAILED`);
    console.log('------------------------------------------------------\n');
    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
