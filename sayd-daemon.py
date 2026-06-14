#!/usr/bin/env python3
"""
sayd-daemon.py - Speech-to-text background daemon for GNOME/Wayland.

Reads config from ~/.config/sayd/config.json (written by the GNOME
extension's preferences page). All settings can be overridden via environment
variables for power users.

Protocol (newline-delimited plain text over Unix socket):
  Commands:
    toggle        - start/stop recording
    quit          - shut down, free GPU/CPU
    status        - report current state
    reload-config - reload config from disk without restarting
    log-start     - start streaming log lines to this connection (stays open)
    list-devices  - return JSON array of input device names

  Responses:
    loading / idle / recording / stopping / ok / unknown
"""

import os
import sys
import json
import socket
import socketserver
import threading
import time
import queue
import subprocess
import signal
import logging
from pathlib import Path

import numpy as np
import sounddevice as sd

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

XDG_DATA_HOME   = Path(os.environ.get("XDG_DATA_HOME",   Path.home() / ".local" / "share"))
XDG_CONFIG_HOME = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))

APP_DIR     = XDG_DATA_HOME   / "sayd"
CONFIG_PATH = XDG_CONFIG_HOME / "sayd" / "config.json"
SOCKET_PATH = APP_DIR / "control.sock"

APP_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULTS = {
    "model":           "small.en",
    "input_device":    "",          # "" = system default
    "chunk_seconds":   3.5,
    "idle_timeout":    900,         # seconds; 0 = never
    "cpu_fallback":    True,        # fall back to CPU if CUDA unavailable
    "color_idle":      "#ffffff",
    "color_recording": "#ff5050",
    "color_loading":   "#d0a000",
}

_config_lock = threading.Lock()
_config = dict(DEFAULTS)


def load_config():
    global _config
    try:
        with open(CONFIG_PATH) as f:
            data = json.load(f)
        with _config_lock:
            _config = {**DEFAULTS, **data}
    except FileNotFoundError:
        with _config_lock:
            _config = dict(DEFAULTS)
    except Exception as exc:
        log.warning("Failed to load config: %s", exc)


def cfg(key):
    with _config_lock:
        return _config.get(key, DEFAULTS.get(key))


# ---------------------------------------------------------------------------
# Logging — stdout only + live streaming; NO file logging
# ---------------------------------------------------------------------------

class _LiveStreamHandler(logging.Handler):
    """Sends log records to registered streaming sockets."""
    def __init__(self):
        super().__init__()
        self._sinks = []
        self._lock  = threading.Lock()

    def add_sink(self, sock):
        with self._lock:
            self._sinks.append(sock)

    def remove_sink(self, sock):
        with self._lock:
            self._sinks = [s for s in self._sinks if s is not sock]

    def emit(self, record):
        line = self.format(record) + "\n"
        data = line.encode("utf-8", errors="replace")
        with self._lock:
            dead = []
            for s in self._sinks:
                try:
                    s.sendall(data)
                except Exception:
                    dead.append(s)
            for s in dead:
                self._sinks = [x for x in self._sinks if x is not s]

    @property
    def has_sinks(self):
        with self._lock:
            return bool(self._sinks)


_live_handler = _LiveStreamHandler()
_live_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

# Only log to stdout and live streaming clients — no file handler at all.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        _live_handler,
    ],
)
log = logging.getLogger("sayd")


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model():
    from faster_whisper import WhisperModel
    model_name = cfg("model")
    cpu_fallback = cfg("cpu_fallback")

    try:
        log.info("Loading model '%s' on CUDA (float16)...", model_name)
        model = WhisperModel(model_name, device="cuda", compute_type="float16")
        log.info("Model loaded on CUDA.")
        return model, "cuda"
    except Exception as exc:
        if not cpu_fallback:
            log.error("CUDA load failed and cpu_fallback=false. Exiting: %s", exc)
            raise
        log.warning("CUDA load failed (%s). Falling back to CPU.", exc)

    log.info("Loading model '%s' on CPU (int8)...", model_name)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    log.info("Model loaded on CPU.")
    return model, "cpu"


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def _resample(audio, orig_rate, target_rate=16000):
    if orig_rate == target_rate or audio.size == 0:
        return audio
    duration  = audio.shape[0] / orig_rate
    target_len = int(round(duration * target_rate))
    if target_len <= 0:
        return audio[:0]
    orig_x   = np.linspace(0, duration, num=audio.shape[0], endpoint=False)
    target_x = np.linspace(0, duration, num=target_len,    endpoint=False)
    return np.interp(target_x, orig_x, audio).astype(np.float32)


