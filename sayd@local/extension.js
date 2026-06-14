/* sayd@local - GNOME Shell extension
 *
 * Topbar mic indicator + Super+H hotkey for the local speech-to-text daemon.
 *
 * - Polls ~/.local/share/sayd/control.sock every second for status.
 * - Left-click or Super+H sends "toggle". If the daemon isn't running yet,
 *   launches it first (cold start), shows "loading..." until ready, then
 *   sends "toggle" once it reports idle.
 * - Right-click menu: "Quit & Free GPU" (sends "quit"), "About".
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const SOCKET_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'sayd', 'control.sock',
]);

const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.config', 'sayd', 'config.json',
]);

// Path to the python daemon script. Adjust if installed elsewhere.
const DAEMON_SCRIPT = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'sayd', 'sayd-daemon.py',
]);
const DAEMON_LAUNCHER = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'sayd', 'launch-daemon.sh',
]);

const POLL_INTERVAL_MS = 1000;
const SOCKET_TIMEOUT_MICROSECONDS = 1500000; // 1.5s

// States as reported by the daemon over the socket, plus local extension states.
const State = {
    NOT_RUNNING: 'not_running', // socket missing / connection refused
    LOADING: 'loading',         // daemon process is up but model not ready
    IDLE: 'idle',
    RECORDING: 'recording',
    STOPPING: 'stopping',
};

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionObject) {
        super._init(0.0, 'sayd');

        this._extension = extensionObject;
        this._settings = extensionObject.getSettings();

        // Mic icon
        this._icon = new St.Icon({
            icon_name: 'microphone-sensitivity-muted-symbolic',
            style_class: 'system-status-icon sayd-indicator-icon',
        });
        this.add_child(this._icon);

        this._pulsing = false;

        // Right-click menu items
        this._quitItem = new PopupMenu.PopupMenuItem('Quit & Free GPU');
        this._quitItem.connect('activate', () => this._extension.sendCommand('quit'));
        this.menu.addMenuItem(this._quitItem);

        const aboutItem = new PopupMenu.PopupMenuItem('About');
        aboutItem.connect('activate', () => this._extension.showAbout());
        this.menu.addMenuItem(aboutItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);

        // Left click toggles recording (separate from the right-click PopupMenu,
        // which PanelMenu.Button already binds to button-press for us).
        this.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                this._extension.requestToggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.setState(State.NOT_RUNNING);

        // Re-apply colors immediately when the user changes them in prefs.
        for (const key of ['color-idle', 'color-recording', 'color-loading']) {
            this._settings.connect(`changed::${key}`, () => {
                this.setState(this._currentDisplayState);
            });
        }
    }

    setState(state) {
        this._currentDisplayState = state;

        this.remove_style_class_name('sayd-recording');
        this.remove_style_class_name('sayd-idle');
        this.remove_style_class_name('sayd-loading');
        this.remove_style_class_name('sayd-not-running');

        // Stop any in-progress pulse animation before applying the new state.
        this._stopPulse();

        const colorIdle = this._settings.get_string('color-idle');
        const colorRecording = this._settings.get_string('color-recording');
        const colorLoading = this._settings.get_string('color-loading');

        switch (state) {
            case State.RECORDING:
                this._icon.icon_name = 'microphone-sensitivity-high-symbolic';
                this.add_style_class_name('sayd-recording');
                this._icon.set_style(`color: ${colorRecording};`);
                this.opacity = 255;
                this._startPulse({
                    minOpacity: 120,
                    maxOpacity: 255,
                    minScale: 0.92,
                    maxScale: 1.12,
                    durationMs: 600,
                });
                break;
            case State.IDLE:
                this._icon.icon_name = 'microphone-sensitivity-medium-symbolic';
                this.add_style_class_name('sayd-idle');
                this._icon.set_style(`color: ${colorIdle};`);
                this.opacity = 255;
                this._icon.set_scale(1, 1);
                break;
            case State.LOADING:
                this._icon.icon_name = 'microphone-sensitivity-low-symbolic';
                this.add_style_class_name('sayd-loading');
                this._icon.set_style(`color: ${colorLoading};`);
                this.opacity = 180;
                this._startPulse({
                    minOpacity: 80,
                    maxOpacity: 200,
                    minScale: 1.0,
                    maxScale: 1.0,
                    durationMs: 900,
                });
                break;
            case State.STOPPING:
                this._icon.icon_name = 'microphone-sensitivity-low-symbolic';
                this.add_style_class_name('sayd-loading');
                this._icon.set_style(`color: ${colorLoading};`);
                this.opacity = 150;
                this._icon.set_scale(1, 1);
                break;
            case State.NOT_RUNNING:
            default:
                this._icon.icon_name = 'microphone-sensitivity-muted-symbolic';
                this.add_style_class_name('sayd-not-running');
                this._icon.set_style(`color: ${colorIdle};`);
                this.opacity = 90;
                this._icon.set_scale(1, 1);
                break;
        }
    }

    /**
     * Start a looping "breathing" pulse on the icon: opacity and scale ease
     * back and forth between the given min/max values. Used for recording
     * (fast, visible pulse) and loading (slow, gentle pulse) states.
     */
    _startPulse({minOpacity, maxOpacity, minScale, maxScale, durationMs}) {
        this._icon.set_pivot_point(0.5, 0.5);

        const pulseOnce = (toMax) => {
            if (!this._pulsing)
                return;

            const targetOpacity = toMax ? maxOpacity : minOpacity;
            const targetScale = toMax ? maxScale : minScale;

            this._icon.ease({
                opacity: targetOpacity,
                scale_x: targetScale,
                scale_y: targetScale,
                duration: durationMs,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onComplete: () => pulseOnce(!toMax),
            });
        };

        this._pulsing = true;
        pulseOnce(true);
    }

    _stopPulse() {
        if (!this._pulsing)
            return;
        this._pulsing = false;
        this._icon.remove_all_transitions();
        this._icon.set_scale(1, 1);
    }
});

