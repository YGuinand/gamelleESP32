/* ==========================================================================
   Banc de diagnostic ESP32 - IUT de Cachan
   Logique de test + génération du rapport + reflashage automatique.
   Handshake SN + V + L avec polling et reset DTR/RTS de secours.
   ========================================================================== */

/* ----------------------------------------------------------------------
   Configuration
   ---------------------------------------------------------------------- */
const FIRMWARE_URL = "firmware.factory.bin";
const FIRMWARE_FLASH_ADDR = 0x0;
const ESPTOOL_CDN = "https://cdn.jsdelivr.net/npm/esptool-js@0.5.4/bundle.js";
const SN_TIMEOUT_MS = 4000;
const HANDSHAKE_TIMEOUT_MS = 2000;
const HANDSHAKE_POLL_MS = 400;
const POST_FLASH_DELAY_MS = 2500;
const AUTO_FLASH_RETRY_LIMIT = 1;

/* ----------------------------------------------------------------------
   Version attendue du firmware
   À SYNCHRONISER avec FIRMWARE_VERSION dans main.cpp
   ---------------------------------------------------------------------- */
const EXPECTED_FW_VERSION = "V0.3";

/* ----------------------------------------------------------------------
   Table des puces USB-série les plus fréquentes sur cartes ESP32
   ---------------------------------------------------------------------- */
const USB_CHIPS = [
    { vid: 0x10C4, pid: 0xEA60, name: "Silicon Labs CP2102" },
    { vid: 0x10C4, pid: 0xEA70, name: "Silicon Labs CP2105" },
    { vid: 0x10C4, pid: 0xEA71, name: "Silicon Labs CP2108" },
    { vid: 0x1A86, pid: 0x7523, name: "WCH CH340" },
    { vid: 0x1A86, pid: 0x55D4, name: "WCH CH9102" },
    { vid: 0x1A86, pid: 0x5523, name: "WCH CH341" },
    { vid: 0x0403, pid: 0x6001, name: "FTDI FT232R" },
    { vid: 0x0403, pid: 0x6015, name: "FTDI FT231X" },
    { vid: 0x303A, pid: 0x1001, name: "Espressif USB-Serial/JTAG" }
];

const ESP32_USB_FILTERS = [
    { usbVendorId: 0x10C4 },
    { usbVendorId: 0x1A86 },
    { usbVendorId: 0x0403 },
    { usbVendorId: 0x303A }
];

function describePort(port) {
    if (!port) return { label: "Aucun", isKnown: false };

    let info;
    try { info = port.getInfo(); }
    catch (e) { return { label: "Port (info indisponible)", isKnown: false }; }

    const vid = info.usbVendorId;
    const pid = info.usbProductId;

    if (vid === undefined || pid === undefined) {
        return { label: "Port série natif (sans info USB)", isKnown: false };
    }

    const hex = (v) => "0x" + v.toString(16).toUpperCase().padStart(4, "0");
    const match = USB_CHIPS.find(c => c.vid === vid && c.pid === pid);
    const chipName = match ? match.name : "Puce USB inconnue";

    return {
        label: `${chipName} [VID=${hex(vid)} PID=${hex(pid)}]`,
        vid: hex(vid),
        pid: hex(pid),
        chip: chipName,
        isKnown: !!match
    };
}

/* ----------------------------------------------------------------------
   Comparaison de versions "Vx.y" ou "Vx.y.z"
   ---------------------------------------------------------------------- */
function compareVersions(a, b) {
    const parse = v => (v || "").replace(/^V/i, "")
                               .split(/[.\-]/)
                               .map(s => parseInt(s, 10))
                               .filter(n => !isNaN(n));
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] ?? 0;
        const nb = pb[i] ?? 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
    }
    return 0;
}

/* ----------------------------------------------------------------------
   État global
   ---------------------------------------------------------------------- */
let port = null;
let reader = null;
let keepReading = false;
let inputBuffer = "";
let serialNumber = "INCONNU";
let currentStepIndex = 0;
let stepTimer = null;
let escalationTimer = null;

let snTimeoutHandle = null;
let handshakeTimeoutHandle = null;
let handshakePollHandle = null;
let autoFlashAttempts = 0;

let firmwareVersion = null;
let firmwareUpToDate = null;
let lcdType = null;
let stepsAdjustedForLcd = false;

let handshakeDone = false;

const reportResults = [];

/* ----------------------------------------------------------------------
   Télémétrie globale
   ---------------------------------------------------------------------- */
const BUTTONS = {
    1: { label: "Bouton Jaune", pressed: false, seenDown: false },
    2: { label: "Bouton Vert",  pressed: false, seenDown: false },
    3: { label: "Bouton Bleu",  pressed: false, seenDown: false },
    4: { label: "Bouton JACK",  pressed: false, seenDown: false },
    5: { label: "Fin de course (FDC)", pressed: false, seenDown: false }
};

const POT_PREFIXES = ["PA", "PB", "PC", "PD", "PE", "PF", "PG"];
const ADC_MAX = 4095;
const JUMP_THRESHOLD = 2500;
const POT_ACCEPT_MIN = 50;
const POT_ACCEPT_MAX = 4050;

const potState = {};
POT_PREFIXES.forEach(p => {
    potState[p] = {
        lastValue: null, min: null, max: null,
        changed: false, jumpCount: 0, jumpEvents: []
    };
});

const encoderState = {
    CA: { lastValue: null, baseline: null, moved: false, min: null, max: null },
    CB: { lastValue: null, baseline: null, moved: false, min: null, max: null }
};

/* ----------------------------------------------------------------------
   Définition des étapes (par défaut, avant adaptation au type d'écran)
   ---------------------------------------------------------------------- */
