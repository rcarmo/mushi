package com.termux.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.termux.shared.termux.TermuxConstants;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bundled UI only. Model text is rendered as text, never executable HTML. */
public final class MushiActivity extends Activity {
    private static final String ORIGIN = "https://mushi.invalid";
    private WebView web;
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private volatile boolean destroyed;
    private final Set<String> routes = new HashSet<>(Arrays.asList(
        "GET /api/state", "GET /api/models", "POST /api/config", "POST /api/submit",
        "POST /api/abort", "POST /api/reset", "GET /api/auth", "POST /api/auth/start",
        "POST /api/auth/cancel", "POST /api/auth/logout"));

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // persistent idempotent outbox, no credentials
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE); // always load this APK's UI after upgrades
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.addJavascriptInterface(new Bridge(), "MushiNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                String path = uri.getPath();
                if ("https".equals(uri.getScheme()) && "mushi.invalid".equals(uri.getHost()) &&
                    ("/".equals(path) || "/app.js".equals(path) || "/style.css".equals(path) || "/mushi.svg".equals(path))) {
                    String name = "/".equals(path) ? "index.html" : path.substring(1);
                    String mime = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html";
                    try { return new WebResourceResponse(mime, "UTF-8", getAssets().open("mushi/" + name)); }
                    catch (IOException ignored) { }
                }
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
        });
        web.loadUrl(ORIGIN + "/");
        // An opted-in existing installation should load updated agent assets
        // when reopened, without silently enabling a previously stopped service.
        if (MushiRuntime.enabled()) startAgent();
    }

    private void startAgent() {
        TermuxInstaller.setupBootstrapIfNeeded(this, () -> io.execute(() -> {
            try {
                File home = new File(TermuxConstants.TERMUX_HOME_DIR_PATH, ".mushi");
                if (!home.isDirectory() && !home.mkdirs()) throw new IOException("Cannot create agent directory");
                // Install atomically and restart a changed agent bundle without
                // deleting durable state or disabling background recovery.
                boolean agentChanged = false;
                for (String name : new String[]{"codemode-worker.mjs", "quickjs.wasm", "start-agent.sh", "agent.mjs"}) {
                    File installed = new File(home, name);
                    byte[] previous = installed.isFile() ? digest(installed) : null;
                    File tmp = new File(home, name + ".tmp");
                    try (InputStream in = getAssets().open("mushi/" + name); OutputStream out = new FileOutputStream(tmp)) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                    }
                    if (previous != null && !Arrays.equals(previous, digest(tmp))) agentChanged = true;
                    if (!tmp.renameTo(installed)) throw new IOException("Cannot install " + name);
                }
                new File(home, "enabled").createNewFile();
                if (agentChanged) {
                    try { socketRequest("POST", "/api/shutdown", "{}"); }
                    catch (IOException ignored) { /* No running daemon; the service will start the new bundle. */ }
                }
                runOnUiThread(() -> {
                    Intent intent = new Intent(MushiActivity.this, TermuxService.class).setAction(MushiRuntime.ACTION_START);
                    if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
                });
            } catch (Exception e) { notifyError(e); }
        }));
    }

    private static byte[] digest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = in.read(buffer)) != -1) digest.update(buffer, 0, n);
        }
        return digest.digest();
    }

    private void notifyError(Exception e) {
        String text = JSONObject.quote(e.getMessage() == null ? e.toString() : e.getMessage());
        runOnUiThread(() -> { if (!destroyed) web.evaluateJavascript("window.mushiError(" + text + ")", null); });
    }

    private final class Bridge {
        @JavascriptInterface public void postMessage(String json) {
            if (json.length() > 400000 || destroyed) return;
            io.execute(() -> {
                String id = "";
                JSONObject response = new JSONObject();
                try {
                    JSONObject req = new JSONObject(json);
                    id = req.getString("id");
                    if (!id.matches("[a-zA-Z0-9-]{1,80}")) throw new IOException("Invalid request ID");
                    String method = req.getString("method"), path = req.getString("path");
                    String result;
                    if ("POST".equals(method) && "/native/start".equals(path)) {
                        runOnUiThread(() -> startAgent()); result = "{\"ok\":true}";
                    } else if ("POST".equals(method) && "/native/copy-text".equals(path)) {
                        String text = req.getJSONObject("body").getString("text");
                        if (text.length() > 65536) throw new IOException("Clipboard limit: 64K characters");
                        runOnUiThread(() -> {
                            try {
                                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                                clipboard.setPrimaryClip(ClipData.newPlainText("Mushi output", text));
                            } catch (RuntimeException error) { notifyError(new IOException("Could not copy text on this device")); }
                        });
                        result = "{\"ok\":true}";
                    } else if ("POST".equals(method) && "/native/open-link".equals(path)) {
                        String raw = req.getJSONObject("body").getString("url");
                        if (raw.length() > 4096) throw new IOException("Link is too long");
                        for (int i = 0; i < raw.length(); i++) {
                            if (raw.charAt(i) <= 32 || raw.charAt(i) == 127) throw new IOException("Invalid link characters");
                        }
                        Uri uri = Uri.parse(raw);
                        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty() ||
                            uri.getUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IOException("Only HTTPS browser links are allowed");
                        runOnUiThread(() -> {
                            if (destroyed) return;
                            new AlertDialog.Builder(MushiActivity.this).setTitle("Open in browser?")
                                .setMessage(uri.toString()).setNegativeButton("Cancel", null)
                                .setPositiveButton("Open", (dialog, which) -> {
                                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
                                    catch (RuntimeException error) { notifyError(new IOException("No browser is available")); }
                                }).show();
                        });
                        result = "{\"ok\":true}";
                    } else if ("POST".equals(method) && "/native/terminal".equals(path)) {
                        runOnUiThread(() -> startActivity(new Intent(MushiActivity.this, TermuxActivity.class))); result = "{}";
                    } else if ("POST".equals(method) && ("/native/auth-browser".equals(path) || "/native/auth-copy".equals(path))) {
                        String provider = req.getJSONObject("body").getString("provider");
                        if (!"openai-codex".equals(provider) && !"github-copilot".equals(provider)) throw new IOException("Unsupported sign-in provider");
                        JSONObject login = new JSONObject(socketRequest("GET", "/api/auth", "{}")).optJSONObject("login");
                        if (login == null || !provider.equals(login.optString("provider"))) throw new IOException("No pending sign-in for this provider");
                        JSONObject device = login.optJSONObject("device");
                        if (device == null || device.optLong("expiresAt") <= System.currentTimeMillis()) throw new IOException("No active device code; start sign-in again");
                        String url = device.getString("verificationUri");
                        String expected = "openai-codex".equals(provider) ? "https://auth.openai.com/codex/device" : "https://github.com/login/device";
                        if (!url.equals(expected) && !url.equals(expected + "/")) throw new IOException("Untrusted verification page");
                        String userCode = device.getString("userCode");
                        if (!userCode.matches("[a-zA-Z0-9 -]{4,64}")) throw new IOException("Invalid device code");
                        final boolean copy = "/native/auth-copy".equals(path);
                        runOnUiThread(() -> {
                            try {
                                if (copy) {
                                    ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                                    clipboard.setPrimaryClip(ClipData.newPlainText("Mushi device code", userCode));
                                } else {
                                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
                                }
                            } catch (RuntimeException error) { notifyError(new IOException("Could not open browser/copy code on this device")); }
                        });
                        result = "{\"ok\":true}";
                    } else if ("POST".equals(method) && "/native/stop".equals(path)) {
                        runOnUiThread(() -> startService(new Intent(MushiActivity.this, TermuxService.class)
                            .setAction(TermuxConstants.TERMUX_APP.TERMUX_SERVICE.ACTION_STOP_SERVICE))); result = "{}";
                    } else if ("GET".equals(method) && "/native/licenses".equals(path)) {
                        try (InputStream in = getAssets().open("mushi/THIRD_PARTY_LICENSES.txt"); ByteArrayOutputStream text = new ByteArrayOutputStream()) {
                            byte[] bytes = new byte[8192]; int n;
                            while ((n = in.read(bytes)) != -1) text.write(bytes, 0, n);
                            result = new JSONObject().put("text", text.toString("UTF-8")).toString();
                        }
                    } else if ("GET".equals(method) && "/native/log".equals(path)) {
                        File file = new File(TermuxConstants.TERMUX_HOME_DIR_PATH, ".mushi/runtime.log");
                        String tail = "No runtime log yet. Tap Start to install and run the agent.";
                        if (file.exists()) try (RandomAccessFile log = new RandomAccessFile(file, "r")) {
                            log.seek(Math.max(0, log.length() - 16384)); byte[] bytes = new byte[(int)(log.length() - log.getFilePointer())];
                            log.readFully(bytes); tail = new String(bytes, StandardCharsets.UTF_8);
                        }
                        result = new JSONObject().put("text", tail).toString();
                    } else {
                        if (!routes.contains(method + " " + path)) throw new IOException("Forbidden route");
                        result = socketRequest(method, path, req.optJSONObject("body") == null ? "{}" : req.getJSONObject("body").toString());
                    }
                    response.put("value", new org.json.JSONTokener(result).nextValue());
                } catch (Exception e) {
                    try { response.put("error", e.getMessage() == null ? e.toString() : e.getMessage()); } catch (Exception ignored) { }
                }
                final String script = "window.mushiReply(" + JSONObject.quote(id) + "," + response + ")";
                runOnUiThread(() -> { if (!destroyed) web.evaluateJavascript(script, null); });
            });
        }
    }

    static String socketRequest(String method, String path, String body) throws IOException {
        try (LocalSocket socket = new LocalSocket()) {
            socket.connect(new LocalSocketAddress(TermuxConstants.TERMUX_HOME_DIR_PATH + "/.mushi/agent.sock", LocalSocketAddress.Namespace.FILESYSTEM));
            socket.setSoTimeout(25000);
            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            OutputStream out = socket.getOutputStream();
            out.write((method + " " + path + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + data.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            out.write(data); out.flush();
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            String status = line(in);
            int length = -1;
            String header;
            for (int count = 0; !(header = line(in)).isEmpty(); count++) {
                if (count > 50) throw new IOException("Too many headers");
                if (header.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(header.substring(15).trim());
            }
            if (length < 0 || length > 8 * 1024 * 1024) throw new IOException("Invalid response size");
            byte[] bytes = new byte[length]; int offset = 0, n;
            while (offset < length && (n = in.read(bytes, offset, length - offset)) != -1) offset += n;
            if (offset != length) throw new IOException("Incomplete response");
            String result = new String(bytes, StandardCharsets.UTF_8);
            if (!status.startsWith("HTTP/1.1 200")) {
                try { throw new IOException(new JSONObject(result).optString("error", "Agent request failed")); }
                catch (org.json.JSONException e) { throw new IOException("Agent request failed"); }
            }
            return result;
        }
    }
    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') return bytes.toString("US-ASCII").replace("\r", "");
            bytes.write(c);
            if (bytes.size() > 8192) throw new IOException("Header too long");
        }
        throw new EOFException("Agent disconnected");
    }
    @Override public void onDestroy() {
        destroyed = true;
        web.removeJavascriptInterface("MushiNative"); web.destroy();
        io.shutdownNow();
        super.onDestroy();
    }
}
