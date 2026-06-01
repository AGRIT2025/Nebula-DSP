#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
#  Nebula DSP — Instalador v1.0
#  Soporta: Ubuntu 22.04+, Debian 12+, Arch Linux
#  Arquitecturas: x86_64, aarch64, armv7l, armv6l
#  Detecta: ALSA, PipeWire, PulseAudio
#  USB Audio: reinicio automático vía udev al cambiar de placa
# ════════════════════════════════════════════════════════════════════════════

set -euo pipefail

NEBULA_VERSION="4.1.3"
INSTALL_DIR="/opt/nebula-dsp"
CONFIG_DIR="/etc/nebula-dsp"
BIN_PATH="/usr/local/bin/camilladsp"
SERVICE_ENGINE="nebula-engine"
# nebula-backend.service: el único service Python tras la consolidación.
# Antes había 3 (nebula-gui + nebula-usb-watcher + nebula-room-correction);
# ahora todo vive dentro del mismo aiohttp Application (ver el patch a
# main.py más abajo). El nombre refleja que ya no es solo "GUI".
SERVICE_BACKEND="nebula-backend"
REPO_URL="https://github.com/HEnquist/camilladsp"
BACKEND_REPO="https://github.com/HEnquist/camillagui-backend"

# Pinned upstream versions. These are the exact tags Nebula DSP has been
# validated against — the main.py eager-connect patch below depends on the
# build_app() shape from camillagui-backend v4.1.0. Bumping these requires
# re-verifying the patch anchor still matches.
BACKEND_TAG="v4.1.0"
PYCAMILLA_TAG="v4.0.0"
PYCAMILLA_PLOT_TAG="v4.1.0"

# ── Colores ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }
section() { echo -e "\n${BOLD}${CYAN}── $* ──────────────────────────────────────────${RESET}"; }

# ════════════════════════════════════════════════════════════════════════════
# 1. Verificaciones previas
# ════════════════════════════════════════════════════════════════════════════
section "Verificaciones"

[[ $EUID -ne 0 ]] && error "Ejecutar como root: sudo bash install.sh"

# Detectar distro
if   command -v apt-get &>/dev/null; then PKG_MANAGER="apt"
elif command -v pacman  &>/dev/null; then PKG_MANAGER="pacman"
else error "Distro no soportada. Se requiere apt (Debian/Ubuntu) o pacman (Arch)."
fi
ok "Package manager: $PKG_MANAGER"

# Detectar arquitectura
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  CDSP_ARCH="amd64"  ;;
  aarch64) CDSP_ARCH="aarch64" ;;
  armv7l)  CDSP_ARCH="armv7"  ;;
  armv6l)  CDSP_ARCH="armv6"  ;;
  *) error "Arquitectura no soportada: $ARCH" ;;
esac
ok "Arquitectura: $ARCH → $CDSP_ARCH"

# Usuario real (el que ejecutó sudo)
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
# Definido temprano porque varias secciones lo usan en `install -g $REAL_GROUP`
# antes de la sección "USB Audio Watcher" (donde estaba originalmente).
REAL_GROUP=$(id -gn "$REAL_USER")
REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
ok "Usuario: $REAL_USER ($REAL_HOME)"

# ════════════════════════════════════════════════════════════════════════════
# 2. Detectar backend de audio
# ════════════════════════════════════════════════════════════════════════════
section "Backend de audio"

detect_audio_backend() {
  if systemctl is-active --quiet pipewire 2>/dev/null || \
     pactl info 2>/dev/null | grep -q "PipeWire"; then
    echo "pipewire"
  elif systemctl is-active --quiet pulseaudio 2>/dev/null || \
       pgrep -x pulseaudio &>/dev/null; then
    echo "pulse"
  else
    echo "alsa"
  fi
}

AUDIO_BACKEND=$(detect_audio_backend)
ok "Audio backend detectado: $AUDIO_BACKEND"

