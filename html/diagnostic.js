/* ==========================================================================
   Banc de diagnostic ESP32 - IUT de Cachan
   Logique de test + génération du rapport + reflashage automatique.
   ========================================================================== */

/* ----------------------------------------------------------------------
   Configuration du reflashage
   ---------------------------------------------------------------------- */
const FIRMWARE_URL = "firmware.bin";      // fichier dans le même dossier
const FIRMWARE_FLASH_ADDR = 0x10000;      // app only (partition par défaut).
                                          // Mettre 0x0 pour un merged.bin complet.
const ESPTOOL_CDN = "https://cdn.jsdelivr.net/npm/esptool-js@0.5.4/bundle.js";
const SN_TIMEOUT_MS = 4000;               // délai max d'attente du SN après ouverture
const POST_FLASH_DELAY_MS = 2500;         // temps de boot de l'ESP32 après reset
const AUTO_FLASH_RETRY_LIMIT = 1;         // évite une boucle infinie si le .bin est mauvais

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
let autoFlashAttempts = 0;

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
   Définition des étapes
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
const btnDisconnect = document.getElementById('btnDisconnect');
const btnFlash      = document.getElementById('btnFlash');
const connStatus    = document.getElementById('connStatus');
const lblSN         = document.getElementById('lblSN');
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

btnConnect.addEventListener('click', () => connectSerial());
btnDisconnect.addEventListener('click', disconnectSerial);
btnFlash.addEventListener('click', manualFlashRequest);
document.getElementById('btnTestAnother').addEventListener('click', testAnotherBoard);
btnForceFail.addEventListener('click', onForceFailClicked);
document.getElementById('btnDownloadReport').addEventListener('click', downloadReportFile);

/* ======================================================================
   Connexion / Déconnexion / Flash
   ====================================================================== */

async function connectSerial(existingPort = null) {
    try {
        if (existingPort) {
            port = existingPort;
        } else {
            port = await navigator.serial.requestPort();
        }
        await port.open({ baudRate: 115200 });

        connStatus.textContent = "Connecté (115200 Baud)";
        connStatus.style.color = "green";
        btnConnect.disabled = true;
        btnDisconnect.disabled = false;
        btnFlash.disabled = false;
        testZone.style.display = "block";
        reportZone.style.display = "none";

        // Arme le watchdog d'absence de SN
        snTimeoutHandle = setTimeout(handleNoResponse, SN_TIMEOUT_MS);

        readSerialLoop();
        setTimeout(() => { sendCommand("SN"); }, 200);

        // Petit délai pour laisser le SN arriver avant de démarrer les étapes.
        // startStep sera déclenché dès la réception du SN (voir processIncomingLine),
        // ou bien par sécurité après 500ms si un SN est déjà arrivé avant.
        setTimeout(() => {
            if (serialNumber !== "INCONNU") startStep(0);
        }, 500);

    } catch (error) {
        alert("Impossible d'accéder au port série : " + error);
    }
}

// Ferme proprement le port. Si keepPortRef=true, la référence `port` est conservée
// pour permettre une réouverture immédiate (cas du reflashage).
async function closeSerialPort(keepPortRef = false) {
    keepReading = false;
    clearTimers();
    if (snTimeoutHandle) { clearTimeout(snTimeoutHandle); snTimeoutHandle = null; }

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
    await connectSerial();
}

function resetUIAfterDisconnect() {
    connStatus.textContent = "Déconnecté";
    connStatus.style.color = "red";
    btnConnect.disabled = false;
    btnDisconnect.disabled = true;
    btnFlash.disabled = true;
    testZone.style.display = "none";
    reportZone.style.display = "none";
    reportArea.style.display = "none";
    reportArea.textContent = "";
    lblSN.textContent = "Lecture en cours... (Veuillez connecter la carte)";
    lblSN.style.color = "#dc3545";
}

function resetAllState() {
    serialNumber = "INCONNU";
    currentStepIndex = 0;
    reportResults.length = 0;
    inputBuffer = "";

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
   Absence de réponse → proposition de reflashage
   ---------------------------------------------------------------------- */

async function handleNoResponse() {
    snTimeoutHandle = null;
    if (serialNumber !== "INCONNU") return;      // SN déjà reçu, rien à faire

    await closeSerialPort(true);                 // on garde la référence de port
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

        // Chargement dynamique du module ESM
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

        // Connexion au bootloader ROM (auto-reset via DTR/RTS si la carte le permet)
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
        await loader.after();                // reset hard
        try { await transport.disconnect(); } catch (e) { /* toléré */ }

        showFlashOverlay("Firmware reflashé ! Reconnexion dans " + (POST_FLASH_DELAY_MS / 1000) + " s…", 100);
        await new Promise(r => setTimeout(r, POST_FLASH_DELAY_MS));
        hideFlashOverlay();

        // Réinitialise et retente la connexion sur le MÊME port
        resetAllState();
        lblSN.textContent = "Lecture en cours... (Veuillez connecter la carte)";
        lblSN.style.color = "#dc3545";
        testZone.style.display = "block";
        reportZone.style.display = "none";
        await connectSerial(portToUse);

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

let step0Started = false;

function processIncomingLine(line) {
    if (!line) return;

    if (line.startsWith("SN")) {
        serialNumber = line.substring(2);
        lblSN.textContent = "SN" + serialNumber;
        lblSN.style.color = "#28a745";
        if (snTimeoutHandle) { clearTimeout(snTimeoutHandle); snTimeoutHandle = null; }
        // Démarre les étapes dès qu'on a le SN (la 1ère fois)
        if (!step0Started) {
            step0Started = true;
            // Laisse le temps au LCD de s'initialiser côté firmware
            setTimeout(() => startStep(0), 300);
        }
        return;
    }

    if ((line[0] === "D" || line[0] === "U") && BUTTONS[line.substring(1)]) {
        const id = line.substring(1);
        if (line[0] === "D") { BUTTONS[id].pressed = true; BUTTONS[id].seenDown = true; }
        else                 { BUTTONS[id].pressed = false; }
        refreshLiveStatus(); checkAutoAdvance();
        return;
    }

    for (const prefix of POT_PREFIXES) {
        if (line.startsWith(prefix)) {
            const value = parseInt(line.substring(prefix.length), 10);
            if (!isNaN(value)) { updatePotState(prefix, value); refreshLiveStatus(); checkAutoAdvance(); }
            return;
        }
    }

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

    // Déconnexion automatique
    (async () => {
        await closeSerialPort();
        connStatus.textContent = "Déconnecté (test terminé)";
        connStatus.style.color = "red";
        btnConnect.disabled = false;
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