const steps = [
    {
        kind: "buttons-visual",
        title: "Test Boutons + LEDs + Rétroéclairage LCD",
        instruction: "Validez d'abord l'état de repos de l'écran, puis testez chaque bouton en vérifiant simultanément l'effet visuel (LED + couleur de l'écran LCD).",
        items: [
            { key: "repos", btnId: null, label: "Sans appui : l'écran est blanc et affiche 'IUT de Cachan' + le SN" },
            { key: "jaune", btnId: 1,    label: "Appui bouton JAUNE : la LED jaune s'allume ET l'écran devient jaune" },
            { key: "vert",  btnId: 2,    label: "Appui bouton VERT : la LED verte s'allume ET l'écran devient vert" },
            { key: "bleu",  btnId: 3,    label: "Appui bouton BLEU : l'écran devient bleu (pas de LED dédiée)" }
        ]
    },
    {
        kind: "buttons",
        title: "Test des Entrées de Sécurité (JACK & FDC)",
        instruction: "Appuyez sur le bouton JACK puis sur le bouton de fin de course FDC.",
        items: [4, 5]
    },
    {
        kind: "pot-single",
        title: "Test de Course Complète du Potentiomètre Principal (PA)",
        instruction: "Faites tourner le potentiomètre PA (IO25) sur toute sa course. Cible : min ≤ 50 et max ≥ 4050 sur 0..4095.",
        channel: "PA"
    },
    {
        kind: "pot-multi",
        title: "Test de Course Complète du Bus Analogique (PB à PG)",
        instruction: "Faites tourner CHACUN des potentiomètres PB, PC, PD, PE, PF et PG sur toute leur course. Cible : min ≤ 50 et max ≥ 4050 sur 0..4095.",
        channels: ["PB", "PC", "PD", "PE", "PF", "PG"]
    },
    {
        kind: "motor-encoder",
        title: "Pilotage Dynamique du Moteur A + Codeur A",
        instruction: "Le banc force un signal PWM à 50% sur IO26 (Moteur A). Le codeur A (IO17/18) doit compter automatiquement pendant la rotation.",
        motorCmd: "MA512", motorLabel: "Moteur A",
        encoderKey: "CA", encoderLabel: "Codeur A",
        timeoutMs: 4000, watchdog: false
    },
    {
        kind: "motor-encoder",
        title: "Pilotage Dynamique du Moteur B + Codeur B & Watchdog",
        instruction: "Le banc force un signal PWM à 50% sur IO27 (Moteur B). Le codeur B (IO19/13) doit compter. Le watchdog (arrêt après 1s sans commande) sera vérifié ensuite.",
        motorCmd: "MB512", motorLabel: "Moteur B",
        encoderKey: "CB", encoderLabel: "Codeur B",
        timeoutMs: 4000, watchdog: true
    }
];

/* ----------------------------------------------------------------------
   Références DOM
   ---------------------------------------------------------------------- */
const btnConnect    = document.getElementById('btnConnect');
const btnConnectAny = document.getElementById('btnConnectAny');
const btnDisconnect = document.getElementById('btnDisconnect');
const btnFlash      = document.getElementById('btnFlash');
const connStatus    = document.getElementById('connStatus');
const lblSN         = document.getElementById('lblSN');
const lblPort       = document.getElementById('lblPort');
const lblFwVersion  = document.getElementById('lblFwVersion');
const lblFwStatus   = document.getElementById('lblFwStatus');
const lblLcd        = document.getElementById('lblLcd');
const testZone      = document.getElementById('testZone');
const stepTitleEl   = document.getElementById('stepTitle');
const stepInstructionEl = document.getElementById('stepInstruction');
const stepLiveData  = document.getElementById('stepLiveData');
const manualActions = document.getElementById('manualActions');
const autoActions   = document.getElementById('autoActions');
const reportZone    = document.getElementById('reportZone');
const reportArea    = document.getElementById('reportArea');
const btnYes        = document.getElementById('btnYes');
const btnNo         = document.getElementById('btnNo');
const btnForceFail  = document.getElementById('btnForceFail');
const manualQuestion= document.getElementById('manualQuestion');

const flashOverlay     = document.getElementById('flashOverlay');
const flashMessage     = document.getElementById('flashMessage');
const flashProgressBar = document.getElementById('flashProgressBar');

btnConnect.addEventListener('click', () => connectSerial(false));
btnConnectAny.addEventListener('click', () => connectSerial(true));
btnDisconnect.addEventListener('click', disconnectSerial);
btnFlash.addEventListener('click', manualFlashRequest);
document.getElementById('btnTestAnother').addEventListener('click', testAnotherBoard);
btnForceFail.addEventListener('click', onForceFailClicked);
document.getElementById('btnDownloadReport').addEventListener('click', downloadReportFile);

/* ======================================================================
   Connexion / Déconnexion / Flash
   ====================================================================== */

async function connectSerial(allowAny, existingPort = null) {
    try {
        if (existingPort) {
            port = existingPort;
            console.log("Réutilisation d'un port existant :", describePort(port));
        } else {
            const known = await navigator.serial.getPorts();
            console.log("Ports déjà autorisés :", known.map(describePort));

            if (known.length === 1 && !allowAny) {
                port = known[0];
                console.log("Réutilisation automatique du port mémorisé :", describePort(port));
            } else {
                const opts = allowAny ? {} : { filters: ESP32_USB_FILTERS };
                port = await navigator.serial.requestPort(opts);
            }
        }

        const desc = describePort(port);
        lblPort.textContent = desc.label;
        lblPort.style.color = desc.isKnown ? "#28a745" : "#0056b3";
        console.log("Port sélectionné :", desc);

        await port.open({ baudRate: 115200 });

        connStatus.textContent = "Connecté (115200 Baud)";
        connStatus.style.color = "green";
        btnConnect.disabled = true;
        btnConnectAny.disabled = true;
        btnDisconnect.disabled = false;
        btnFlash.disabled = false;

        // Le testZone reste masqué jusqu'à ce que le handshake soit terminé
        // et que startStep() affiche le contenu de la première étape.
        // Comme ça, aucune étape fantôme n'apparaît pendant la connexion.
        reportZone.style.display = "none";

        // Arme le watchdog d'absence totale de réponse
        snTimeoutHandle = setTimeout(handleNoResponse, SN_TIMEOUT_MS);

        // Prépare le handshake (SN + V + L)
        handshakeDone = false;
        if (handshakeTimeoutHandle) { clearTimeout(handshakeTimeoutHandle); handshakeTimeoutHandle = null; }
        if (handshakePollHandle)    { clearInterval(handshakePollHandle);   handshakePollHandle = null; }

        // Réémission périodique tant que le handshake n'est pas terminé.
        setTimeout(() => {
            const pollOnce = () => {
                if (handshakeDone) return;
                sendCommand("SN");
                sendCommand("V");
                sendCommand("L");
            };
            pollOnce();
            handshakePollHandle = setInterval(pollOnce, HANDSHAKE_POLL_MS);
        }, 200);

        // Timeout global : tentative de reset matériel DTR/RTS
        handshakeTimeoutHandle = setTimeout(async () => {
            if (handshakeDone) return;
            console.warn("Handshake incomplet — tentative de reset matériel DTR/RTS…");

            try {
                await port.setSignals({ dataTerminalReady: false, requestToSend: true });
                await new Promise(r => setTimeout(r, 200));
                await port.setSignals({ dataTerminalReady: false, requestToSend: false });
            } catch (e) {
                console.warn("Reset DTR/RTS échoué :", e);
            }

            setTimeout(() => {
                if (!handshakeDone) {
                    console.warn("Démarrage du diagnostic en mode dégradé.");
                    maybeStartDiagnostic(true);
                }
            }, 1500);
        }, SN_TIMEOUT_MS + HANDSHAKE_TIMEOUT_MS);

        readSerialLoop();

    } catch (error) {
        console.error("Erreur de connexion série :", error);
        alert("Impossible d'accéder au port série : " + error);
        lblPort.textContent = "Aucun";
        lblPort.style.color = "#0056b3";
    }
}