# Sufijo del binario de CamillaDSP según backend
case "${AUDIO_BACKEND}-${CDSP_ARCH}" in
  pipewire-amd64)  CDSP_BINARY="camilladsp-linux-pipewire-amd64.tar.gz"   ;;
  pipewire-aarch64)CDSP_BINARY="camilladsp-linux-pipewire-aarch64.tar.gz" ;;
  pulse-amd64)     CDSP_BINARY="camilladsp-linux-pulse-amd64.tar.gz"      ;;
  pulse-aarch64)   CDSP_BINARY="camilladsp-linux-pulse-aarch64.tar.gz"    ;;
  alsa-amd64)      CDSP_BINARY="camilladsp-linux-amd64.tar.gz"            ;;
  alsa-aarch64)    CDSP_BINARY="camilladsp-linux-aarch64.tar.gz"          ;;
  *-armv7)         CDSP_BINARY="camilladsp-linux-armv7.tar.gz"            ;;
  *-armv6)         CDSP_BINARY="camilladsp-linux-armv6.tar.gz"            ;;
  *) CDSP_BINARY="camilladsp-linux-amd64.tar.gz" ;;
esac
ok "Binario a descargar: $CDSP_BINARY"

# ════════════════════════════════════════════════════════════════════════════
# 3. Detectar placa de sonido USB (si está conectada)
# ════════════════════════════════════════════════════════════════════════════
section "Placa de sonido"

detect_usb_audio() {
  # Busca dispositivos USB de audio en ALSA
  if aplay -l 2>/dev/null | grep -i "usb\|USB" | head -1 | grep -oP 'card \K[0-9]+' ; then
    return 0
  fi
  echo ""
}

USB_CARD=$(detect_usb_audio)
if [[ -n "$USB_CARD" ]]; then
  USB_NAME=$(aplay -l 2>/dev/null | grep "card $USB_CARD" | head -1 | grep -oP '\[.*?\]' | head -1 | tr -d '[]')
  ok "Placa USB detectada: card $USB_CARD — $USB_NAME"
  CAPTURE_DEVICE="hw:$USB_CARD,0"
  PLAYBACK_DEVICE="hw:$USB_CARD,0"
else
  warn "No se detectó placa USB. Usando dispositivo default."
  warn "Conectá la placa USB y el servicio se reiniciará automáticamente."
  CAPTURE_DEVICE="default"
  PLAYBACK_DEVICE="default"
fi

# Detectar formato soportado por la placa (S32_LE para DACs hi-end,
# S16_LE para auriculares/headsets USB de consumo). Si no podemos
# detectarlo, S16_LE es seguro en cualquier dispositivo USB Audio Class 1.
DEFAULT_FORMAT="S16_LE"
if [[ -n "$USB_CARD" ]]; then
  if arecord --dump-hw-params -D "hw:$USB_CARD,0" 2>/dev/null | grep -q "S32_LE"; then
    DEFAULT_FORMAT="S32_LE"
  elif arecord --dump-hw-params -D "hw:$USB_CARD,0" 2>/dev/null | grep -q "S24_3LE"; then
    DEFAULT_FORMAT="S24_3LE"
  fi
  ok "Formato de muestra: $DEFAULT_FORMAT"
fi

# ════════════════════════════════════════════════════════════════════════════
# 4. Dependencias del sistema
# ════════════════════════════════════════════════════════════════════════════
section "Dependencias"

if [[ "$PKG_MANAGER" == "apt" ]]; then
  apt-get update -qq

  # libasound2 vs libasound2t64 según versión de Ubuntu/Debian
  if apt-cache show libasound2t64 &>/dev/null 2>&1; then
    ALSA_PKG="libasound2t64"
  else
    ALSA_PKG="libasound2"
  fi

  DEPS="python3 python3-pip python3-venv git curl tar $ALSA_PKG"
  [[ "$AUDIO_BACKEND" == "pipewire" ]] && DEPS="$DEPS libpipewire-0.3-0"
  [[ "$AUDIO_BACKEND" == "pulse"    ]] && DEPS="$DEPS libpulse0"

  apt-get install -y -qq $DEPS
  ok "Dependencias instaladas (apt)"
else
  pacman -Sy --noconfirm python python-pip git curl tar alsa-lib
  [[ "$AUDIO_BACKEND" == "pipewire" ]] && pacman -S --noconfirm pipewire
  ok "Dependencias instaladas (pacman)"
