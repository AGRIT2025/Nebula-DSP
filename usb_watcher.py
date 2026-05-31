"""
Nebula DSP — USB Audio Device Watcher.

Detecta conexión/desconexión de placas de audio USB y recarga el
engine CamillaDSP automáticamente con el nuevo dispositivo.

Usado en dos modos:
  1. Importado por el backend consolidado: `setup(app)` registra un
     `on_startup` hook que lanza `UsbAudioWatcher().start()` como
     `asyncio.create_task()` dentro del mismo event loop de aiohttp.
  2. Standalone para debug: `python usb_watcher.py` corre el watcher
     directo (kept for backwards compatibility).

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
# Cuando el watcher corría como service standalone, basicConfig acá era
# suficiente. Tras la consolidación, camillagui-backend ya configuró el
# root logger antes de que importemos este módulo, así que basicConfig
# queda no-op y los mensajes se pierden. Solución: attach explícitamente
# los handlers a *nuestro* logger en vez de delegar al root.
_FORMATTER = logging.Formatter(
    "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("nebula.usb")
log.setLevel(logging.INFO)
log.propagate = False  # no doble-loggear vía root
if not log.handlers:
    _stream = logging.StreamHandler(sys.stdout)
    _stream.setFormatter(_FORMATTER)
    log.addHandler(_stream)
    try:
        _file = logging.FileHandler("/var/log/nebula-dsp-usb.log")
        _file.setFormatter(_FORMATTER)
        log.addHandler(_file)
    except (PermissionError, OSError):
        # /var/log/nebula-dsp-usb.log no existe / no escribible.
        # No fatal — seguimos con el stream a stdout (journald lo captura).
        pass

# ── Configuración ─────────────────────────────────────────────────────────────
CDSP_WS_HOST    = os.getenv("CDSP_HOST",    "127.0.0.1")
CDSP_WS_PORT    = int(os.getenv("CDSP_PORT", "1234"))
NEBULA_CONFIG   = Path(os.getenv("NEBULA_CONFIG", "/etc/nebula-dsp/configs/default.yml"))
SETTLE_DELAY_S  = 2.5    # segundos para que ALSA registre el dispositivo
RECONNECT_DELAY = 5.0    # segundos entre reintentos de WebSocket
RECONCILE_INT_S = 15.0   # cada cuántos segundos hacer un reconcile defensivo
                         # contra la realidad ALSA (independiente de udev)


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

    def probe_best_format(self, device: AudioDevice) -> Optional[str]:
        """Pregunta a ALSA qué formatos soporta este device y devuelve el
        mejor disponible (preferencia: S32_LE > S24_3LE > S16_LE).

        Devuelve `None` si NO se pudo medir con confianza (por ejemplo,
        el device está abierto en exclusiva por el engine, o arecord no
        respondió en time). El caller debe mantener la config existente
        en ese caso — un fallback ciego a S16_LE causaría ping-pong con
        el reconcile periódico cuando el device realmente es S32_LE-only.

        Esto evita que el engine quede en restart-loop tras hot-swap
        cuando el USB nuevo no soporta el formato que tenía configurado
        el dispositivo anterior."""
        try:
            result = subprocess.run(
                ["arecord", "--dump-hw-params", "-D", device.capture_device, "-f", "cd"],
                capture_output=True, timeout=2, text=True,
            )
            combined = result.stdout + result.stderr
            # `arecord --dump-hw-params` siempre imprime la sección
            # "HW Params of device" si pudo abrir el dispositivo. Si esa
            # cabecera no está, no logró abrir → no podemos confiar en
            # nuestra detección.
            if "HW Params of device" not in combined and "FORMAT" not in combined:
                return None
            for fmt in ("S32_LE", "S24_3LE", "S16_LE"):
                if fmt in combined:
                    return fmt
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        return None


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

    def update_audio_device(self, device: AudioDevice, sample_format: Optional[str] = None) -> bool:
        """
        Actualiza capture y playback device en la config.
        Retorna True si hubo cambios reales.

        Si `sample_format` viene seteado (típicamente desde
        AlsaScanner.probe_best_format), también lo escribe en
        devices.capture.format y devices.playback.format — necesario al
        hacer hot-swap entre placas que no comparten el formato (p.ej.
        un headset S16_LE-only y una interface pro S32_LE-only).
        """
        try:
            config = self.load()
        except Exception as e:
            log.error("Error leyendo config: %s", e)
            return False

        devices_section = config.get("devices", {})
        capture  = devices_section.get("capture",  {})
        playback = devices_section.get("playback", {})

        old_cap     = capture.get("device",  "")
        old_pb      = playback.get("device", "")
        old_cap_fmt = capture.get("format",  "")
        old_pb_fmt  = playback.get("format", "")

        new_fmt = sample_format or old_cap_fmt or "S16_LE"

        if (old_cap == device.capture_device and old_pb == device.playback_device
                and old_cap_fmt == new_fmt and old_pb_fmt == new_fmt):
            log.info("Dispositivo sin cambios: %s (%s)", device.capture_device, new_fmt)
            return False

        # Actualizar dispositivos + formato manteniendo el resto de la config
        capture["device"]  = device.capture_device
        playback["device"] = device.playback_device
        if sample_format:
            capture["format"]  = sample_format
            playback["format"] = sample_format
        devices_section["capture"]  = capture
        devices_section["playback"] = playback
        config["devices"] = devices_section

        self.save(config)
        log.info(
            "Config actualizada: capture %s/%s → %s/%s | playback %s/%s → %s/%s",
            old_cap, old_cap_fmt, device.capture_device, new_fmt,
            old_pb,  old_pb_fmt,  device.playback_device, new_fmt,
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

    Cuando corre embebido en el backend Python (vía `setup(app)`), también
    refresca `app["STATUSCACHE"]["{playback,capture}_devices"]` tras cada
    plug/unplug — sino la GUI sigue viendo la lista ALSA cacheada al boot
    y el badge "USB Connected" no refleja la desconexión.
    """

    def __init__(self, app=None):
        self.scanner  = AlsaScanner()
        self.config   = ConfigManager(NEBULA_CONFIG)
        self.client   = CamillaDSPClient(CDSP_WS_HOST, CDSP_WS_PORT)
        self._context = pyudev.Context()
        self._monitor = pyudev.Monitor.from_netlink(self._context)
        self._monitor.filter_by(subsystem="sound")
        self._current_device: Optional[AudioDevice] = None
        self._pending_task: Optional[asyncio.Task] = None
        # Reference to the aiohttp app so we can repopulate STATUSCACHE
        # in-process.  None when running standalone (no cache to refresh).
        self._app = app

    async def _refresh_status_cache(self) -> None:
        """Re-query CamillaDSP for the current ALSA device list and update
        the backend's STATUSCACHE.  No-op if we're standalone or the
        engine is unreachable."""
        if self._app is None:
            return
        try:
            cdsp = self._app.get("CAMILLA")
            cache = self._app.get("STATUSCACHE")
            if cdsp is None or cache is None:
                return
            if not cdsp.is_connected():
                # Engine offline; clear cached lists so the GUI sees empty
                # instead of stale entries that no longer exist.
                cache["playback_devices"] = {}
                cache["capture_devices"]  = {}
                log.info("Cache invalidado: engine offline (lista vacía)")
                return
            # Use the engine's view of ALSA, the same source the upstream
            # camillagui-backend uses on initial _reconnect.  Engine calls
            # snd_pcm_open under the hood so this matches what /api/status
            # has historically shown — just refreshed live.
            backends = cdsp.general.supported_device_types()
            pb_backends, cap_backends = backends
            new_pb, new_cap = {}, {}
            for b in pb_backends:
                new_pb[b] = cdsp.general.list_playback_devices(b)
            for b in cap_backends:
                new_cap[b] = cdsp.general.list_capture_devices(b)
            cache["playback_devices"] = new_pb
            cache["capture_devices"]  = new_cap
            log.info("STATUSCACHE refrescado: %d playback / %d capture entries (Alsa)",
                     len(new_pb.get("Alsa", [])), len(new_cap.get("Alsa", [])))
        except Exception as e:
            log.warning("No se pudo refrescar STATUSCACHE: %s", e)

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

        # Detectar el formato soportado por el dispositivo nuevo.  Si la
        # config tenía S16_LE de un headset previo y ahora viene una
        # interface S32_LE-only (o viceversa), el engine entraría en
        # restart-loop con "snd_pcm_hw_params_set_format / Invalid argument".
        sample_format = self.scanner.probe_best_format(device)
        log.info("Formato soportado por %s: %s", device.capture_device, sample_format)

        # Actualizar config YAML (device + format)
        changed = self.config.update_audio_device(device, sample_format=sample_format)
        self._current_device = device

        if not changed:
            log.info("Config sin cambios, no se recarga el engine")
            return

        # Recargar engine
        log.info("Recargando engine con nuevo dispositivo: %s (%s)", device, sample_format)
        success = await self.client.reload_config()

        if success:
            log.info("✓ Engine recargado correctamente con %s", device.capture_device)
        else:
            log.warning("Engine no disponible — config actualizada, se aplicará al próximo inicio")

        # Refrescar el cache del backend para que la GUI vea el cambio.
        await self._refresh_status_cache()

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
            # Refrescar el cache aunque no haya plug nuevo: el badge debe
            # bajar del estado "USB Connected" al ver que la lista ALSA
            # ya no contiene el dispositivo.
            await self._refresh_status_cache()

    async def _process_event(self, action: str, udev_device) -> None:
        """Despacha el evento al handler correspondiente."""
        if action == "add":
            await self._handle_device_added(udev_device)
        elif action == "remove":
            await self._handle_device_removed(udev_device)

    async def _event_loop(self) -> None:
        """Loop principal que escucha eventos udev con debounce.

        Un plug/unplug físico genera varios eventos udev consecutivos en
        rápida sucesión (uno por cada subdevice ALSA + interfaces USB).
        La versión anterior cancelaba el handler en curso con cada nuevo
        evento — y dado que el handler hace `await asyncio.sleep(2.5)` de
        settle, NUNCA llegaba a completar si los eventos llegaban a
        intervalos < 2.5 s. Resultado: el watcher detectaba el plug,
        loggeaba "conectado", pero no llegaba a actualizar la config ni
        a recargar el engine.

        Nueva estrategia: coalescer eventos en una ventana DEBOUNCE_S.
        Cada evento nuevo resetea el timer; el handler se ejecuta solo
        después de que pase la ventana sin eventos adicionales — eso
        garantiza que cuando arranca, ALSA + udev ya se estabilizaron.
        """
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        DEBOUNCE_S = 0.5    # ventana de coalescing

        def _on_event(device):
            loop.call_soon_threadsafe(queue.put_nowait, (device.action, device))

        observer = pyudev.MonitorObserver(self._monitor, callback=_on_event)
        observer.start()
        log.info("Escuchando eventos de audio USB...")

        try:
            while True:
                # Block hasta que llegue al menos un evento
                action, device = await queue.get()

                # Coalescing: drenar cualquier evento adicional que llegue
                # dentro de DEBOUNCE_S. Si llega otro mientras esperamos,
                # extendemos la ventana — clásica debounce de "ultimo
                # evento gana".
                last = (action, device)
                while True:
                    try:
                        nxt = await asyncio.wait_for(queue.get(), timeout=DEBOUNCE_S)
                        last = nxt    # extender ventana
                    except asyncio.TimeoutError:
                        break        # ventana sin más eventos → procesar

                final_action, final_device = last
                log.debug("udev evento (coalescido): %s — %s",
                          final_action, final_device.sys_name)

                # Esperar si hay un handler previo todavía corriendo (raro
                # tras el debounce, pero defensivo).
                if self._pending_task and not self._pending_task.done():
                    try:
                        await self._pending_task
                    except Exception:
                        pass

                self._pending_task = asyncio.create_task(
                    self._process_event(final_action, final_device)
                )
        finally:
            observer.stop()

    async def _reconcile(self, reason: str = "periodic") -> None:
        """Compara la realidad ALSA con la config y arregla si difieren.

        Cubre el caso donde los eventos udev se pierden — pasa típicamente
        cuando el usuario hace hot-swaps rápidos (unplug + plug en < 500 ms)
        y el debounce del event loop coalesce los eventos como un solo
        `remove`, sin enterarse del `add` posterior. También cubre cards
        que comparten el mismo card index (e.g. ambas placas USB salen como
        `card 1`): udev manda eventos pero el config ya tiene `hw:1,0` y
        la igualdad textual hace que no se haga nada, aunque el formato
        sea distinto.
        """
        present = self.scanner.get_best_usb_device()
        cap_dev, _ = self.config.get_current_devices()

        if present is None and self._current_device is not None:
            log.info("[reconcile %s] dispositivo previo %s ya no presente",
                     reason, self._current_device)
            self._current_device = None
            await self._refresh_status_cache()
            return

        if present is None:
            return  # nada que hacer

        # Leer el formato actual del config
        try:
            cfg = self.config.load()
            cur_fmt = (((cfg.get("devices") or {}).get("capture") or {}).get("format") or "")
        except Exception:
            cur_fmt = ""

        # Probar el formato real del device. Si devuelve None (típicamente
        # porque el engine tiene el device abierto en exclusiva ALSA), no
        # podemos saber el formato real → confiamos en el config actual y
        # no hacemos cambios.
        probed_fmt = self.scanner.probe_best_format(present)
        effective_fmt = probed_fmt if probed_fmt else cur_fmt

        device_matches = (cap_dev == present.capture_device)
        format_matches = (cur_fmt == effective_fmt)

        # Si la config + formato YA reflejan la realidad ALSA, no hay nada
        # que reconciliar — incluso si self._current_device interno estaba
        # a None (típico tras un restart del backend con USB ya conectado).
        if device_matches and format_matches:
            if self._current_device is None:
                # Sincronizamos el state interno silenciosamente.
                self._current_device = present
            return

        # Si el probe falló (no podemos saber el formato real) Y el device
        # actual coincide con el config, no tocamos nada — evita el
        # ping-pong S16_LE↔S32_LE con el engine running.
        if not probed_fmt and device_matches:
            return

        log.info(
            "[reconcile %s] desfase detectado — device: %s%s · format: %s%s",
            reason,
            cap_dev, '' if device_matches else f' → {present.capture_device}',
            cur_fmt, '' if format_matches else f' → {effective_fmt}',
        )

        changed = self.config.update_audio_device(present, sample_format=probed_fmt)
        self._current_device = present

        if changed:
            log.info("[reconcile %s] recargando engine con %s (%s)",
                     reason, present.capture_device, effective_fmt)
            await self.client.reload_config()
            await self._refresh_status_cache()

    async def _periodic_reconcile(self) -> None:
        """Background task: re-check ALSA reality every RECONCILE_INT_S
        seconds. Cheap (no I/O if everything is in sync) and saves us
        from missed udev events."""
        while True:
            await asyncio.sleep(RECONCILE_INT_S)
            try:
                await self._reconcile("periodic")
            except Exception as e:
                log.warning("reconcile error: %s", e)

    async def start(self) -> None:
        """Inicia el watcher. Escanea el estado inicial y luego monitorea."""
        log.info("Nebula DSP USB Audio Watcher iniciando...")
        log.info("Config: %s", NEBULA_CONFIG)
        log.info("Engine WS: ws://%s:%d", CDSP_WS_HOST, CDSP_WS_PORT)

        # Escaneo inicial — detectar placa ya conectada al arrancar
        await self._reconcile("startup")

        # El cache del backend se popula al boot vía _reconnect(); forzamos
        # un refresh ahora (con un pequeño delay para que el engine termine
        # su init si vino primero el watcher).
        await asyncio.sleep(2.0)
        await self._refresh_status_cache()

        # Lanzar reconciliación periódica en background para detectar
        # cambios que se pierdan por debounce o por subir/bajar el USB
        # mientras el watcher estaba ocupado.
        asyncio.create_task(self._periodic_reconcile())

        await self._event_loop()