async function closeSerialPort(keepPortRef = false) {
    keepReading = false;
    clearTimers();
    if (snTimeoutHandle)        { clearTimeout(snTimeoutHandle);        snTimeoutHandle = null; }
    if (handshakeTimeoutHandle) { clearTimeout(handshakeTimeoutHandle); handshakeTimeoutHandle = null; }
    if (handshakePollHandle)    { clearInterval(handshakePollHandle);   handshakePollHandle = null; }

    if (reader) {
        try { await reader.cancel(); } catch (e) { /* ignoré */ }
    }
    let waited = 0;
    while (reader && waited < 1000) {
        await new Promise(r => setTimeout(r, 20));
        waited += 20;
    }
    if (port) {
        try { await port.close(); } catch (e) { console.warn("Close port:", e); }
    }
    if (!keepPortRef) port = null;
    reader = null;
}

async function disconnectSerial() {
    await closeSerialPort();
    resetAllState();
    resetUIAfterDisconnect();
}

async function testAnotherBoard() {
    if (port) await closeSerialPort();
    resetAllState();
    resetUIAfterDisconnect();
    autoFlashAttempts = 0;
    await connectSerial(false);
}

function resetUIAfterDisconnect() {
    connStatus.textContent = "Déconnecté";
    connStatus.style.color = "red";
    btnConnect.disabled = false;
    btnConnectAny.disabled = false;
    btnDisconnect.disabled = true;
    btnFlash.disabled = true;
    testZone.style.display = "none";
    reportZone.style.display = "none";
    reportArea.style.display = "none";
    reportArea.textContent = "";
    lblPort.textContent = "Aucun";
    lblPort.style.color = "#0056b3";
    lblSN.textContent = "Lecture en cours... (Veuillez connecter la carte)";
    lblSN.style.color = "#dc3545";
    lblFwVersion.textContent = "—";
    lblFwVersion.style.color = "#dc3545";
    lblFwStatus.textContent = "";
    lblFwStatus.className = "";
    lblLcd.textContent = "—";
    lblLcd.style.color = "#dc3545";

    // Nettoie les textes résiduels pour éviter tout affichage fantôme
    // si le testZone redevenait visible par erreur.
    stepTitleEl.textContent = "Étape";
    stepInstructionEl.textContent = "...";
    stepLiveData.textContent = "Données en attente...";
}

function resetAllState() {
    serialNumber = "INCONNU";
    currentStepIndex = 0;
    reportResults.length = 0;
    inputBuffer = "";

    firmwareVersion = null;
    firmwareUpToDate = null;
    lcdType = null;
    stepsAdjustedForLcd = false;
    handshakeDone = false;

    if (handshakeTimeoutHandle) { clearTimeout(handshakeTimeoutHandle); handshakeTimeoutHandle = null; }
    if (handshakePollHandle)    { clearInterval(handshakePollHandle);   handshakePollHandle = null; }
    if (snTimeoutHandle)        { clearTimeout(snTimeoutHandle);        snTimeoutHandle = null; }

    Object.values(BUTTONS).forEach(b => { b.pressed = false; b.seenDown = false; });
    POT_PREFIXES.forEach(p => {
        const st = potState[p];
        st.lastValue = null; st.min = null; st.max = null;
        st.changed = false; st.jumpCount = 0; st.jumpEvents = [];
    });
    ["CA", "CB"].forEach(k => {
        const st = encoderState[k];
        st.lastValue = null; st.baseline = null; st.moved = false;
        st.min = null; st.max = null;
    });

    const step1 = steps.find(s => s.kind === "buttons-visual");
    if (step1) {
        step1.title = "Test Boutons + LEDs + Rétroéclairage LCD";
        step1.instruction = "Validez d'abord l'état de repos de l'écran, puis testez chaque bouton en vérifiant simultanément l'effet visuel (LED + couleur de l'écran LCD).";
        step1.items = [
            { key: "repos", btnId: null, label: "Sans appui : l'écran est blanc et affiche 'IUT de Cachan' + le SN" },
            { key: "jaune", btnId: 1,    label: "Appui bouton JAUNE : la LED jaune s'allume ET l'écran devient jaune" },
            { key: "vert",  btnId: 2,    label: "Appui bouton VERT : la LED verte s'allume ET l'écran devient vert" },
            { key: "bleu",  btnId: 3,    label: "Appui bouton BLEU : l'écran devient bleu (pas de LED dédiée)" }
        ];
    }

    steps.forEach(s => {
        s._subIndex = 0; s._subAnswers = {};
        s._escalated = false; s._escalationChoice = null; s._watchdogAnswer = null;
    });
}

async function readSerialLoop() {
    reader = port.readable.getReader();
    const textDecoder = new TextDecoder();
    keepReading = true;

    try {
        while (keepReading) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                inputBuffer += textDecoder.decode(value, { stream: true });
                const lines = inputBuffer.split("\n");
                inputBuffer = lines.pop();
                for (const line of lines) processIncomingLine(line.trim());
            }
        }
    } catch (error) {
        if (keepReading) console.error("Erreur de flux :", error);
    } finally {
        try { reader.releaseLock(); } catch (e) { /* ignoré */ }
        reader = null;
    }
}

async function sendCommand(cmdStr) {
    if (!port) return;
    try {
        const encoder = new TextEncoder();
        const writer = port.writable.getWriter();
        await writer.write(encoder.encode(cmdStr + "\n"));
        writer.releaseLock();
    } catch (e) {
        console.warn("sendCommand failed:", e);
    }
}

/* ----------------------------------------------------------------------
   Handshake : attend SN + V + L avant de démarrer le diagnostic
   ---------------------------------------------------------------------- */
async function maybeStartDiagnostic(force = false) {
    if (handshakeDone) return;

    const hasSn = serialNumber !== "INCONNU";
    const hasV  = firmwareVersion !== null;
    const hasL  = lcdType !== null;

    if (!force && !(hasSn && hasV && hasL)) return;

    handshakeDone = true;
    if (handshakeTimeoutHandle) { clearTimeout(handshakeTimeoutHandle); handshakeTimeoutHandle = null; }
    if (handshakePollHandle)    { clearInterval(handshakePollHandle);   handshakePollHandle = null; }

    if (hasSn) {
        await checkFirmwareFreshness();
    }

    if (!port || !keepReading) return;

    if (hasL) adjustStepsForLcd(lcdType);
    startStep(0);
}

