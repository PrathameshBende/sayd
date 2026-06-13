/* prefs.js - Preferences window for the sayd extension.
 *
 * Provides a Settings UI (Adwaita) backed by GSettings, and writes the
 * resulting configuration to ~/.config/sayd/config.json so the
 * Python daemon can pick it up. After saving, sends "reload-config" to
 * the daemon's control socket if it's already running, so changes apply
 * without a restart.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SOCKET_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.local', 'share', 'sayd', 'control.sock',
]);

const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.config', 'sayd', 'config.json',
]);

const WHISPER_MODELS = [
    'tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3',
];

export default class saydPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(560, 640);

        // -----------------------------------------------------------
        // Page: General
        // -----------------------------------------------------------
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // --- Hotkey group ---
        const hotkeyGroup = new Adw.PreferencesGroup({
            title: _('Hotkey'),
            description: _('Global keyboard shortcut to start/stop recording'),
        });
        generalPage.add(hotkeyGroup);

        const hotkeyRow = new Adw.ActionRow({
            title: _('Toggle recording'),
            subtitle: _('Click "Set Shortcut" then press a key combination'),
        });
        hotkeyGroup.add(hotkeyRow);

        const hotkeyLabel = new Gtk.ShortcutLabel({
            disabled_text: _('Unset'),
            valign: Gtk.Align.CENTER,
        });
        const currentBinding = settings.get_strv('toggle-recording');
        hotkeyLabel.set_accelerator(currentBinding[0] || '');
        hotkeyRow.add_suffix(hotkeyLabel);

        const setShortcutButton = new Gtk.Button({
            label: _('Set Shortcut'),
            valign: Gtk.Align.CENTER,
        });
        hotkeyRow.add_suffix(setShortcutButton);

        setShortcutButton.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                heading: _('Set Shortcut'),
                body: _('Press a key combination, or Escape to cancel.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.set_default_response('cancel');

            const eventControl = new Gtk.EventControllerKey();
            dialog.add_controller(eventControl);

            eventControl.connect('key-pressed', (_widget, keyval, keycode, state) => {
                if (keyval === 65307) { // Escape
                    dialog.close();
                    return true;
                }

                // Ignore lone modifier presses.
                const modifierKeyvals = [
                    65505, 65506, // Shift L/R
                    65507, 65508, // Control L/R
                    65513, 65514, // Alt L/R
                    65515, 65516, // Super L/R
                ];
                if (modifierKeyvals.includes(keyval))
                    return true;

                const mask = state & Gtk.accelerator_get_default_mod_mask();
                const accel = Gtk.accelerator_name(keyval, mask);

                if (accel) {
                    settings.set_strv('toggle-recording', [accel]);
                    hotkeyLabel.set_accelerator(accel);
                }
                dialog.close();
                return true;
            });

            dialog.present();
        });

        // --- Model group ---
        const modelGroup = new Adw.PreferencesGroup({
            title: _('Transcription Model'),
            description: _('Larger models are more accurate but slower and use more VRAM'),
        });
        generalPage.add(modelGroup);

        const modelRow = new Adw.ComboRow({
            title: _('Whisper model'),
            subtitle: _('faster-whisper model name'),
            model: Gtk.StringList.new(WHISPER_MODELS),
        });
        modelGroup.add(modelRow);

        const currentModel = settings.get_string('model');
        const modelIdx = WHISPER_MODELS.indexOf(currentModel);
        modelRow.selected = modelIdx >= 0 ? modelIdx : WHISPER_MODELS.indexOf('small.en');

        modelRow.connect('notify::selected', () => {
            settings.set_string('model', WHISPER_MODELS[modelRow.selected]);
        });

        const cpuFallbackRow = new Adw.SwitchRow({
            title: _('Fall back to CPU'),
            subtitle: _('If CUDA is unavailable, use CPU instead of failing'),
        });
        modelGroup.add(cpuFallbackRow);
        settings.bind('cpu-fallback', cpuFallbackRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // -----------------------------------------------------------
        // Page: Audio
        // -----------------------------------------------------------
        const audioPage = new Adw.PreferencesPage({
            title: _('Audio'),
            icon_name: 'audio-input-microphone-symbolic',
        });
        window.add(audioPage);

        // --- Input device group ---
        const deviceGroup = new Adw.PreferencesGroup({
            title: _('Input Device'),
            description: _('Leave empty to use the system default input device'),
        });
        audioPage.add(deviceGroup);

        const deviceModel = Gtk.StringList.new([_('System default')]);
        const deviceRow = new Adw.ComboRow({
            title: _('Microphone'),
            model: deviceModel,
        });
        deviceGroup.add(deviceRow);

        // Keep a parallel array of "values to write to gsettings" for each
        // combo entry (index 0 = "" for system default, others = device name).
        let deviceValues = [''];

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Refresh device list (requires the daemon to be running)'),
        });
        deviceGroup.set_header_suffix(refreshButton);

        const populateDevices = (devices) => {
            // Rebuild the model.
            while (deviceModel.get_n_items() > 0)
                deviceModel.remove(0);

            deviceValues = [''];
            deviceModel.append(_('System default'));

            for (const dev of devices) {
                deviceModel.append(`[${dev.index}] ${dev.name}`);
                deviceValues.push(dev.name);
            }

            // Restore selection based on current setting.
            const current = settings.get_string('input-device');
            const idx = deviceValues.indexOf(current);
            deviceRow.selected = idx >= 0 ? idx : 0;
        };

        const queryDevices = () => {
            const result = sendCommandSync('list-devices');
            if (result === null) {
                deviceRow.subtitle = _('Daemon not running — start recording once, then refresh');
                populateDevices([]);
                return;
            }
            try {
                const devices = JSON.parse(result);
                deviceRow.subtitle = '';
                populateDevices(devices);
            } catch (e) {
                deviceRow.subtitle = _('Could not parse device list');
                populateDevices([]);
            }
        };

        refreshButton.connect('clicked', () => queryDevices());

        deviceRow.connect('notify::selected', () => {
            const idx = deviceRow.selected;
            const value = deviceValues[idx] !== undefined ? deviceValues[idx] : '';
            settings.set_string('input-device', value);
        });

        // Initial population: try live devices, fall back to just showing
        // the currently-configured value as a placeholder entry.
        const initialDevice = settings.get_string('input-device');
        if (initialDevice) {
            deviceModel.append(initialDevice);
            deviceValues.push(initialDevice);
            deviceRow.selected = 1;
        }
        queryDevices();

        // --- Chunking group ---
        const chunkGroup = new Adw.PreferencesGroup({
            title: _('Transcription Chunking'),
            description: _('How much audio to accumulate before transcribing'),
        });
        audioPage.add(chunkGroup);

        const chunkRow = new Adw.SpinRow({
            title: _('Chunk length (seconds)'),
            subtitle: _('Shorter feels more responsive; longer is more accurate'),
            adjustment: new Gtk.Adjustment({
                lower: 1.0,
                upper: 10.0,
                step_increment: 0.5,
                page_increment: 1.0,
                value: settings.get_double('chunk-seconds'),
            }),
            digits: 1,
        });
        chunkGroup.add(chunkRow);
        settings.bind('chunk-seconds', chunkRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // -----------------------------------------------------------
        // Page: Power
        // -----------------------------------------------------------
        const powerPage = new Adw.PreferencesPage({
            title: _('Power'),
            icon_name: 'battery-symbolic',
        });
        window.add(powerPage);

        const idleGroup = new Adw.PreferencesGroup({
            title: _('Auto-shutdown'),
            description: _('Free GPU/CPU resources after a period of inactivity'),
        });
        powerPage.add(idleGroup);

        const neverRow = new Adw.SwitchRow({
            title: _('Never auto-shutdown'),
            subtitle: _('Keep the model loaded indefinitely'),
        });
        idleGroup.add(neverRow);
        settings.bind('idle-timeout-never', neverRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const timeoutRow = new Adw.SpinRow({
            title: _('Idle timeout (minutes)'),
            subtitle: _('Shut down the daemon after this many minutes of inactivity'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 240,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('idle-timeout-minutes'),
            }),
        });
        idleGroup.add(timeoutRow);
        settings.bind('idle-timeout-minutes', timeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        settings.bind(
            'idle-timeout-never', timeoutRow, 'sensitive',
            Gio.SettingsBindFlags.INVERT_BOOLEAN,
        );

        // -----------------------------------------------------------
        // Page: Appearance
        // -----------------------------------------------------------
        const appearancePage = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearancePage);

        const colorGroup = new Adw.PreferencesGroup({
            title: _('Indicator Colors'),
            description: _('Topbar mic icon color for each state'),
        });
        appearancePage.add(colorGroup);

        addColorRow(colorGroup, settings, 'color-idle', _('Idle'));
        addColorRow(colorGroup, settings, 'color-recording', _('Recording'));
        addColorRow(colorGroup, settings, 'color-loading', _('Loading'));

        // -----------------------------------------------------------
        // Save config.json + notify daemon whenever any relevant
        // setting changes.
        // -----------------------------------------------------------
        const keysToWatch = [
            'model', 'input-device', 'chunk-seconds',
            'idle-timeout-never', 'idle-timeout-minutes', 'cpu-fallback',
            'color-idle', 'color-recording', 'color-loading',
        ];

        const writeConfig = () => {
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

            // Ask the daemon to reload, if it's running. No-op if not.
            sendCommandSync('reload-config');
        };

        // Write config once on open (covers first-run with no config.json yet).
        writeConfig();

        const handlerIds = [];
        for (const key of keysToWatch)
            handlerIds.push(settings.connect(`changed::${key}`, () => writeConfig()));

        window.connect('close-request', () => {
            for (const id of handlerIds)
                settings.disconnect(id);
            return false;
        });
    }
}

/**
 * Add an Adw.ActionRow with a color-picker button bound to a string
 * GSettings key holding a "#rrggbb" hex color.
 */