fi

# ════════════════════════════════════════════════════════════════════════════
# 5. Permisos de audio y tiempo real
# ════════════════════════════════════════════════════════════════════════════
section "Permisos de audio"

getent group audio   &>/dev/null || groupadd audio
getent group realtime &>/dev/null || groupadd realtime

usermod -aG audio,realtime "$REAL_USER"
ok "Usuario $REAL_USER agregado a grupos audio y realtime"

cat > /etc/security/limits.d/nebula-dsp.conf << 'EOF'
@audio   -  rtprio     99
@audio   -  memlock    unlimited
@audio   -  nice       -20
@realtime - rtprio     99
@realtime - memlock    unlimited
EOF
ok "Límites RT configurados en /etc/security/limits.d/nebula-dsp.conf"

# ════════════════════════════════════════════════════════════════════════════
# 6. Descargar e instalar CamillaDSP engine
# ════════════════════════════════════════════════════════════════════════════
section "CamillaDSP Engine v$NEBULA_VERSION"

DOWNLOAD_URL="$REPO_URL/releases/download/v$NEBULA_VERSION/$CDSP_BINARY"
TMP_DIR=$(mktemp -d)

info "Descargando $DOWNLOAD_URL ..."
if curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/$CDSP_BINARY"; then
  tar -xzf "$TMP_DIR/$CDSP_BINARY" -C "$TMP_DIR"
  install -m 755 "$TMP_DIR/camilladsp" "$BIN_PATH"
  ok "CamillaDSP instalado en $BIN_PATH"

  # Verificar binario
  INSTALLED_VER=$("$BIN_PATH" --version 2>&1 | head -1 || echo "unknown")
  ok "Versión instalada: $INSTALLED_VER"
else
  warn "No se pudo descargar el binario. Verificá la versión $NEBULA_VERSION en $REPO_URL/releases"
  warn "Continuando instalación sin binario del engine..."
fi

rm -rf "$TMP_DIR"

# ════════════════════════════════════════════════════════════════════════════
# 7. Instalar backend Python (CamillaGUI backend)
# ════════════════════════════════════════════════════════════════════════════
section "Backend Python"

mkdir -p "$INSTALL_DIR/backend"

# Clonar backend en tag pinneado.
# Si ya existe, lo descartamos para evitar arrastrar un checkout viejo
# o un pull que mueva HEAD lejos del tag verificado.
rm -rf "$INSTALL_DIR/backend"
info "Clonando backend en $BACKEND_TAG..."
git clone --quiet --depth 1 --branch "$BACKEND_TAG" "$BACKEND_REPO" "$INSTALL_DIR/backend"
ok "Backend clonado en $INSTALL_DIR/backend ($BACKEND_TAG)"

# ── Patch: eager connect a CamillaDSP al arranque ───────────────────────────
# camillagui-backend solo se conecta al engine cuando llega el primer poll
# a /api/status. Cualquier otro endpoint (/api/getconfig, /api/getparam/*,
# etc.) llamado antes devuelve 500 "Not connected to CamillaDSP". El frontend
# de Nebula DSP pega varios endpoints en paralelo al cargar, así que sin esto
# se ven 500s intermitentes en el primer load. Lanzamos el reconnect thread
# en build_app para que la conexión se establezca apenas arranca el service.
python3 - "$INSTALL_DIR/backend/main.py" << 'PYEOF'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
src = p.read_text()
marker = "Nebula DSP: kick off a connect attempt"
if marker in src:
    print("  [skip] main.py already patched")
    sys.exit(0)
needle = '    app["VALIDATOR"] = camillavalidator\n    return app\n'
if needle not in src:
    print(f"  [WARN] anchor not found in {p}; backend layout changed upstream")
    sys.exit(0)
