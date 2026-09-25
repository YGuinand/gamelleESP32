#include <Arduino.h>
#include <Wire.h>
#include <rgb_lcd.h>
#include <ESP32Encoder.h>

// ============================================================================
// VERSION DU FIRMWARE
// À incrémenter à chaque modification du firmware.
// Format "Vx.y" — l'interface web compare cette valeur pour décider
// si un reflashage est nécessaire.
// ============================================================================
const char FIRMWARE_VERSION[] = "V0.2";

// Configuration des broches
#define PIN_SDA 21
#define PIN_SCL 22

#define PIN_BTN_JAUNE 14
#define PIN_BTN_VERT  12
#define PIN_BTN_BLEU  15
#define PIN_BTN_JACK  23
#define PIN_BTN_FDC   16

#define PIN_LED_JAUNE 4
#define PIN_LED_VERT  2

#define PIN_PWM_MOTEUR_A 26
#define PIN_PWM_MOTEUR_B 27

// Paramètres PWM conformes à l'API ESP32 Arduino Core 3.x
#define PWM_FREQ       20000
#define PWM_RESOLUTION 10

// Taille du filtre moyenne glissante (puissance de 2 pour optimisation)
#define FILTER_SIZE 8

// Adresses I2C utilisées par le LCD
#define LCD_ADDR_HD44780  0x3E   // contrôleur LCD (présent si écran branché)
#define LCD_ADDR_PCA9633  0x62   // contrôleur RGB (présent seulement si RGB)

// Codes de détection LCD
#define LCD_NONE        0
#define LCD_MONOCHROME  1
#define LCD_RGB         2

// Timeout I2C (ms) — évite les blocages si un périphérique ne répond pas
#define I2C_TIMEOUT_MS  50

// Instance de l'écran LCD Grove RGB
rgb_lcd lcd;

// Type d'écran détecté (0 = aucun, 1 = monochrome, 2 = RGB)
uint8_t lcdType = LCD_NONE;

// Instances matérielles des codeurs (Périphérique PCNT)
ESP32Encoder encoderA;
ESP32Encoder encoderB;

// Chaine de caractères globale stockant le Numéro de Série unique
char serialNumberStr[13];

// Structures pour la gestion des boutons (anti-rebond logiciel)
struct Button {
    uint8_t pin;
    uint8_t id;
    bool lastState;
    unsigned long lastDebounceTime;
};

Button buttons[] = {
    {PIN_BTN_JAUNE, 1, LOW, 0},
    {PIN_BTN_VERT,  2, LOW, 0},
    {PIN_BTN_BLEU,  3, LOW, 0},
    {PIN_BTN_JACK,  4, LOW, 0},
    {PIN_BTN_FDC,   5, LOW, 0}
};
const uint8_t numButtons = sizeof(buttons) / sizeof(Button);
const unsigned long debounceDelay = 50;

// Structure pour la gestion des potentiomètres avec filtrage par moyenne glissante
struct Potentiometer {
    uint8_t pin;
    const char* prefix;
    int lastValue;
    int history[FILTER_SIZE];
    uint8_t historyIndex;
    int runningSum;
};

Potentiometer pots[] = {
    {25, "PA", -10, {0}, 0, 0},
    {32, "PB", -10, {0}, 0, 0},
    {33, "PC", -10, {0}, 0, 0},
    {35, "PD", -10, {0}, 0, 0},
    {34, "PE", -10, {0}, 0, 0},
    {36, "PF", -10, {0}, 0, 0},
    {39, "PG", -10, {0}, 0, 0}
};
const uint8_t numPots = sizeof(pots) / sizeof(Potentiometer);

// Variables globales pour les rythmes d'échantillonnage (20Hz max -> 50ms)
unsigned long lastAnalogAndEncoderTime = 0;
const unsigned long loopInterval = 50;

// État actuel du rétroéclairage
uint8_t currentR = 255;
uint8_t currentG = 255;
uint8_t currentB = 255;

// Variables pour la réception série et le Watchdog moteur
String serialBuffer = "";
unsigned long lastMotorCmdTime = 0;
const unsigned long motorTimeout = 1000;
bool motorsActive = false;

// ----------------------------------------------------------------------------
// Signal visuel de boot : 3 clignotements rapides de la LED jaune.
// Permet de confirmer que le firmware démarre correctement.
// ----------------------------------------------------------------------------
void bootBlink() {
    pinMode(PIN_LED_JAUNE, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED_JAUNE, HIGH);
        delay(100);
        digitalWrite(PIN_LED_JAUNE, LOW);
        delay(100);
    }
}

// ----------------------------------------------------------------------------
// Sondage d'une adresse I2C sans écriture de données.
// La nouvelle pile ESP32 core 3.x traduit ceci en "probe", pas en "transmit",
// ce qui évite l'erreur ESP_ERR_INVALID_STATE.
// ----------------------------------------------------------------------------
bool i2cProbe(uint8_t addr) {
    Wire.beginTransmission(addr);
    return (Wire.endTransmission() == 0);
}

