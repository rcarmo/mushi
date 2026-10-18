#!/usr/bin/env python3
"""Generate Mushi's Android workspace from pinned upstream sources + our overlay.
The upstream submodule and installed app data are never reset or edited.
"""
from pathlib import Path
import io
import shutil
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
upstream = root / 'vendor/termux-app'
termux = root / 'build/android/termux-app'
expected = '8629e632fcb95da272221be327db653fb24befe9'
actual = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip()
if actual != expected:
    raise SystemExit(f'Unexpected Termux revision {actual}; review the overlay first')
archive = subprocess.check_output(['git', '-C', str(upstream), 'archive', expected])
files, modes = {}, {}
with tarfile.open(fileobj=io.BytesIO(archive)) as source:
    for entry in source:
        if entry.isfile():
            files[entry.name] = source.extractfile(entry).read()
            modes[entry.name] = entry.mode
        elif entry.issym():
            raise SystemExit(f'Review upstream source symlink before exporting: {entry.name}')

def patch(path, old, new):
    text = files[path].decode()
    if text.count(old) != 1:
        raise SystemExit(f'Overlay mismatch: {path}: {old[:100]!r}')
    files[path] = text.replace(old, new, 1).encode()

patch('app/build.gradle', '    defaultConfig {', '''    defaultConfig {
        applicationId "io.carmo.mushi"
        ndk { abiFilters(*mushiArchitectures.collect { mushiAbiMap[it] }) }''')
patch('app/build.gradle', 'android {\n    namespace "com.termux"', '''def mushiAbiMap = [aarch64: 'arm64-v8a', arm: 'armeabi-v7a', i686: 'x86', x86_64: 'x86_64']
def mushiArchitectures = (System.getenv("MUSHI_ARCHITECTURES") ?: "aarch64").split(",").toList()
if (!mushiArchitectures || mushiArchitectures.any { !mushiAbiMap.containsKey(it) }) {
    throw new GradleException("Invalid MUSHI_ARCHITECTURES")
}

android {
    namespace "com.termux"''')
patch('app/build.gradle', "                include 'x86', 'x86_64', 'armeabi-v7a', 'arm64-v8a'", '                include(*mushiArchitectures.collect { mushiAbiMap[it] })')
patch('app/build.gradle', 'manifestPlaceholders.TERMUX_PACKAGE_NAME = "com.termux"', 'manifestPlaceholders.TERMUX_PACKAGE_NAME = "io.carmo.mushi"')
constants = 'termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java'
patch(constants, 'public static final String TERMUX_PACKAGE_NAME = "com.termux";', 'public static final String TERMUX_PACKAGE_NAME = "io.carmo.mushi";')
patch(constants, 'public static final String TERMUX_APP_NAME = "Termux";', 'public static final String TERMUX_APP_NAME = "Mushi";')
import re
text = files[constants].decode()
text = re.sub(r'(public static final String (?:BUILD_CONFIG_CLASS_NAME|FILE_SHARE_RECEIVER_ACTIVITY_CLASS_NAME|FILE_VIEW_RECEIVER_ACTIVITY_CLASS_NAME|TERMUX_ACTIVITY_NAME|TERMUX_SETTINGS_ACTIVITY_NAME|TERMUX_SERVICE_NAME|RUN_COMMAND_SERVICE_NAME) = )TERMUX_PACKAGE_NAME \+ "([^"]+)";', r'\1"com.termux\2";', text)
files[constants] = text.encode()
for resource in ['app/src/main/res/values/strings.xml', 'termux-shared/src/main/res/values/strings.xml']:
    patch(resource, '<!ENTITY TERMUX_PACKAGE_NAME "com.termux">', '<!ENTITY TERMUX_PACKAGE_NAME "io.carmo.mushi">')
    patch(resource, '<!ENTITY TERMUX_APP_NAME "Termux">', '<!ENTITY TERMUX_APP_NAME "Mushi">')
