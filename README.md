# Govee Direct Connect (Cold Boot Fix)

Fork of [fu-raz/signalrgb-govee-direct-connect](https://github.com/fu-raz/signalrgb-govee-direct-connect),
patched so Govee LAN devices come up **with the rest of the PC** instead of sitting dark until you
disable and re-enable them in SignalRGB.

Target hardware: **Govee H6056** Flow Plus light bars (DreamView protocol) and **H6076** RGBICW
corner floor lamp.

## The bug this fixes

The stock plugin will not send a single colour frame until it has received a `status` reply from the
device saying `onOff == 1`.

That reply is awkward to get. Govee firmware answers LAN requests on a **fixed UDP port 4002**,
regardless of which port the request came from. Port 4002 is owned by the plugin's *discovery
service*, which then has to relay the payload over loopback to the *rendering* instance on a
per-device port. Three things have to line up for a device to ever light: 4002 bound successfully,
the per-device port bound successfully, and the relay landing.

At cold boot they frequently do not line up. The network adapter is often not ready when SignalRGB
binds 4002, Windows may still be classifying the network, and there is no retry anywhere in the
stock code: `startSocketServer()` guards on `if (!this.udpServer)`, so once the socket object exists
a failed bind is never retried.

It then deadlocks. In `sendRGB`, the same `waitingForStatusUpdate` flag that is waiting on the reply
*also* gates `turnOn()` and the razer-mode enable:

```js
if (!this.onOff && !this.waitingForStatusUpdate) { this.turnOn(); ... }
if (!this.razerOn && !this.waitingForStatusUpdate) { this.send(this.getRazerModeCommand(true)); ... }
if (this.onOff) { /* only here are colours sent */ }
```

No reply means no `onOff`, which means no power command, no razer enable, and no colour. Forever.
Toggling the device in the UI tears down and rebuilds every socket, which is why that has always
been the workaround.

## What changed

**Colour frames are never gated on the handshake.** Status replies are now an optimisation, not a
precondition. A device that is off ignores DreamView frames anyway, and the power command is already
in flight.

**Power and razer mode are re-armed on a timer.** Every 2 seconds for the first 90 seconds after the
device starts, then every 30 seconds. If a fresh status reply (within 30s) confirms the device is on
and razer mode is active, the re-arm stops. If we have never heard back, it keeps nudging. This also
recovers a device that silently drops out of razer mode mid-session.

**The discovery socket retries.** Binding 4002 is wrapped in try/catch with a 5-second backoff, and
if 4002 has been bound but no Govee traffic has arrived for 60 seconds while controllers exist, the
socket is torn down and rebound. That is the case where the boot-time bind silently did not take.

**Per-device sockets retry too**, and a failed UDP write drops the socket for rebuild instead of
throwing out of `Render()` and taking the device down with it.

### Behaviour verified

A harness drives the render loop against a stubbed SignalRGB UDP module:

| Scenario | Expected | Result |
| --- | --- | --- |
| Device never replies (broken relay) | Streams colour anyway, keeps re-arming | 304 frames / 10s, 5 arms |
| Device confirms on + razer on | Streams colour, stops re-arming | 1 opening arm, then quiet |
| Device reports itself off | Keeps nudging power, keeps streaming | 5 turn-ons / 10s |
| 200 seconds elapsed | Arm cadence relaxes after 90s | 48 arms, not 100 |
| Socket bind throws | No crash, rebuilds when bind succeeds | passes |
| Single-colour protocol | Never arms razer | 0 arms |

## Install

SignalRGB git-validates and hard-resets marketplace addon files on every launch, so editing the
installed copy in place does not survive a restart. The patch has to be the `HEAD` of a repo you
install from.

1. Create a **public** GitHub repo, e.g. `signalrgb-govee-coldboot`.
2. Push the contents of this folder to it (`GoveeDirectConnect.js`, `GoveeDirectConnect.qml`, the
   three `*.test.js` modules, `govee-products.test.js`, `Components/`, `LICENSE`, `README.md`).
3. **Disable the original Govee Direct Connect addon first.** Both bind UDP 4002 and will fight.
4. Open `signalrgb://addon/install?url=https://github.com/<you>/signalrgb-govee-coldboot` and allow
   the install when SignalRGB prompts.

## Device settings

**H6056 Flow Plus bars** — Protocol `Dreamview`, Split `Duplicate`, LEDs = the count for *one* bar.
Reserve the bars' IP in your router; the plugin still keys controllers by IP.

**H6076 corner floor lamp** — start with Protocol `Single color` and 1 LED to confirm the lamp
responds at all, then try `Dreamview` with the segment count from the Govee app. Reports on this
model are mixed as to whether per-segment streaming works over the open LAN API; the always-stream
change here removes the handshake obstacle, which is the part that was definitely broken.

Both devices need **LAN Control** enabled in the Govee Home app, and light segments refreshed there
at least once.

## Troubleshooting

`signalrgb://view/logs` shows the plugin's log lines. Useful markers:

- `Trying to bind UDP port 4002` appearing repeatedly means the bind keeps failing; check that
  nothing else holds 4002 (another Govee integration on the same PC, an old copy of this addon).
- `No Govee traffic on 4002 for Ns, rebinding` means the socket was deaf and is being rebuilt.
- `Device armed and streaming` means a status reply confirmed the device is on with razer active.
- No `Device armed` line but the lights work anyway is fine: it means frames are landing without the
  status relay ever completing, which is exactly the case this fork is built to survive.