function addColorRow(group, settings, key, title) {
    const row = new Adw.ActionRow({title});
    group.add(row);

    const colorButton = new Gtk.ColorButton({
        valign: Gtk.Align.CENTER,
    });

    const rgba = new Gdk.RGBA();
    if (!rgba.parse(settings.get_string(key)))
        rgba.parse('#ffffff');
    colorButton.set_rgba(rgba);

    colorButton.connect('color-set', () => {
        const c = colorButton.get_rgba();
        const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
        const hex = `#${toHex(c.red)}${toHex(c.green)}${toHex(c.blue)}`;
        settings.set_string(key, hex);
    });

    row.add_suffix(colorButton);
    row.activatable_widget = colorButton;
}

/**
 * Send a single-line command to the daemon's control socket and return
 * the trimmed response, or null if the daemon isn't reachable.
 *
 * prefs.js runs in a separate process from the Shell, so this uses a
 * short-lived synchronous GLib socket connection just like the main
 * extension does.
 */
function sendCommandSync(command) {
    let connection = null;
    try {
        const socketClient = new Gio.SocketClient();
        const address = new Gio.UnixSocketAddress({path: SOCKET_PATH});
        connection = socketClient.connect(address, null);

        const outStream = connection.get_output_stream();
        const inStream = connection.get_input_stream();

        outStream.write_all(command + '\n', null);

        const dataInStream = new Gio.DataInputStream({base_stream: inStream});
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
