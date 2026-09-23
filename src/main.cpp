#include <Arduino.h>
#include <Wire.h>
#include <rgb_lcd.h>

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

// Instance de l'écran LCD Grove RGB
rgb_lcd lcd;

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

// Structure pour la gestion des potentiomètres
struct Potentiometer {
    uint8_t pin;
    const char* prefix;
    int lastValue;
};

Potentiometer pots[] = {
    {25, "PA", -10},
    {32, "PB", -10},
    {33, "PC", -10},
    {35, "PD", -10},
    {34, "PE", -10},
    {36, "PF", -10},
    {39, "PG", -10}
};
const uint8_t numPots = sizeof(pots) / sizeof(Potentiometer);

// Variables globales pour le rythme d'échantillonnage analogique (20Hz max -> 50ms)
unsigned long lastPotTime = 0;
const unsigned long potInterval = 50; 

// État actuel du rétroéclairage
uint8_t currentR = 255;
uint8_t currentG = 255;
uint8_t currentB = 255;

// Variables pour la réception série et le Watchdog moteur
String serialBuffer = "";
unsigned long lastMotorCmdTime = 0;
const unsigned long motorTimeout = 1000; // 1 seconde de timeout
bool motorsActive = false;

void updateBacklight() {
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
    if (cmd.length() < 3) return;

    if (cmd.startsWith("MA")) {
        int duty = cmd.substring(2).toInt();
        if (duty >= 0 && duty <= 1023) {
            // API ledc d'Arduino Core 3.x : Pilotage direct par la broche GPIO
            ledcWrite(PIN_PWM_MOTEUR_A, duty);
            lastMotorCmdTime = millis();
            motorsActive = true;
        }
    } 
    else if (cmd.startsWith("MB")) {
        int duty = cmd.substring(2).toInt();
        if (duty >= 0 && duty <= 1023) {
            // API ledc d'Arduino Core 3.x : Pilotage direct par la broche GPIO
            ledcWrite(PIN_PWM_MOTEUR_B, duty);
            lastMotorCmdTime = millis();
            motorsActive = true;
        }
    }
}

void setup() {
    Serial.begin(115200);
    serialBuffer.reserve(32);

    Wire.begin(PIN_SDA, PIN_SCL);

    lcd.begin(16, 2);
    lcd.setRGB(255, 255, 255);
    
    lcd.setCursor(0, 0);
    lcd.print("IUT de Cachan");

    // Configuration des boutons
    for (uint8_t i = 0; i < numButtons; i++) {
        pinMode(buttons[i].pin, INPUT);
    }

    pinMode(PIN_LED_JAUNE, OUTPUT);
    pinMode(PIN_LED_VERT, OUTPUT);
    
    digitalWrite(PIN_LED_JAUNE, LOW);
    digitalWrite(PIN_LED_VERT, LOW);

    // Configuration des potentiomètres
    for (uint8_t i = 0; i < numPots; i++) {
        pinMode(pots[i].pin, ANALOG);
    }

    // API ledc d'Arduino Core 3.x : Configuration et attachement combinés sur le GPIO
    ledcAttach(PIN_PWM_MOTEUR_A, PWM_FREQ, PWM_RESOLUTION);
    ledcAttach(PIN_PWM_MOTEUR_B, PWM_FREQ, PWM_RESOLUTION);

    // Initialisation des rapports cycliques à 0
    ledcWrite(PIN_PWM_MOTEUR_A, 0);
    ledcWrite(PIN_PWM_MOTEUR_B, 0);
    lastMotorCmdTime = millis();
}

void loop() {
    // Lecture de la liaison série et reconstruction des commandes
    while (Serial.available() > 0) {
        char c = Serial.read();
        if (c == 0x0A) { 
            parseSerialCommand(serialBuffer);
            serialBuffer = "";
        } else if (c != 0x0D) { 
            serialBuffer += c;
        }
    }

    // Watchdog de sécurité sur les moteurs (1 seconde sans commande)
    if (motorsActive && (millis() - lastMotorCmdTime >= motorTimeout)) {
        ledcWrite(PIN_PWM_MOTEUR_A, 0);
        ledcWrite(PIN_PWM_MOTEUR_B, 0);
        motorsActive = false;
    }

    // Gestion des boutons avec anti-rebond
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

    // Lecture séquentielle de tous les potentiomètres à la fréquence globale de 20 Hz (50 ms)
    if (millis() - lastPotTime >= potInterval) {
        lastPotTime = millis();

        for (uint8_t i = 0; i < numPots; i++) {
            int currentPotValue = analogRead(pots[i].pin);

            if (abs(currentPotValue - pots[i].lastValue) > 1) {
                pots[i].lastValue = currentPotValue;
                Serial.print(pots[i].prefix);
                Serial.print(currentPotValue);
                Serial.write(0x0A);
            }
        }
    }

    digitalWrite(PIN_LED_JAUNE, digitalRead(PIN_BTN_JAUNE));
    digitalWrite(PIN_LED_VERT, digitalRead(PIN_BTN_VERT));

    updateBacklight();
}