patch = (
    '    app["VALIDATOR"] = camillavalidator\n'
    '\n'
    '    # Nebula DSP: kick off a connect attempt at startup, so endpoints\n'
    '    # like /api/getconfig do not 500 with "Not connected to CamillaDSP"\n'
    '    # before the frontend has polled /api/status. _reconnect retries\n'
    '    # with backoff until the engine is reachable, then the thread exits.\n'
    '    import threading\n'
    '    from backend.views import _reconnect\n'
    '    _eager = threading.Thread(\n'
    '        target=_reconnect,\n'
    '        args=(app["CAMILLA"], app["STATUSCACHE"], camillavalidator),\n'
    '        daemon=True,\n'
    '    )\n'
    '    _eager.start()\n'
    '    app["STORE"]["reconnect_thread"] = _eager\n'
    '\n'
    '    return app\n'
)
p.write_text(src.replace(needle, patch))
print("  [ok] main.py patched (eager-connect)")
PYEOF
ok "Backend parcheado: conexión eager al engine"

# Virtualenv Python aislado
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip

# Instalar pycamilladsp desde GitHub (no está en PyPI), pinneado a tag.
"$INSTALL_DIR/venv/bin/pip" install --quiet \
  "git+https://github.com/HEnquist/pycamilladsp.git@${PYCAMILLA_TAG}" \
  "git+https://github.com/HEnquist/pycamilladsp-plot.git@${PYCAMILLA_PLOT_TAG}" \
  aiohttp aiohttp_cors

# Dependencias de Room Correction
"$INSTALL_DIR/venv/bin/pip" install --quiet \
  sounddevice scipy numpy pyyaml websockets
ok "Dependencias Room Correction instaladas"

ok "Virtualenv Python configurado"

# ════════════════════════════════════════════════════════════════════════════
# 8. Copiar frontend compilado
# ════════════════════════════════════════════════════════════════════════════
section "Frontend Nebula DSP"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIST="$SCRIPT_DIR/frontend/dist"

mkdir -p "$INSTALL_DIR/backend/build"

if [[ -d "$FRONTEND_DIST" ]]; then
  cp -r "$FRONTEND_DIST/." "$INSTALL_DIR/backend/build/"
  chown -R "$REAL_USER:$REAL_USER" "$INSTALL_DIR/backend/build"
  ok "Frontend copiado a $INSTALL_DIR/backend/build"
else
  warn "No se encontró frontend compilado en $FRONTEND_DIST"
  warn "Ejecutá: cd frontend && npm run build"
fi

# ════════════════════════════════════════════════════════════════════════════
# 9. Configuración inicial
# ════════════════════════════════════════════════════════════════════════════
section "Configuración"

mkdir -p "$CONFIG_DIR/configs"

# Config CamillaGUI backend
# Keys must match BACKEND_CONFIG_SCHEMA in camillagui-backend/backend/settings_schemas.py
cat > "$CONFIG_DIR/camillagui.yml" << EOF
camilla_host: "127.0.0.1"
camilla_port: 1234
bind_address: "0.0.0.0"
port: 5005
ssl_certificate: null
ssl_private_key: null
gui_config_file: null
config_dir: "$CONFIG_DIR/configs"
coeff_dir: "$CONFIG_DIR/coeffs"
default_config: "$CONFIG_DIR/configs/default.yml"
statefile_path: "$CONFIG_DIR/statefile.yml"
log_file: null
on_set_active_config: null
on_get_active_config: null
supported_capture_types: null
supported_playback_types: null
EOF

# camillagui-backend's settings.py loads config from a hardcoded path
# ($INSTALL_DIR/backend/config/camillagui.yml), ignoring CAMILLAGUI_CONFIG env var.
# Symlink the bundled path to /etc/nebula-dsp/camillagui.yml so:
#   - users edit a single canonical file in /etc/
#   - re-installs don't leave stale config behind
mkdir -p "$INSTALL_DIR/backend/config"
ln -sf "$CONFIG_DIR/camillagui.yml" "$INSTALL_DIR/backend/config/camillagui.yml"

# Statefile que camilladsp persiste con `-s`: contiene el config activo
# y los gains. CamillaDSP lo crea/actualiza solo en cada cambio; lo
# pre-creamos con default.yml como config activo para que al primer
# arranque tras reboot el engine cargue automáticamente y la GUI no se
# vea en estado INACTIVE.
cat > "$CONFIG_DIR/statefile.yml" << EOF
---
config_path: $CONFIG_DIR/configs/default.yml
mute: [false, false, false, false, false]
volume: [0.0, 0.0, 0.0, 0.0, 0.0]
EOF