def resolve_device():
    name_or_idx = cfg("input_device") or ""
    if not name_or_idx:
        return None
    if str(name_or_idx).isdigit():
        return int(name_or_idx)
    devices = sd.query_devices()
    for idx, dev in enumerate(devices):
        if dev["max_input_channels"] > 0 and name_or_idx.lower() in dev["name"].lower():
            log.info("Matched input_device '%s' -> [%d] %s", name_or_idx, idx, dev["name"])
            return idx
    log.warning("input_device '%s' not found; using system default.", name_or_idx)
    return None


def list_input_devices():
    """Return list of (index, name) for all input-capable devices."""
    result = []
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            result.append({"index": idx, "name": dev["name"]})
    return result


# ---------------------------------------------------------------------------
# Text injection
# ---------------------------------------------------------------------------

def _focused_is_editable():
    try:
        import pyatspi
        desktop = pyatspi.Registry.getDesktop(0)

        def find_focused(node, depth=0):
            if depth > 12:
                return None
            try:
                if node.getState().contains(pyatspi.STATE_FOCUSED):
                    return node
                for i in range(node.childCount):
                    r = find_focused(node.getChildAtIndex(i), depth + 1)
                    if r is not None:
                        return r
            except Exception:
                pass
            return None

        for app in desktop:
            if app is None:
                continue
            node = find_focused(app)
            if node is not None:
                try:
                    return node.getState().contains(pyatspi.STATE_EDITABLE)
                except Exception:
                    return False
        return False
    except Exception as exc:
        log.debug("AT-SPI check failed: %s", exc)
        return True  # fail open


def inject_text(text):
    text = text.strip()
    if not text:
        return
    if not _focused_is_editable():
        log.info("Focused element not editable — skipping injection.")
        return
    try:
        subprocess.run(["ydotool", "type", "--", text + " "], check=True)
    except FileNotFoundError:
        log.error("ydotool not found. Install: sudo dnf install ydotool")
    except subprocess.CalledProcessError as exc:
        log.error("ydotool failed: %s", exc)


# ---------------------------------------------------------------------------
# Daemon
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16000