// ----------------------------------------------------------------------------
// Détection du LCD par sondage I2C
// ----------------------------------------------------------------------------
uint8_t detectLcd() {
    if (!i2cProbe(LCD_ADDR_HD44780)) return LCD_NONE;
    if (i2cProbe(LCD_ADDR_PCA9633))  return LCD_RGB;
    return LCD_MONOCHROME;
}

// Fonction de génération du numéro de série à partir de l'eFuse MAC
void initSerialNumber() {
    uint64_t mac = ESP.getEfuseMac();
    snprintf(serialNumberStr, sizeof(serialNumberStr), "%04X%08X",
             (uint16_t)(mac >> 32), (uint32_t)mac);
}

// ----------------------------------------------------------------------------
// Envoi groupé des identifiants : SN, Version, LCD
// ----------------------------------------------------------------------------
void sendIdentity() {
    Serial.print("SN");
    Serial.print(serialNumberStr);
    Serial.write(0x0A);

    Serial.print(FIRMWARE_VERSION);
    Serial.write(0x0A);

    Serial.print("L");
    Serial.print(lcdType);
    Serial.write(0x0A);
}

void updateBacklight() {
    if (lcdType != LCD_RGB) return;   // pas de rétroéclairage RGB disponible

    if (digitalRead(PIN_BTN_JAUNE) == HIGH) {
        if (currentR != 255 || currentG != 255 || currentB != 0) {
            lcd.setRGB(255, 255, 0);
            currentR = 255; currentG = 255; currentB = 0;
        }
    }
    else if (digitalRead(PIN_BTN_VERT) == HIGH) {
        if (currentR != 0 || currentG != 255 || currentB != 0) {
            lcd.setRGB(0, 255, 0);
            currentR = 0; currentG = 255; currentB = 0;
        }
    }
    else if (digitalRead(PIN_BTN_BLEU) == HIGH) {
        if (currentR != 0 || currentG != 0 || currentB != 255) {
            lcd.setRGB(0, 0, 255);
            currentR = 0; currentG = 0; currentB = 255;
        }
    }
    else {
        if (currentR != 255 || currentG != 255 || currentB != 255) {
            lcd.setRGB(255, 255, 255);
            currentR = 255; currentG = 255; currentB = 255;
        }
    }
}

void parseSerialCommand(String cmd) {
    cmd.trim();
    if (cmd.length() < 1) return;

    // ----- Interrogation du numéro de série -----
    if (cmd == "SN") {
        Serial.print("SN");
        Serial.print(serialNumberStr);
        Serial.write(0x0A);
        return;
    }

    // ----- Interrogation de la version firmware -----
    if (cmd == "V") {
        Serial.print(FIRMWARE_VERSION);
        Serial.write(0x0A);
        return;
    }

    // ----- Interrogation du type d'écran -----
    if (cmd == "L") {
        // Re-sonde à chaud : utile si l'écran a été branché après le boot
        lcdType = detectLcd();
        Serial.print("L");
        Serial.print(lcdType);
        Serial.write(0x0A);
        return;
    }

    if (cmd.startsWith("MA")) {
        int duty = cmd.substring(2).toInt();
        if (duty >= 0 && duty <= 1023) {
            ledcWrite(PIN_PWM_MOTEUR_A, duty);
            lastMotorCmdTime = millis();
            motorsActive = true;
        }
    }
    else if (cmd.startsWith("MB")) {
        int duty = cmd.substring(2).toInt();
        if (duty >= 0 && duty <= 1023) {
            ledcWrite(PIN_PWM_MOTEUR_B, duty);
            lastMotorCmdTime = millis();
            motorsActive = true;
        }
    }
    else if (cmd.startsWith("CA")) {
        long value = cmd.substring(2).toInt();
        encoderA.setCount(value);
    }
    else if (cmd.startsWith("CB")) {
        long value = cmd.substring(2).toInt();
        encoderB.setCount(value);
    }
}