# Logfile del engine: separado del statefile para evitar que camilladsp
# clobbere el statefile con sus logs (bug original: -o apuntaba al
# statefile, lo que dejaba el engine sin persistencia y la GUI en
# estado INACTIVE).
install -m 0644 -o "$REAL_USER" -g "$REAL_GROUP" /dev/null /var/log/nebula-dsp-engine.log

# Config de audio por defecto
cat > "$CONFIG_DIR/configs/default.yml" << EOF
---
devices:
  samplerate: 48000
  chunksize: 4096
  queuelimit: 4
  enable_rate_adjust: false
  capture:
    type: Alsa
    channels: 2
    device: "$CAPTURE_DEVICE"
    format: $DEFAULT_FORMAT
  playback:
    type: Alsa
    channels: 2
    device: "$PLAYBACK_DEVICE"
    format: $DEFAULT_FORMAT

mixers: {}
filters: {}
pipeline: []
EOF

mkdir -p "$CONFIG_DIR/gui" "$CONFIG_DIR/coeffs"
chown -R "$REAL_USER:$REAL_USER" "$CONFIG_DIR"
ok "Configuración generada en $CONFIG_DIR"
[[ -n "$USB_CARD" ]] && ok "Dispositivo: $CAPTURE_DEVICE (USB card $USB_CARD)"

# ════════════════════════════════════════════════════════════════════════════
# 10. Servicios systemd
# ════════════════════════════════════════════════════════════════════════════
section "Servicios systemd"

# Engine service
cat > "/etc/systemd/system/${SERVICE_ENGINE}.service" << EOF
[Unit]
Description=Nebula DSP — CamillaDSP Audio Engine
After=sound.target
Wants=sound.target

[Service]
# Flags:
#   -p 1234                              WebSocket de control
#   -s <statefile>                       Persiste config activo + gains entre reinicios
#   -o <logfile>                         Logs del engine (separado del statefile)
#   <CONFIGFILE>                         Config inicial; statefile tiene prioridad si existe
# Importante: NO usar -w, porque hace que el engine se quede esperando
# config por websocket y la GUI muestre INACTIVE indefinidamente.
ExecStart=$BIN_PATH -p 1234 -s $CONFIG_DIR/statefile.yml -o /var/log/nebula-dsp-engine.log $CONFIG_DIR/configs/default.yml
Restart=always
RestartSec=2
User=$REAL_USER
Group=audio
Nice=-10
LimitRTPRIO=99
LimitMEMLOCK=infinity
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# nebula-backend service. Tras la consolidación, este único proceso aiohttp
# corre TODO lo Python: la API del engine (camillagui upstream), Room
# Correction (/api/rc/*), el USB hot-swap watcher (background task), y el
# proxy al sidecar Rust del limiter (/api/limiter/*). Es lo que reemplaza
# a los antiguos nebula-gui + nebula-room-correction + nebula-usb-watcher.
cat > "/etc/systemd/system/${SERVICE_BACKEND}.service" << EOF
[Unit]
Description=Nebula DSP — Backend (API + Room Correction + USB watcher)
After=network.target ${SERVICE_ENGINE}.service
Requires=${SERVICE_ENGINE}.service

[Service]
# main.py lee la config desde un path hardcodeado en backend/settings.py
# (BASEPATH/config/camillagui.yml), que apuntamos por symlink a
# $CONFIG_DIR/camillagui.yml en la sección "Configuración" más arriba.
# Una sola instancia Python sirve la GUI + RC + USB watcher en el mismo
# event loop asyncio (ver el patch de main.py más abajo).
ExecStart=$INSTALL_DIR/venv/bin/python main.py
WorkingDirectory=$INSTALL_DIR/backend
Restart=on-failure
RestartSec=3
User=$REAL_USER
Environment="CDSP_HOST=127.0.0.1"
Environment="CDSP_PORT=1234"
Environment="NEBULA_CONFIG=$CONFIG_DIR/configs/default.yml"
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

ok "Servicios systemd creados"

