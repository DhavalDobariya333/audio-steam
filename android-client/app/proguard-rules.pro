# Keep AndroidX Room components & entities
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class * { *; }
-keep @androidx.room.Dao class * { *; }
-dontwarn androidx.room.paging.**

# Keep OkHttp & Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# Keep Coroutines
-dontwarn kotlinx.coroutines.**
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# Keep Gson models and annotations
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}

# Keep Services and NotificationListener
-keep public class com.audiostream.client.AudioRecordService extends android.app.Service
-keep public class com.audiostream.client.CallNotificationListener extends android.service.notification.NotificationListenerService
-keep public class com.audiostream.client.BootReceiver extends android.content.BroadcastReceiver
-keep public class com.audiostream.client.AlarmReceiver extends android.content.BroadcastReceiver
-keep public class com.audiostream.client.MainActivity extends androidx.appcompat.app.AppCompatActivity

# Strip debugging logs and line numbers in release
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable
