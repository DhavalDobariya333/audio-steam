# 🌐 Cloudflare Tunnel Setup Guide

Your Termux server is running on `localhost:8765`. To allow your friend's phone to connect from anywhere in the world, we need to expose this port to the internet.

We will use **Cloudflare Tunnel (cloudflared)**. It is free, requires no port forwarding on your router, and does not host your app (it just routes traffic).

## 1. Install `cloudflared` in Termux

Termux runs on ARM64 architecture, so we need the correct binary.

```bash
# Create a bin directory
mkdir -p ~/bin
cd ~/bin

# Download the ARM64 build of cloudflared
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -O cloudflared

# Make it executable
chmod +x cloudflared

# Add it to your PATH (add this to ~/.bashrc for future sessions)
export PATH=$PATH:~/bin
```

Verify installation:
```bash
cloudflared --version
```

## 2. Start a Quick Tunnel (No Account Required)

For a quick test, you can use the free, account-less TryCloudflare service.

```bash
# Route traffic from the internet to your local port 8765
cloudflared tunnel --url http://localhost:8765
```

Look for a line in the output like this:
`https://random-words-here.trycloudflare.com`

**This is your public URL.**

## 3. Connect the Client

1. Give the URL to your friend.
2. In the Android App, they should enter:
   `wss://random-words-here.trycloudflare.com/ws/stream`
   *(Notice `https://` becomes `wss://` for secure WebSockets).*
3. They press **CONNECT**.

You can also open the dashboard from any PC in the world by visiting `https://random-words-here.trycloudflare.com` in a browser.

---

## (Optional) Permanent Tunnel with Custom Domain

If you own a domain name on Cloudflare, you can set up a permanent tunnel (so the URL doesn't change every time you restart).

1. Login to Cloudflare Zero Trust dashboard.
2. Go to Networks > Tunnels > Create a tunnel.
3. Name it "Termux-Audio".
4. Cloudflare will give you a command to run, which looks like:
   `cloudflared service install eyJh...`
5. Map a subdomain (e.g., `audio.yourdomain.com`) to `http://localhost:8765`.
6. Now the Android app can always connect to `wss://audio.yourdomain.com/ws/stream`.
