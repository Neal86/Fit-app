package com.fitflow.app.accounts;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Replaces Capacitor's core WebView ID. No inherited root-mutation implementation is callable.
 * This is a shell packaging restriction, not an account request channel. */
@CapacitorPlugin(name = "WebView")
public final class PackagedWebView extends Plugin {
    @PluginMethod public void setServerAssetPath(PluginCall call) { call.reject("unavailable"); }
    @PluginMethod public void setServerBasePath(PluginCall call) { call.reject("unavailable"); }
    @PluginMethod public void persistServerBasePath(PluginCall call) { call.reject("unavailable"); }
    @PluginMethod public void getServerBasePath(PluginCall call) { call.reject("unavailable"); }
}