/* ----------------------------------------------------------------------
   Contrôle de fraîcheur du firmware (après handshake)
   ---------------------------------------------------------------------- */
async function checkFirmwareFreshness() {
    if (serialNumber === "INCONNU") return;

    if (firmwareVersion !== null && firmwareUpToDate === false) {
        const userWantsFlash = confirm(
            `Le firmware de la carte est en version ${firmwareVersion}, ` +
            `mais la version attendue est ${EXPECTED_FW_VERSION}.\n\n` +
            `Voulez-vous mettre à jour le firmware maintenant ?\n\n` +
            `OUI = reflasher, NON = continuer avec la version actuelle ` +
            `(certains tests peuvent échouer).`
        );
        if (userWantsFlash) {
            await closeSerialPort(true);
            testZone.style.display = "none";
            await flashFirmwareAndRetry();
            return;
        }
        console.warn("Diagnostic lancé avec firmware obsolète : " + firmwareVersion);
        reportResults.push({
            title: "ATTENTION — Version firmware",
            status: "AVERTISSEMENT",
            lines: [
                `  - Version détectée : ${firmwareVersion}`,
                `  - Version attendue : ${EXPECTED_FW_VERSION}`,
                `  - L'opérateur a choisi de continuer malgré tout.`
            ]
        });
    } else if (firmwareVersion === null) {
        console.warn("Version firmware non reçue.");
        reportResults.push({
            title: "ATTENTION — Version firmware",
            status: "AVERTISSEMENT",
            lines: [
                "  - Aucune réponse à la commande V.",
                "  - Le firmware ne supporte probablement pas l'interrogation de version.",
                `  - Version attendue : ${EXPECTED_FW_VERSION}`
            ]
        });
    }
}

/* ----------------------------------------------------------------------
   Absence de réponse totale → proposition de reflashage
   ---------------------------------------------------------------------- */
async function handleNoResponse() {
    snTimeoutHandle = null;
    if (serialNumber !== "INCONNU") return;

    await closeSerialPort(true);
    autoActions.style.display = "none";
    testZone.style.display = "none";

    if (autoFlashAttempts >= AUTO_FLASH_RETRY_LIMIT) {
        alert("La carte ne répond toujours pas après reflashage. Vérifiez le câble USB, l'alimentation, ou testez une autre carte.");
        resetUIAfterDisconnect();
        return;
    }

    const userWantsFlash = confirm(
        "Aucune réponse de l'ESP32 (SN non reçu après " + (SN_TIMEOUT_MS / 1000) + " s).\n\n" +
        "La carte est peut-être vierge ou son firmware est corrompu.\n" +
        "Voulez-vous reflasher automatiquement '" + FIRMWARE_URL + "' ?\n\n" +
        "NB : sur les cartes sans auto-reset, il faudra maintenir BOOT + appuyer sur EN."
    );

    if (userWantsFlash) {
        autoFlashAttempts++;
        await flashFirmwareAndRetry();
    } else {
        resetUIAfterDisconnect();
    }
}

function manualFlashRequest() {
    if (!port) {
        alert("Connectez d'abord la carte.");
        return;
    }
    if (!confirm("Reflasher '" + FIRMWARE_URL + "' sur la carte actuellement connectée ?")) return;
    (async () => {
        await closeSerialPort(true);
        testZone.style.display = "none";
        await flashFirmwareAndRetry();
    })();
}

/* ----------------------------------------------------------------------
   Flashage via esptool-js
   ---------------------------------------------------------------------- */
function showFlashOverlay(msg, pct = null) {
    flashOverlay.classList.add("visible");
    flashMessage.textContent = msg;
    if (pct !== null) flashProgressBar.style.width = Math.round(pct) + "%";
}
function hideFlashOverlay() {
    flashOverlay.classList.remove("visible");
    flashProgressBar.style.width = "0%";
}

function arrayBufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        str += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return str;
}

async function flashFirmwareAndRetry() {
    const portToUse = port;
    if (!portToUse) {
        alert("Aucun port disponible pour le flashage.");
        return;
    }

    try {
        showFlashOverlay("Chargement du module esptool-js…", 0);

        const esptool = await import(ESPTOOL_CDN);
        const { ESPLoader, Transport } = esptool;

        showFlashOverlay("Téléchargement de " + FIRMWARE_URL + "…", 5);
        const resp = await fetch(FIRMWARE_URL + "?t=" + Date.now());
        if (!resp.ok) {
            throw new Error("Impossible de récupérer '" + FIRMWARE_URL +
                "' (HTTP " + resp.status + "). Vérifiez que le fichier est bien " +
                "dans le même dossier et que la page est servie en HTTP (pas file://).");
        }
        const arrayBuffer = await resp.arrayBuffer();
        const binaryString = arrayBufferToBinaryString(arrayBuffer);
        const sizeKo = Math.round(arrayBuffer.byteLength / 1024);
        showFlashOverlay(`Firmware chargé (${sizeKo} Ko). Ouverture du bootloader…`, 10);

        const transport = new Transport(portToUse, false);
        const loader = new ESPLoader({
            transport,
            baudrate: 921600,
            romBaudrate: 115200,
            terminal: {
                clean() {},
                writeLine(data) { console.log("[esp]", data); },
                write(data)     { console.log("[esp]", data); }
            }
        });

        const chip = await loader.main();
        showFlashOverlay(`Chip détecté : ${chip}. Effacement + écriture en cours…`, 15);

        await loader.writeFlash({
            fileArray: [{ data: binaryString, address: FIRMWARE_FLASH_ADDR }],
            flashSize: "keep",
            flashMode: "keep",
            flashFreq: "keep",
            eraseAll: false,
            compress: true,
            reportProgress: (_fileIndex, written, total) => {
                const pct = 15 + 80 * (written / total);
                showFlashOverlay(`Écriture… ${Math.round(100 * written / total)}%  (${written}/${total} octets)`, pct);
            },
            calculateMD5Hash: (image) =>
                CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)).toString()
        });

        showFlashOverlay("Redémarrage de la carte…", 98);
        try { await transport.disconnect(); } catch (e) { /* toléré */ }

        await new Promise(r => setTimeout(r, 500));

        try { await portToUse.close(); } catch (e) { /* ignoré */ }
        await new Promise(r => setTimeout(r, 300));
        await portToUse.open({ baudRate: 115200 });

        const sleep = (ms) => new Promise(res => setTimeout(res, ms));
        await portToUse.setSignals({ dataTerminalReady: false, requestToSend: true });
        await sleep(100);
        await portToUse.setSignals({ dataTerminalReady: true, requestToSend: false });
        await sleep(100);
        await portToUse.setSignals({ dataTerminalReady: false, requestToSend: false });
        await sleep(100);
        await portToUse.setSignals({ dataTerminalReady: true, requestToSend: true });
        await sleep(200);
        await portToUse.setSignals({ dataTerminalReady: false, requestToSend: false });

        try { await portToUse.close(); } catch (e) { /* ignoré */ }

        showFlashOverlay("Firmware reflashé ! Reconnexion dans " + (POST_FLASH_DELAY_MS / 1000) + " s…", 100);
        await new Promise(r => setTimeout(r, POST_FLASH_DELAY_MS));
        hideFlashOverlay();

        resetAllState();
        lblSN.textContent = "Lecture en cours... (Veuillez connecter la carte)";
        lblSN.style.color = "#dc3545";
        // On ne réaffiche pas testZone ici : c'est startStep() qui s'en charge
        // après le handshake, pour éviter d'afficher une étape fantôme.
        reportZone.style.display = "none";
        await connectSerial(false, portToUse);

    } catch (err) {
        hideFlashOverlay();
        console.error("Échec du flashage :", err);
        alert("Échec du flashage :\n" + (err && err.message ? err.message : err));
        resetUIAfterDisconnect();
    }
}

/* ======================================================================
   Traitement des trames entrantes
   ====================================================================== */
function processIncomingLine(line) {
    if (!line) return;

    // --- Numéro de série ---
    if (line.startsWith("SN")) {
        if (serialNumber === "INCONNU") {
            serialNumber = line.substring(2);
            lblSN.textContent = "SN" + serialNumber;
            lblSN.style.color = "#28a745";
            if (snTimeoutHandle) { clearTimeout(snTimeoutHandle); snTimeoutHandle = null; }
            maybeStartDiagnostic();
        }
        return;
    }

    // --- Version firmware ---
    if (line[0] === "V" && /^V[0-9]/.test(line)) {
        if (firmwareVersion === null) {
            firmwareVersion = line;
            lblFwVersion.textContent = firmwareVersion;

            const cmp = compareVersions(firmwareVersion, EXPECTED_FW_VERSION);
            if (cmp < 0) {
                firmwareUpToDate = false;
                lblFwVersion.style.color = "#dc3545";
                lblFwStatus.textContent = `(obsolète — attendu ${EXPECTED_FW_VERSION})`;
                lblFwStatus.className = "outdated";
                console.warn("Firmware obsolète : " + firmwareVersion + " < " + EXPECTED_FW_VERSION);
            } else if (cmp === 0) {
                firmwareUpToDate = true;
                lblFwVersion.style.color = "#28a745";
                lblFwStatus.textContent = "(à jour)";
                lblFwStatus.className = "uptodate";
            } else {
                firmwareUpToDate = true;
                lblFwVersion.style.color = "#28a745";
                lblFwStatus.textContent = `(plus récent que ${EXPECTED_FW_VERSION})`;
                lblFwStatus.className = "uptodate";
            }
            maybeStartDiagnostic();
        }
        return;
    }

    // --- Type d'écran ---
    if (line[0] === "L" && line.length === 2 && /[0-2]/.test(line[1])) {
        if (lcdType === null) {
            lcdType = parseInt(line[1], 10);
            const labels = {
                0: "Aucun écran (L0)",
                1: "Écran LCD monochrome (L1)",
                2: "Écran LCD avec rétroéclairage RGB (L2)"
            };
            lblLcd.textContent = labels[lcdType] || ("Type inconnu (" + lcdType + ")");
            lblLcd.style.color = (lcdType === 0) ? "#dc3545" : "#28a745";
            adjustStepsForLcd(lcdType);
            maybeStartDiagnostic();
        }
        return;
    }

    // --- Boutons "D<id>" / "U<id>" ---
    if ((line[0] === "D" || line[0] === "U") && BUTTONS[line.substring(1)]) {
        const id = line.substring(1);
        if (line[0] === "D") { BUTTONS[id].pressed = true; BUTTONS[id].seenDown = true; }
        else                 { BUTTONS[id].pressed = false; }
        refreshLiveStatus(); checkAutoAdvance();
        return;
    }

    // --- Potentiomètres ---
    for (const prefix of POT_PREFIXES) {
        if (line.startsWith(prefix)) {
            const value = parseInt(line.substring(prefix.length), 10);
            if (!isNaN(value)) { updatePotState(prefix, value); refreshLiveStatus(); checkAutoAdvance(); }
            return;
        }
    }

    // --- Codeurs ---
    for (const key of ["CA", "CB"]) {
        if (line.startsWith(key)) {
            const value = parseInt(line.substring(key.length), 10);
            if (!isNaN(value)) { updateEncoderState(key, value); refreshLiveStatus(); checkAutoAdvance(); }
            return;
        }
    }
}

function updatePotState(prefix, value) {
    const st = potState[prefix];
    if (st.lastValue !== null) {
        const delta = Math.abs(value - st.lastValue);
        if (delta >= JUMP_THRESHOLD) {
            st.jumpCount++;
            st.jumpEvents.push(`${st.lastValue} -> ${value}`);
        }
        if (value !== st.lastValue) st.changed = true;
    }
    st.min = (st.min === null) ? value : Math.min(st.min, value);
    st.max = (st.max === null) ? value : Math.max(st.max, value);
    st.lastValue = value;
}

function updateEncoderState(key, value) {
    const st = encoderState[key];
    if (st.baseline === null) st.baseline = value;
    if (value !== st.baseline) st.moved = true;
    st.min = (st.min === null) ? value : Math.min(st.min, value);
    st.max = (st.max === null) ? value : Math.max(st.max, value);
    st.lastValue = value;
}

/* ======================================================================
   Adaptation des étapes au type d'écran détecté
   ====================================================================== */