patch('termux-shared/src/main/res/values/strings.xml', '<!ENTITY TERMUX_PREFIX_DIR_PATH "/data/data/com.termux/files/usr">', '<!ENTITY TERMUX_PREFIX_DIR_PATH "/data/data/io.carmo.mushi/files/usr">')
shortcuts = 'app/src/main/res/xml/shortcuts.xml'
files[shortcuts] = files[shortcuts].replace(b'android:targetPackage="com.termux"', b'android:targetPackage="io.carmo.mushi"').replace(b'android:name="com.termux.app.failsafe_session"', b'android:name="io.carmo.mushi.app.failsafe_session"')

gradle = files['app/build.gradle'].decode()
old_bootstraps = gradle.split('task downloadBootstraps() {', 1)[1].split('\nafterEvaluate {', 1)[0]
patch('app/build.gradle', 'task downloadBootstraps() {' + old_bootstraps, '''task downloadBootstraps(type: Exec) {
    workingDir rootProject.projectDir
    commandLine "python3", "mushi/prepare-bootstraps.py", "--destination", "app/src/main/cpp"
}
''')
patch('app/build.gradle', 'afterEvaluate {\n    android.applicationVariants.all { variant ->', 'afterEvaluate {\n    tasks.named("preBuild").configure { dependsOn(downloadBootstraps) }\n    android.applicationVariants.all { variant ->')
env = 'termux-shared/src/main/java/com/termux/shared/termux/shell/command/environment/TermuxShellEnvironment.java'
patch(env, '                // Termux binaries on Android 7+ rely on DT_RUNPATH, so LD_LIBRARY_PATH should be unset by default', '                // Mushi relocated prebuilts need the app-private library path.')
patch(env, '                environment.remove(ENV_LD_LIBRARY_PATH);', '                environment.put(ENV_LD_LIBRARY_PATH, TermuxConstants.TERMUX_LIB_PREFIX_DIR_PATH);')
patch(env, '        return environment;\n    }', '''        if (!isFailSafe && new java.io.File(TermuxConstants.TERMUX_LIB_PREFIX_DIR_PATH + "/libmushi-exec.so").isFile()) {
            environment.put("LD_PRELOAD", TermuxConstants.TERMUX_LIB_PREFIX_DIR_PATH + "/libmushi-exec.so");
            environment.put("BASH_ENV", TermuxConstants.TERMUX_PREFIX_DIR_PATH + "/etc/mushi/environment.sh");
        }
        return environment;
    }''')
patch('app/src/main/cpp/Android.mk', 'LOCAL_SRC_FILES := termux-bootstrap-zip.S termux-bootstrap.c', 'LOCAL_SRC_FILES := termux-bootstrap-zip.S termux-bootstrap.c\nLOCAL_ADDITIONAL_DEPENDENCIES := $(wildcard $(LOCAL_PATH)/bootstrap-*.zip)')
# Termux's Bun prebuilt is Android API 28+, regardless of the Java UI's minimum.
patch('gradle.properties', 'minSdkVersion=21', 'minSdkVersion=28')
service = 'app/src/main/java/com/termux/app/TermuxService.java'
patch(service, '    private final IBinder mBinder = new LocalBinder();', '    private final IBinder mBinder = new LocalBinder();\n    private MushiRuntime mushiRuntime;')
patch(service, '        runStartForeground();\n\n        SystemEventReceiver.registerPackageUpdateEvents(this);', '        runStartForeground();\n        mushiRuntime = new MushiRuntime(this);\n\n        SystemEventReceiver.registerPackageUpdateEvents(this);')
patch(service, '                case TERMUX_SERVICE.ACTION_STOP_SERVICE:', '                case MushiRuntime.ACTION_START:\n                    mushiRuntime.ensure();\n                    break;\n                case TERMUX_SERVICE.ACTION_STOP_SERVICE:\n                    mushiRuntime.stop();')
patch(service, '''        // If this service really do get killed, there is no point restarting it automatically - let the user do on next
        // start of {@link Term):''', '        // Resume opted-in durable work after a system-initiated restart.')
