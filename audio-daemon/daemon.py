#!/usr/bin/env python3
"""
Python Audio Daemon

TypeScriptメインプロセスと通信し、
音声I/OとGPIO制御を担当する軽量デーモン
"""

import asyncio
import base64
import json
import os
import signal
import sys
from typing import Optional

# 環境変数の読み込み
from dotenv import load_dotenv

load_dotenv(os.path.expanduser("~/.ai-necklace/.env"))

SOCKET_PATH = os.getenv("AUDIO_DAEMON_SOCKET", "/tmp/raspi-voice-audio.sock")

# オーディオ設定
INPUT_SAMPLE_RATE = 48000  # マイク入力
OUTPUT_SAMPLE_RATE = 48000  # スピーカー出力
SEND_SAMPLE_RATE = 24000  # OpenAI送信用
RECEIVE_SAMPLE_RATE = 24000  # OpenAI受信用
CHANNELS = 1
CHUNK_SIZE = 512


class AudioHandler:
    """音声I/Oハンドラ"""

    def __init__(self):
        self.pyaudio = None
        self.input_stream = None
        self.output_stream = None
        self.is_recording = False
        self._input_device_index = None
        self._output_device_index = None

    def initialize(self):
        """PyAudioを初期化"""
        try:
            import pyaudio

            self.pyaudio = pyaudio.PyAudio()
            self._find_devices()
            self._open_output_stream()
            print("[Audio] Initialized")
            return True
        except Exception as e:
            print(f"[Audio] Failed to initialize: {e}")
            return False

    def _find_devices(self):
        """USBオーディオデバイスを検出"""
        if not self.pyaudio:
            return

        for i in range(self.pyaudio.get_device_count()):
            info = self.pyaudio.get_device_info_by_index(i)
            name = info.get("name", "").lower()

            # USBマイクを検出
            if "usb" in name and info.get("maxInputChannels", 0) > 0:
                self._input_device_index = i
                print(f"[Audio] Input device: {info['name']}")

            # USBスピーカーを検出
            if "usb" in name and info.get("maxOutputChannels", 0) > 0:
                self._output_device_index = i
                print(f"[Audio] Output device: {info['name']}")

    def _open_output_stream(self):
        """出力ストリームを開く"""
        if not self.pyaudio:
            return

        import pyaudio

        try:
            self.output_stream = self.pyaudio.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=OUTPUT_SAMPLE_RATE,
                output=True,
                output_device_index=self._output_device_index,
                frames_per_buffer=CHUNK_SIZE * 4,
            )
        except Exception as e:
            print(f"[Audio] Failed to open output stream: {e}")

    def start_recording(self, callback):
        """録音を開始"""
        if not self.pyaudio or self.is_recording:
            return

        import pyaudio

        try:
            self.is_recording = True
            self.input_stream = self.pyaudio.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=INPUT_SAMPLE_RATE,
                input=True,
                input_device_index=self._input_device_index,
                frames_per_buffer=CHUNK_SIZE,
                stream_callback=lambda in_data, frame_count, time_info, status: self._input_callback(
                    in_data, callback
                ),
            )
            self.input_stream.start_stream()
            print("[Audio] Recording started")
        except Exception as e:
            print(f"[Audio] Failed to start recording: {e}")
            self.is_recording = False

    def _input_callback(self, in_data, callback):
        """入力コールバック"""
        import pyaudio

        if self.is_recording and in_data:
            # 48kHz → 24kHz にリサンプリング
            resampled = self._resample(in_data, INPUT_SAMPLE_RATE, SEND_SAMPLE_RATE)
            callback(resampled)

        return (None, pyaudio.paContinue)

    def _resample(self, data: bytes, from_rate: int, to_rate: int) -> bytes:
        """リサンプリング"""
        if from_rate == to_rate:
            return data

        import numpy as np

        # bytes → numpy array
        samples = np.frombuffer(data, dtype=np.int16)

        # リサンプリング比率
        ratio = to_rate / from_rate

        # 新しいサンプル数
        new_length = int(len(samples) * ratio)

        # 線形補間でリサンプリング
        indices = np.linspace(0, len(samples) - 1, new_length)
        resampled = np.interp(indices, np.arange(len(samples)), samples)

        return resampled.astype(np.int16).tobytes()

    def stop_recording(self):
        """録音を停止"""
        self.is_recording = False
        if self.input_stream:
            try:
                self.input_stream.stop_stream()
                self.input_stream.close()
            except Exception:
                pass
            self.input_stream = None
        print("[Audio] Recording stopped")

    def play_audio(self, data: bytes):
        """音声を再生"""
        if not self.output_stream:
            return

        # 24kHz → 48kHz にリサンプリング
        resampled = self._resample(data, RECEIVE_SAMPLE_RATE, OUTPUT_SAMPLE_RATE)

        try:
            self.output_stream.write(resampled)
        except Exception as e:
            print(f"[Audio] Playback error: {e}")

    def cleanup(self):
        """リソースを解放"""
        self.stop_recording()
        if self.output_stream:
            try:
                self.output_stream.stop_stream()
                self.output_stream.close()
            except Exception:
                pass
        if self.pyaudio:
            self.pyaudio.terminate()