function adjustStepsForLcd(type) {
    if (stepsAdjustedForLcd) return;
    stepsAdjustedForLcd = true;

    const step = steps.find(s => s.kind === "buttons-visual");
    if (!step) return;

    if (type === 0) {
        // Aucun écran : le bouton bleu n'a pas d'effet visuel, mais on
        // vérifie quand même sa détection électrique.
        step.items = [
            { key: "jaune", btnId: 1, label: "Appui bouton JAUNE : la LED jaune s'allume" },
            { key: "vert",  btnId: 2, label: "Appui bouton VERT : la LED verte s'allume" },
            { key: "bleu",  btnId: 3, label: "Appui bouton BLEU : la détection est enregistrée automatiquement (aucun effet visuel sans écran)" }
        ];
        step.instruction = "Aucun écran détecté — test des LEDs et de la détection des 3 boutons. Appuyez successivement sur JAUNE, VERT puis BLEU.";
        step.title = "Test Boutons + LEDs (sans écran)";
    } else if (type === 1) {
        // Écran monochrome : pas de rétroéclairage RGB, mais le bouton bleu
        // reste testé électriquement (détection uniquement).
        step.items = [
            { key: "repos", btnId: null, label: "L'écran s'allume et affiche 'IUT de Cachan' + le SN (sans couleur particulière)" },
            { key: "jaune", btnId: 1,    label: "Appui bouton JAUNE : la LED jaune s'allume" },
            { key: "vert",  btnId: 2,    label: "Appui bouton VERT : la LED verte s'allume" },
            { key: "bleu",  btnId: 3,    label: "Appui bouton BLEU : la détection est enregistrée automatiquement (le rétroéclairage RGB est absent)" }
        ];
        step.instruction = "Écran monochrome détecté — validez l'affichage puis les LEDs, et vérifiez la détection des 3 boutons. Le rétroéclairage RGB n'est pas disponible.";
        step.title = "Test Boutons + LEDs + Écran monochrome";
    } else {
        step.title = "Test Boutons + LEDs + Rétroéclairage LCD";
    }

    if (currentStep() === step) {
        step._subIndex = 0;
        step._subAnswers = {};
        renderButtonsVisualSubQuestion(step);
    }
}

/* ======================================================================
   Helpers de validation des potentiomètres
   ====================================================================== */
function potIsValidated(st) {
    return st.min !== null && st.max !== null
        && st.min <= POT_ACCEPT_MIN
        && st.max >= POT_ACCEPT_MAX;
}
function potSwing(st) {
    if (st.min === null || st.max === null) return 0;
    return st.max - st.min;
}
function potValidationBadge(st) {
    if (st.min === null) return '<span style="color:#adb5bd;">non testé</span>';
    if (potIsValidated(st)) return '<span style="color:#28a745; font-weight:bold;">&#10003; OK</span>';
    return '<span style="color:#ffc107; font-weight:bold;">partiel</span>';
}

/* ======================================================================
   Moteur de déroulement des étapes
   ====================================================================== */
function currentStep() { return steps[currentStepIndex]; }

function startStep(index) {
    clearTimers();
    if (index >= steps.length) { endDiagnostic(); return; }
    currentStepIndex = index;
    const step = steps[index];

    // Affiche le testZone uniquement au moment où le contenu est prêt.
    // Ça évite d'afficher une étape fantôme lors de la reconnexion.
    testZone.style.display = "block";

    stepTitleEl.textContent = `Étape ${index + 1} / ${steps.length} : ${step.title}`;
    stepInstructionEl.textContent = step.instruction;

    step._subIndex = 0; step._subAnswers = {};
    step._escalated = false; step._escalationChoice = null; step._watchdogAnswer = null;

    if (step.kind === "buttons-visual") {
        manualActions.style.display = "block";
        autoActions.style.display = "none";
        renderButtonsVisualSubQuestion(step);
    } else {
        manualActions.style.display = "none";
        autoActions.style.display = "block";
        btnForceFail.textContent = "Terminer l'étape (éléments non testés = défaut)";
        btnForceFail.style.display = "inline-block";
    }

    if (step.kind === "motor-encoder") {
        sendCommand(step.motorCmd);
        stepTimer = setInterval(() => sendCommand(step.motorCmd), 200);
        escalationTimer = setTimeout(() => showMotorEncoderEscalation(step), step.timeoutMs);
    }

    refreshLiveStatus();
}

function clearTimers() {
    if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
    if (escalationTimer) { clearTimeout(escalationTimer); escalationTimer = null; }
}

function setLiveText(text) {
    stepLiveData.style.whiteSpace = "pre-wrap";
    stepLiveData.textContent = text;
}
function setLiveHtml(html) {
    stepLiveData.style.whiteSpace = "normal";
    stepLiveData.innerHTML = html;
}

function potBarHtml(prefix, st, opts = {}) {
    const large = !!opts.large;
    const pct = v => (Math.max(0, Math.min(ADC_MAX, v)) / ADC_MAX) * 100;

    let rangeStyle = "";
    if (st.min !== null && st.max !== null) {
        rangeStyle = `left:${pct(st.min)}%; width:${pct(st.max) - pct(st.min)}%;`;
    }
    const cursorLeft = (st.lastValue !== null) ? pct(st.lastValue) : 0;
    const jumpBadge = st.jumpCount > 0
        ? ` <span style="color:#dc3545; font-weight:bold;">&#9888; ${st.jumpCount} saut(s)</span>` : "";
    const cursorHtml = (st.lastValue !== null)
        ? `<div class="pot-bar-cursor" style="left:${cursorLeft}%"></div>` : "";

    return `
        <div class="pot-bar-container ${large ? 'pot-bar-large' : 'pot-bar-small'}">
            <div class="pot-bar-head">
                <span><strong>${prefix}</strong> — ${potValidationBadge(st)}</span>
                <span>Valeur : <strong>${st.lastValue ?? '-'}</strong> / ${ADC_MAX}${jumpBadge}</span>
            </div>
            <div class="pot-bar-track">
                <div class="pot-bar-range" style="${rangeStyle}"></div>
                ${cursorHtml}
            </div>
            <div class="pot-bar-foot">
                <span>min : ${st.min ?? '-'}</span>
                <span>course : ${potSwing(st)}</span>
                <span>max : ${st.max ?? '-'}</span>
            </div>
        </div>`;
}

function refreshLiveStatus() {
    const step = currentStep();
    if (!step) return;

    if (step.kind === "buttons") {
        setLiveText(step.items.map(id => `${BUTTONS[id].label}: ${BUTTONS[id].seenDown ? 'Reçu' : 'Attente'}`).join(" | "));
    } else if (step.kind === "buttons-visual") {
        updateButtonsVisualLive(step);
    } else if (step.kind === "pot-single") {
        const st = potState[step.channel];
        const html = potBarHtml(step.channel, st, { large: true })
            + `<div style="margin-top:8px; font-size:12px; color:#adb5bd;">`
            + `Cible : min &le; ${POT_ACCEPT_MIN} et max &ge; ${POT_ACCEPT_MAX} (échelle 0..${ADC_MAX}).`
            + `</div>`;
        setLiveHtml(html);
    } else if (step.kind === "pot-multi") {
        const validated = step.channels.filter(ch => potIsValidated(potState[ch])).length;
        const header = `<div style="margin-bottom:6px; color:#adb5bd; font-size:12px;">`
            + `Validés : <strong>${validated}/${step.channels.length}</strong> — cible : min &le; ${POT_ACCEPT_MIN} et max &ge; ${POT_ACCEPT_MAX} (0..${ADC_MAX}).`
            + `</div>`;
        setLiveHtml(header + step.channels.map(ch => potBarHtml(ch, potState[ch])).join(""));
    } else if (step.kind === "motor-encoder") {
        const st = encoderState[step.encoderKey];
        setLiveText(`${step.encoderLabel} — comptage: ${st.lastValue ?? '-'} — mouvement détecté: ${st.moved ? 'OUI' : 'en attente...'}`);
    }
}

