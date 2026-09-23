#include <Arduino.h>
#include <Wire.h>
#include <rgb_lcd.h>

// Configuration des broches
#define PIN_SDA 21
#define PIN_SCL 22

#define PIN_BTN_JAUNE 14
#define PIN_BTN_VERT  12
#define PIN_BTN_BLEU  15

#define PIN_LED_JAUNE 4
#define PIN_LED_VERT  2

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
    {PIN_BTN_BLEU,  3, LOW, 0}
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

void setup() {
    Serial.begin(115200);

    Wire.begin(PIN_SDA, PIN_SCL);

    lcd.begin(16, 2);
    lcd.setRGB(255, 255, 255);
    
    lcd.setCursor(0, 0);
    lcd.print("IUT de Cachan");

    pinMode(PIN_BTN_JAUNE, INPUT);
    pinMode(PIN_BTN_VERT, INPUT);
    pinMode(PIN_BTN_BLEU, INPUT);

    pinMode(PIN_LED_JAUNE, OUTPUT);
    pinMode(PIN_LED_VERT, OUTPUT);
    
    digitalWrite(PIN_LED_JAUNE, LOW);
    digitalWrite(PIN_LED_VERT, LOW);

    // Initialisation de toutes les broches des potentiomètres
    for (uint8_t i = 0; i < numPots; i++) {
        pinMode(pots[i].pin, ANALOG);
    }
}

void loop() {
    while (Serial.available() > 0) {
        Serial.read(); 
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

            // Vérification du seuil de tolérance de +/- 1 par rapport à la dernière valeur envoyée
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
