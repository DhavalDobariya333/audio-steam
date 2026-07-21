# 📱 Termux Server Setup Guide

Follow these steps to turn your Android phone into a stable FastAPI server.

## 1. Install Termux
Do **NOT** use the Google Play Store version (it is deprecated).
Download and install **Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/).
Also install **Termux:API** from F-Droid.

## 2. Essential Configuration

Open Termux and run:
```bash
# Update package lists and upgrade existing packages
pkg update && pkg upgrade -y

# Install Python and Git
pkg install -y python git termux-api

# Grant storage permission (so we can save recordings to internal storage)
termux-setup-storage
```

## 3. Prevent Android from Killing the Server (CRITICAL)
Android aggressively kills background apps. You MUST do both steps below.

**A. In Termux, run:**
```bash
# Acquire a wake-lock to keep the CPU running even when screen is off
termux-wake-lock
```

**B. In Android Settings:**
1. Settings > Apps > Termux > Battery > Set to **Unrestricted** (or "Don't optimize").
2. Lock Termux in your recent apps tray (swipe up, long press Termux, tap Lock).
3. *(Samsung)*: Settings > Battery > Background usage limits > Never sleeping apps > Add Termux.
4. *(Xiaomi)*: Settings > Apps > Manage Apps > Termux > Battery saver > No restrictions. Enable "AutoStart".

## 4. Install Server Dependencies

Navigate to your project directory (where you copied `server/`) and run:
```bash
cd server
pip install -r requirements.txt
```

*(If `pip` fails due to compilation errors, try `pip install --no-cache-dir fastapi uvicorn websockets`)*

## 5. Run the Server

```bash
# Make sure you ran termux-wake-lock!
python main.py
```

You should see:
```text
INFO     │ server       │ INFO    │ ══════════════════════════════════════════════════
INFO     │ server       │ INFO    │   Audio Stream Server — Starting
INFO     │ server       │ INFO    │   Dashboard:  http://0.0.0.0:8765
INFO     │ server       │ INFO    │ ══════════════════════════════════════════════════
```

Open Chrome on the same phone and go to `http://localhost:8765`. You will see your dashboard!