class SaydDaemon:
    STATE_LOADING   = "loading"
    STATE_IDLE      = "idle"
    STATE_RECORDING = "recording"
    STATE_STOPPING  = "stopping"

    def __init__(self):
        self.state      = self.STATE_LOADING
        self._state_lock = threading.Lock()
        self.model      = None
        self.device_used = None
        self.audio_queue = queue.Queue()
        self.stream     = None
        self._capture_rate = SAMPLE_RATE
        self.record_thread    = None
        self.transcribe_thread = None
        self.stop_recording_event = threading.Event()
        self.last_activity_time   = time.time()
        self.shutdown_event       = threading.Event()

    def set_state(self, s):
        with self._state_lock:
            self.state = s
        log.info("State -> %s", s)

    def get_state(self):
        with self._state_lock:
            return self.state

    # -- model ---------------------------------------------------------------

    def start_model_load(self):
        def _load():
            try:
                self.model, self.device_used = load_model()
                self.set_state(self.STATE_IDLE)
                self.last_activity_time = time.time()
            except Exception:
                log.exception("Failed to load model")
                self.shutdown_event.set()
        threading.Thread(target=_load, daemon=True, name="model-loader").start()

    def unload_model(self):
        if self.model is not None:
            log.info("Unloading model...")
            del self.model
            self.model = None
            try:
                import gc; gc.collect()
                if self.device_used == "cuda":
                    try:
                        import torch; torch.cuda.empty_cache()
                    except Exception:
                        pass
            except Exception:
                pass

    # -- recording -----------------------------------------------------------

    def toggle_recording(self):
        state = self.get_state()
        if state == self.STATE_RECORDING:
            self._stop_recording_async()
        elif state == self.STATE_IDLE:
            self.start_recording()
        else:
            log.info("Toggle ignored in state=%s", state)

    def start_recording(self):
        if self.get_state() != self.STATE_IDLE:
            return
        self.set_state(self.STATE_RECORDING)
        self.stop_recording_event.clear()
        while not self.audio_queue.empty():
            try: self.audio_queue.get_nowait()
            except queue.Empty: break

        device_idx = resolve_device()
        try:
            info = sd.query_devices(device_idx if device_idx is not None else sd.default.device[0])
            self._capture_rate = int(info["default_samplerate"])
        except Exception:
            self._capture_rate = SAMPLE_RATE

        self.record_thread = threading.Thread(
            target=self._record_loop, args=(device_idx,), daemon=True, name="record")
        self.transcribe_thread = threading.Thread(
            target=self._transcribe_loop, daemon=True, name="transcribe")
        self.record_thread.start()
        self.transcribe_thread.start()
        log.info("Recording started (device_idx=%s, capture_rate=%s)", device_idx, self._capture_rate)

    def _stop_recording_async(self):
        """
        Signal the recording/transcription threads to stop without blocking
        the socket handler (and therefore without freezing the shell extension
        or the desktop). The transition to IDLE happens inside the background
        thread once it has cleanly wound down.
        """
        if self.get_state() != self.STATE_RECORDING:
            return
        log.info("Stopping recording (async)...")
        self.set_state(self.STATE_STOPPING)
        self.stop_recording_event.set()
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None

        def _wait_and_idle():
            if self.record_thread:
                self.record_thread.join(timeout=5)
            if self.transcribe_thread:
                self.transcribe_thread.join(timeout=12)
            self.set_state(self.STATE_IDLE)
            self.last_activity_time = time.time()
            log.info("Recording stopped.")

        threading.Thread(target=_wait_and_idle, daemon=True, name="stop-waiter").start()

    def stop_recording(self):
        """Synchronous stop — used only during daemon shutdown."""
        if self.get_state() not in (self.STATE_RECORDING, self.STATE_STOPPING):
            return
        self.stop_recording_event.set()
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None
        if self.record_thread:
            self.record_thread.join(timeout=5)
        if self.transcribe_thread:
            self.transcribe_thread.join(timeout=12)
        self.set_state(self.STATE_IDLE)

    def _record_loop(self, device_idx):
        chunk_frames = int(cfg("chunk_seconds") * self._capture_rate)
        buffer = []
        frames_collected = 0

        def callback(indata, frames, time_info, status):
            nonlocal frames_collected
            buffer.append(indata.copy())
            frames_collected += frames
            if frames_collected >= chunk_frames:
                chunk = np.concatenate(buffer, axis=0)
                self.audio_queue.put(chunk)
                buffer.clear()
                frames_collected = 0

        try:
            with sd.InputStream(
                device=device_idx,
                samplerate=self._capture_rate,
                channels=1,
                dtype="float32",
                blocksize=1024,
                callback=callback,
            ) as self.stream:
                while not self.stop_recording_event.is_set():
                    time.sleep(0.1)
        except Exception as exc:
            log.error("Error in recording stream: %s", exc)
        finally:
            if buffer:
                chunk = np.concatenate(buffer, axis=0)
                self.audio_queue.put(chunk)
            self.audio_queue.put(None)  # sentinel

    def _transcribe_loop(self):
        while True:
            if self.stop_recording_event.is_set() and self.audio_queue.empty():
                break
            try:
                chunk = self.audio_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if chunk is None:
                break

            audio = chunk.flatten().astype(np.float32)
            if audio.size == 0:
                continue
            if self._capture_rate != SAMPLE_RATE:
                audio = _resample(audio, self._capture_rate)
            if np.max(np.abs(audio)) < 0.01:
                continue

            try:
                segments, info = self.model.transcribe(
                    audio, language="en", beam_size=1,
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=200),
                    condition_on_previous_text=False,
                    no_speech_threshold=0.6,
                )
                segments = list(segments)
                if getattr(info, "speech_duration", None) is not None and info.speech_duration < 0.2:
                    continue
                kept = [
                    seg for seg in segments
                    if (getattr(seg, "no_speech_prob", 0) or 0) <= 0.6
                    and (getattr(seg, "avg_logprob", 0) or 0) >= -1.0
                ]
                text = "".join(seg.text for seg in kept)
                if text.strip():
                    log.info("Transcribed: %s", text.strip())
                    inject_text(text)
                    self.last_activity_time = time.time()
            except Exception:
                log.exception("Transcription error")

    # -- shutdown / watchdog -------------------------------------------------

    def request_shutdown(self):
        self.set_state(self.STATE_STOPPING)
        self.stop_recording()
        self.unload_model()
        self.shutdown_event.set()

    def watchdog_loop(self):
        while not self.shutdown_event.is_set():
            time.sleep(5)
            timeout = cfg("idle_timeout")
            if timeout <= 0:
                continue  # never
            if self.get_state() == self.STATE_IDLE:
                idle_for = time.time() - self.last_activity_time
                if idle_for >= timeout:
                    log.info("Idle for %.0fs (limit %.0fs). Auto-shutting down.", idle_for, timeout)
                    self.request_shutdown()
                    break


