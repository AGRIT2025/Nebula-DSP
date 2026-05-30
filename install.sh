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
SERVICE_GUI="nebula-gui"
REPO_URL="https://github.com/HEnquist/camilladsp"
BACKEND_REPO="https://github.com/HEnquist/camillagui-backend"

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

# Clonar o actualizar backend
if [[ -d "$INSTALL_DIR/backend/.git" ]]; then
  info "Actualizando backend existente..."
  git -C "$INSTALL_DIR/backend" pull --quiet
else
  info "Clonando backend..."
  git clone --quiet "$BACKEND_REPO" "$INSTALL_DIR/backend"
fi
ok "Backend clonado en $INSTALL_DIR/backend"

# Virtualenv Python aislado
python3 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip

# Instalar pycamilladsp desde GitHub (no está en PyPI)
"$INSTALL_DIR/venv/bin/pip" install --quiet \
  "git+https://github.com/HEnquist/pycamilladsp.git" \
  "git+https://github.com/HEnquist/pycamilladsp-plot.git" \
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

# State file
cat > "$CONFIG_DIR/statefile.yml" << 'EOF'
volume: -20.0
mute: false
EOF

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
    format: S32_LE
  playback:
    type: Alsa
    channels: 2
    device: "$PLAYBACK_DEVICE"
    format: S32_LE

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
ExecStart=$BIN_PATH -p 1234 -w $CONFIG_DIR/configs/default.yml -o $CONFIG_DIR/statefile.yml
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

# GUI backend service
cat > "/etc/systemd/system/${SERVICE_GUI}.service" << EOF
[Unit]
Description=Nebula DSP — GUI Backend
After=network.target ${SERVICE_ENGINE}.service
Requires=${SERVICE_ENGINE}.service

[Service]
ExecStart=$INSTALL_DIR/venv/bin/python main.py
WorkingDirectory=$INSTALL_DIR/backend
Environment="CAMILLAGUI_CONFIG=$CONFIG_DIR/camillagui.yml"
Restart=on-failure
RestartSec=3
User=$REAL_USER
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

ok "Servicios systemd creados"

# ════════════════════════════════════════════════════════════════════════════
# 11. USB Audio Watcher — servicio de hot-swap embebido
# ════════════════════════════════════════════════════════════════════════════
section "USB Audio Watcher"

# Copiar el watcher y el módulo de room correction
cp "$SCRIPT_DIR/usb_watcher.py"          "$INSTALL_DIR/usb_watcher.py"
cp "$SCRIPT_DIR/room_correction.py"      "$INSTALL_DIR/room_correction.py"
cp "$SCRIPT_DIR/room_correction_server.py" "$INSTALL_DIR/room_correction_server.py"
chown "$REAL_USER:$REAL_USER" "$INSTALL_DIR/usb_watcher.py" \
      "$INSTALL_DIR/room_correction.py" "$INSTALL_DIR/room_correction_server.py"

# Instalar dependencias Python del watcher
"$INSTALL_DIR/venv/bin/pip" install --quiet pyudev websockets pyyaml
ok "Dependencias del watcher instaladas"

# ── Room Correction service ──────────────────────────────────────────────────
cat > "/etc/systemd/system/nebula-room-correction.service" << EOF
[Unit]
Description=Nebula DSP — Room Correction Server
After=${SERVICE_ENGINE}.service ${SERVICE_GUI}.service
Wants=${SERVICE_ENGINE}.service

[Service]
ExecStart=$INSTALL_DIR/venv/bin/python $INSTALL_DIR/room_correction_server.py --host 127.0.0.1 --port 5006
WorkingDirectory=$INSTALL_DIR
Environment="CDSP_HOST=127.0.0.1"
Environment="CDSP_PORT=1234"
Environment="NEBULA_CONFIG=$CONFIG_DIR/configs/default.yml"
Restart=on-failure
RestartSec=5
User=$REAL_USER
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
ok "Servicio nebula-room-correction creado"

# Servicio systemd para el watcher
cat > "/etc/systemd/system/nebula-usb-watcher.service" << EOF
[Unit]
Description=Nebula DSP — USB Audio Device Watcher
After=${SERVICE_ENGINE}.service
Wants=${SERVICE_ENGINE}.service

[Service]
ExecStart=$INSTALL_DIR/venv/bin/python $INSTALL_DIR/usb_watcher.py
Environment="CDSP_HOST=127.0.0.1"
Environment="CDSP_PORT=1234"
Environment="NEBULA_CONFIG=$CONFIG_DIR/configs/default.yml"
Restart=always
RestartSec=3
User=$REAL_USER
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

ok "Servicio nebula-usb-watcher creado"

# ════════════════════════════════════════════════════════════════════════════
# 12. Habilitar e iniciar servicios
# ════════════════════════════════════════════════════════════════════════════
section "Iniciando servicios"

systemctl daemon-reload
systemctl enable "${SERVICE_ENGINE}.service" "${SERVICE_GUI}.service" \
                 nebula-usb-watcher.service nebula-room-correction.service

if [[ -f "$BIN_PATH" ]]; then
  systemctl start "${SERVICE_ENGINE}.service"         || warn "Engine no inició — verificá la config de audio"
  sleep 2
  systemctl start "${SERVICE_GUI}.service"            || warn "GUI no inició — revisá los logs"
  systemctl start "nebula-usb-watcher.service"        || warn "USB watcher no inició"
  systemctl start "nebula-room-correction.service"    || warn "Room Correction server no inició"
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
echo -e "  ${CYAN}GUI:${RESET}        http://localhost:5005/gui"
echo -e "  ${CYAN}Engine:${RESET}     WebSocket ws://localhost:1234"
echo -e "  ${CYAN}Config:${RESET}     $CONFIG_DIR/configs/default.yml"
echo -e "  ${CYAN}Logs:${RESET}       journalctl -u $SERVICE_ENGINE -u $SERVICE_GUI -u nebula-usb-watcher -u nebula-room-correction -f"
echo ""
echo -e "  ${YELLOW}USB hot-swap:${RESET} Conectá o desconectá la placa USB en cualquier"
echo -e "               momento — el watcher detecta el cambio y reconfigura"
echo -e "               el engine automáticamente sin interrumpir el servicio."
echo ""
echo -e "  ${YELLOW}Nota:${RESET} Cerrá sesión y volvé a entrar para que los cambios"
echo -e "        de grupo (audio/realtime) tomen efecto."
echo ""
echo -e "  ${BOLD}Comandos útiles:${RESET}"
echo -e "  systemctl status $SERVICE_ENGINE"
echo -e "  systemctl status $SERVICE_GUI"
echo -e "  systemctl status nebula-usb-watcher"
echo -e "  systemctl status nebula-room-correction"
echo -e "  journalctl -u nebula-room-correction -f"
echo -e "  journalctl -u nebula-usb-watcher -f"
echo ""