# ════════════════════════════════════════════════════════════════════════════
# Integration with the consolidated backend
# ════════════════════════════════════════════════════════════════════════════

async def _supervisor(app=None):
    """Wraps UsbAudioWatcher.start() with the same restart-on-error logic
    the standalone main() had.  `app` is passed through so the watcher
    can refresh STATUSCACHE in-process."""
    watcher = UsbAudioWatcher(app=app)
    while True:
        try:
            await watcher.start()
        except asyncio.CancelledError:
            log.info("Watcher cancelado (shutdown del backend)")
            raise
        except Exception as e:
            log.error("Error inesperado en USB watcher: %s — reintentando en %ss", e, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


def setup(app) -> None:  # `app: aiohttp.web.Application` — imported lazily to keep this file
    """Schedule the USB watcher as a background task next to the API.

    Registers an `on_startup` hook so the supervisor task is created
    once the event loop is running, and an `on_cleanup` hook to cancel
    it gracefully on shutdown.  `app` is captured so the watcher can
    refresh STATUSCACHE (used by /api/status) in-process when a USB
    plug/unplug event occurs — otherwise the GUI's "USB Connected"
    badge stays stale because the cache is only populated once at boot.
    """
    async def _on_startup(_app):
        log.info("Nebula USB watcher: scheduling background task")
        _app["_usb_watcher_task"] = asyncio.create_task(_supervisor(_app))

    async def _on_cleanup(_app):
        task = _app.get("_usb_watcher_task")
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)


# ════════════════════════════════════════════════════════════════════════════
# Standalone entry point (kept for `python usb_watcher.py` debugging)
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
