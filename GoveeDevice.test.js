import {encode, decode} from "@SignalRGB/base64";
import udp from "@SignalRGB/udp";

const PROTOCOL_SINGLE_COLOR = 3;

// Cold boot / recovery tuning. See the comment in the constructor.
const BOOT_WINDOW_MS       = 90 * 1000;  // treat the first 90s as "coming up"
const ARM_INTERVAL_BOOT_MS = 2 * 1000;   // re-send power + razer this often while booting
const ARM_INTERVAL_IDLE_MS = 30 * 1000;  // ...and this often once settled
const STATUS_FRESH_MS      = 30 * 1000;  // a status reply is trusted for this long
const STATUS_POLL_MS       = 10 * 1000;  // how often to ask for status
const DEVICE_DATA_RETRY_MS = 10 * 1000;  // retry metadata fetch while id is unknown
const SOCKET_RECYCLE_MS    = 20 * 1000;  // recycle a reply-less socket this often during boot
const DEVICE_DATA_MAX_MS   = 60 * 60 * 1000;

const GRADIENT_OFF_SKUS = [
    "H610A",
    "H6056",
    "H6047",
    "H610B",
    "H6046",
    "H6608",
    "H6609",
    "H606A",
    "H6065",
    "H6066",
    "H6067",
    "H6061",
    "H6043",
    "H6042",
    "H70BC",
    "H6063",
    "H6069",
    "H8069"
];

export default class GoveeDevice
{
    constructor(data)
    {
        if (data)
        {
            this.id = (data.hasOwnProperty('id')) ? data.id : null;
            this.ip = data.ip;
            this.leds = parseInt(data.leds);
            this.type = parseInt(data.type);
            this.split = data.split ? parseInt(data.split) : 1;
            this.sku = data.hasOwnProperty('sku') ? data.sku : null;
            this.firmware = data.hasOwnProperty('bleVersionSoft') ? data.bleVersionSoft : null;
            this.name = (data.hasOwnProperty('name')) ? data.name : this.generateName();
            this.uniquePort = (data.hasOwnProperty('uniquePort') ? data.uniquePort : null);
        }

        this.testMode = (!this.id);
        
        this.onOff = 0;
        this.pt = null;
        this.port = 4003;
        this.statusPort = 4001;
        this.enabled = true;

        this.razerOn = false;

        this.lastRender = 0;
        this.lastStatus = 0;
        this.lastDeviceDataCheck = 0;
        this.lastSingleColor = '';

        this.hasChanged = false;

        this.forceStatusUpdate = false;
        this.waitingForStatusUpdate = false;
        this.waitingForDeviceUpdate = false;

        this.shuttingDown = false;

        // --- COLD BOOT FIX -------------------------------------------------
        // The stock plugin refuses to send colour frames until a `status`
        // reply has come back saying onOff == 1. That reply arrives on UDP
        // 4002, which the *discovery service* owns, and has to be relayed to
        // this instance over loopback. At cold boot that relay frequently
        // never completes (adapter not up when 4002 was bound, firewall still
        // treating the network as unidentified, device not yet answering),
        // and because `waitingForStatusUpdate` also gates turnOn() and the
        // razer-enable, nothing is ever sent and the device sits dark until
        // you toggle it in the UI.
        //
        // Fix: colour frames are never gated on the handshake. Power and
        // razer-mode are re-armed on a timer, aggressively right after start
        // and steadily afterwards, and status replies are treated as an
        // optimisation rather than a precondition.
        this.startedAt = Date.now();
        this.lastStatusRequest = 0;
        this.lastStatusReply = 0;    // 0 == we have never heard from this device
        this.lastTurnOn = 0;
        this.lastRazerArm = 0;
        this.lastSocketRecycle = 0;
        this.armedLogged = false;
    }

    // How long a status reply is considered to still describe the device.
    statusIsFresh(now)
    {
        return this.lastStatusReply !== 0 && (now - this.lastStatusReply) < STATUS_FRESH_MS;
    }

    // Fast re-arm right after startup / resume, relaxed cadence afterwards.
    armInterval(now)
    {
        return ((now - this.startedAt) < BOOT_WINDOW_MS) ? ARM_INTERVAL_BOOT_MS : ARM_INTERVAL_IDLE_MS;
    }

    handleSocketMessage(message)
    {
        try
        {
            let goveeResponse = JSON.parse(message.data);
            if (goveeResponse.hasOwnProperty('msg'))
            {
                switch(goveeResponse.msg.cmd)
                {
                    case 'scan':
                        this.update(goveeResponse.msg.data);
                        break;
                    case 'status':
                    case 'devStatus':
                        this.updateStatus(goveeResponse.msg.data);
                        break;
                    case 'disconnect':
                        this.disconnectSocket();
                        break;
                    default:
                        this.log('Received unknown command');
                        this.log(message.data);
                        break;
                }
            }
        } catch(err)
        {
            this.log(err.message);
        }
    }

    handleSocketError(errorId, errorMessage)
    {
        this.log('Device socket error: ' + errorMessage);

        // A socket that has errored can be permanently dead - typical right
        // after boot when it was created before the network stack was ready.
        // Drop it so sendRGB rebuilds a fresh one (with the bind backoff).
        try { if (this.udpServer) this.udpServer.close(); } catch(ex) { /* already gone */ }
        this.udpServer = null;
    }

    handleListening()
    {
        const address = this.udpServer.address();
        this.log(`Started listening on`);
        this.log(address);
    }

    handleConnection()
    {
        // this.log('Connected to');
        // this.log(this.udpServer.remoteAddress());
    }

    disconnectSocket()
    {
        this.udpServer.close();
        this.udpServer = null;
    }

    setupUdpServer()
    {
        if (!this.uniquePort) return;
        if (this.udpServer) return;

        // Don't hammer the bind on every single frame if it keeps failing.
        const now = Date.now();
        if (this.lastBindAttempt && (now - this.lastBindAttempt) < 5000) return;
        this.lastBindAttempt = now;

        try
        {
            this.udpServer = udp.createSocket();
            this.udpServer.on('message', this.handleSocketMessage.bind(this));
            this.udpServer.on('error', this.handleSocketError.bind(this));
            this.udpServer.on('listening', this.handleListening.bind(this));

            this.log('Trying to bind UDP port ' + this.uniquePort);

            // Listen to this device specific port
            this.udpServer.bind(this.uniquePort);
        } catch(ex)
        {
            this.log('Could not bind UDP port ' + this.uniquePort + ': ' + ex.message);
            this.udpServer = null;
        }
    }

    stopUdpServer()
    {
        if (this.udpServer)
        {
            this.udpServer.disconnect();
		    this.udpServer.close();
            this.udpServer = false;
        }
    }

    save()
    {
        if (this.id)
        {
            // Create a new setting specifically for that device
            service.saveSetting(this.id, 'ip', this.ip);
            service.saveSetting(this.id, 'leds', this.leds);
            service.saveSetting(this.id, 'type', this.type);
            service.saveSetting(this.id, 'split', this.split);
            service.saveSetting(this.id, 'sku', this.sku);
            service.saveSetting(this.id, 'firmware', this.firmware);
            service.saveSetting(this.id, 'name', this.name);
            service.saveSetting(this.id, 'uniquePort', this.uniquePort);

            this.log('Saved device');
            this.printDetails(service);
        } else
        {
            this.log('Data not yet received by device, saving device data later');
        }

        return this;
    }

    log(text)
    {
        if (typeof service !== 'undefined')
        {
            service.log(text);
        } else
        {
            device.log(text)
        }
    }

    toCacheJSON()
    {
        return {
            id: this.id,
            ip: this.ip,
            name: this.name,
            leds: this.leds,
            type: this.type,
            split: this.split,
            uniquePort: this.uniquePort
        };
    }

    load(id)
    {
        this.id         = id;
        this.ip         = service.getSetting(id, 'ip');
        this.leds       = service.getSetting(id, 'leds');
        this.type       = service.getSetting(id, 'type');
        this.split      = service.getSetting(id, 'split');
        this.sku        = service.getSetting(id, 'sku');
        this.firmware   = service.getSetting(id, 'firmware');
        this.name       = service.getSetting(id, 'name');
        this.uniquePort = service.getSetting(id, 'uniquePort');

        this.log('Loaded device');
        this.printDetails(service);

        return this;
    }

    update(receivedData)
    {
        let hasChanged = false;
        
        if (this.id !== receivedData.device)
        {
            this.id = receivedData.device;
            hasChanged = true;
        }

        if (this.sku !== receivedData.sku)
        {
            this.sku = receivedData.sku;
            hasChanged = true;
        }

        if (this.firmware !== receivedData.bleVersionSoft)
        {
            this.firmware = receivedData.bleVersionSoft;
            hasChanged = true;
        }
        
        if (hasChanged)
        {
            this.name       = this.generateName();
            this.testMode   = false;
            this.hasChanged = hasChanged;
        }

        this.waitingForDeviceUpdate = false;
    }

    updateStatus(receivedData)
    {
        if (this.onOff !== receivedData.onOff)
        {
            this.log(`Changed onOff from ${this.onOff} to ${receivedData.onOff}`);
            this.onOff = receivedData.onOff;
        }

        if (this.pt !== receivedData.pt)
        {
            this.pt = receivedData.pt;
            this.decodePTData(receivedData.pt);
        }

        this.waitingForStatusUpdate = false;
        this.lastStatus = Date.now();
        this.lastStatusReply = Date.now();
    }

    generateName()
    {
        return `Govee ${this.sku ? this.sku : 'device'} on ${this.ip}`;
    }

    getName()
    {
        return this.name;
    }

    printDetails(logger)
    {
        logger.log(`Name: ${this.name}`);
        logger.log(`SKU: ${this.sku}`);
        logger.log(`Firmware: ${this.firmware}`);
        logger.log(`IP address: ${this.ip}`);
        logger.log(`Total LED count: ${this.leds}`);
        switch(this.type)
        {
            // Dreamview mode
            case 1:
                logger.log(`Protocol: Dreamview`);
                break;
            case 2:
                logger.log(`Protocol: Razer`);
                break;
            case 3:
                logger.log(`Protocol: Solid color`);
                break;
            case 4:
                logger.log(`Protocol: Legacy Razer protocol`);
                break;
        }
        switch(this.split)
        {
            case 1:
                logger.log(`Split: Single logger`);
                break;
            case 2:
                logger.log(`Split: Mirrored`);
                break;
            case 3:
                logger.log(`Split: Two devices`);
                break;
            case 4:
                logger.log(`Split: Custom components`);
                break;
        }
    }

    decodePTData(pt)
    {
        if (pt !== null)
        {
            const byteArrayPt = decode(pt);
            if (byteArrayPt[3] == 0xb2)
            {
                this.razerOn = (byteArrayPt[4] == 0x01) ? true : false;
                if (this.razerOn)
                {
                    this.log('Razer mode is on: ' + pt);
                } else
                {
                    this.log('Razer mode is off: ' + pt);
                }
            } else
            {
                this.log('PT is weird: ' + pt);
            }
        }
    }

    // Fire-and-forget. We no longer block anything on the answer coming back,
    // because on a cold boot it often does not.
    getStatus(now)
    {
        this.lastStatus = now;
        this.lastStatusRequest = now;
        this.waitingForStatusUpdate = false;

        const statusPacket = { msg: { cmd: "status", data: {} } };
        this.send(statusPacket);
    }

    requestDeviceData(now)
    {
        this.lastDeviceDataCheck = now;
        this.waitingForDeviceUpdate = false;

        const deviceDataRequestPacket = {msg: { cmd: 'scan', data: {account_topic: 'reserve'} }};
        this.send(deviceDataRequestPacket, this.statusPort)
    }

    getGradientOff()
    {
        if (this.sku === null) return 1;
        return (GRADIENT_OFF_SKUS.includes(this.sku)) ? 0 : 1;
    }

    getRazerModeCommand(enable)
    {
        let command = encode([0xBB, 0x00, 0x01, 0xB1, enable, enable ? 0x0A : 0x0B]);
        return { msg: { cmd: "razer", data: { pt: command } } };
    }

    getColorCommand(colors)
    {
        let command = {};

        switch(this.type)
        {
            // Dreamview mode
            case 1:
                command = this.getDreamViewCommand(colors);
                break;
            case 2:
                command = this.getRazerCommand(colors);
                break;
            case 3:
                command = this.getSolidColorCommand(colors);
                break;
            case 4:
                command = this.getRazerLegacyCommand(colors);
                break;
            case 5:
                command = this.getDreamViewV2Command(colors);
                break;
        }
        
        return { msg: command };
    }

