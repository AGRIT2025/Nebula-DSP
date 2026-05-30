"""
Nebula DSP — USB Audio Device Watcher
Detecta conexión/desconexión de placas de audio USB y recarga
el engine CamillaDSP automáticamente con el nuevo dispositivo.

Dependencias: pyudev, websockets, pyyaml
"""

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pyudev
import websockets
import yaml

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/var/log/nebula-dsp-usb.log"),
    ],
)
log = logging.getLogger("nebula.usb")

# ── Configuración ─────────────────────────────────────────────────────────────
CDSP_WS_HOST    = os.getenv("CDSP_HOST",    "127.0.0.1")
CDSP_WS_PORT    = int(os.getenv("CDSP_PORT", "1234"))
NEBULA_CONFIG   = Path(os.getenv("NEBULA_CONFIG", "/etc/nebula-dsp/configs/default.yml"))
SETTLE_DELAY_S  = 2.5   # segundos para que ALSA registre el dispositivo
RECONNECT_DELAY = 5.0   # segundos entre reintentos de WebSocket


# ════════════════════════════════════════════════════════════════════════════
# Modelos de datos
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class AudioDevice:
    card_id: int
    device_id: int
    name: str
    alsa_id: str
    vendor_id: str = ""
    product_id: str = ""
    bus_path: str = ""

    @property
    def capture_device(self) -> str:
        return f"hw:{self.card_id},{self.device_id}"

    @property
    def playback_device(self) -> str:
        return f"hw:{self.card_id},{self.device_id}"

    def __str__(self) -> str:
        return f"{self.name} [{self.alsa_id}] @ hw:{self.card_id},{self.device_id}"


# ════════════════════════════════════════════════════════════════════════════
# Detección de dispositivos ALSA
# ════════════════════════════════════════════════════════════════════════════

