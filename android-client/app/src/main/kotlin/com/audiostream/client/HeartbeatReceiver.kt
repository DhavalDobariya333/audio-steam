package com.audiostream.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * HeartbeatReceiver.kt — Broadcast receiver triggered every 1 hour to transmit
 * the "alive" signal to the server.
 */
class HeartbeatReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        Log.i("HeartbeatReceiver", "⏰ 1-Hour Heartbeat Alarm received. Transmitting alive beacon...")
        HeartbeatManager.sendHeartbeat(context, "hourly_alarm")
    }
}
