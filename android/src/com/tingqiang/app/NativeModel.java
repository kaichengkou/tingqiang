package com.tingqiang.app;

import android.content.res.AssetManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtLoggingLevel;
import ai.onnxruntime.OrtSession;

/**
 * Runs the separation model's passes for the page with ONNX Runtime's Android build.
 *
 * Android WebView gives pages no threads (it has no cross-origin isolation), and a single WebAssembly thread needs about
 * a quarter of an hour for a two-minute recording on a phone. Here the same model runs on several cores with ARM kernels.
 * The page keeps everything else (STFT, blocks, mixing), so results match the browser and Windows builds; it sends each
 * pass's input as base64 pieces and fetches the output from /__model/&lt;id&gt; (MainActivity serves it).
 */
final class NativeModel {
    interface Reply { void send(int id, String json); }

    private static final String MODEL = "web/models/UVR_MDXNET_KARA_2.onnx";
    private final AssetManager assets;
    private final Reply reply;
    private final ExecutorService runner = Executors.newSingleThreadExecutor();
    private final Map<Integer, ByteBuffer> inputs = new ConcurrentHashMap<>();
    private final Map<Integer, byte[]> outputs = new ConcurrentHashMap<>();
    private OrtEnvironment environment;
    private OrtSession session;
    private String inputName, outputName;
    private Boolean available;

    NativeModel(AssetManager assets, Reply reply) {
        this.assets = assets;
        this.reply = reply;
    }

    /** False on phones the library has no build for (32-bit only, for one); the page then uses WebAssembly. */
    synchronized boolean available() {
        if (available == null) {
            try { environment = OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_WARNING, "tingqiang"); available = true; }
            catch (Throwable e) { available = false; }
        }
        return available;
    }

    /** Leaves two cores for playback and the page; beyond four the passes gained little on the emulator. */
    static int threads() {
        return Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 2));
    }

    void load(int id) {
        runner.execute(() -> {
            try {
                if (!available()) throw new IllegalStateException("ONNX Runtime is not available on this phone");
                if (session == null) {
                    OrtSession.SessionOptions options = new OrtSession.SessionOptions();
                    options.setIntraOpNumThreads(threads());
                    options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                    session = environment.createSession(readModel(), options);
                    inputName = session.getInputNames().iterator().next();
                    outputName = session.getOutputNames().iterator().next();
                }
                reply.send(id, new JSONObject().put("threads", threads()).toString());
            } catch (Throwable e) { fail(id, e); }
        });
    }

    /** The model is stored compressed in the APK; ONNX Runtime wants it whole in native memory. */
    private ByteBuffer readModel() throws IOException {
        try (InputStream in = assets.open(MODEL, AssetManager.ACCESS_STREAMING)) {
            ByteBuffer buffer = ByteBuffer.allocateDirect(64 * 1024 * 1024);
            byte[] chunk = new byte[1 << 16];
            for (int n; (n = in.read(chunk)) > 0; ) {
                if (buffer.remaining() < n) {
                    ByteBuffer larger = ByteBuffer.allocateDirect(buffer.capacity() * 2);
                    buffer.flip();
                    larger.put(buffer);
                    buffer = larger;
                }
                buffer.put(chunk, 0, n);
            }
            buffer.flip();
            return buffer;
        }
    }

    boolean begin(int id, int bytes) {
        if (bytes <= 0 || bytes > 256 * 1024 * 1024) return false;
        inputs.put(id, ByteBuffer.allocateDirect(bytes).order(ByteOrder.LITTLE_ENDIAN));
        return true;
    }

    boolean append(int id, String base64) {
        ByteBuffer input = inputs.get(id);
        if (input == null) return false;
        try { input.put(android.util.Base64.decode(base64, android.util.Base64.DEFAULT)); return true; }
        catch (RuntimeException e) { inputs.remove(id); return false; }
    }

    void run(int id, String dims) {
        runner.execute(() -> {
            ByteBuffer input = inputs.remove(id);
            try {
                if (session == null || input == null || input.hasRemaining()) throw new IllegalStateException("The pass's input did not arrive whole");
                JSONArray array = new JSONArray(dims);
                long[] shape = new long[array.length()];
                for (int i = 0; i < shape.length; i++) shape[i] = array.getLong(i);
                input.flip();
                try (OnnxTensor tensor = OnnxTensor.createTensor(environment, input.asFloatBuffer(), shape);
                     OrtSession.Result result = session.run(Collections.singletonMap(inputName, tensor))) {
                    OnnxTensor output = (OnnxTensor) result.get(outputName).orElseThrow(() -> new IllegalStateException("The model gave no output"));
                    ByteBuffer data = output.getByteBuffer().order(ByteOrder.LITTLE_ENDIAN);
                    byte[] bytes = new byte[data.remaining()];
                    data.get(bytes);
                    outputs.put(id, bytes);
                    reply.send(id, new JSONObject().put("dims", new JSONArray(output.getInfo().getShape())).toString());
                }
            } catch (Throwable e) { fail(id, e); }
        });
    }

    /** The output of a finished pass, once. */
    byte[] take(int id) { return outputs.remove(id); }

    void release(int id) {
        runner.execute(() -> {
            try { if (session != null) session.close(); } catch (Throwable ignored) { /* Closing anyway. */ }
            session = null;
            inputs.clear();
            outputs.clear();
            reply.send(id, "{}");
        });
    }

    void shutdown() {
        release(0);
        runner.shutdown();
    }

    private void fail(int id, Throwable error) {
        try { reply.send(id, new JSONObject().put("error", String.valueOf(error.getMessage())).toString()); }
        catch (Exception ignored) { reply.send(id, "{\"error\":\"native model failed\"}"); }
    }
}