function checkAutoAdvance() {
    const step = currentStep();
    if (!step) return;

    if (step.kind === "buttons") {
        if (step.items.every(id => BUTTONS[id].seenDown)) finalizeButtonsStep(step);
    } else if (step.kind === "pot-single") {
        if (potIsValidated(potState[step.channel])) finalizePotSingleStep(step, true);
    } else if (step.kind === "pot-multi") {
        if (step.channels.every(ch => potIsValidated(potState[ch]))) finalizePotMultiStep(step);
    } else if (step.kind === "motor-encoder") {
        const st = encoderState[step.encoderKey];
        if (st.moved && !step._escalated) finalizeMotorEncoderStep(step, "auto-ok");
    }
}

function onForceFailClicked() {
    const step = currentStep();
    if (!step) return;
    if (step.kind === "buttons")          finalizeButtonsStep(step);
    else if (step.kind === "pot-single")  finalizePotSingleStep(step, false);
    else if (step.kind === "pot-multi")   finalizePotMultiStep(step);
    else if (step.kind === "motor-encoder") showMotorEncoderEscalation(step);
}

function finalizeButtonsStep(step) {
    const lines = step.items.map(id => `  - ${BUTTONS[id].label} : ${BUTTONS[id].seenDown ? 'OK' : 'DEFAUT (non détecté)'}`);
    const allOk = step.items.every(id => BUTTONS[id].seenDown);
    reportResults.push({ title: step.title, status: allOk ? "CONFORME (PASS)" : "DEFAUT PARTIEL (FAIL)", lines });
    goToNextStep();
}

function finalizePotSingleStep(step, validated) {
    const st = potState[step.channel];
    const okLow  = st.min !== null && st.min <= POT_ACCEPT_MIN;
    const okHigh = st.max !== null && st.max >= POT_ACCEPT_MAX;
    const lines = [
        `  - Plage parcourue : ${st.min ?? '-'} à ${st.max ?? '-'} (amplitude ${potSwing(st)}, échelle 0..${ADC_MAX})`,
        `  - Cible : min <= ${POT_ACCEPT_MIN} -> ${okLow ? 'OK' : 'NON ATTEINT'}, max >= ${POT_ACCEPT_MAX} -> ${okHigh ? 'OK' : 'NON ATTEINT'}`,
        `  - Sauts brutaux détectés : ${st.jumpCount}${st.jumpEvents.length ? ' (' + st.jumpEvents.join(', ') + ')' : ''}`
    ];
    const ok = validated && st.jumpCount === 0;
    reportResults.push({
        title: step.title,
        status: ok ? "CONFORME (PASS)" : (validated ? "ANOMALIE (SAUT DETECTE)" : "DEFAUT (COURSE INCOMPLETE)"),
        lines
    });
    goToNextStep();
}

function finalizePotMultiStep(step) {
    const lines = step.channels.map(ch => {
        const st = potState[ch];
        const okLow  = st.min !== null && st.min <= POT_ACCEPT_MIN;
        const okHigh = st.max !== null && st.max >= POT_ACCEPT_MAX;
        const valid  = okLow && okHigh;
        const jumpTxt = st.jumpCount ? `, SAUT BRUTAL x${st.jumpCount} (${st.jumpEvents.join(', ')})` : "";
        const rangeTxt = st.min === null
            ? "aucune trame reçue"
            : `min=${st.min} max=${st.max} amplitude=${potSwing(st)}`;
        return `  - ${ch} : ${valid ? 'OK' : 'DEFAUT (course incomplète)'} [${rangeTxt}]${jumpTxt}`;
    });
    const allValidated = step.channels.every(ch => potIsValidated(potState[ch]));
    const anyJump      = step.channels.some(ch => potState[ch].jumpCount > 0);
    reportResults.push({
        title: step.title,
        status: anyJump ? "ANOMALIE (SAUT DETECTE)"
                        : (allValidated ? "CONFORME (PASS)" : "DEFAUT (COURSE INCOMPLETE)"),
        lines
    });
    goToNextStep();
}

function showMotorEncoderEscalation(step) {
    if (step._escalated) return;
    step._escalated = true;
    clearTimers();
    stepTimer = setInterval(() => sendCommand(step.motorCmd), 200);

    autoActions.style.display = "none";
    manualActions.style.display = "block";
    manualQuestion.textContent = `Aucune rotation du ${step.encoderLabel} détectée après ${step.timeoutMs / 1000}s. Le ${step.motorLabel} tourne-t-il visuellement ?`;
    btnYes.textContent = "OUI, le moteur tourne";
    btnNo.textContent  = "NON, rien ne tourne";
    btnYes.disabled = false;

    btnYes.onclick = () => { if (stepTimer) { clearInterval(stepTimer); stepTimer = null; } finalizeMotorEncoderStep(step, "encoder-fault"); };
    btnNo.onclick  = () => { if (stepTimer) { clearInterval(stepTimer); stepTimer = null; } finalizeMotorEncoderStep(step, "motor-fault"); };
}

function finalizeMotorEncoderStep(step, outcome) {
    if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
    clearTimers();

    const st = encoderState[step.encoderKey];
    const lines = [];
    let status;

    if (outcome === "auto-ok") {
        status = "CONFORME (PASS)";
        lines.push(`  - ${step.motorLabel} : rotation détectée indirectement via le codeur`);
        lines.push(`  - ${step.encoderLabel} : comptage actif (dernière valeur : ${st.lastValue})`);
    } else if (outcome === "encoder-fault") {
        status = "DEFAUT (FAIL)";
        lines.push(`  - ${step.motorLabel} : OK (rotation confirmée visuellement)`);
        lines.push(`  - ${step.encoderLabel} : DEFAILLANT (aucun comptage reçu malgré la rotation)`);
    } else {
        status = "DEFAUT (FAIL)";
        lines.push(`  - ${step.motorLabel} : DEFAILLANT (aucune rotation visible, PWM pourtant commandé)`);
        lines.push(`  - ${step.encoderLabel} : NON CONCLUANT (impossible à tester sans rotation du moteur)`);
    }

    if (step.watchdog && outcome !== "motor-fault") { askWatchdogQuestion(step, status, lines); return; }

    reportResults.push({ title: step.title, status, lines });
    goToNextStep();
}

