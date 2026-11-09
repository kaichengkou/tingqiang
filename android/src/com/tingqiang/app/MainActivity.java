package com.tingqiang.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * One WebView showing dist/, the page the browser and Windows builds show, served from the APK's assets.
 *
 * The page lives at https://appassets.androidplatform.net, a name Android reserves for exactly this: a fixed origin keeps
 * saved practice across updates, https makes the microphone available, and the isolation headers below give the page
 * SharedArrayBuffer for threaded separation. Every other address is refused, and the app has no INTERNET permission.
 */
public final class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net", ORIGIN = "https://" + HOST;
    /** Older WebViews lack features the page and ONNX Runtime use (WebAssembly SIMD, module workers, 'wasm-unsafe-eval'). */
    private static final int MIN_WEBVIEW = 100;
    private static final int REQUEST_MICROPHONE = 1, REQUEST_FILES = 2, REQUEST_SAVE = 3;
    private static final int PAPER = 0xFFF5F3ED;
    private static final long MAX_OPEN_BYTES = 1L << 31, IDLE_DELAY_MS = 5000;
    private static final Set<String> OPENABLE = new HashSet<>(Arrays.asList(".tqproj", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".lrc"));
    private static final Map<String, String> HEADERS = new HashMap<>();
    static {
        HEADERS.put("Cache-Control", "no-cache");
        HEADERS.put("Cross-Origin-Opener-Policy", "same-origin");
        HEADERS.put("Cross-Origin-Embedder-Policy", "require-corp");
        HEADERS.put("Cross-Origin-Resource-Policy", "same-origin");
        // The same policy as the Windows client (desktop/main.mjs).
        HEADERS.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob: data:; "
            + "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'");
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Files handed to the app, waiting for the page to fetch them once from /__opened/<token>. */
    private final Map<String, File> opened = new ConcurrentHashMap<>();
    private final Map<String, Export> exports = new ConcurrentHashMap<>();
    private final List<String[]> pendingOpen = new ArrayList<>();
    private final Runnable becomeIdle = () -> BusyService.update(this, "", "", this.visible);
    private FrameLayout root;
    private WebView web;
    private NativeModel model;
    private SharedPreferences prefs;
    private boolean pageReady, visible, reopenOnStart;
    private long lastCrash = -60000;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest microphoneRequest;
    private Export saving;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("tingqiang", MODE_PRIVATE);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        root.setOnApplyWindowInsetsListener(this::padForSystemBars);
        setContentView(root);
        // After setContentView: the window has no decor, and so no insets controller, before it.
        drawBehindSystemBars();
        // Copies from the last run: the page has saved what it kept into its own storage.
        for (String folder : new String[]{"opened", "exports", "picked"}) clearFolder(new File(getCacheDir(), folder));
        model = new NativeModel(getAssets(), (id, json) -> main.post(() -> {
            if (web != null) web.evaluateJavascript("window.__tingqiangModel && __tingqiangModel(" + id + ", " + JSONObject.quote(json) + ")", null);
        }));
        openPage();
        // After Android ends the app in the background and restores it, the intent that first opened it was already handled.
        if (saved == null) receive(getIntent());
        if (Build.VERSION.SDK_INT >= 33) Back33.register(this);
        warnIfWebViewIsOld();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receive(intent);
    }

    @Override protected void onStart() {
        super.onStart();
        visible = true;
        if (reopenOnStart) { reopenOnStart = false; openPage(); }
    }

    @Override protected void onStop() {
        visible = false;
        super.onStop();
    }

    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        BusyService.update(this, "", "", false);
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        model.shutdown();
        io.shutdown();
        super.onDestroy();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (web != null) web.getSettings().setTextZoom(textZoom());
    }

    // ----- Page -----

    private void openPage() {
        web = new WebView(this);
        configure(web);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        pageReady = false;
        web.loadUrl(ORIGIN + "/index.html");
    }

    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(textZoom());
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setSafeBrowsingEnabled(false);
        if (Build.VERSION.SDK_INT >= 33) settings.setAlgorithmicDarkeningAllowed(false);
        settings.setUserAgentString(settings.getUserAgentString() + " TingQiang/" + versionName());
        view.setBackgroundColor(PAPER);
        // Playback and separation continue behind other apps, so the page's process must not be the first to go.
        view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        view.addJavascriptInterface(new Bridge(), "tingqiangAndroid");
        view.setWebViewClient(new Client());
        view.setWebChromeClient(new Chrome());
    }

    /** Follows the phone's text size a little: the layout holds up to 130 %, and larger text belongs to the system. */
    private int textZoom() {
        float scale = getResources().getConfiguration().fontScale;
        return Math.max(100, Math.min(130, Math.round(scale * 100)));
    }

    private void drawBehindSystemBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (controller != null) controller.setSystemBarsAppearance(light, light);
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            // Dark navigation buttons arrived in 8.1; before that the bar keeps its own dark background.
            if (Build.VERSION.SDK_INT >= 27) flags |= View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            window.getDecorView().setSystemUiVisibility(flags);
        }
        window.setStatusBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 27) window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) window.setNavigationBarContrastEnforced(false);
    }

    /** The page draws only inside the bars, the notch and the keyboard. */
    private WindowInsets padForSystemBars(View view, WindowInsets insets) {
        if (Build.VERSION.SDK_INT >= 30) {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            int keyboard = insets.getInsets(WindowInsets.Type.ime()).bottom;
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard));
        } else {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
        }
        return insets;
    }

    /** The page went away: a crash, or Android reclaiming memory while the app was behind others. */
    private void replacePage(WebView dead, boolean crashed) {
        boolean current = dead == web;
        if (current) { root.removeView(dead); web = null; pageReady = false; }
        dead.destroy();
        if (!current) return;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        main.removeCallbacks(becomeIdle);
        BusyService.update(this, "", "", visible);
        // A separation that ended with the page leaves its model loaded; the new page may need the memory.
        model.release(0);
        if (!visible) { reopenOnStart = true; return; }
        long now = SystemClock.elapsedRealtime();
        boolean again = now - lastCrash < 20000;
        lastCrash = now;
        if (!again) {
            openPage();
            toast(crashed ? "听腔的页面出错了，已经重新打开。保存过的练习都还在。" : "听腔的页面被系统关闭了，已经重新打开。保存过的练习都还在。");
            return;
        }
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
            .setTitle("听腔又出错了")
            .setMessage("保存过的练习都还在。如果是在减弱伴奏时出错，可能是手机内存不够，可以先剪短录音再试。")
            .setCancelable(false)
            .setPositiveButton("重新打开", (dialog, which) -> openPage())
            .setNegativeButton("退出", (dialog, which) -> finish())
            .show();
    }

    private void warnIfWebViewIsOld() {
        PackageInfo webView = WebView.getCurrentWebViewPackage();
        int major = 0;
        try { major = Integer.parseInt(webView.versionName.split("\\.")[0]); } catch (RuntimeException ignored) { /* Unknown: let the page try. */ }
        if (webView == null || major >= MIN_WEBVIEW) return;
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
            .setTitle("系统网页组件太旧")
            .setMessage("听腔需要 Android System WebView " + MIN_WEBVIEW + " 或更新版本，这部手机是 " + webView.versionName
                + "。请在应用商店更新「Android System WebView」或升级系统；不更新的话，分析和减弱伴奏可能用不了。")
            .setPositiveButton("知道了", null)
            .show();
    }

    // ----- Serving the page -----

    private static boolean isApp(Uri url) {
        return "https".equals(url.getScheme()) && HOST.equals(url.getHost());
    }

    private WebResourceResponse serve(WebResourceRequest request) {
        Uri url = request.getUrl();
        // Anything else is refused here, before WebView could try the network.
        if (!isApp(url)) return failure(403, "Forbidden");
        if (!"GET".equalsIgnoreCase(request.getMethod())) return failure(405, "Method Not Allowed");
        String path = url.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
        if (path.startsWith("/__opened/")) {
            File file = opened.remove(path.substring("/__opened/".length()));
            try { return file == null ? failure(404, "Not Found") : respond("application/octet-stream", new DeleteOnClose(file)); }
            catch (IOException e) { return failure(404, "Not Found"); }
        }
        if (path.startsWith("/__model/")) {
            byte[] output = null;
            try { output = model.take(Integer.parseInt(path.substring("/__model/".length()))); } catch (NumberFormatException ignored) { /* Not a pass. */ }
            return output == null ? failure(404, "Not Found") : respond("application/octet-stream", new ByteArrayInputStream(output));
        }
        if (path.contains("..") || path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return failure(404, "Not Found");
        String name = path.substring(1);
        try { return respond(mimeType(name), getAssets().open("web/" + name, AssetManager.ACCESS_STREAMING)); }
        catch (IOException e) { return failure(404, "Not Found"); }
    }

    private static WebResourceResponse respond(String mime, InputStream data) {
        boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
        return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", new HashMap<>(HEADERS), data);
    }

    private static WebResourceResponse failure(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, new HashMap<>(HEADERS), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeType(String name) {
        switch (extension(name)) {
            case ".html": return "text/html";
            case ".mjs": case ".js": return "text/javascript";
            case ".css": return "text/css";
            case ".json": return "application/json";
            case ".svg": return "image/svg+xml";
            case ".wasm": return "application/wasm";
            case ".txt": return "text/plain";
            case ".png": return "image/png";
            default: return "application/octet-stream";
        }
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase(Locale.ROOT);
    }

    /** An opened file is served once and then removed. */
    private static final class DeleteOnClose extends FileInputStream {
        private final File file;
        DeleteOnClose(File file) throws FileNotFoundException { super(file); this.file = file; }
        @Override public void close() throws IOException {
            try { super.close(); } finally { file.delete(); }
        }
    }

    private final class Client extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return serve(request); }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !isApp(request.getUrl()); }
        @Override public void onPageStarted(WebView view, String url, Bitmap favicon) { if (view == web) pageReady = false; }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            replacePage(view, detail.didCrash());
            return true;
        }
    }

    // ----- Microphone and file picking -----

    private final class Chrome extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest request) { main.post(() -> askForMicrophone(request)); }
        @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (microphoneRequest == request) microphoneRequest = null; }
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            // Lyrics and practice packages have no type Android knows, so only recordings are filtered.
            if (acceptsOnlyAudio(params.getAcceptTypes())) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "application/ogg", "video/mp4", "video/webm"});
            try { startActivityForResult(intent, REQUEST_FILES); }
            catch (ActivityNotFoundException e) { fileCallback = null; toast("这部手机上没有选择文件的应用。"); return false; }
            return true;
        }
    }

    private static boolean acceptsOnlyAudio(String[] accept) {
        boolean audio = false;
        for (String entry : accept) for (String type : entry.split(",")) {
            String t = type.trim().toLowerCase(Locale.ROOT);
            if (t.isEmpty()) continue;
            if (t.startsWith("audio/") || Arrays.asList(".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".webm").contains(t)) audio = true;
            else return false;
        }
        return audio;
    }

    private void askForMicrophone(PermissionRequest request) {
        boolean audioOnly = request.getResources().length > 0;
        for (String resource : request.getResources()) audioOnly &= PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource);
        if (!audioOnly || !isApp(request.getOrigin())) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) { request.grant(request.getResources()); return; }
        if (microphoneRequest != null) microphoneRequest.deny();
        microphoneRequest = request;
        prefs.edit().putBoolean("asked-microphone", true).apply();
        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != REQUEST_MICROPHONE || microphoneRequest == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) microphoneRequest.grant(microphoneRequest.getResources());
        else microphoneRequest.deny();
        microphoneRequest = null;
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        if (request == REQUEST_FILES) {
            final List<Uri> picked = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) picked.add(clip.getItemAt(i).getUri());
                else if (data.getData() != null) picked.add(data.getData());
            }
            final ValueCallback<Uri[]> callback = fileCallback;
            fileCallback = null;
            if (callback == null) return;
            if (picked.isEmpty()) { callback.onReceiveValue(null); return; }
            // WebView gives a content:// pick a size of 0 although it reads in full, so slicing it, building a practice
            // package from it or checking its size all fail. A copy in the app's cache is an ordinary file.
            io.execute(() -> {
                List<Uri> copies = new ArrayList<>();
                for (Uri uri : picked) {
                    File copy = copyToCache(uri, "picked");
                    if (copy != null) copies.add(Uri.fromFile(copy));
                }
                main.post(() -> callback.onReceiveValue(copies.isEmpty() ? null : copies.toArray(new Uri[0])));
            });
        } else if (request == REQUEST_SAVE) {
            final Export export = saving;
            saving = null;
            if (result != RESULT_OK || data == null || data.getData() == null || export == null) return;
            final Uri target = data.getData();
            io.execute(() -> {
                try (InputStream in = new FileInputStream(export.file); OutputStream out = getContentResolver().openOutputStream(target)) {
                    if (out == null) throw new IOException("无法写入");
                    copy(in, out, Long.MAX_VALUE);
                    toast("已保存到手机。");
                } catch (IOException | SecurityException e) { toast("保存失败：" + e.getMessage()); }
            });
        }
    }

    // ----- Files handed to the app: 打开方式 and 分享 -----

    private void receive(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = stream(intent);
        if (uri == null) return;
        final Uri source = uri;
        final String type = intent.getType();
        io.execute(() -> copyIn(source, type));
    }

    @SuppressWarnings("deprecation")
    private static Uri stream(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        Object value = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return value instanceof Uri ? (Uri) value : null;
    }

    private void copyIn(Uri uri, String type) {
        String name = displayName(uri);
        if (!OPENABLE.contains(extension(name)) && (type == null || !type.startsWith("audio/"))) { toast("听腔打不开这种文件：" + name); return; }
        File folder = new File(getCacheDir(), "opened");
        String token = UUID.randomUUID().toString();
        File file = new File(folder, token);
        folder.mkdirs();
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(file)) {
            if (in == null) throw new IOException("没有内容");
            copy(in, out, MAX_OPEN_BYTES);
        } catch (IOException | SecurityException e) {
            file.delete();
            toast("无法读取「" + name + "」。");
            return;
        }
        opened.put(token, file);
        final String[] entry = {name, ORIGIN + "/__opened/" + token};
        main.post(() -> { pendingOpen.add(entry); flushOpened(); });
    }

    /** A copy under cache/&lt;folder&gt;/&lt;random&gt;/, keeping the file's own name, or null if it cannot be read. */
    private File copyToCache(Uri uri, String folder) {
        File directory = new File(new File(getCacheDir(), folder), UUID.randomUUID().toString()), file = new File(directory, safeName(displayName(uri)));
        directory.mkdirs();
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(file)) {
            if (in == null) throw new IOException("没有内容");
            copy(in, out, MAX_OPEN_BYTES);
            return file;
        } catch (IOException | SecurityException e) {
            clearFolder(directory);
            toast("无法读取「" + file.getName() + "」。");
            return null;
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (RuntimeException ignored) { /* Some apps share streams their provider cannot describe. */ }
        String last = uri.getLastPathSegment();
        return last == null || last.isEmpty() ? "录音" : last.substring(last.lastIndexOf('/') + 1);
    }

    private void flushOpened() {
        if (!pageReady || web == null) return;
        for (String[] file : pendingOpen) {
            web.evaluateJavascript("window.__tingqiangOpen && __tingqiangOpen(" + JSONObject.quote(file[0]) + ", " + JSONObject.quote(file[1]) + ")", null);
        }
        pendingOpen.clear();
    }

    // ----- Saving files the page made: 发送给 or 保存到手机 -----

    private static final class Export {
        final File file;
        final String mime;
        final OutputStream out;
        Export(File file, String mime) throws IOException {
            this.file = file;
            this.mime = mime;
            out = new BufferedOutputStream(new FileOutputStream(file), 1 << 16);
        }
    }

    private void offer(Export export) {
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Light_Dialog_Alert)
            .setTitle(export.file.getName())
            .setItems(new CharSequence[]{"发送给…（微信、QQ 等）", "保存到手机…"}, (dialog, which) -> { if (which == 0) share(export); else saveAs(export); })
            .setNegativeButton("取消", null)
            .show();
    }

    private void share(Export export) {
        Uri uri = SharedFiles.uriFor(export.file);
        Intent send = new Intent(Intent.ACTION_SEND).setType(export.mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(export.file.getName(), uri));
        try { startActivity(Intent.createChooser(send, "发送「" + export.file.getName() + "」")); }
        catch (ActivityNotFoundException e) { toast("这部手机上没有可以接收文件的应用。"); }
    }

    private void saveAs(Export export) {
        saving = export;
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(export.mime).putExtra(Intent.EXTRA_TITLE, export.file.getName());
        try { startActivityForResult(create, REQUEST_SAVE); }
        catch (ActivityNotFoundException e) { saving = null; toast("这部手机上没有保存文件的应用。"); }
    }

    private static String safeName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (clean.isEmpty() || clean.startsWith(".")) clean = "听腔" + clean;
        if (clean.length() > 120) {
            String ext = extension(clean);
            clean = clean.substring(0, 120 - ext.length()) + ext;
        }
        return clean;
    }

    // ----- Bridge for the page (dist/lib/shell.mjs) -----

    /** Called on WebView's own thread; anything touching views goes through the main thread. */
    private final class Bridge {
        @JavascriptInterface public void ready() { main.post(() -> { pageReady = true; flushOpened(); }); }

        @JavascriptInterface public String info() {
            try {
                PackageInfo webView = WebView.getCurrentWebViewPackage();
                return new JSONObject().put("version", versionName()).put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                    .put("webview", webView == null ? "" : webView.versionName).put("device", Build.MANUFACTURER + " " + Build.MODEL).toString();
            } catch (Exception e) { return "{}"; }
        }

        /** "granted", "prompt", or "denied" once Android no longer shows its question and only Settings can change it. */
        @JavascriptInterface public String microphoneAccess() {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return "granted";
            boolean asked = prefs.getBoolean("asked-microphone", false);
            return asked && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) ? "denied" : "prompt";
        }

        @JavascriptInterface public void openMicrophoneSettings() {
            main.post(() -> {
                try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))); }
                catch (ActivityNotFoundException e) { toast("请在系统设置的应用管理里找到「听腔」，打开麦克风权限。"); }
            });
        }

        /** kind is "playing", "processing" or "": the screen stays on and Android lets the work go on behind other apps. */
        @JavascriptInterface public void setBusy(String kind, String text) {
            final String k = kind == null ? "" : kind, t = text == null ? "" : text;
            main.post(() -> {
                main.removeCallbacks(becomeIdle);
                if (k.isEmpty()) {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    // Practice pauses between repetitions; ending the service then would stop it for good behind a locked screen.
                    main.postDelayed(becomeIdle, IDLE_DELAY_MS);
                } else {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    BusyService.update(MainActivity.this, k, t, visible);
                }
            });
        }

        // The separation model's passes (NativeModel); each call answers through __tingqiangModel(id, json).
        @JavascriptInterface public boolean modelAvailable() { return model.available(); }
        @JavascriptInterface public void modelLoad(int id) { model.load(id); }
        @JavascriptInterface public boolean modelBegin(int id, int bytes) { return model.begin(id, bytes); }
        @JavascriptInterface public boolean modelAppend(int id, String base64) { return model.append(id, base64); }
        @JavascriptInterface public void modelRun(int id, String dims) { model.run(id, dims); }
        @JavascriptInterface public void modelRelease(int id) { model.release(id); }

        @JavascriptInterface public String beginSave(String name, String mime) {
            String id = UUID.randomUUID().toString();
            File folder = new File(new File(getCacheDir(), "exports"), id);
            if (!folder.mkdirs()) return "";
            try {
                exports.put(id, new Export(new File(folder, safeName(name)), mime == null || mime.isEmpty() ? "application/octet-stream" : mime));
                return id;
            } catch (IOException e) { return ""; }
        }

        @JavascriptInterface public boolean appendSave(String id, String base64) {
            Export export = exports.get(id);
            if (export == null) return false;
            try { export.out.write(Base64.decode(base64, Base64.DEFAULT)); return true; }
            catch (IOException | IllegalArgumentException e) { return false; }
        }

        @JavascriptInterface public void finishSave(String id) {
            final Export export = exports.remove(id);
            if (export == null) return;
            try { export.out.close(); } catch (IOException e) { toast("文件没有写完：" + e.getMessage()); return; }
            main.post(() -> offer(export));
        }

        @JavascriptInterface public void cancelSave(String id) {
            Export export = exports.remove(id);
            if (export == null) return;
            try { export.out.close(); } catch (IOException ignored) { /* Removed below. */ }
            clearFolder(export.file.getParentFile());
        }
    }

    // ----- Back -----

    /** Before Android 13, and as the fallback after it. */
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { goBack(); }

    /** The page closes a dialog or stops a recording first; otherwise the app goes behind, keeping the page as it was. */
    void goBack() {
        if (web == null) { moveTaskToBack(true); return; }
        web.evaluateJavascript("window.__tingqiangBack ? window.__tingqiangBack() : false", value -> { if (!"true".equals(value)) moveTaskToBack(true); });
    }

    /** Kept apart so older Android never loads the Android 13 types. */
    private static final class Back33 {
        static void register(MainActivity activity) {
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, activity::goBack);
        }
    }

    // ----- Helpers -----

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (PackageManager.NameNotFoundException e) { return ""; }
    }

    void toast(final String message) {
        main.post(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
    }

    private static void copy(InputStream in, OutputStream out, long limit) throws IOException {
        byte[] buffer = new byte[1 << 16];
        long total = 0;
        for (int n; (n = in.read(buffer)) > 0; ) {
            total += n;
            if (total > limit) throw new IOException("文件太大");
            out.write(buffer, 0, n);
        }
    }

    static void clearFolder(File folder) {
        File[] children = folder == null ? null : folder.listFiles();
        if (children != null) for (File child : children) {
            if (child.isDirectory()) clearFolder(child);
            else child.delete();
        }
        if (folder != null) folder.delete();
    }
}
