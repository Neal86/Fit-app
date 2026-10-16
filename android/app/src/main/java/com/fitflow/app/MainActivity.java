package com.fitflow.app;

import android.os.Bundle;
import com.fitflow.app.accounts.NativeAccountInstaller;
import com.fitflow.app.accounts.NativeAccountPolicy;
import com.fitflow.app.accounts.PackagedWebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.ServerPath;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Capacitor 8.5.3 loads core plugins before initialPlugins: this replaces the core WebView ID.
        // Explicit ASSET_PATH is applied after any saved deploy path and before the first load.
        bridgeBuilder.setServerPath(new ServerPath(ServerPath.PathType.ASSET_PATH, NativeAccountPolicy.ASSET_ROOT));
        registerPlugin(PackagedWebView.class);
        registerPlugin(NativeAccountInstaller.class);
        super.onCreate(savedInstanceState);
    }
}
