# sayd

**Win+H-style speech-to-text for Fedora GNOME Wayland.**

Press **Super+H**, speak, press **Super+H** again — transcribed text appears in whatever window has focus. Powered by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) running entirely on your machine. No cloud, no subscription.

---

## Features

- **Super+H** hotkey to toggle recording from anywhere
- Local Whisper transcription — fully offline, no data leaves your machine
- GPU acceleration (CUDA) with automatic CPU fallback
- Top-bar mic indicator with live status (idle / loading / recording)
- Types directly into the focused window via `ydotool`
- Auto-shuts down after inactivity to free GPU memory
- Configurable model, mic device, colors, and idle timeout via GSettings

---

## Requirements

- Fedora 40+ (tested on Fedora 44)
- GNOME Shell 47–50 on Wayland
- Python 3.10+
- `ydotool` (in the default Fedora repos)

Optional for GPU transcription:
- NVIDIA GPU with CUDA support

---

## Installation

```bash
git clone https://github.com/PrathameshBende/sayd.git
cd sayd
chmod +x setup.sh
./setup.sh
```

The script will:
1. Offer to install missing system packages (`ydotool`, `python3`) via `dnf`
2. Create a Python venv at `~/.local/share/sayd/venv`
3. Install `faster-whisper`, `sounddevice`, and `numpy` into the venv
4. Install and enable the GNOME Shell extension

Then **log out and back in** — Wayland requires a Shell restart to load new extensions.

---

## Usage

| Action | How |
|---|---|
| Start / stop recording | **Super+H** or left-click the mic icon |
| Open settings | Right-click icon → **Settings** |
| Shut down daemon + free GPU | Right-click icon → **Quit & Free GPU** |

**First launch** downloads the Whisper `small.en` model (~250 MB) and loads it — this takes 20–30 seconds. Subsequent launches are fast (model is cached).

### Icon states

| Icon | Meaning |
|---|---|
| Dim grey | Daemon not running |
| Yellow (pulsing) | Model loading |
| Solid grey | Idle, ready |
| Red (pulsing) | Recording |

---

## GPU acceleration

The daemon tries CUDA first and falls back to CPU automatically. CPU transcription with `small.en` + int8 is fast enough for real-time use (~2–4 s latency per chunk).

For GPU transcription, install the CUDA libraries into the venv:

```bash
~/.local/share/sayd/venv/bin/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

sayd tries CUDA first and falls back to CPU automatically if CUDA is unavailable (configurable via the "Fall back to CPU" setting).

---

## Configuration

Settings are stored in GSettings under `org.gnome.shell.extensions.sayd` and written to `~/.config/sayd/config.json` when changed via the extension preferences.

You can also edit `config.json` directly and send `reload-config` to the socket:

```bash
echo "reload-config" | socat - UNIX-CONNECT:~/.local/share/sayd/control.sock
```

| Key | Default | Description |
|---|---|---|
| `model` | `small.en` | Whisper model (`tiny.en`, `base.en`, `small.en`, `medium.en`, `large-v3`) |
| `input_device` | `""` | Mic name substring or numeric index. Empty = system default |
| `chunk_seconds` | `3.5` | Audio chunk size before each transcription pass |
| `idle_timeout` | `900` | Seconds idle before auto-shutdown (0 = never) |
| `cpu_fallback` | `true` | Fall back to CPU if CUDA unavailable |

---

## File layout

```
~/.local/share/sayd/
  sayd-daemon.py   # the daemon
  launch-daemon.sh      # wrapper that sets LD_LIBRARY_PATH for CUDA pip libs
  venv/                 # Python virtualenv
  daemon.log            # rotating log (1 MB max)
  control.sock          # Unix socket

~/.config/sayd/
  config.json           # persisted settings

~/.local/share/gnome-shell/extensions/sayd@local/
                        # GNOME Shell extension
```

---

## Uninstall

```bash
gnome-extensions disable sayd@local
rm -rf ~/.local/share/sayd
rm -rf ~/.local/share/gnome-shell/extensions/sayd@local
rm -rf ~/.config/sayd
```

---

## Troubleshooting

**Transcription works but nothing is typed**
- `ydotoold` must be running. It's started automatically by `launch-daemon.sh`; if it's missing, run `sudo dnf install ydotool`.
- The focused element must be an editable text field. The daemon skips injection when a non-editable element is focused (e.g. a file manager, Settings panel).

**`libcublas.so.12` not found**
```bash
~/.local/share/sayd/venv/bin/pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

**Extension not appearing after login**
```bash
gnome-extensions enable sayd@local
```

**Check logs**
```bash
tail -f ~/.local/share/sayd/daemon.log
```

---

## License

MIT — see [LICENSE](LICENSE).