export default class saydExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Internal state tracking
        this._currentState = State.NOT_RUNNING;
        this._daemonLaunching = false;
        this._pendingToggleAfterLoad = false;

        // Poll the socket every second.
        this._pollSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            },
        );
        // Kick off an immediate poll too.
        this._poll();

        // Register Super+H global keybinding.
        Main.wm.addKeybinding(
            'toggle-recording',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            () => this.requestToggle(),
        );
    }

    disable() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = null;
        }

        Main.wm.removeKeybinding('toggle-recording');

        if (this._indicator) {
            this._indicator._stopPulse();
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    // -----------------------------------------------------------------
    // Socket communication
    // -----------------------------------------------------------------

    /**
     * Send a single-line command to the daemon socket and return the
     * trimmed response string, or null on failure (daemon not running).
     * This is a blocking call with a short timeout; the socket protocol
     * is tiny so this stays fast.
     */
    _sendCommandSync(command) {
        let connection = null;
        try {
            const socketClient = new Gio.SocketClient();
            const address = new Gio.UnixSocketAddress({path: SOCKET_PATH});
            connection = socketClient.connect(address, null);

            const outStream = connection.get_output_stream();
            const inStream = connection.get_input_stream();

            const data = command + '\n';
            outStream.write_all(data, null);

            // Read response (small, single line).
            const dataInStream = new Gio.DataInputStream({
                base_stream: inStream,
            });
            const [line] = dataInStream.read_line_utf8(null);

            connection.close(null);
            return line ? line.trim() : null;
        } catch (e) {
            if (connection) {
                try {
                    connection.close(null);
                } catch (_e) { /* ignore */ }
            }
            return null;
        }
    }

    _poll() {
        const response = this._sendCommandSync('status');

        if (response === null) {
            // Socket not present / connection refused -> daemon not running,
            // unless we're in the middle of launching it.
            this._currentState = this._daemonLaunching ? State.LOADING : State.NOT_RUNNING;
        } else if (Object.values(State).includes(response)) {
            this._currentState = response;
            if (response !== State.NOT_RUNNING) {
                this._daemonLaunching = false;
            }
        } else {
            this._currentState = State.NOT_RUNNING;
        }

        this._indicator.setState(this._currentState);

        // If we were waiting to send a toggle once the daemon became ready.
        if (this._pendingToggleAfterLoad && this._currentState === State.IDLE) {
            this._pendingToggleAfterLoad = false;
            this._sendCommandSync('toggle');
            // Reflect immediately for snappier UI; next poll will confirm.
            this._currentState = State.RECORDING;
            this._indicator.setState(this._currentState);
        }
    }

    // -----------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------

    /** Send an arbitrary command to the daemon (used by the menu items). */
    sendCommand(command) {
        const response = this._sendCommandSync(command);
        if (response !== null) {
            if (Object.values(State).includes(response))
                this._currentState = response;
            this._indicator.setState(this._currentState);
        }
        if (command === 'quit') {
            this._currentState = State.NOT_RUNNING;
            this._daemonLaunching = false;
            this._pendingToggleAfterLoad = false;
            this._indicator.setState(this._currentState);
        }
    }

    /**
     * Toggle recording. If the daemon isn't running, launch it first,
     * show a loading state, and toggle once it becomes ready.
     */
    requestToggle() {
        const response = this._sendCommandSync('toggle');

        if (response !== null) {
            // Daemon responded directly.
            if (response === State.LOADING) {
                // Daemon is up but model still loading; queue the toggle.
                this._pendingToggleAfterLoad = true;
                this._currentState = State.LOADING;
            } else if (Object.values(State).includes(response)) {
                this._currentState = response;
            }
            this._indicator.setState(this._currentState);
            return;
        }

        // No daemon running at all -> launch it.
        if (!this._daemonLaunching) {
            this._launchDaemon();
        }
        this._pendingToggleAfterLoad = true;
        this._currentState = State.LOADING;
        this._indicator.setState(this._currentState);
    }

    /**
     * Write ~/.config/sayd/config.json from current GSettings values.
     * Called before launching the daemon so it picks up settings even if
     * the user never opened the preferences window (gschema defaults
     * still apply in that case).
     */
    _writeConfigFromSettings() {
        const settings = this._settings;
        const idleTimeoutSeconds = settings.get_boolean('idle-timeout-never')
            ? 0
            : settings.get_int('idle-timeout-minutes') * 60;

        const config = {
            model: settings.get_string('model'),
            input_device: settings.get_string('input-device'),
            chunk_seconds: settings.get_double('chunk-seconds'),
            idle_timeout: idleTimeoutSeconds,
            cpu_fallback: settings.get_boolean('cpu-fallback'),
            color_idle: settings.get_string('color-idle'),
            color_recording: settings.get_string('color-recording'),
            color_loading: settings.get_string('color-loading'),
        };

        try {
            const dir = Gio.File.new_for_path(CONFIG_PATH).get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);

            const file = Gio.File.new_for_path(CONFIG_PATH);
            const contents = JSON.stringify(config, null, 2);
            file.replace_contents(
                contents, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            );
        } catch (e) {
            logError(e, 'sayd: failed to write config.json');
        }
    }

    _launchDaemon() {
        this._daemonLaunching = true;

        this._writeConfigFromSettings();

        let argv;
        if (GLib.file_test(DAEMON_LAUNCHER, GLib.FileTest.IS_EXECUTABLE)) {
            argv = [DAEMON_LAUNCHER];
        } else {
            argv = ['python3', DAEMON_SCRIPT];
        }

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
            });

            const proc = launcher.spawnv(argv);
            // Don't wait on it; it's a long-lived background daemon.
            proc.wait_async(null, () => {
                // If the process exits, reflect that on next poll automatically.
            });
        } catch (e) {
            logError(e, 'sayd: failed to launch daemon');
            this._daemonLaunching = false;
            this._currentState = State.NOT_RUNNING;
            this._indicator.setState(this._currentState);
        }
    }

    // -----------------------------------------------------------------
    // About dialog
    // -----------------------------------------------------------------

    showAbout() {
        // Use MessageTray which works reliably across GNOME versions.
        try {
            const source = new MessageTray.Source({
                title: 'sayd',
                icon_name: 'microphone-sensitivity-high-symbolic',
            });
            Main.messageTray.add(source);

            const notification = new MessageTray.Notification({
                source,
                title: 'sayd \u2014 Speech to Text',
                body:
                    'Left-click or Super+H: toggle recording.\n' +
                    'Right-click \u2192 Quit & Free GPU: shut down the daemon.\n' +
                    'Open Settings to configure the model, audio device, and more.',
            });
            notification.setTransient(true);
            source.addNotification(notification);
        } catch (_e) {
            // Fallback for very old GNOME Shell builds.
            Main.notify('sayd',
                'Left-click or Super+H: toggle recording.\n' +
                'Right-click \u2192 Quit & Free GPU: shut down the daemon.\n' +
                'Open Settings to configure the model, audio device, and more.');
        }
    }
}