# ---------------------------------------------------------------------------
# Socket server
# ---------------------------------------------------------------------------

class ControlHandler(socketserver.BaseRequestHandler):
    def handle(self):
        daemon = self.server.sayd_daemon
        try:
            data = self.request.recv(4096)
            if not data:
                return
            cmd = data.decode("utf-8", errors="replace").strip().lower()
            log.debug("Command: %s", cmd)

            if cmd == "toggle":
                state = daemon.get_state()
                if state == daemon.STATE_LOADING:
                    self._respond(daemon.STATE_LOADING)
                    return
                daemon.toggle_recording()
                # Return immediately — async stop means we may still be in
                # STOPPING state; that's fine, the extension polls for IDLE.
                self._respond(daemon.get_state())

            elif cmd == "quit":
                self._respond("ok")
                threading.Thread(target=daemon.request_shutdown, daemon=True).start()

            elif cmd == "status":
                self._respond(daemon.get_state())

            elif cmd == "reload-config":
                load_config()
                self._respond("ok")

            elif cmd == "list-devices":
                devs = list_input_devices()
                self._respond(json.dumps(devs))

            elif cmd == "log-start":
                # Keep this connection open and stream log lines to it.
                # Logs are NOT stored anywhere — only live-streamed here.
                self._respond("ok")
                _live_handler.add_sink(self.request)
                try:
                    while True:
                        r = self.request.recv(1)
                        if not r:
                            break
                except Exception:
                    pass
                finally:
                    _live_handler.remove_sink(self.request)

            else:
                self._respond("unknown")
        except Exception:
            log.exception("Error handling command")

    def _respond(self, text):
        try:
            self.request.sendall((text + "\n").encode("utf-8"))
        except Exception:
            pass


class ControlServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True
    daemon_threads      = True

    def __init__(self, path, sayd_daemon):
        self.sayd_daemon = sayd_daemon
        super().__init__(str(path), ControlHandler)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def remove_stale_socket():
    if SOCKET_PATH.exists():
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(0.5)
            s.connect(str(SOCKET_PATH))
            s.close()
            log.error("Another sayd-daemon instance is running. Exiting.")
            sys.exit(1)
        except (ConnectionRefusedError, FileNotFoundError, socket.timeout, OSError):
            try: SOCKET_PATH.unlink()
            except FileNotFoundError: pass


def main():
    load_config()
    remove_stale_socket()

    daemon = SaydDaemon()
    server = ControlServer(SOCKET_PATH, daemon)
    threading.Thread(target=server.serve_forever, daemon=True, name="control-server").start()
    log.info("Socket: %s", SOCKET_PATH)

    daemon.start_model_load()
    threading.Thread(target=daemon.watchdog_loop, daemon=True, name="watchdog").start()

    def _sig(signum, _):
        log.info("Signal %s received, shutting down.", signum)
        daemon.request_shutdown()

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT,  _sig)

    try:
        while not daemon.shutdown_event.is_set():
            time.sleep(0.5)
    finally:
        server.shutdown()
        server.server_close()
        try: SOCKET_PATH.unlink()
        except FileNotFoundError: pass
        log.info("Daemon exited cleanly.")


if __name__ == "__main__":
    main()