class AlsaScanner:
    """Escanea el sistema ALSA para encontrar placas de audio USB."""

    USB_DRIVER = "snd-usb-audio"
    PROC_CARDS = Path("/proc/asound/cards")

    def scan_usb_devices(self) -> list[AudioDevice]:
        """Retorna lista de todos los dispositivos USB de audio activos."""
        devices: list[AudioDevice] = []

        try:
            output = subprocess.check_output(
                ["aplay", "-l"], stderr=subprocess.DEVNULL, text=True
            )
        except (subprocess.CalledProcessError, FileNotFoundError):
            log.warning("aplay no disponible, usando /proc/asound/cards")
            return self._scan_from_proc()

        # Parsear salida de aplay -l
        # Formato: "card N: NAME [LONGNAME], device M: ..."
        pattern = re.compile(
            r"^card\s+(\d+):\s+(\S+)\s+\[(.+?)\],\s+device\s+(\d+):",
            re.MULTILINE
        )
        for match in pattern.finditer(output):
            card_id   = int(match.group(1))
            alsa_id   = match.group(2)
            card_name = match.group(3).strip()
            device_id = int(match.group(4))

            # Verificar que es USB consultando el driver en sysfs
            if self._is_usb_audio_card(card_id):
                vendor, product, bus = self._get_usb_info(card_id)
                devices.append(AudioDevice(
                    card_id=card_id,
                    device_id=device_id,
                    name=card_name,
                    alsa_id=alsa_id,
                    vendor_id=vendor,
                    product_id=product,
                    bus_path=bus,
                ))

        return devices

    def _is_usb_audio_card(self, card_id: int) -> bool:
        """Verifica que la card usa el driver snd-usb-audio."""
        driver_path = Path(f"/proc/asound/card{card_id}/usbid")
        if driver_path.exists():
            return True

        # Verificar vía sysfs
        sysfs_path = Path(f"/sys/class/sound/card{card_id}")
        if sysfs_path.exists():
            try:
                device_link = (sysfs_path / "device").resolve()
                driver_link = device_link / "driver"
                if driver_link.exists():
                    driver_name = driver_link.resolve().name
                    return driver_name == self.USB_DRIVER
            except (OSError, RuntimeError):
                pass

        # Fallback: revisar el nombre en /proc/asound/cards
        cards_file = self.PROC_CARDS
        if cards_file.exists():
            content = cards_file.read_text()
            card_block = re.search(
                rf"^\s*{card_id}\s+\[.*?\]:.*\n\s*(.*)",
                content, re.MULTILINE
            )
            if card_block:
                desc = card_block.group(1).lower()
                return "usb" in desc

        return False

    def _get_usb_info(self, card_id: int) -> tuple[str, str, str]:
        """Obtiene vendor ID, product ID y bus path del dispositivo USB."""
        vendor = product = bus = ""
        try:
            usbid_path = Path(f"/proc/asound/card{card_id}/usbid")
            if usbid_path.exists():
                ids = usbid_path.read_text().strip()
                if ":" in ids:
                    vendor, product = ids.split(":", 1)
            bus_path = Path(f"/sys/class/sound/card{card_id}/device")
            if bus_path.exists():
                bus = str(bus_path.resolve())
        except OSError:
            pass
        return vendor, product, bus

    def _scan_from_proc(self) -> list[AudioDevice]:
        """Fallback: leer /proc/asound/cards directamente."""
        devices: list[AudioDevice] = []
        if not self.PROC_CARDS.exists():
            return devices
        content = self.PROC_CARDS.read_text()
        for match in re.finditer(r"^\s*(\d+)\s+\[(\S+)\s*\]:\s+.*\n\s*(.*)", content, re.MULTILINE):
            card_id  = int(match.group(1))
            alsa_id  = match.group(2)
            desc     = match.group(3).strip()
            if "usb" in desc.lower():
                devices.append(AudioDevice(
                    card_id=card_id, device_id=0,
                    name=desc, alsa_id=alsa_id,
                ))
        return devices

    def get_best_usb_device(self) -> Optional[AudioDevice]:
        """Retorna el dispositivo USB de audio más adecuado."""
        devices = self.scan_usb_devices()
        if not devices:
            return None
        # Preferir el primero encontrado (card con ID más bajo)
        return sorted(devices, key=lambda d: d.card_id)[0]

    def verify_device_accessible(self, device: AudioDevice) -> bool:
        """Verifica que el dispositivo responde correctamente."""
        try:
            result = subprocess.run(
                ["aplay", "-D", device.playback_device, "--dump-hw-params",
                 "/dev/zero"],
                capture_output=True, timeout=3,
                text=True
            )
            # aplay puede fallar por formato, pero si menciona el device es accesible
            combined = result.stdout + result.stderr
            return "hw_params" in combined or "FORMAT" in combined
        except (subprocess.TimeoutExpired, FileNotFoundError):
            # Verificación básica: comprobar que la entrada en /dev/snd existe
            snd_path = Path(f"/dev/snd/pcmC{device.card_id}D{device.device_id}p")
            return snd_path.exists()


# ════════════════════════════════════════════════════════════════════════════
# Gestión de configuración YAML
# ════════════════════════════════════════════════════════════════════════════

class ConfigManager:
    """Lee y actualiza la configuración YAML de CamillaDSP."""

    def __init__(self, config_path: Path):
        self.path = config_path

    def load(self) -> dict:
        if not self.path.exists():
            raise FileNotFoundError(f"Config no encontrada: {self.path}")
        with open(self.path) as f:
            return yaml.safe_load(f) or {}

    def save(self, config: dict) -> None:
        # Escribir en archivo temporal y luego mover (evita corrupción)
        tmp_path = self.path.with_suffix(".yml.tmp")
        with open(tmp_path, "w") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
        tmp_path.replace(self.path)
        log.debug("Config guardada: %s", self.path)

    def update_audio_device(self, device: AudioDevice) -> bool:
        """
        Actualiza capture y playback device en la config.
        Retorna True si hubo cambios reales.
        """
        try:
            config = self.load()
        except Exception as e:
            log.error("Error leyendo config: %s", e)
            return False

        devices_section = config.get("devices", {})
        capture  = devices_section.get("capture",  {})
        playback = devices_section.get("playback", {})

        old_cap = capture.get("device",  "")
        old_pb  = playback.get("device", "")

        if old_cap == device.capture_device and old_pb == device.playback_device:
            log.info("Dispositivo sin cambios: %s", device.capture_device)
            return False

        # Actualizar dispositivos manteniendo el resto de la config
        capture["device"]  = device.capture_device
        playback["device"] = device.playback_device
        devices_section["capture"]  = capture
        devices_section["playback"] = playback
        config["devices"] = devices_section

        self.save(config)
        log.info(
            "Config actualizada: capture %s → %s | playback %s → %s",
            old_cap, device.capture_device,
            old_pb, device.playback_device,
        )
        return True

    def get_current_devices(self) -> tuple[str, str]:
        """Retorna (capture_device, playback_device) actuales."""
        try:
            config = self.load()
            devices = config.get("devices", {})
            return (
                devices.get("capture",  {}).get("device", ""),
                devices.get("playback", {}).get("device", ""),
            )
        except Exception:
            return "", ""


