"use strict";

const VID = 0x0b05;
const PID = 0x1bf2;
const USAGE_PAGE = 0xffe0;
const USAGE = 0x0001;
const OUTPUT_REPORT_ID = 0x20;
const INPUT_REPORT_ID = 0x21;
const PAYLOAD_SIZE = 63;
const VALID_LAYOUTS = new Set([1, 2, 3, 4, 5, 0x81, 0x82, 0x83, 0x84, 0x85]);

const elements = {
  connect: document.querySelector("#connectButton"),
  refresh: document.querySelector("#refreshButton"),
  legacy: document.querySelector("#legacyButton"),
  copilot: document.querySelector("#copilotButton"),
  device: document.querySelector("#deviceValue"),
  mode: document.querySelector("#modeValue"),
  raw: document.querySelector("#rawValue"),
  status: document.querySelector("#status"),
};

let device = null;
let currentLayout = null;
let busy = false;
const pendingResponses = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (value) => `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", error);
}

function render() {
  const connected = Boolean(device?.opened);
  elements.connect.textContent = connected ? "Choose another keyboard" : "Connect keyboard";
  elements.refresh.disabled = busy || !connected;
  elements.legacy.disabled = busy || !connected || currentLayout === null || !(currentLayout & 0x80);
  elements.copilot.disabled = busy || !connected || currentLayout === null || Boolean(currentLayout & 0x80);
  elements.legacy.classList.toggle("active", currentLayout !== null && !(currentLayout & 0x80));
  elements.copilot.classList.toggle("active", currentLayout !== null && Boolean(currentLayout & 0x80));
}

function setBusy(value) {
  busy = value;
  elements.connect.disabled = value;
  render();
}

function handleInputReport(event) {
  if (event.reportId !== INPUT_REPORT_ID) return;
  const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
  const index = pendingResponses.findIndex(
    (pending) => bytes[0] === pending.family && bytes[1] === pending.command,
  );
  if (index < 0) return;
  const [pending] = pendingResponses.splice(index, 1);
  clearTimeout(pending.timer);
  pending.resolve(new Uint8Array(bytes));
}

async function command(bytes) {
  if (!device?.opened) throw new Error("The keyboard is not connected.");
  const payload = new Uint8Array(PAYLOAD_SIZE);
  payload.set(bytes);
  let pending;
  const responsePromise = new Promise((resolve, reject) => {
    pending = {
      family: bytes[0],
      command: bytes[1],
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = pendingResponses.indexOf(pending);
        if (index >= 0) pendingResponses.splice(index, 1);
        reject(new Error("Timed out waiting for the keyboard firmware response."));
      }, 3000),
    };
    pendingResponses.push(pending);
  });
  try {
    await device.sendReport(OUTPUT_REPORT_ID, payload);
  } catch (error) {
    clearTimeout(pending.timer);
    const index = pendingResponses.indexOf(pending);
    if (index >= 0) pendingResponses.splice(index, 1);
    throw error;
  }
  return responsePromise;
}

function requireMagic(response, operation) {
  if (response[4] !== 0xec || response[5] !== 0xac) {
    throw new Error(`${operation} failed: ${Array.from(response.slice(0, 6), hex).join(" ")}`);
  }
}

async function withConfigurationSession(callback) {
  requireMagic(await command([0xa0, 0xea, 0x5a, 0xa5]), "Entering configuration mode");
  let result;
  let primaryError = null;
  try {
    result = await callback();
  } catch (error) {
    primaryError = error;
  }
  try {
    requireMagic(await command([0xa0, 0xda, 0x5a, 0xa5]), "Leaving configuration mode");
  } catch (exitError) {
    if (!primaryError) primaryError = exitError;
  }
  if (primaryError) throw primaryError;
  return result;
}

async function queryRawInSession() {
  const response = await command([0xc1, 0x13]);
  const length = response[2] | (response[3] << 8);
  if (length !== 1 || response[5] !== 0) {
    throw new Error(`The keyboard rejected the layout query (length=${length}, status=${response[5]}).`);
  }
  return response[4];
}

async function querySettledInSession() {
  const delays = [0, 50, 100, 200, 400, 750, 1250];
  let raw = 0xff;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    raw = await queryRawInSession();
    if (VALID_LAYOUTS.has(raw)) return raw;
    if (raw !== 0xff) break;
  }
  throw new Error(`The keyboard returned unsupported layout value ${hex(raw)}.`);
}

async function queryLayout() {
  return withConfigurationSession(querySettledInSession);
}

async function setFamily(copilot) {
  return withConfigurationSession(async () => {
    const before = await querySettledInSession();
    const target = (before & 0x7f) | (copilot ? 0x80 : 0);
    if (before === target) return { before, after: before, changed: false };

    const response = await command([0xc1, 0x12, 0x01, 0x00, target]);
    if (response[4] !== 0xec || response[5] !== 0xac) {
      const reasons = {
        1: "configuration session is locked",
        2: "unsupported command",
        3: "malformed request",
        4: "invalid layout value",
        5: "flash erase/write failed",
      };
      throw new Error(`The keyboard rejected the layout change: ${reasons[response[5]] ?? `status ${response[5]}`}.`);
    }
    const after = await querySettledInSession();
    if (after !== target) {
      throw new Error(`Layout verification failed: wrote ${hex(target)}, read back ${hex(after)}.`);
    }
    return { before, after, changed: true };
  });
}

function showLayout(raw) {
  currentLayout = raw;
  const id = raw & 0x7f;
  elements.mode.textContent = raw & 0x80 ? "Copilot (Win + Shift + F23)" : "Legacy (Right Ctrl)";
  elements.raw.textContent = `${hex(raw)} · regional/SKU ID ${id}`;
  render();
}

async function runBusy(message, operation) {
  setBusy(true);
  setStatus(message);
  try {
    return await operation();
  } catch (error) {
    setStatus(error?.message ?? String(error), true);
    throw error;
  } finally {
    setBusy(false);
  }
}

async function connect() {
  if (!("hid" in navigator)) {
    setStatus("WebHID is unavailable. Use current Chrome or Edge on localhost/HTTPS.", true);
    return;
  }
  try {
    await runBusy("Waiting for Chrome's device picker…", async () => {
      const devices = await navigator.hid.requestDevice({
        filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE, usage: USAGE }],
      });
      if (!devices.length) throw new Error("No keyboard was selected.");
      if (device?.opened) await device.close();
      device = devices[0];
      await device.open();
      device.addEventListener("inputreport", handleInputReport);
      currentLayout = null;
      elements.device.textContent = device.productName || `ASUS ${VID.toString(16)}:${PID.toString(16)}`;
      const raw = await queryLayout();
      showLayout(raw);
      setStatus("Connected and queried. No persistent data was changed.");
    });
  } catch (_) {
    // runBusy already displayed the useful error.
  }
}

async function refresh() {
  try {
    await runBusy("Querying the keyboard…", async () => {
      showLayout(await queryLayout());
      setStatus("Layout read successfully. No persistent data was changed.");
    });
  } catch (_) {}
}

async function applyFamily(copilot) {
  const name = copilot ? "Copilot (Win + Shift + F23)" : "Legacy (Right Ctrl)";
  if (!window.confirm(`Change the keyboard to ${name}?\n\nThe regional/SKU ID will be preserved.`)) return;
  try {
    await runBusy(`Changing to ${name}… Do not disconnect the keyboard.`, async () => {
      const result = await setFamily(copilot);
      showLayout(result.after);
      setStatus(
        result.changed
          ? `Changed and verified: ${hex(result.before)} → ${hex(result.after)}.`
          : "That family was already active; nothing was written.",
      );
    });
  } catch (_) {}
}

elements.connect.addEventListener("click", connect);
elements.refresh.addEventListener("click", refresh);
elements.legacy.addEventListener("click", () => applyFamily(false));
elements.copilot.addEventListener("click", () => applyFamily(true));

if ("hid" in navigator) {
  navigator.hid.addEventListener("disconnect", (event) => {
    if (event.device !== device) return;
    device = null;
    currentLayout = null;
    elements.device.textContent = "Disconnected";
    elements.mode.textContent = "Not queried";
    elements.raw.textContent = "—";
    setStatus("The keyboard was disconnected.", true);
    render();
  });
} else {
  setStatus("WebHID is unavailable. Use current Chrome or Edge on localhost/HTTPS.", true);
}

render();