void setup() {
    // LED jaune prête pour le boot blink
    pinMode(PIN_LED_JAUNE, OUTPUT);
    digitalWrite(PIN_LED_JAUNE, LOW);

    Serial.begin(115200);
    serialBuffer.reserve(64);

    // Signal visuel : 3 clignotements
    bootBlink();

    initSerialNumber();

    // ------------------------------------------------------------------
    // Bus I2C : on configure AVANT toute sonde.
    // ------------------------------------------------------------------
    Wire.begin(PIN_SDA, PIN_SCL);
    Wire.setTimeOut(I2C_TIMEOUT_MS);

    // Détection LCD (sondes sans écriture — fiable sur core 3.x)
    lcdType = detectLcd();

    // Émission immédiate des identifiants, AVANT l'init du LCD.
    // Comme ça, même si le LCD bloque, le navigateur a les infos.
    sendIdentity();

    // ------------------------------------------------------------------
    // Init LCD : à faire APRÈS les sondes.
    // ATTENTION : rgb_lcd::begin() rappelle Wire.begin() sans paramètres.
    // Sur ESP32 core 3.x, cela réinitialise le timeout et le clock du bus.
    // → On les redéfinit juste après.
    // ------------------------------------------------------------------
    if (lcdType != LCD_NONE) {
        lcd.begin(16, 2);

        // Restauration de la config du bus après le Wire.begin() interne
        Wire.setTimeOut(I2C_TIMEOUT_MS);
        Wire.setClock(100000);

        if (lcdType == LCD_RGB) {
            lcd.setRGB(255, 255, 255);
        }
        lcd.setCursor(0, 0);
        lcd.print("IUT de Cachan");
        lcd.setCursor(0, 1);
        lcd.print(serialNumberStr);
    }

    // Boutons
    for (uint8_t i = 0; i < numButtons; i++) {
        pinMode(buttons[i].pin, INPUT);
    }

    pinMode(PIN_LED_VERT, OUTPUT);
    digitalWrite(PIN_LED_JAUNE, LOW);
    digitalWrite(PIN_LED_VERT, LOW);

    // Potentiomètres : init + pré-remplissage de l'historique de filtrage
    for (uint8_t i = 0; i < numPots; i++) {
        pinMode(pots[i].pin, ANALOG);
        int initialValue = analogRead(pots[i].pin);
        pots[i].runningSum = initialValue * FILTER_SIZE;
        for (uint8_t j = 0; j < FILTER_SIZE; j++) {
            pots[i].history[j] = initialValue;
        }
        pots[i].lastValue = initialValue;
    }

    // PWM moteurs
    ledcAttach(PIN_PWM_MOTEUR_A, PWM_FREQ, PWM_RESOLUTION);
    ledcAttach(PIN_PWM_MOTEUR_B, PWM_FREQ, PWM_RESOLUTION);
    ledcWrite(PIN_PWM_MOTEUR_A, 0);
    ledcWrite(PIN_PWM_MOTEUR_B, 0);
    lastMotorCmdTime = millis();

    // Codeurs
    ESP32Encoder::useInternalWeakPullResistors = puType::up;
    encoderA.attachFullQuad(17, 18);
    encoderB.attachFullQuad(19, 13);
    encoderA.setCount(0);
    encoderB.setCount(0);

    // Signal de fin de setup
    digitalWrite(PIN_LED_JAUNE, HIGH);
    delay(200);
    digitalWrite(PIN_LED_JAUNE, LOW);
}

void loop() {
    while (Serial.available() > 0) {
        char c = Serial.read();
        if (c == 0x0A) {
            parseSerialCommand(serialBuffer);
            serialBuffer = "";
        } else if (c != 0x0D) {
            // Limite de sécurité : évite qu'un buffer sans \n ne grossisse sans fin
            if (serialBuffer.length() < 64) {
                serialBuffer += c;
            } else {
                serialBuffer = "";
            }
        }
    }

    if (motorsActive && (millis() - lastMotorCmdTime >= motorTimeout)) {
        ledcWrite(PIN_PWM_MOTEUR_A, 0);
        ledcWrite(PIN_PWM_MOTEUR_B, 0);
        motorsActive = false;
    }

    for (uint8_t i = 0; i < numButtons; i++) {
        bool reading = (digitalRead(buttons[i].pin) == HIGH);

        if (reading != buttons[i].lastState && (millis() - buttons[i].lastDebounceTime) > debounceDelay) {
            buttons[i].lastState = reading;
            buttons[i].lastDebounceTime = millis();

            if (reading) {
                Serial.write('D');
                Serial.print(buttons[i].id);
                Serial.write(0x0A);
            } else {
                Serial.write('U');
                Serial.print(buttons[i].id);
                Serial.write(0x0A);
            }
        }
    }

    if (millis() - lastAnalogAndEncoderTime >= loopInterval) {
        lastAnalogAndEncoderTime = millis();

        // Lecture, filtrage par moyenne glissante et envoi des potentiomètres
        for (uint8_t i = 0; i < numPots; i++) {
            int rawValue = analogRead(pots[i].pin);

            // Soustraction de la valeur la plus ancienne et ajout de la nouvelle
            pots[i].runningSum -= pots[i].history[pots[i].historyIndex];
            pots[i].history[pots[i].historyIndex] = rawValue;
            pots[i].runningSum += rawValue;

            // Incrémentation de l'index du tableau circulaire
            pots[i].historyIndex = (pots[i].historyIndex + 1) % FILTER_SIZE;

            // Calcul de la moyenne
            int filteredValue = pots[i].runningSum / FILTER_SIZE;

            // Envoi uniquement si la valeur filtrée change (seuil de tolérance ± 1)
            if (abs(filteredValue - pots[i].lastValue) > 1) {
                pots[i].lastValue = filteredValue;
                Serial.print(pots[i].prefix);
                Serial.print(filteredValue);
                Serial.write(0x0A);
            }
        }

        Serial.print("CA");
        Serial.print((int32_t)encoderA.getCount());
        Serial.write(0x0A);

        Serial.print("CB");
        Serial.print((int32_t)encoderB.getCount());
        Serial.write(0x0A);
    }

    digitalWrite(PIN_LED_JAUNE, digitalRead(PIN_BTN_JAUNE));
    digitalWrite(PIN_LED_VERT, digitalRead(PIN_BTN_VERT));

    updateBacklight();
}
