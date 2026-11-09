package com.tingqiang.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Lends a saved file to the app it is sent to (微信, QQ, 文件管理…), read only and only through the grant on that one share.
 * The files live in the cache folder MainActivity writes exports to: content://com.tingqiang.app.files/<id>/<name>.
 */
public final class SharedFiles extends ContentProvider {
    static final String AUTHORITY = "com.tingqiang.app.files";

    static Uri uriFor(File file) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(file.getParentFile().getName()).appendPath(file.getName()).build();
    }

    @Override public boolean onCreate() { return true; }

    private File fileFor(Uri uri) throws FileNotFoundException {
        List<String> segments = uri.getPathSegments();
        if (segments.size() != 2) throw new FileNotFoundException(uri.toString());
        File exports = new File(getContext().getCacheDir(), "exports");
        File file = new File(new File(exports, segments.get(0)), segments.get(1));
        try {
            if (!file.getCanonicalPath().startsWith(exports.getCanonicalPath() + File.separator) || !file.isFile()) throw new FileNotFoundException(uri.toString());
        } catch (IOException e) { throw new FileNotFoundException(uri.toString()); }
        return file;
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("Shared files are read only.");
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try { file = fileFor(uri); } catch (FileNotFoundException e) { return null; }
        String[] wanted = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        List<String> columns = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (String column : wanted) {
            if (OpenableColumns.DISPLAY_NAME.equals(column)) { columns.add(column); values.add(file.getName()); }
            else if (OpenableColumns.SIZE.equals(column)) { columns.add(column); values.add(file.length()); }
        }
        MatrixCursor cursor = new MatrixCursor(columns.toArray(new String[0]), 1);
        cursor.addRow(values.toArray());
        return cursor;
    }

    @Override public String getType(Uri uri) {
        String name = uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment().toLowerCase(Locale.ROOT);
        if (name.endsWith(".wav")) return "audio/wav";
        if (name.endsWith(".m4a")) return "audio/mp4";
        if (name.endsWith(".mp3")) return "audio/mpeg";
        if (name.endsWith(".ogg")) return "audio/ogg";
        if (name.endsWith(".webm")) return "audio/webm";
        return "application/octet-stream";
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read only."); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