patch(service, '        return Service.START_NOT_STICKY;', '        return MushiRuntime.enabled() ? Service.START_STICKY : Service.START_NOT_STICKY;')
patch(service, '        TermuxShellUtils.clearTermuxTMPDIR(true);', '        if (mushiRuntime != null) mushiRuntime.dispose();\n        TermuxShellUtils.clearTermuxTMPDIR(true);')
patch(service, '        if (mWakeLock == null && mShellManager.mTermuxSessions.isEmpty() && mShellManager.mTermuxTasks.isEmpty()) {', '        if (!MushiRuntime.enabled() && mWakeLock == null && mShellManager.mTermuxSessions.isEmpty() && mShellManager.mTermuxTasks.isEmpty()) {')
patch(service, 'Intent notificationIntent = TermuxActivity.newInstance(this);', 'Intent notificationIntent = new Intent(this, MushiActivity.class);')
manifest = 'app/src/main/AndroidManifest.xml'
patch(manifest, '    android:sharedUserId="${TERMUX_PACKAGE_NAME}"\n', '')
patch(manifest, '    android:installLocation="internalOnly"\n    android:sharedUserLabel="@string/shared_user_label">', '    android:installLocation="internalOnly">')
patch(manifest, '''            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>''', '')
patch(manifest, '        <activity\n            android:name=".app.TermuxActivity"', '''        <activity android:name=".app.MushiActivity" android:exported="true"
            android:label="Mushi" android:windowSoftInputMode="adjustResize"
            android:theme="@style/Theme.TermuxActivity.DayNight.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <activity
            android:name=".app.TermuxActivity"''')
patch(manifest, '        <service\n            android:name=".app.TermuxService"', '''        <receiver android:name=".app.MushiBootReceiver" android:exported="false">
            <intent-filter><action android:name="android.intent.action.BOOT_COMPLETED" /></intent-filter>
        </receiver>

        <service
            android:name=".app.TermuxService"''')
patch(manifest, '            android:name=".app.RunCommandService"\n            android:exported="true"', '            android:name=".app.RunCommandService"\n            android:exported="false"')
patch(manifest, 'android:label="@string/application_name"\n        android:requestLegacyExternalStorage', 'android:label="Mushi"\n        android:requestLegacyExternalStorage')
patch('app/build.gradle', '''    signingConfigs {
        debug {
            storeFile file('testkey_untrusted.jks')
            keyAlias 'alias'
            storePassword 'xrj45yWGLbsO7W0v'
            keyPassword 'xrj45yWGLbsO7W0v'
        }
    }''', '    // Use the builder\'s private debug key, never the public Termux test key.\n')

for path, data in files.items():
    target = termux / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or target.read_bytes() != data:
        target.write_bytes(data)
    target.chmod(modes[path])
for source in (root / 'android/java').rglob('*.java'):
    target = termux / 'app/src/main/java' / source.relative_to(root / 'android/java')
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists() or target.read_bytes() != source.read_bytes(): shutil.copy2(source, target)
for source in (root / 'android/res').rglob('*'):
    if source.is_file():
        target = termux / 'app/src/main/res' / source.relative_to(root / 'android/res')
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_bytes() != source.read_bytes(): shutil.copy2(source, target)
helper = termux / 'mushi'
helper.mkdir(exist_ok=True)
for name in ['prepare-bootstraps.py', 'bootstrap_validation.py']:
    shutil.copy2(root / 'scripts' / name, helper / name)
assets = root / 'build/assets/mushi'
if not (assets / 'agent.mjs').exists(): raise SystemExit('Run bun run build first')
shutil.copytree(assets, termux / 'app/src/main/assets/mushi', dirs_exist_ok=True)
print(f'Prepared Mushi Android workspace: {termux}')
