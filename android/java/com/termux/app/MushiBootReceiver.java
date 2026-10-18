package com.termux.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/** Start/recover is an opt-in persisted by the enabled marker. Stop removes it. */
public final class MushiBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) || !MushiRuntime.enabled()) return;
        try {
            Intent service = new Intent(context, TermuxService.class).setAction(MushiRuntime.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service); else context.startService(service);
        } catch (RuntimeException e) {
            // OEM restrictions/force-stop can require the user to launch the app again.
            Log.w("Mushi", "Boot recovery requires a manual app launch", e);
        }
    }
}
