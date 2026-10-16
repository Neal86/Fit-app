package com.fitflow.app.accounts;

import java.net.URI;
import java.util.Collections;
import java.util.Set;

/** Reviewed native source policy only. Neither value is supplied by the WebView or build environment. */
public final class NativeAccountPolicy {
    private NativeAccountPolicy() {}
    private static final String PACKAGED_ENDPOINT = "";
    private static final Set<String> ALLOWED_ENDPOINTS = Collections.emptySet();
    public static final String APP_ORIGIN = "https://localhost";
    public static final String ACCOUNT_URL = APP_ORIGIN + "/account";
    public static final String ASSET_ROOT = "public";
    public static final int REQUEST_BYTES = 8192;
    public static final int SNAPSHOT_BYTES = 10 * 1024 * 1024 + 1024;
    public static final int RESPONSE_BYTES = 10 * 1024 * 1024 + 64 * 1024;
    public static final int CHALLENGE_BYTES = 256 * 1024;
    public static final int EXPORT_BYTES = 64 * 1024 * 1024;
    public static final int ERROR_BYTES = 1024;
    public static final int DEPTH = 32;
    public static final int NODES = 1_000_000;
    public static final long TIMEOUT_MS = 20_000L;
    public static final long ABSOLUTE_MS = 8 * 60 * 60 * 1000L;
    public static final long IDLE_MS = 30 * 60 * 1000L;
    public static final int LEDGER_LIMIT = 4096;

    public static String endpoint() { return validatedEndpoint(PACKAGED_ENDPOINT, ALLOWED_ENDPOINTS); }

    /** Only these packaged SPA documents may establish authority; URL/history alone never does. */
    public static boolean packagedDocument(String url) {
        if (APP_ORIGIN.equals(url)) return true;
        if (url == null || !url.startsWith(APP_ORIGIN + "/")) return false;
        String path = url.substring(APP_ORIGIN.length());
        return path.matches("/(?:index\\.html|workouts(?:/[A-Za-z0-9_-]{1,128})?|plan|schedule|nutrition|progress|account|profile)?");
    }
    public static boolean forbiddenResource(String url) {
        if (url == null) return true;
        try {
            URI uri = new URI(url); String path = uri.getPath();
            return path != null && (path.startsWith("/_capacitor_") || path.contains("\\") || path.contains("/../") || path.contains("/./"));
        } catch (Exception ignored) { return true; }
    }


    static String validatedEndpoint(String endpoint, Set<String> allowed) {
        if (endpoint == null || allowed == null || !allowed.contains(endpoint) || endpoint.length() > 2048 ||
            !endpoint.startsWith("https://") || endpoint.matches(".*[\\\\%\\s?#].*")) return null;
        try {
            URI uri = new URI(endpoint);
            String host = uri.getHost();
            int port = uri.getPort();
            if (host == null || host.isEmpty() || !host.equals(host.toLowerCase(java.util.Locale.ROOT)) ||
                uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
                !"https".equals(uri.getScheme()) || !"/api/native/v1".equals(uri.getRawPath()) ||
                port == 443 || port == 0 || port > 65535 || !uri.normalize().toASCIIString().equals(endpoint)) return null;
            // Refuse alternative port spellings (e.g. :08443) rather than accepting URI normalization.
            String authority = host + (port == -1 ? "" : ":" + port);
            if (!authority.equals(uri.getRawAuthority())) return null;
            return endpoint;
        } catch (Exception ignored) { return null; }
    }
}
