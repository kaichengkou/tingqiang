package com.tingqiang.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps practice playing and separation running while the phone is locked or another app is in front.
 *
 * Without it Android freezes the app's page within seconds of it leaving the screen, or ends it to reclaim memory, and a
 * separation that takes minutes on a phone is lost. A foreground service, shown as a notification, is how an app asks to
 * keep working. Recording is not covered: the page stops a recording when it leaves the screen.
 */
public final class BusyService extends Service {
    private static final int NOTIFICATION = 1;
    private static final String CHANNEL = "busy";
    private static final long WAKE_LIMIT_MS = 30 * 60 * 1000;
    private static volatile boolean running;
    private PowerManager.WakeLock wakeLock;

    /** kind is "playing", "processing" or "" to stop. Android only lets an app start one while it is on screen. */
    static void update(Context context, String kind, String text, boolean onScreen) {
        Intent intent = new Intent(context, BusyService.class).putExtra("kind", kind).putExtra("text", text);
        if (kind.isEmpty()) { if (running) context.stopService(intent); return; }
        if (!running && !onScreen) return;
        try { context.startForegroundService(intent); }
        catch (RuntimeException e) { /* Refused while in the background: the work goes on until Android pauses it. */ }
    }

    @Override public void onCreate() {
        super.onCreate();
        running = true;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String kind = intent == null ? null : intent.getStringExtra("kind"), text = intent == null ? null : intent.getStringExtra("text");
        if (kind == null || kind.isEmpty()) { stopSelf(); return START_NOT_STICKY; }
        boolean processing = "processing".equals(kind);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                int type = !processing ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    : Build.VERSION.SDK_INT >= 35 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
                startForeground(NOTIFICATION, notification(text), type);
            } else startForeground(NOTIFICATION, notification(text));
        } catch (RuntimeException e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Playback keeps the processor awake through the audio system; separation needs to ask for itself.
        if (processing) holdWakeLock(); else releaseWakeLock();
        return START_NOT_STICKY;
    }

    private Notification notification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.busy_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.busy_channel_description));
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFFA34132)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text == null || text.isEmpty() ? "正在工作" : text)
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void holdWakeLock() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tingqiang:processing");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKE_LIMIT_MS);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    /** Android 15 limits processing services to six hours a day. */
    @Override public void onTimeout(int startId, int type) { stopSelf(); }

    @Override public void onDestroy() {
        running = false;
        releaseWakeLock();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
