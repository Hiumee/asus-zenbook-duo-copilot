# ASUS Zenbook Duo Copilot key switch

A small, dependency-free WebHID app for the detachable ASUS Zenbook Duo
UX8406CA keyboard (USB `VID 0B05`, `PID 1BF2`, firmware 2.04).

It switches the Copilot-position key between:

- **Legacy:** Right Ctrl
- **Copilot:** Win + Shift + F23

Only the firmware's family bit is changed. The lower regional/SKU layout ID is
preserved, and no write occurs when the requested mode is already active. The
app talks to the configuration command built into the stock keyboard firmware;
it does not install a driver or flash firmware.

## Usage

Open https://asuskb.hiumee.com in desktop Chrome or Edge, click **Connect
keyboard**, and approve the ASUS device in the browser picker.

## Run locally

Connect the keyboard directly by USB. From this directory, start any static
HTTP server, for example:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000` in desktop Chrome or Edge, click **Connect
keyboard**, and approve the ASUS device in the browser picker.

WebHID requires a secure context, so use `localhost` during development and
HTTPS when publishing the app. Device access always requires an explicit user
permission prompt.

## Scope and warning

This was developed for the UX8406CA detachable keyboard with firmware 2.04.
Changing persistent keyboard configuration carries some risk. Keep the
keyboard connected to stable power and do not disconnect it while a change is
being written and verified.

Independent research; not affiliated with ASUS.


## AI

Everything from research to creating the web app was done using GPT 5.6 Sol