# ════════════════════════════════════════════════════════════════════════════
# 11. Módulos Python embebidos en el backend (RC + USB watcher)
# ════════════════════════════════════════════════════════════════════════════
section "Módulos Python (Room Correction + USB watcher)"

# Copiar los módulos al INSTALL_DIR. Ya no corren como services aparte:
# main.py los importa y llama setup(app) sobre la misma aiohttp Application
# (ver el patch más abajo).
cp "$SCRIPT_DIR/usb_watcher.py"            "$INSTALL_DIR/usb_watcher.py"
cp "$SCRIPT_DIR/room_correction.py"        "$INSTALL_DIR/room_correction.py"
cp "$SCRIPT_DIR/room_correction_server.py" "$INSTALL_DIR/room_correction_server.py"
chown "$REAL_USER:$REAL_USER" "$INSTALL_DIR/usb_watcher.py" \
      "$INSTALL_DIR/room_correction.py" "$INSTALL_DIR/room_correction_server.py"

# Deps adicionales necesarias para el USB watcher (pyudev) que no vienen
# por defecto en camillagui-backend.
"$INSTALL_DIR/venv/bin/pip" install --quiet pyudev
ok "Dependencias Python de USB watcher instaladas"

# usb_watcher.py escribe en /var/log/nebula-dsp-usb.log (FileHandler hardcoded).
# Aunque ahora corre dentro del backend, sigue usando el mismo path.
# /var/log/ es propiedad de root, así que precreamos el archivo con
# ownership del usuario que corre el backend (REAL_GROUP ya definido arriba).
install -m 0644 -o "$REAL_USER" -g "$REAL_GROUP" /dev/null /var/log/nebula-dsp-usb.log

# Patch a main.py para importar usb_watcher + room_correction_server y
# llamar sus setup(app). Idempotente: si ya está parcheado, skip.
python3 - << PYEOF
import pathlib, sys
p = pathlib.Path("$INSTALL_DIR/backend/main.py")
src = p.read_text()
if "room_correction_server" in src and "usb_watcher" in src:
    print("  [skip] main.py ya tiene RC + USB watcher consolidados")
    sys.exit(0)
needle_imp = "from backend.routes import setup_routes, setup_static_routes"
add_imp = (
    "\nimport sys, os"
    "\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))"
    "\nimport room_correction_server"
    "\nimport usb_watcher"
)
if needle_imp in src and "import room_correction_server" not in src:
    src = src.replace(needle_imp, needle_imp + add_imp)
needle_call = "    setup_static_routes(app)"
add_call = (
    "\n    # Nebula DSP: consolidar Room Correction + USB watcher dentro del"
    "\n    # mismo proceso aiohttp (antes eran 2 services systemd separados)."
    "\n    room_correction_server.setup(app)"
    "\n    usb_watcher.setup(app)"
)
if needle_call in src and "room_correction_server.setup" not in src:
    src = src.replace(needle_call, needle_call + add_call)
p.write_text(src)
print("  [ok] main.py parcheado: room_correction + usb_watcher consolidados")
PYEOF
ok "Backend consolida Room Correction (/api/rc/*) + USB watcher (background task)"

# ════════════════════════════════════════════════════════════════════════════
# 11.5. Nebula Limiter — sidecar Rust, brickwall con lookahead + true-peak
# ════════════════════════════════════════════════════════════════════════════
section "Brickwall Limiter (Rust)"

LIMITER_SRC="$SCRIPT_DIR/nebula-limiter"
LIMITER_BIN_DIR="$INSTALL_DIR/bin"
LIMITER_BIN="$LIMITER_BIN_DIR/nebula-limiter"

mkdir -p "$LIMITER_BIN_DIR"

