package com.termux.app;

import android.os.Handler;
import android.os.Looper;
import com.termux.shared.shell.command.runner.app.AppShell;
import com.termux.shared.termux.TermuxConstants;
import java.io.File;

/** Uses the upstream AppShell/TermuxTask runner, environment and notification. */
final class MushiRuntime {
    static final String ACTION_START = "io.carmo.mushi.START";
    private final TermuxService service;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AppShell task;
    private final Runnable monitor = new Runnable() {
        @Override public void run() {
            if (enabled() && (task == null || !task.getExecutionCommand().isExecuting())) {
                task = service.createTermuxTask(TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/bin/bash",
                    new String[]{TermuxConstants.TERMUX_HOME_DIR_PATH + "/.mushi/start-agent.sh"}, null,
                    TermuxConstants.TERMUX_HOME_DIR_PATH);
            }
            handler.postDelayed(this, 30000);
        }
    };
    MushiRuntime(TermuxService service) { this.service = service; handler.post(monitor); }
    static boolean enabled() {
        return new File(TermuxConstants.TERMUX_HOME_DIR_PATH, ".mushi/enabled").isFile();
    }
    void ensure() { handler.removeCallbacks(monitor); handler.post(monitor); }
    void dispose() { handler.removeCallbacks(monitor); }
    void stop() {
        new File(TermuxConstants.TERMUX_HOME_DIR_PATH, ".mushi/enabled").delete();
        // Let Harness.close() preserve pending work and release SQLite ownership.
        new Thread(() -> {
            try { MushiActivity.socketRequest("POST", "/api/shutdown", "{}"); }
            catch (Exception ignored) { /* Not started yet; shell sees the removed enabled file. */ }
        }, "mushi-stop").start();
    }
}
