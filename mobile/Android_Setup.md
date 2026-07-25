# Android Native Configuration

Since you are running Node 16 locally, the standard React Native CLI (which requires Node 18+) could not automatically scaffold the `android/` directory.

When you initialize the React Native project on a machine with Node 18+, you must add the following configurations to support the foreground service and microphone access.

## 1. `android/app/src/main/AndroidManifest.xml`

Add these permissions above the `<application>` tag:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- Internet & Network State -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    
    <!-- Audio Recording -->
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    
    <!-- Foreground Service (Prevents Doze Mode from killing the app) -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <application ...>
        ...
        
        <!-- Foreground Service Declaration -->
        <service 
            android:name="com.voximplant.foregroundservice.VIForegroundService" 
            android:exported="true"
            android:foregroundServiceType="microphone" />

    </application>
</manifest>
```

## 2. Dependencies to Install

Once your project is scaffolded, install the required packages:

```bash
npm install react-native-audio-record @react-native-community/netinfo react-native-sqlite-storage @voximplant/react-native-foreground-service react-native-fs react-native-video
```

Link the dependencies (if required by your RN version) and ensure your `android/build.gradle` `minSdkVersion` is at least 21.
