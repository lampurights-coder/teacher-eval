package ir.embed.asrparser;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * In-process audio loading only — never opens DocumentsUI / Files
 * (that path destroys the Capacitor WebView on many devices/emulators).
 */
@CapacitorPlugin(name = "AudioPicker")
public class AudioPickerPlugin extends Plugin {

    private static final String DEMO_ASSET = "samples/dual_speaker_class.mp3";

    @PluginMethod
    public void loadDemo(PluginCall call) {
        try {
            byte[] bytes = readAsset(DEMO_ASSET);
            call.resolve(toResult("dual_speaker_class.mp3", "audio/mpeg", bytes));
        } catch (Exception e) {
            call.reject("Could not load demo audio: " + e.getMessage());
        }
    }

    @PluginMethod
    public void loadDownload(PluginCall call) {
        String name = call.getString("name", "");
        if (name == null || name.trim().isEmpty()) {
            call.reject("name required");
            return;
        }
        name = name.trim();
        // Prevent path traversal
        if (name.contains("..") || name.contains("/") || name.contains("\\")) {
            call.reject("Invalid file name");
            return;
        }
        try {
            File downloads = android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS
            );
            File music = android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_MUSIC
            );
            File file = new File(downloads, name);
            if (!file.isFile()) {
                file = new File(music, name);
            }
            if (!file.isFile()) {
                call.reject("File not found in Downloads/Music: " + name);
                return;
            }
            byte[] bytes = readFile(file);
            String mime = guessMime(name);
            call.resolve(toResult(name, mime, bytes));
        } catch (SecurityException se) {
            call.reject("No permission to read Downloads. Use the demo sample instead.");
        } catch (Exception e) {
            call.reject("Could not read file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void listDownloads(PluginCall call) {
        com.getcapacitor.JSArray files = new com.getcapacitor.JSArray();
        try {
            addDir(files, android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS
            ));
            addDir(files, android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_MUSIC
            ));
        } catch (Exception ignored) {
            // Still return whatever we collected
        }
        JSObject out = new JSObject();
        out.put("files", files);
        out.put("demo", "dual_speaker_class.mp3");
        call.resolve(out);
    }

    private void addDir(com.getcapacitor.JSArray files, File dir) {
        if (dir == null || !dir.isDirectory()) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File file : list) {
            if (!file.isFile()) continue;
            String name = file.getName();
            String lower = name.toLowerCase(Locale.US);
            if (!(lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".m4a")
                || lower.endsWith(".ogg") || lower.endsWith(".flac") || lower.endsWith(".aac")
                || lower.endsWith(".webm"))) {
                continue;
            }
            JSObject row = new JSObject();
            row.put("name", name);
            row.put("size", file.length());
            files.put(row);
        }
    }

    private byte[] readAsset(String path) throws Exception {
        try (InputStream in = getContext().getAssets().open(path);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            copy(in, out);
            return out.toByteArray();
        }
    }

    private byte[] readFile(File file) throws Exception {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            copy(in, out);
            return out.toByteArray();
        }
    }

    private void copy(InputStream in, ByteArrayOutputStream out) throws Exception {
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) {
            out.write(buf, 0, n);
        }
    }

    private String guessMime(String name) {
        String lower = name.toLowerCase(Locale.US);
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".ogg")) return "audio/ogg";
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".webm")) return "audio/webm";
        return "audio/mpeg";
    }

    private JSObject toResult(String name, String mime, byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            throw new IllegalStateException("Empty audio");
        }
        JSObject out = new JSObject();
        out.put("name", name);
        out.put("mimeType", mime);
        out.put("size", bytes.length);
        out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        return out;
    }
}