if [[ -d "$LIMITER_SRC" ]]; then
  # Rust toolchain: si no está, instalamos minimal rustup (sin pedir prompt).
  if ! command -v cargo &>/dev/null; then
    info "Instalando Rust (minimal) — necesario para compilar nebula-limiter..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sudo -u "$REAL_USER" sh -s -- -y --default-toolchain stable --profile minimal
    # shellcheck disable=SC1091
    source "/home/$REAL_USER/.cargo/env" 2>/dev/null || true
    export PATH="/home/$REAL_USER/.cargo/bin:$PATH"
  fi

  # Headers ALSA: el crate `alsa` los necesita en build time.
  if [[ "$PKG_MANAGER" == "apt" ]]; then
    apt-get install -y --no-install-recommends libasound2-dev pkg-config >/dev/null 2>&1 \
      || warn "No se pudo instalar libasound2-dev — la compilación puede fallar"
  fi

  info "Compilando nebula-limiter (release, ~30 s)..."
  if sudo -u "$REAL_USER" -E bash -c "cd '$LIMITER_SRC' && cargo build --release --quiet"; then
    install -m 755 "$LIMITER_SRC/target/release/nebula-limiter" "$LIMITER_BIN"
    ok "Binario instalado en $LIMITER_BIN"
  else
    warn "Compilación del limitador falló — la GUI mostrará 'Offline' en el tab Limiter"
  fi
else
  warn "No se encontró $LIMITER_SRC — el limitador no se instalará"
fi

# Cargar snd-aloop al arranque: necesario para insertar el limitador entre
# CamillaDSP y el DAC físico.
cat > /etc/modules-load.d/nebula-loopback.conf << 'EOF'
# Cargado por systemd al boot. snd-aloop provee hw:Loopback para
# insertar nebula-limiter entre CamillaDSP y el DAC físico.
snd-aloop
EOF
cat > /etc/modprobe.d/nebula-loopback.conf << 'EOF'
options snd-aloop enable=1 index=7 pcm_substreams=1
EOF
modprobe snd-aloop pcm_substreams=1 enable=1 index=7 2>/dev/null || true
ok "snd-aloop configurado"

# Service unit del limitador. Default: capture desde el loopback, playback
# a `null` (audio descartado). Esto deja el service vivo + el socket de
# control disponible sin grabar el DAC físico al boot; el usuario re-rutea
# --playback a su DAC desde el tab Limiter (vía /api/limiter/params, una
# vez que tengamos esa funcionalidad implementada).
cat > "/etc/systemd/system/nebula-limiter.service" << EOF
[Unit]
Description=Nebula DSP — Lookahead Brickwall Limiter
After=sound.target ${SERVICE_ENGINE}.service
Wants=sound.target

[Service]
ExecStart=$LIMITER_BIN \\
  --capture hw:Loopback,1,0 \\
  --playback null \\
  --rate 48000 --channels 2 --period 256 --periods 4 \\
  --ceiling-db=-1.0 --lookahead-ms 3.0 --release-ms 50.0 \\
  --true-peak \\
  --socket /run/nebula-limiter/control.sock
Restart=always
RestartSec=2
User=$REAL_USER
Group=audio
Nice=-10
LimitRTPRIO=99
LimitMEMLOCK=infinity
RuntimeDirectory=nebula-limiter
RuntimeDirectoryMode=0755
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
ok "Servicio nebula-limiter creado"

# sudoers: el backend Python (corriendo como $REAL_USER) necesita poder
# parar/iniciar el sidecar nebula-limiter desde la GUI sin password.
# Limitado a esos tres verbos sobre ESE service específico — no es sudo
# general. Usamos /usr/bin/systemctl con path absoluto para que la regla
# no matchee otros binarios.
cat > "/etc/sudoers.d/99-nebula-limiter" << EOF
# Generated by Nebula DSP install.sh — passwordless systemctl control
# of the brickwall sidecar so the GUI can stop/start it.
$REAL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start nebula-limiter.service
$REAL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop nebula-limiter.service
$REAL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart nebula-limiter.service
EOF
chmod 0440 /etc/sudoers.d/99-nebula-limiter
# Validate — bad sudoers files can lock you out, but visudo -c is safe.
if visudo -c -f /etc/sudoers.d/99-nebula-limiter >/dev/null 2>&1; then
  ok "sudoers rule installed for $REAL_USER → systemctl {start,stop,restart} nebula-limiter"
else
  warn "sudoers validation failed — removing the rule"
  rm -f /etc/sudoers.d/99-nebula-limiter
fi