class CameraHandler:
    """カメラハンドラ（Raspberry Pi用）"""

    def __init__(self):
        self._lock = asyncio.Lock()

    async def capture(self) -> Optional[bytes]:
        """画像を撮影"""
        import subprocess

        async with self._lock:
            try:
                image_path = "/tmp/ai_necklace_capture.jpg"
                result = subprocess.run(
                    ["rpicam-still", "-o", image_path, "-t", "500",
                     "--width", "1280", "--height", "960"],
                    capture_output=True, text=True, timeout=10
                )

                if result.returncode != 0:
                    print(f"[Camera] Capture failed: {result.stderr}")
                    return None

                with open(image_path, "rb") as f:
                    return f.read()

            except subprocess.TimeoutExpired:
                print("[Camera] Capture timeout")
                return None
            except FileNotFoundError:
                print("[Camera] rpicam-still not found")
                return None
            except Exception as e:
                print(f"[Camera] Capture error: {e}")
                return None


class ButtonHandler:
    """GPIOボタンハンドラ（Raspberry Pi用）"""

    def __init__(self):
        self.button = None
        self.on_press = None
        self.on_release = None
        self.on_double_click = None
        self._last_press_time = 0
        self._double_click_threshold = 0.3

    def initialize(self, pin: int = 5):
        """ボタンを初期化"""
        try:
            from gpiozero import Button

            self.button = Button(pin, pull_up=True, bounce_time=0.05)
            self.button.when_pressed = self._handle_press
            self.button.when_released = self._handle_release
            print(f"[Button] Initialized on GPIO {pin}")
            return True
        except ImportError:
            print("[Button] gpiozero not available (not on Raspberry Pi)")
            return False
        except Exception as e:
            print(f"[Button] Failed to initialize: {e}")
            return False

    def _handle_press(self):
        """ボタン押下を処理"""
        import time

        current_time = time.time()

        # ダブルクリック検出
        if current_time - self._last_press_time < self._double_click_threshold:
            if self.on_double_click:
                self.on_double_click()
        else:
            if self.on_press:
                self.on_press()

        self._last_press_time = current_time

    def _handle_release(self):
        """ボタンリリースを処理"""
        if self.on_release:
            self.on_release()


class DaemonServer:
    """Unix Socketサーバー"""

    def __init__(self):
        self.audio_handler = AudioHandler()
        self.button_handler = ButtonHandler()
        self.camera_handler = CameraHandler()
        self.server = None
        self.clients: list = []

    async def start(self):
        """サーバーを開始"""
        # 既存のソケットファイルを削除
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)

        # オーディオを初期化
        self.audio_handler.initialize()

        # ボタンを初期化（Raspberry Piの場合のみ）
        self.button_handler.initialize()
        self.button_handler.on_press = lambda: self._broadcast({"type": "button_press"})
        self.button_handler.on_release = lambda: self._broadcast(
            {"type": "button_release"}
        )
        self.button_handler.on_double_click = lambda: self._broadcast(
            {"type": "button_double_click"}
        )

        # サーバーを開始
        self.server = await asyncio.start_unix_server(
            self._handle_client, path=SOCKET_PATH
        )

        # ソケットのパーミッションを設定
        os.chmod(SOCKET_PATH, 0o666)

        print(f"[Daemon] Listening on {SOCKET_PATH}")

        async with self.server:
            await self.server.serve_forever()

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ):
        """クライアント接続を処理"""
        self.clients.append(writer)
        print(f"[Daemon] Client connected ({len(self.clients)} total)")

        try:
            while True:
                line = await reader.readline()
                if not line:
                    break

                try:
                    message = json.loads(line.decode())
                    await self._handle_message(message, writer)
                except json.JSONDecodeError:
                    print("[Daemon] Invalid JSON received")

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[Daemon] Client error: {e}")
        finally:
            self.clients.remove(writer)
            writer.close()
            await writer.wait_closed()
            print(f"[Daemon] Client disconnected ({len(self.clients)} total)")

    async def _handle_message(
        self, message: dict, writer: asyncio.StreamWriter
    ):
        """メッセージを処理"""
        msg_type = message.get("type")

        if msg_type == "audio_output":
            # 音声再生
            data = message.get("data")
            if data:
                audio_data = base64.b64decode(data)
                self.audio_handler.play_audio(audio_data)

        elif msg_type == "start_recording":
            # 録音開始
            def on_audio(data: bytes):
                self._broadcast(
                    {"type": "audio_input", "data": base64.b64encode(data).decode()}
                )

            self.audio_handler.start_recording(on_audio)

        elif msg_type == "stop_recording":
            # 録音停止
            self.audio_handler.stop_recording()

        elif msg_type == "capture_image":
            # 画像撮影
            image_data = await self.camera_handler.capture()
            if image_data:
                self._send(writer, {
                    "type": "capture_result",
                    "success": True,
                    "data": base64.b64encode(image_data).decode()
                })
            else:
                self._send(writer, {
                    "type": "capture_result",
                    "success": False
                })

        elif msg_type == "ping":
            # Heartbeat
            self._send(writer, {"type": "pong"})

    def _send(self, writer: asyncio.StreamWriter, message: dict):
        """メッセージを送信"""
        try:
            data = json.dumps(message) + "\n"
            writer.write(data.encode())
        except Exception as e:
            print(f"[Daemon] Send error: {e}")

    def _broadcast(self, message: dict):
        """全クライアントにブロードキャスト"""
        for writer in self.clients:
            self._send(writer, message)

    def cleanup(self):
        """リソースを解放"""
        self.audio_handler.cleanup()
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)


async def main():
    """メイン"""
    print("=" * 50)
    print("raspi-voice11 Audio Daemon")
    print("=" * 50)

    daemon = DaemonServer()

    # シグナルハンドラを設定
    def shutdown(signum, frame):
        print("\n[Daemon] Shutting down...")
        daemon.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        await daemon.start()
    except Exception as e:
        print(f"[Daemon] Error: {e}")
        daemon.cleanup()
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