    getDreamViewV2Command(colors)
    {
        let collection = [
            this.getGradientOff(),
            colors.length,
        ];
        
        for (let c = 0; c < colors.length; c++)
        {
            let color = colors[c];
            collection = collection.concat(color);

            if (c < 36)
            {
                collection.push(1);
            } else
            {
                collection.push(2);
            }
        }

        let dreamViewHeader = [
            0xBB,
            (collection.length >> 8 & 0xFF),
            (collection.length & 0xFF),
            0xB4,
        ];

        let colorsCommand = dreamViewHeader.concat(collection);
        colorsCommand.push( this.calculateXorChecksum(colorsCommand) );

        return {cmd: "razer", data: { pt: encode(colorsCommand) } };
    }

    getDreamViewCommand(colors)
    {
        let collection = [
            this.getGradientOff(),
            colors.length,
        ];
        
        for (let c = 0; c < colors.length; c++)
        {
            let color = colors[c];
            collection = collection.concat(color);
        }

        let dreamViewHeader = [
            0xBB,
            (collection.length >> 8 & 0xFF),
            (collection.length & 0xFF),
            0xB0,
        ];

        let colorsCommand = dreamViewHeader.concat(collection);
        colorsCommand.push( this.calculateXorChecksum(colorsCommand) );

        return {cmd: "razer", data: { pt: encode(colorsCommand) } };
    }

    getRazerCommand(colors)
    {
        let razerHeader = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length];
        
        let colorsCommand = razerHeader;
        for(let c = 0; c < colors.length; c++)
        {
            // Color is an [r,g,b] array
            let color = colors[c];
            colorsCommand = colorsCommand.concat(color);
        }

        // Add razer checksum
        colorsCommand.push( this.calculateXorChecksum(colorsCommand) );
        // colorsCommand.push(0);