function askWatchdogQuestion(step, baseStatus, baseLines) {
    manualActions.style.display = "block";
    autoActions.style.display = "none";
    manualQuestion.textContent = "Watchdog : le moteur s'arrête-t-il instantanément quand vous validez cette question (coupure de commande) ?";
    btnYes.textContent = "OUI (arrêt immédiat)";
    btnNo.textContent  = "NON (le moteur continue)";
    btnYes.disabled = false;

    btnYes.onclick = () => {
        baseLines.push("  - Watchdog (arrêt après 1s sans commande) : OK");
        reportResults.push({ title: step.title, status: baseStatus, lines: baseLines });
        goToNextStep();
    };
    btnNo.onclick = () => {
        baseLines.push("  - Watchdog (arrêt après 1s sans commande) : DEFAUT (moteur non coupé)");
        reportResults.push({ title: step.title, status: "DEFAUT (FAIL)", lines: baseLines });
        goToNextStep();
    };
}

function renderButtonsVisualSubQuestion(step) {
    const item = step.items[step._subIndex];
    if (!item) return;

    manualQuestion.textContent = item.label;
    btnYes.textContent = "OUI (Conforme)";
    btnNo.textContent  = "NON (Défaillant)";
    btnYes.onclick = () => answerButtonsVisualSubQuestion(step, true);
    btnNo.onclick  = () => answerButtonsVisualSubQuestion(step, false);
    updateButtonsVisualLive(step);
}

function updateButtonsVisualLive(step) {
    const item = step.items[step._subIndex];
    if (!item) return;

    let html = `<div style="margin-bottom:6px;">Point ${step._subIndex + 1} / ${step.items.length}</div>`;

    if (item.btnId) {
        const detected = BUTTONS[item.btnId].seenDown;
        btnYes.disabled = !detected;
        if (detected) html += `<div style="color:#28a745; font-weight:bold;">&#10003; Bouton détecté automatiquement — vérifiez l'effet visuel puis validez.</div>`;
        else          html += `<div style="color:#ffc107;">Appuyez sur le ${BUTTONS[item.btnId].label} pour activer la validation…</div>`;
    } else {
        btnYes.disabled = false;
        html += `<div style="color:#adb5bd;">Vérification visuelle uniquement (aucun appui requis).</div>`;
    }
    setLiveHtml(html);
}

function answerButtonsVisualSubQuestion(step, ok) {
    const item = step.items[step._subIndex];
    step._subAnswers[item.key] = ok;
    step._subIndex++;
    if (step._subIndex >= step.items.length) finalizeButtonsVisualStep(step);
    else                                     renderButtonsVisualSubQuestion(step);
}

function finalizeButtonsVisualStep(step) {
    const lines = step.items.map(item => {
        const manual = !!step._subAnswers[item.key];
        let line = `  - ${item.label} : ${manual ? 'OK' : 'DEFAUT (visuel)'}`;
        if (item.btnId) {
            const detected = BUTTONS[item.btnId].seenDown;
            line += ` | Détection auto bouton : ${detected ? 'OK' : 'NON DETECTE'}`;
        }
        return line;
    });
    const allOk = step.items.every(item => {
        const manual = !!step._subAnswers[item.key];
        const detected = !item.btnId || BUTTONS[item.btnId].seenDown;
        return manual && detected;
    });
    reportResults.push({ title: step.title, status: allOk ? "CONFORME (PASS)" : "DEFAUT PARTIEL (FAIL)", lines });
    goToNextStep();
}

function goToNextStep() { startStep(currentStepIndex + 1); }

/* ======================================================================
   Rapport final + déconnexion automatique
   ====================================================================== */
function endDiagnostic() {
    clearTimers();
    testZone.style.display = "none";
    reportZone.style.display = "block";

    const dateStr = new Date().toLocaleString('fr-FR');
    let text = "";
    text += `==================================================\n`;
    text += `       RAPPORT DE CONFORMITE MATERIELLE ESP32      \n`;
    text += `==================================================\n`;
    text += `Date du Diagnostic : ${dateStr}\n`;
    text += `Identifiant Carte  : SN${serialNumber}\n`;
    text += `Entite             : IUT de Cachan\n`;

    text += `Version firmware   : ${firmwareVersion ?? "non communiquée"}`;
    if (firmwareUpToDate === false) {
        text += ` -- ATTENTION : obsolète (attendu ${EXPECTED_FW_VERSION})`;
    } else if (firmwareUpToDate === true) {
        text += ` (à jour)`;
    }
    text += `\n`;

    const lcdLabels = {
        0: "Aucun écran détecté",
        1: "Écran LCD monochrome (sans rétroéclairage RGB)",
        2: "Écran LCD RGB"
    };
    text += `Écran LCD détecté  : ${lcdLabels[lcdType] ?? "non communiqué"}\n`;
    text += `--------------------------------------------------\n\n`;

    let totalPass = 0;
    reportResults.forEach((res, i) => {
        text += `Etape ${i + 1}: ${res.title}\n`;
        text += `  Statut : ${res.status}\n`;
        res.lines.forEach(l => { text += l + "\n"; });
        text += "\n";
        if (res.status.startsWith("CONFORME")) totalPass++;
    });

    text += `--------------------------------------------------\n`;
    text += `ANNEXE - Bilan complet des potentiometres (session)\n`;
    text += `Cible : min <= ${POT_ACCEPT_MIN} et max >= ${POT_ACCEPT_MAX} sur l'echelle 0..${ADC_MAX}\n`;
    text += `--------------------------------------------------\n`;
    POT_PREFIXES.forEach(prefix => {
        const st = potState[prefix];
        let line = `  ${prefix} : `;
        if (st.min === null) line += "aucune trame recue";
        else {
            const valid = potIsValidated(st);
            line += `min=${st.min} max=${st.max} amplitude=${potSwing(st)} -> ${valid ? 'OK' : 'DEFAUT (course incomplete)'}`;
            if (st.jumpCount > 0) line += ` -- ANOMALIE : ${st.jumpCount} saut(s) brutal(aux) [${st.jumpEvents.join(', ')}]`;
        }
        text += line + "\n";
    });

    text += `\n--------------------------------------------------\n`;
    const globalOk = totalPass === steps.length;
    text += `RESULTAT GLOBAL : ${globalOk ? "CARTE VALIDEE (SANS DEFAUT)" : "CARTE REJETEE (DEFAILLANTE OU A VERIFIER)"}\n`;
    text += `==================================================\n`;

    reportArea.textContent = text;
    reportArea.style.display = "block";

    (async () => {
        await closeSerialPort();
        connStatus.textContent = "Déconnecté (test terminé)";
        connStatus.style.color = "red";
        btnConnect.disabled = false;
        btnConnectAny.disabled = false;
        btnDisconnect.disabled = true;
        btnFlash.disabled = true;
    })();
}

function downloadReportFile() {
    const blob = new Blob([reportArea.textContent], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Rapport_Test_SN${serialNumber}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
}