# Copiar el proxy Python al backend y patchear main.py para registrar los
# endpoints /api/limiter/*.
if [[ -f "$SCRIPT_DIR/backend/nebula_limiter_routes.py" ]]; then
  cp "$SCRIPT_DIR/backend/nebula_limiter_routes.py" "$INSTALL_DIR/backend/nebula_limiter_routes.py"
  chown "$REAL_USER:$REAL_USER" "$INSTALL_DIR/backend/nebula_limiter_routes.py"

  python3 - << PYEOF
import pathlib, sys
p = pathlib.Path("$INSTALL_DIR/backend/main.py")
src = p.read_text()
if "nebula_limiter_routes" in src:
    print("  [skip] main.py ya tiene nebula_limiter_routes")
    sys.exit(0)
needle_imp = "from backend.routes import setup_routes, setup_static_routes"
if needle_imp in src:
    src = src.replace(needle_imp, needle_imp + "\nimport nebula_limiter_routes")
needle_call = "    setup_static_routes(app)"
if needle_call in src:
    src = src.replace(needle_call, needle_call + "\n    nebula_limiter_routes.setup(app)")
p.write_text(src)
print("  [ok] main.py parcheado para /api/limiter/*")
PYEOF
  ok "Backend proxied: /api/limiter/{status,params,reset}"
fi

# ════════════════════════════════════════════════════════════════════════════
# 12. Habilitar e iniciar servicios
# ════════════════════════════════════════════════════════════════════════════
section "Iniciando servicios"

systemctl daemon-reload
# Limpiar units viejos de una instalación anterior pre-consolidación (si los hay).
for stale in nebula-gui.service nebula-usb-watcher.service nebula-room-correction.service; do
  if [[ -f "/etc/systemd/system/$stale" ]]; then
    systemctl disable "$stale" 2>/dev/null || true
    rm -f "/etc/systemd/system/$stale"
    info "Removido service obsoleto: $stale"
  fi
done
systemctl daemon-reload

systemctl enable "${SERVICE_ENGINE}.service" "${SERVICE_BACKEND}.service" \
                 nebula-limiter.service 2>/dev/null || true

if [[ -f "$BIN_PATH" ]]; then
  systemctl start "${SERVICE_ENGINE}.service"         || warn "Engine no inició — verificá la config de audio"
  sleep 2
  systemctl start "${SERVICE_BACKEND}.service"        || warn "Backend no inició — revisá los logs"
  [[ -x "$LIMITER_BIN" ]] && systemctl start "nebula-limiter.service" \
    || warn "Brickwall Limiter no inició (opcional — el resto del DSP funciona igual)"
  ok "Servicios iniciados"
else
  warn "Binario del engine no encontrado — servicios no iniciados"
fi

# ════════════════════════════════════════════════════════════════════════════
# 13. Resumen final
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Nebula DSP instalado correctamente${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${CYAN}GUI:${RESET}        http://localhost:5005/"
echo -e "  ${CYAN}Engine:${RESET}     WebSocket ws://localhost:1234"
echo -e "  ${CYAN}Config:${RESET}     $CONFIG_DIR/configs/default.yml"
echo -e "  ${CYAN}Logs:${RESET}       journalctl -u $SERVICE_ENGINE -u $SERVICE_BACKEND -u nebula-limiter -f"
echo ""
echo -e "  ${YELLOW}USB hot-swap:${RESET} Conectá o desconectá la placa USB en cualquier"
echo -e "               momento — el watcher (corriendo dentro del backend) detecta"
echo -e "               el cambio y reconfigura el engine automáticamente."
echo ""
echo -e "  ${YELLOW}Nota:${RESET} Cerrá sesión y volvé a entrar para que los cambios"
echo -e "        de grupo (audio/realtime) tomen efecto."
echo ""
echo -e "  ${BOLD}Servicios (3 totales):${RESET}"
echo -e "  systemctl status $SERVICE_ENGINE        # CamillaDSP audio engine"
echo -e "  systemctl status $SERVICE_BACKEND       # Python aiohttp (GUI + API + RC + USB watcher)"
echo -e "  systemctl status nebula-limiter         # Rust brickwall sidecar (opcional)"
echo ""
echo -e "  ${BOLD}Logs unificados:${RESET}"
echo -e "  journalctl -u $SERVICE_BACKEND -f"
echo ""