        return {cmd: "razer", data: { pt: encode(colorsCommand) } };
    }

    getRazerLegacyCommand(colors)
    {
        let razerHeader = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length];
        
        let colorsCommand = razerHeader;
        for(let c = 0; c < colors.length; c++)
        {
            // Color is an [r,g,b] array
            let color = colors[c];
            colorsCommand = colorsCommand.concat(color);
        }

        // Add razer checksum
        colorsCommand.push(0);

        return {cmd: "razer", data: { pt: encode(colorsCommand) } };
    }

    getSolidColorCommand(colors)
    {
        let color = colors[0];
        return {
            cmd: "colorwc",
            data: {
                color: {r: color[0], g: color[1], b: color[2]},
                colorTemInKelvin: 0
            }
        }
        
    }

    calculateXorChecksum(packet) {
        let checksum = 0;
        for (let i = 0; i < packet.length; i++) {
          checksum ^= packet[i];
        }
        return checksum;
    }

    sendRGB(colors, now, frameDelay)
    {
        if (this.shuttingDown) return;
        if (!this.enabled) return;

        // The socket can fail to bind at boot; keep trying rather than going
        // permanently mute.
        if (!this.udpServer)
        {
            this.setupUdpServer();
            if (!this.udpServer) return;
        }

        // A socket created before the network was ready can also be silently
        // dead: bound, no error event, packets going nowhere. If we have never
        // heard a single reply and we're still in the boot window, recycle it
        // periodically - a healthy device answers the status poll within a
        // couple of seconds, so a fresh socket that works stops this quickly.
        if (this.lastStatusReply === 0 && (now - this.startedAt) < BOOT_WINDOW_MS)
        {
            if (this.lastSocketRecycle === 0) this.lastSocketRecycle = this.startedAt;
            if ((now - this.lastSocketRecycle) > SOCKET_RECYCLE_MS)
            {
                this.lastSocketRecycle = now;
                this.log('No replies yet, recycling device socket');
                try { if (this.udpServer) this.udpServer.close(); } catch(ex) { /* already gone */ }
                this.udpServer = null;
                this.lastBindAttempt = 0;
                this.setupUdpServer();
                if (!this.udpServer) return;
            }
        }

        if (this.split == 2)
        {
            colors = colors.concat(colors);
        }

        // --- metadata (id / sku / firmware). Never blocks rendering. --------
        if (this.id == null)
        {
            if (now - this.lastDeviceDataCheck > DEVICE_DATA_RETRY_MS) this.requestDeviceData(now);
        }
        else if (now - this.lastDeviceDataCheck > DEVICE_DATA_MAX_MS)
        {
            this.requestDeviceData(now);
        }

        // --- status poll. Also never blocks rendering. ----------------------
        if (this.forceStatusUpdate)
        {
            this.forceStatusUpdate = false;
            this.getStatus(now);
        }
        else if (now - this.lastStatusRequest > STATUS_POLL_MS)
        {
            this.getStatus(now);
        }

        // --- arm the device -------------------------------------------------
        // If we have a fresh status reply we trust it. If we have never heard
        // back (the cold boot case, and the H6076's fixed-port-4002 quirk) we
        // assume the device needs both the power nudge and razer mode, and we
        // keep re-sending on a timer until something changes.
        const fresh    = this.statusIsFresh(now);
        const interval = this.armInterval(now);

        const needsPower = fresh ? !this.onOff : true;
        const needsRazer = (this.type !== PROTOCOL_SINGLE_COLOR) && (fresh ? !this.razerOn : true);

        if (needsPower && (now - this.lastTurnOn) > interval)
        {
            this.lastTurnOn = now;
            this.turnOn();
            this.forceStatusUpdate = true;
        }

        if (needsRazer && (now - this.lastRazerArm) > interval)
        {
            this.lastRazerArm = now;
            this.send(this.getRazerModeCommand(true));
            this.forceStatusUpdate = true;
        }

        if (!this.armedLogged && fresh && this.onOff)
        {
            this.armedLogged = true;
            this.log('Device armed and streaming');
        }

        // --- always stream colour -------------------------------------------
        // Unconditional. A device that is off ignores these frames, and the
        // turn-on above is already in flight; waiting for confirmation is what
        // caused the dead-at-boot behaviour in the first place.
        try
        {
            let colorCommand = this.getColorCommand(colors);
            this.send(colorCommand);
        } catch(ex)
        {
            device.error(ex.message);
            device.error(colors);
        }

        this.lastRender = now;

        frameDelay = parseInt(frameDelay);
        if (frameDelay > 0)
        {
            device.pause(frameDelay);
        }
    }

    singleColor(color, now, shutDown)
    {
        if (now - this.lastRender > 10000 || shutDown)
        {
            // Turn off Razer mode
            if (this.razerOn)
            {
                this.log('Sending `razer off` command');
                this.send(this.getRazerModeCommand(false));
            }

            if (!shutDown)
            {
                this.getStatus(0);
            }

            this.lastRender = now;
        }

        let jsonColor = JSON.stringify(color);
        if (jsonColor !== this.lastSingleColor || shutDown)
        {
            this.lastSingleColor = jsonColor;
            let colorCommand = this.getSolidColorCommand([color]);
            this.log('Sending new color code ' + JSON.stringify(colorCommand));
            this.send({msg: colorCommand});
        }
    }

    send(command, port)
    {
        if (!this.udpServer) return;

        try
        {
            this.udpServer.write(command, this.ip, port ? port : this.port);
        } catch(ex)
        {
            // A write failure used to escape into Render() and take the whole
            // device down. Drop the socket instead and let it be rebuilt.
            this.log('UDP write failed: ' + ex.message);
            this.udpServer = null;
        }
    }

    turnOffRazer()
    {
        this.send(this.getRazerModeCommand(false));
        this.razerOn = false;
        this.pt = null;
    }

    turnOff()
    {
        // Set to shutdown mode so no new packets are being sent
        this.shuttingDown = true;
        
        // Turn device off
        // Maybe force it a little? :)
        this.send({ msg: { cmd: "turn", data: { value: 0 } } });
        this.send({ msg: { cmd: "turn", data: { value: 0 } } });
        this.send({ msg: { cmd: "turn", data: { value: 0 } } });
        this.send({ msg: { cmd: "turn", data: { value: 0 } } });
        this.send({ msg: { cmd: "turn", data: { value: 0 } } });
        this.send({ msg: { cmd: "turn", data: { value: 0 } } });

        this.turnOffRazer();
        this.turnOffRazer();
    }

    turnOn()
    {
        this.send({ msg: { cmd: "turn", data: { value: 1 } } });
    }
}