# ════════════════════════════════════════════════════════════════════════════
# Cliente WebSocket de CamillaDSP
# ════════════════════════════════════════════════════════════════════════════

class CamillaDSPClient:
    """Envía comandos al engine CamillaDSP vía WebSocket."""

    def __init__(self, host: str, port: int):
        self.uri = f"ws://{host}:{port}"

    async def send_command(self, command: dict) -> Optional[dict]:
        """Envía un comando y retorna la respuesta."""
        try:
            async with websockets.connect(
                self.uri,
                open_timeout=5,
                close_timeout=5,
            ) as ws:
                await ws.send(json.dumps(command))
                response = await asyncio.wait_for(ws.recv(), timeout=5.0)
                return json.loads(response)
        except asyncio.TimeoutError:
            log.warning("Timeout esperando respuesta del engine")
        except (websockets.exceptions.WebSocketException, OSError) as e:
            log.debug("Engine no disponible: %s", e)
        return None

    async def get_state(self) -> Optional[str]:
        """Obtiene el estado actual del engine."""
        resp = await self.send_command({"GetState": None})
        if resp:
            return resp.get("GetState", {}).get("value")
        return None

    async def reload_config(self) -> bool:
        """
        Recarga la configuración del engine.
        CamillaDSP recarga el archivo de config activo si se le envía SetConfigFilePath.
        """
        # Obtener path del config activo
        resp = await self.send_command({"GetConfigFilePath": None})
        if not resp:
            return False

        config_path = resp.get("GetConfigFilePath", {}).get("value", "")
        if not config_path:
            log.warning("No se pudo obtener el path del config activo")
            return False

        # Recargar enviando el mismo path
        resp = await self.send_command({"SetConfigFilePath": {"value": config_path}})
        if resp and resp.get("SetConfigFilePath", {}).get("result") == "Ok":
            log.info("Config recargada en el engine: %s", config_path)
            return True

        log.warning("Respuesta inesperada al recargar: %s", resp)
        return False

    async def is_running(self) -> bool:
        state = await self.get_state()
        return state in ("Running", "Paused")


# ════════════════════════════════════════════════════════════════════════════
# Watcher principal
# ════════════════════════════════════════════════════════════════════════════

class UsbAudioWatcher:
    """
    Monitorea eventos udev de audio USB y reconfigura el engine automáticamente.
    """

    def __init__(self):
        self.scanner  = AlsaScanner()
        self.config   = ConfigManager(NEBULA_CONFIG)
        self.client   = CamillaDSPClient(CDSP_WS_HOST, CDSP_WS_PORT)
        self._context = pyudev.Context()
        self._monitor = pyudev.Monitor.from_netlink(self._context)
        self._monitor.filter_by(subsystem="sound")
        self._current_device: Optional[AudioDevice] = None
        self._pending_task: Optional[asyncio.Task] = None

    async def _handle_device_added(self, udev_device) -> None:
        """Maneja la conexión de un nuevo dispositivo de audio."""
        driver = udev_device.get("ID_USB_DRIVER", "")
        if driver and driver != "snd-usb-audio":
            return  # No es una placa USB de audio

        log.info("Dispositivo USB de audio conectado — esperando a ALSA...")
        await asyncio.sleep(SETTLE_DELAY_S)

        # Escanear y obtener el mejor dispositivo USB disponible
        device = self.scanner.get_best_usb_device()
        if not device:
            log.warning("No se encontró dispositivo USB de audio después del evento")
            return

        log.info("Dispositivo detectado: %s", device)

        # Verificar accesibilidad
        if not self.scanner.verify_device_accessible(device):
            log.warning("Dispositivo detectado pero no accesible aún: %s", device)
            await asyncio.sleep(1.5)
            if not self.scanner.verify_device_accessible(device):
                log.error("Dispositivo inaccesible, abortando reconfiguración")
                return

        # Actualizar config YAML
        changed = self.config.update_audio_device(device)
        self._current_device = device

        if not changed:
            log.info("Config sin cambios, no se recarga el engine")
            return

        # Recargar engine
        log.info("Recargando engine con nuevo dispositivo: %s", device)
        success = await self.client.reload_config()

        if success:
            log.info("✓ Engine recargado correctamente con %s", device.capture_device)
        else:
            log.warning("Engine no disponible — config actualizada, se aplicará al próximo inicio")

    async def _handle_device_removed(self, udev_device) -> None:
        """Maneja la desconexión de un dispositivo de audio."""
        log.info("Dispositivo USB de audio desconectado")
        self._current_device = None

        # Verificar si queda algún dispositivo USB disponible
        await asyncio.sleep(1.0)
        remaining = self.scanner.scan_usb_devices()
        if remaining:
            log.info("Dispositivos USB restantes: %s", [str(d) for d in remaining])
            await self._handle_device_added(udev_device)
        else:
            log.info("Sin dispositivos USB de audio — el engine seguirá con config actual")

    async def _process_event(self, action: str, udev_device) -> None:
        """Despacha el evento al handler correspondiente."""
        if action == "add":
            await self._handle_device_added(udev_device)
        elif action == "remove":
            await self._handle_device_removed(udev_device)

    async def _event_loop(self) -> None:
        """Loop principal que escucha eventos udev."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        def _on_event(device):
            loop.call_soon_threadsafe(queue.put_nowait, (device.action, device))

        observer = pyudev.MonitorObserver(self._monitor, callback=_on_event)
        observer.start()
        log.info("Escuchando eventos de audio USB...")

        try:
            while True:
                action, device = await queue.get()
                log.debug("udev evento: %s — %s", action, device.sys_name)

                # Cancelar tarea pendiente si llega nuevo evento rápido
                if self._pending_task and not self._pending_task.done():
                    self._pending_task.cancel()

                self._pending_task = asyncio.create_task(
                    self._process_event(action, device)
                )
        finally:
            observer.stop()

    async def start(self) -> None:
        """Inicia el watcher. Escanea el estado inicial y luego monitorea."""
        log.info("Nebula DSP USB Audio Watcher iniciando...")
        log.info("Config: %s", NEBULA_CONFIG)
        log.info("Engine WS: ws://%s:%d", CDSP_WS_HOST, CDSP_WS_PORT)

        # Escaneo inicial — detectar placa ya conectada al arrancar
        initial = self.scanner.get_best_usb_device()
        if initial:
            log.info("Dispositivo USB ya conectado: %s", initial)
            self._current_device = initial
            # Actualizar config si el dispositivo difiere del actual
            cap, _ = self.config.get_current_devices()
            if cap != initial.capture_device:
                log.info("Config desactualizada, actualizando al dispositivo presente")
                self.config.update_audio_device(initial)
        else:
            log.info("Sin dispositivos USB al iniciar — esperando conexión")

        await self._event_loop()


# ════════════════════════════════════════════════════════════════════════════
# Entry point
# ════════════════════════════════════════════════════════════════════════════

async def main():
    watcher = UsbAudioWatcher()
    while True:
        try:
            await watcher.start()
        except KeyboardInterrupt:
            log.info("Detenido por el usuario")
            break
        except Exception as e:
            log.error("Error inesperado: %s — reintentando en %ss", e, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


if __name__ == "__main__":
    asyncio.run(main())
